import type { NodeConfig, NodeDeps, NodeResult } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { appendLog, runShellCapture, shellEscape } from "../shell.js";

function resolveBaseBranch(ctx: ContextBag, deps: NodeDeps): string | undefined {
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

interface SquashCommitMessage {
  subject: string;
  body: string;
}

async function buildReadyForMergeCommitMessage(
  repoDir: string,
  logFile: string,
  mergeBase: string,
  headSha: string,
): Promise<SquashCommitMessage> {
  const commitSubjectsResult = await runShellCapture(
    `git log --reverse --format=%s ${shellEscape(`${mergeBase}..${headSha}`)}`,
    { cwd: repoDir, logFile },
  );
  if (commitSubjectsResult.code !== 0) {
    throw new Error("Failed to list commit subjects before ready-for-merge squash");
  }

  const commitSubjects = commitSubjectsResult.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (commitSubjects.length === 0) {
    throw new Error("Ready-for-merge squash found no commit subjects to squash");
  }

  const [subject, ...remainingSubjects] = commitSubjects;

  return {
    subject,
    body: remainingSubjects.join("\n"),
  };
}

async function getCurrentHead(repoDir: string, logFile: string): Promise<string> {
  const result = await runShellCapture("git rev-parse HEAD", { cwd: repoDir, logFile });
  if (result.code !== 0) {
    throw new Error("Failed to read current HEAD before ready-for-merge squash");
  }
  return result.stdout.trim();
}

export async function squashReadyForMergeNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps,
): Promise<NodeResult> {
  const repoDir = ctx.getRequired<string>("repoDir");
  const baseBranch = resolveBaseBranch(ctx, deps);
  const logFile = deps.logFile;

  if (!baseBranch) {
    return {
      outcome: "failure",
      error: "Ready-for-merge squash requires a base branch.",
    };
  }

  ctx.set("resolvedBaseBranch", baseBranch);

  const fetchResult = await runShellCapture(`git fetch origin ${shellEscape(baseBranch)}`, {
    cwd: repoDir,
    logFile,
  });
  if (fetchResult.code !== 0) {
    return {
      outcome: "failure",
      error: `Failed to fetch origin/${baseBranch} before ready-for-merge squash.`,
      rawOutput: fetchResult.stderr || fetchResult.stdout,
    };
  }

  const commitCountResult = await runShellCapture(
    `git rev-list --count ${shellEscape(`origin/${baseBranch}`)}..HEAD`,
    { cwd: repoDir, logFile },
  );
  if (commitCountResult.code !== 0) {
    return {
      outcome: "failure",
      error: `Failed to count commits ahead of origin/${baseBranch}.`,
      rawOutput: commitCountResult.stderr || commitCountResult.stdout,
    };
  }

  const commitCountAhead = Number.parseInt(commitCountResult.stdout.trim(), 10);
  if (!Number.isFinite(commitCountAhead)) {
    return {
      outcome: "failure",
      error: `Invalid commit count returned for origin/${baseBranch}.`,
      rawOutput: commitCountResult.stdout,
    };
  }

  if (commitCountAhead <= 1) {
    ctx.set("squashPerformed", false);
    ctx.set("forcePushWithLease", false);
    return {
      outcome: "success",
      outputs: {
        commitCountAhead,
        squashPerformed: false,
        requiresForcePush: false,
        forcePushWithLease: false,
      },
    };
  }

  await deps.onPhase("rebasing");

  const oldHead = await getCurrentHead(repoDir, logFile);
  const mergeBaseResult = await runShellCapture(
    `git merge-base HEAD ${shellEscape(`origin/${baseBranch}`)}`,
    { cwd: repoDir, logFile },
  );
  if (mergeBaseResult.code !== 0) {
    return {
      outcome: "failure",
      error: `Failed to resolve merge-base against origin/${baseBranch}.`,
      rawOutput: mergeBaseResult.stderr || mergeBaseResult.stdout,
    };
  }

  const mergeBase = mergeBaseResult.stdout.trim();
  const resetResult = await runShellCapture(`git reset --soft ${shellEscape(mergeBase)}`, {
    cwd: repoDir,
    logFile,
  });
  if (resetResult.code !== 0) {
    return {
      outcome: "failure",
      error: "Failed to reset the PR branch for squash.",
      rawOutput: resetResult.stderr || resetResult.stdout,
    };
  }

  const commitMessage = await buildReadyForMergeCommitMessage(repoDir, logFile, mergeBase, oldHead);
  const commitCommand = commitMessage.body
    ? `git commit --no-verify -m ${shellEscape(commitMessage.subject)} -m ${shellEscape(commitMessage.body)}`
    : `git commit --no-verify -m ${shellEscape(commitMessage.subject)}`;
  const commitResult = await runShellCapture(commitCommand, {
    cwd: repoDir,
    logFile,
  });
  if (commitResult.code !== 0) {
    return {
      outcome: "failure",
      error: "Failed to create the squashed ready-for-merge commit.",
      rawOutput: commitResult.stderr || commitResult.stdout,
    };
  }

  const newHead = await getCurrentHead(repoDir, logFile);
  const changedFilesResult = await runShellCapture(
    `git diff --name-only ${shellEscape(mergeBase)}..${shellEscape(newHead)}`,
    { cwd: repoDir, logFile },
  );
  if (changedFilesResult.code !== 0) {
    return {
      outcome: "failure",
      error: "Failed to list files changed by the squashed ready-for-merge commit.",
      rawOutput: changedFilesResult.stderr || changedFilesResult.stdout,
    };
  }
  const changedFiles = changedFilesResult.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);

  await appendLog(
    logFile,
    `\n[squash_ready_for_merge] squashed ${String(commitCountAhead)} commits into one commit on ${deps.run.branchName}\n`,
  );

  ctx.set("commitSha", newHead);
  ctx.set("changedFiles", changedFiles);
  ctx.set("squashPerformed", true);
  ctx.set("forcePushWithLease", true);

  return {
    outcome: "success",
    outputs: {
      commitCountAhead,
      squashPerformed: true,
      requiresForcePush: true,
      forcePushWithLease: true,
      commitSha: newHead,
      previousCommitSha: oldHead,
      changedFiles,
    },
  };
}
