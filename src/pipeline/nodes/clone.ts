import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { runShell, runShellCapture, shellEscape, appendLog } from "../shell.js";
import { buildAuthenticatedGitUrl } from "../../github.js";
import { loadRepoConfig, applyRepoConfig } from "../repo-config.js";

/**
 * Clone node: clone repo, checkout branch (or create new), set git config.
 */
export async function cloneNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const run = deps.run;
  const config = deps.config;
  const logFile = deps.logFile;

  const runDir = path.resolve(deps.workRoot, run.id);
  const repoDir = path.join(runDir, "repo");
  const promptFile = path.join(runDir, "task.md");

  // Reset run workspace
  await rm(runDir, { recursive: true, force: true });
  await mkdir(runDir, { recursive: true });
  const followUpNote = run.parentRunId ? ` (follow-up from ${run.parentRunId})` : "";
  await writeFile(logFile, `${config.appName} run ${run.id}${followUpNote}\n`, "utf8");

  // Store paths in context
  ctx.set("runDir", runDir);
  ctx.set("repoDir", repoDir);
  ctx.set("promptFile", promptFile);

  const repoUrl = config.githubToken
    ? buildAuthenticatedGitUrl(run.repoSlug, config.githubToken)
    : `https://github.com/${run.repoSlug}.git`;

  await deps.onPhase("cloning");

  // Shallow clone option from node config
  const depth = (_nodeConfig.config?.["depth"] as number) ?? 0;
  const depthFlag = depth > 0 ? ` --depth ${String(depth)}` : "";
  await runShell(`git clone${depthFlag} ${shellEscape(repoUrl)} ${shellEscape(repoDir)}`, { logFile });

  const isFollowUp = !!run.parentRunId && !!run.parentBranchName;
  ctx.set("isFollowUp", isFollowUp);

  let resolvedBaseBranch = run.baseBranch;

  if (isFollowUp && run.parentBranchName) {
    // Follow-up: checkout the existing parent branch
    await appendLog(logFile, `\n[info] follow-up run: checking out existing branch '${run.parentBranchName}'\n`);
    const fetchResult = await runShellCapture(
      `git fetch origin ${shellEscape(run.parentBranchName)}`,
      { cwd: repoDir, logFile }
    );
    if (fetchResult.code !== 0) {
      return { outcome: "failure", error: `Failed to fetch parent branch '${run.parentBranchName}' from origin.` };
    }
    const checkoutResult = await runShellCapture(
      `git checkout ${shellEscape(run.parentBranchName)}`,
      { cwd: repoDir, logFile }
    );
    if (checkoutResult.code !== 0) {
      return { outcome: "failure", error: `Failed to checkout parent branch '${run.parentBranchName}'.` };
    }
  } else {
    // Fresh run: checkout base branch, then create new branch
    let checkoutResult = await runShellCapture(
      `git checkout ${shellEscape(resolvedBaseBranch)}`,
      { cwd: repoDir, logFile }
    );
    if (checkoutResult.code !== 0) {
      await appendLog(logFile, `\n[info] requested base branch '${resolvedBaseBranch}' not found. trying origin default branch fallback\n`);
      const remoteHead = await runShellCapture(
        "git symbolic-ref --quiet --short refs/remotes/origin/HEAD | sed 's#^origin/##'",
        { cwd: repoDir, logFile }
      );
      const detected = remoteHead.stdout.trim();
      if (!detected) {
        return { outcome: "failure", error: `Base branch '${resolvedBaseBranch}' not found and could not detect origin default branch.` };
      }
      resolvedBaseBranch = detected;
      checkoutResult = await runShellCapture(
        `git checkout ${shellEscape(resolvedBaseBranch)}`,
        { cwd: repoDir, logFile }
      );
      if (checkoutResult.code !== 0) {
        return { outcome: "failure", error: `Failed to checkout base branch '${run.baseBranch}' and fallback '${resolvedBaseBranch}'.` };
      }
    }
    await runShell(`git checkout -b ${shellEscape(run.branchName)}`, { cwd: repoDir, logFile });
  }

  // Git config
  await runShell(`git config user.name ${shellEscape(config.gitAuthorName)}`, { cwd: repoDir, logFile });
  await runShell(`git config user.email ${shellEscape(config.gitAuthorEmail)}`, { cwd: repoDir, logFile });

  ctx.set("resolvedBaseBranch", resolvedBaseBranch);

  // Load per-repo .gooseherd.yml config (from base branch for security)
  const repoConfig = await loadRepoConfig(repoDir, resolvedBaseBranch);
  if (repoConfig) {
    applyRepoConfig(repoConfig, ctx);
    await appendLog(logFile, `\n[info] loaded .gooseherd.yml from ${resolvedBaseBranch}\n`);
  }

  return {
    outcome: "success",
    outputs: { repoDir, runDir, promptFile, resolvedBaseBranch, isFollowUp }
  };
}
