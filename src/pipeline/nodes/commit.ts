import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { runShell, runShellCapture, shellEscape, appendLog } from "../shell.js";

/**
 * Commit node: assert changes, git add + commit, capture SHA + changed files.
 * Equivalent to executor.ts lines 402-439.
 */
export async function commitNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const run = deps.run;
  const config = deps.config;
  const logFile = deps.logFile;
  const repoDir = ctx.getRequired<string>("repoDir");
  const isFollowUp = ctx.get<boolean>("isFollowUp") ?? false;

  // Assert changes exist
  try {
    await runShell("git diff --quiet HEAD", { cwd: repoDir, logFile });
    // If this succeeds (exit 0), there are NO changes → error
    return {
      outcome: "failure",
      error: "Agent produced no file changes. Ensure AGENT_COMMAND_TEMPLATE writes modifications before commit."
    };
  } catch {
    // exit code != 0 means there ARE changes → good
  }

  // Stage all changes
  await runShell("git add -A", { cwd: repoDir, logFile });

  // Build commit message
  const taskSummary = (isFollowUp ? run.feedbackNote ?? run.task : run.task).slice(0, 72);
  const commitMsg = `${config.appSlug}: ${taskSummary}`;

  await runShell(`git commit -m ${shellEscape(commitMsg)}`, { cwd: repoDir, logFile });

  // Capture commit SHA
  const commitShaResult = await runShellCapture("git rev-parse HEAD", { cwd: repoDir, logFile });
  if (commitShaResult.code !== 0) {
    return { outcome: "failure", error: "Failed to determine commit SHA." };
  }
  // Use last line — some shells emit profile noise before the actual SHA
  const commitSha = commitShaResult.stdout.trim().split("\n").pop()?.trim() ?? "";

  // Capture changed files
  const changedFilesResult = await runShellCapture("git show --name-only --pretty='' HEAD", { cwd: repoDir, logFile });
  if (changedFilesResult.code !== 0) {
    return { outcome: "failure", error: "Failed to determine changed files." };
  }
  const changedFiles = changedFilesResult.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !entry.startsWith("---"));

  ctx.set("commitSha", commitSha);
  ctx.set("changedFiles", changedFiles);

  return {
    outcome: "success",
    outputs: { commitSha, changedFiles }
  };
}
