import type { NodeConfig, NodeDeps, NodeResult } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { appendLog, runShellCapture, shellEscape } from "../shell.js";
import { canAutoRebaseFeatureDeliveryBranch } from "../../work-items/feature-delivery-policy.js";

function getMaxBehindCommits(nodeConfig: NodeConfig, deps: NodeDeps): number {
  const configured = nodeConfig.config?.["maxBehindCommits"];
  if (typeof configured === "number" && Number.isFinite(configured) && configured >= 0) {
    return configured;
  }
  return Math.max(0, deps.config.autoReviewBranchSyncMaxBehindCommits ?? 5);
}

function hasCompletedRequiredReviews(deps: NodeDeps): boolean {
  const flags = deps.run.prefetchContext?.workItem.flags ?? [];
  return canAutoRebaseFeatureDeliveryBranch(flags);
}

function resolveSyncBaseBranch(ctx: ContextBag, deps: NodeDeps): string | undefined {
  const prBaseBranch = deps.run.prefetchContext?.github?.pr.baseRef?.trim();
  if (prBaseBranch) {
    return prBaseBranch;
  }

  const resolvedBaseBranch = ctx.get<string>("resolvedBaseBranch")?.trim();
  if (resolvedBaseBranch) {
    return resolvedBaseBranch;
  }

  const runBaseBranch = deps.run.baseBranch?.trim();
  return runBaseBranch || undefined;
}

function shouldPreservePriorRebaseResult(ctx: ContextBag, baseBranch: string): boolean {
  return ctx.get<boolean>("rebasePerformed") === true
    && ctx.get<string>("rebaseConflictBaseBranch") === baseBranch;
}

async function getCurrentHead(repoDir: string, logFile: string): Promise<string> {
  const result = await runShellCapture("git rev-parse HEAD", { cwd: repoDir, logFile });
  if (result.code !== 0) {
    throw new Error("Failed to read current HEAD before branch sync");
  }
  return result.stdout.trim();
}

