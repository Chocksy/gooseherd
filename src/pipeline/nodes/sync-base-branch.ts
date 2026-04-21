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

async function resolveConflictFiles(repoDir: string, logFile: string, files: string[]): Promise<void> {
  if (files.length === 0) {
    throw new Error("Rebase stopped with conflicts, but no conflicted files were reported.");
  }

  for (const file of files) {
    const checkoutResult = await runShellCapture(
      `git checkout --theirs -- ${shellEscape(file)}`,
      { cwd: repoDir, logFile },
    );
    if (checkoutResult.code !== 0) {
      throw new Error(`Failed to prefer feature branch content for conflicted file: ${file}`);
    }

    const addResult = await runShellCapture(`git add -- ${shellEscape(file)}`, {
      cwd: repoDir,
      logFile,
    });
    if (addResult.code !== 0) {
      throw new Error(`Failed to stage conflicted file during auto-resolution: ${file}`);
    }
  }
}

async function resolveConflicts(repoDir: string, logFile: string): Promise<string[]> {
  const files = await listConflictedFiles(repoDir, logFile);
  await resolveConflictFiles(repoDir, logFile, files);
  return files;
}

async function advanceRebase(
  repoDir: string,
  logFile: string,
  command: string,
): Promise<{ completed: boolean; conflictFiles: string[] }> {
  const stepResult = await runShellCapture(command, { cwd: repoDir, logFile });
  if (stepResult.code === 0) {
    return { completed: true, conflictFiles: [] };
  }

  const conflictFiles = await listConflictedFiles(repoDir, logFile);
  if (conflictFiles.length > 0) {
    await resolveConflictFiles(repoDir, logFile, conflictFiles);
    return { completed: false, conflictFiles };
  }

  const skipResult = await runShellCapture("git rebase --skip", { cwd: repoDir, logFile });
  if (skipResult.code === 0) {
    return { completed: true, conflictFiles: [] };
  }

  const skippedConflictFiles = await listConflictedFiles(repoDir, logFile);
  if (skippedConflictFiles.length > 0) {
    await resolveConflictFiles(repoDir, logFile, skippedConflictFiles);
    return { completed: false, conflictFiles: skippedConflictFiles };
  }

  const output = [
    stepResult.stderr,
    stepResult.stdout,
    skipResult.stderr,
    skipResult.stdout,
  ]
    .filter(Boolean)
    .join("\n")
    .trim();

  throw new Error(
    output
      ? `Automatic rebase could not continue or skip the current commit.\n${output}`
      : "Automatic rebase could not continue or skip the current commit.",
  );
}

async function rebaseOntoBase(repoDir: string, logFile: string, baseBranch: string): Promise<string[]> {
  const rebasedFiles = new Set<string>();
  const rebaseTarget = shellEscape(`origin/${baseBranch}`);
  const initial = await advanceRebase(repoDir, logFile, `git rebase ${rebaseTarget}`);
  if (initial.completed) {
    return [];
  }

  initial.conflictFiles.forEach((file) => rebasedFiles.add(file));

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const continued = await advanceRebase(repoDir, logFile, "GIT_EDITOR=true git rebase --continue");
    continued.conflictFiles.forEach((file) => rebasedFiles.add(file));
    if (continued.completed) {
      return [...rebasedFiles];
    }
  }

  throw new Error("Automatic rebase conflict resolution exceeded 50 continuation attempts.");
}

export async function syncBaseBranchNode(
  nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps,
): Promise<NodeResult> {
  const repoDir = ctx.getRequired<string>("repoDir");
  const resolvedBaseBranch = ctx.get<string>("resolvedBaseBranch") ?? deps.run.baseBranch;
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
    ctx.set("rebasePerformed", false);
    ctx.set("forcePushWithLease", false);
    return {
      outcome: "success",
      outputs: {
        behindCount: Number.isFinite(behindCount) ? behindCount : 0,
        rebasePerformed: false,
        requiresForcePush: false,
      },
    };
  }

  await deps.onPhase("rebasing");

  const oldHead = await getCurrentHead(repoDir, logFile);
  const autoResolvedFiles = await rebaseOntoBase(repoDir, logFile, resolvedBaseBranch);
  const newHead = await getCurrentHead(repoDir, logFile);
  const changedFilesResult = await runShellCapture(
    `git diff --name-only ${shellEscape(oldHead)}..${shellEscape(newHead)}`,
    { cwd: repoDir, logFile },
  );
  const changedFiles = new Set(
    changedFilesResult.stdout
      .split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  autoResolvedFiles.forEach((file) => changedFiles.add(file));

  await appendLog(logFile, `\n[sync_base_branch] rebased onto origin/${resolvedBaseBranch}; behind=${String(behindCount)}\n`);

  ctx.set("commitSha", newHead);
  ctx.set("changedFiles", [...changedFiles]);
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
      changedFiles: [...changedFiles],
    },
  };
}
