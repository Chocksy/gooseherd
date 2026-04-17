import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { runShellCapture } from "../shell.js";
import { commitCaptureAndPush } from "../git-ops.js";

/**
 * Commit node: assert changes, git add + commit, capture SHA + changed files.
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

  // Assert changes exist (tracked modifications + untracked new files)
  const statusResult = await runShellCapture("git status --porcelain", { cwd: repoDir, logFile });
  if (statusResult.code === 0 && statusResult.stdout.trim() === "") {
    return {
      outcome: "failure",
      error: "Agent produced no file changes. The model may not support tool calling via the current provider."
    };
  }

  // Commit and capture SHA + changed files (no push — push node handles that)
  const taskSummary = (isFollowUp ? run.feedbackNote ?? run.task : run.task).slice(0, 72);
  const commitMsg = `${config.appSlug}: ${taskSummary}`;

  const { commitSha, changedFiles, internalArtifacts } = await commitCaptureAndPush(repoDir, commitMsg, logFile);

  return {
    outcome: "success",
    outputs: { commitSha, changedFiles, internalArtifacts }
  };
}
