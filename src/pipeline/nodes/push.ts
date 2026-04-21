import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { runShell, shellEscape } from "../shell.js";
import { buildAuthenticatedGitUrl } from "../../github.js";

export function buildPushCommand(branchName: string, forcePushWithLease: boolean): string {
  const pushFlag = forcePushWithLease ? " --force-with-lease" : "";
  return `git push origin ${shellEscape(branchName)}${pushFlag}`;
}

/**
 * Push node: git push to origin.
 * Refreshes git remote URL with a fresh token before pushing to handle
 * installation token expiry (GitHub App tokens expire after 1 hour).
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
  const forcePushWithLease = ctx.get<boolean>("forcePushWithLease") ?? false;

  if (config.dryRun) {
    return {
      outcome: "success",
      outputs: { dryRun: true }
    };
  }

  if (!deps.githubService) {
    return {
      outcome: "failure",
      error: "GitHub authentication required (set GITHUB_TOKEN or GitHub App credentials) when DRY_RUN=false."
    };
  }

  await deps.onPhase("pushing");

  // Refresh the remote URL with a fresh token to handle installation token expiry
  const freshToken = await deps.githubService.getToken();
  const freshUrl = buildAuthenticatedGitUrl(run.repoSlug, freshToken);
  await runShell(`git remote set-url origin ${shellEscape(freshUrl)}`, {
    cwd: repoDir,
    logFile
  });

  await runShell(buildPushCommand(run.branchName, isFollowUp || forcePushWithLease), {
    cwd: repoDir,
    logFile
  });

  return { outcome: "success" };
}