async function listConflictedFiles(repoDir: string, logFile: string): Promise<string[]> {
  const conflicted = await runShellCapture("git diff --name-only --diff-filter=U", {
    cwd: repoDir,
    logFile,
  });
  return conflicted.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function abortRebase(repoDir: string, logFile: string): Promise<void> {
  await runShellCapture("git rebase --abort", { cwd: repoDir, logFile });
}

type RebaseAttemptResult =
  | { kind: "completed" }
  | { kind: "conflict"; conflictFiles: string[]; rawOutput: string }
  | { kind: "stuck"; rawOutput: string };

async function rebaseOntoBase(
  repoDir: string,
  logFile: string,
  baseBranch: string,
): Promise<RebaseAttemptResult> {
  const rebaseTarget = shellEscape(`origin/${baseBranch}`);
  const stepResult = await runShellCapture(`git rebase ${rebaseTarget}`, { cwd: repoDir, logFile });
  if (stepResult.code === 0) {
    return { kind: "completed" };
  }

  const rawOutput = [stepResult.stderr, stepResult.stdout].filter(Boolean).join("\n").trim();
  const conflictFiles = await listConflictedFiles(repoDir, logFile);
  if (conflictFiles.length > 0) {
    return { kind: "conflict", conflictFiles, rawOutput };
  }
  return { kind: "stuck", rawOutput };
}

export async function syncBaseBranchNode(
  nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps,
): Promise<NodeResult> {
  const repoDir = ctx.getRequired<string>("repoDir");
  const resolvedBaseBranch = resolveSyncBaseBranch(ctx, deps);
  const logFile = deps.logFile;
  const maxBehindCommits = getMaxBehindCommits(nodeConfig, deps);

  if (!resolvedBaseBranch?.trim()) {
    return {
      outcome: "success",
      outputs: {
        rebasePerformed: false,
        requiresForcePush: false,
      },
    };
  }

  ctx.set("resolvedBaseBranch", resolvedBaseBranch);

  if (!hasCompletedRequiredReviews(deps)) {
    await appendLog(logFile, "\n[sync_base_branch] skipped: engineering_review_done and qa_review_done are both required\n");
    ctx.set("rebasePerformed", false);
    ctx.set("forcePushWithLease", false);
    return {
      outcome: "success",
      outputs: {
        rebasePerformed: false,
        requiresForcePush: false,
      },
    };
  }

  const fetchResult = await runShellCapture(`git fetch origin ${shellEscape(resolvedBaseBranch)}`, {
    cwd: repoDir,
    logFile,
  });
  if (fetchResult.code !== 0) {
    return {
      outcome: "failure",
      error: `Failed to fetch origin/${resolvedBaseBranch} before branch sync.`,
      rawOutput: fetchResult.stderr || fetchResult.stdout,
    };
  }

  const behindResult = await runShellCapture(
    `git rev-list --count HEAD..${shellEscape(`origin/${resolvedBaseBranch}`)}`,
    { cwd: repoDir, logFile },
  );
  if (behindResult.code !== 0) {
    return {
      outcome: "failure",
      error: `Failed to calculate branch divergence against origin/${resolvedBaseBranch}.`,
      rawOutput: behindResult.stderr || behindResult.stdout,
    };
  }

  const behindCount = Number.parseInt(behindResult.stdout.trim(), 10);
  if (!Number.isFinite(behindCount) || behindCount <= maxBehindCommits) {
    const rebasePerformed = shouldPreservePriorRebaseResult(ctx, resolvedBaseBranch);
    ctx.set("rebasePerformed", rebasePerformed);
    ctx.set("forcePushWithLease", false);
    return {
      outcome: "success",
      outputs: {
        behindCount: Number.isFinite(behindCount) ? behindCount : 0,
        rebasePerformed,
        requiresForcePush: false,
      },
    };
  }

  await deps.onPhase("rebasing");

  const oldHead = await getCurrentHead(repoDir, logFile);
  const rebaseResult = await rebaseOntoBase(repoDir, logFile, resolvedBaseBranch);

  if (rebaseResult.kind !== "completed") {
    await abortRebase(repoDir, logFile);
    const conflictFiles = rebaseResult.kind === "conflict" ? rebaseResult.conflictFiles : [];
    const reason = rebaseResult.kind === "conflict"
      ? `Rebase onto origin/${resolvedBaseBranch} stopped on conflicts in ${String(conflictFiles.length)} file(s).`
      : `Rebase onto origin/${resolvedBaseBranch} could not proceed.`;
    await appendLog(logFile, `\n[sync_base_branch] ${reason} Aborted; agent fallback should resolve.\n`);
    ctx.set("rebaseConflictBaseBranch", resolvedBaseBranch);
    ctx.set("rebasePerformed", false);
    ctx.set("forcePushWithLease", false);
    return {
      outcome: "failure",
      error: reason,
      rawOutput: rebaseResult.rawOutput,
      outputs: {
        rebasePerformed: false,
        requiresForcePush: false,
        rebaseConflictBaseBranch: resolvedBaseBranch,
        rebaseConflictFiles: conflictFiles,
      },
    };
  }

  const newHead = await getCurrentHead(repoDir, logFile);
  const changedFilesResult = await runShellCapture(
    `git diff --name-only ${shellEscape(oldHead)}..${shellEscape(newHead)}`,
    { cwd: repoDir, logFile },
  );
  const changedFiles = changedFilesResult.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);

  await appendLog(logFile, `\n[sync_base_branch] rebased onto origin/${resolvedBaseBranch}; behind=${String(behindCount)}\n`);

  ctx.set("commitSha", newHead);
  ctx.set("changedFiles", changedFiles);
  ctx.set("rebasePerformed", true);
  ctx.set("forcePushWithLease", true);

  return {
    outcome: "success",
    outputs: {
      behindCount,
      rebasePerformed: true,
      requiresForcePush: true,
      forcePushWithLease: true,
      commitSha: newHead,
      changedFiles,
    },
  };
}
