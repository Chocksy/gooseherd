import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { runShell, shellEscape } from "../shell.js";

/**
 * Push node: git push to origin.
 * Equivalent to executor.ts lines 450-460.
 */
export async function pushNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const config = deps.config;
  const logFile = deps.logFile;
  const repoDir = ctx.getRequired<string>("repoDir");
  const run = deps.run;
  const isFollowUp = ctx.get<boolean>("isFollowUp") ?? false;

  if (config.dryRun) {
    return {
      outcome: "success",
      outputs: { dryRun: true }
    };
  }

  if (!config.githubToken) {
    return {
      outcome: "failure",
      error: "GITHUB_TOKEN is required when DRY_RUN=false."
    };
  }

  await deps.onPhase("pushing");

  // Follow-ups use --force-with-lease since we're pushing to an existing branch
  const pushFlag = isFollowUp ? " --force-with-lease" : "";
  await runShell(`git push origin ${shellEscape(run.branchName)}${pushFlag}`, {
    cwd: repoDir,
    logFile
  });

  return { outcome: "success" };
}
