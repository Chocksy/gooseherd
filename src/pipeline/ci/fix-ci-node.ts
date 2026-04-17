import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { runShell, runShellCapture, appendLog } from "../shell.js";
import { buildAgentCommand } from "../agent-command.js";
import { commitCaptureAndPush } from "../git-ops.js";
import { buildCIFixPrompt, type CIAnnotation } from "./ci-monitor.js";

/**
 * CI Fix node: "fat" agent node that fixes CI failures, commits, and pushes.
 *
 * Unlike fix_validation (which only runs the agent — the engine handles retry),
 * fix_ci must also commit+push so that CI can detect the new changes.
 * After pushing, it updates commitSha in context so wait_ci polls the new ref.
 *
 * Called by the pipeline engine's on_failure loop handler when wait_ci fails.
 */
export async function fixCiNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const config = deps.config;
  const logFile = deps.logFile;
  const repoDir = ctx.getRequired<string>("repoDir");
  const run = deps.run;
  const attempt = ctx.get<number>("loopAttempt") ?? 1;

  await deps.onPhase("ci_fixing");
  await appendLog(logFile, `\n[ci:fix] starting CI fix attempt ${String(attempt)}\n`);

  // Build fix prompt from CI failure context
  const annotations = ctx.get<CIAnnotation[]>("ciAnnotations") ?? [];
  const logTail = ctx.get<string>("ciLogTail") ?? "";
  const changedFiles = ctx.get<string[]>("changedFiles") ?? [];

  const fixPrompt = (annotations.length > 0 || logTail)
    ? buildCIFixPrompt(annotations, logTail, changedFiles)
    : "CI failed. Fix the issues and ensure tests pass.";

  // Write fix prompt to disk for the agent
  const runDir = ctx.getRequired<string>("runDir");
  const fixPromptFile = path.join(runDir, `ci-fix-round-${String(attempt)}.md`);
  await writeFile(fixPromptFile, fixPrompt, "utf8");

  // Run the coding agent with the fix prompt
  const isFollowUp = ctx.get<boolean>("isFollowUp") ?? false;
  const agentCommand = buildAgentCommand(config, run, repoDir, fixPromptFile, isFollowUp);

  await runShell(agentCommand, {
    cwd: path.resolve("."),
    logFile,
    timeoutMs: config.agentTimeoutSeconds * 1000
  });

  // Check if agent made any changes (including untracked files)
  const diffCheck = await runShellCapture("git status --porcelain", { cwd: repoDir, logFile });
  if (diffCheck.code === 0 && diffCheck.stdout.trim() === "") {
    await appendLog(logFile, "\n[ci:fix] agent made no changes\n");
    return { outcome: "success" };
  }

  // Commit, capture SHA + changed files, and push
  const commitMsg = `${config.appSlug}: fix CI (attempt ${String(attempt)})`;
  const { commitSha: newSha, changedFiles: newChangedFiles, internalArtifacts } = await commitCaptureAndPush(
    repoDir, commitMsg, logFile, run.branchName
  );

  await appendLog(logFile, `\n[ci:fix] pushed fix commit ${newSha.slice(0, 8)}\n`);

  return {
    outcome: "success",
    outputs: { commitSha: newSha, changedFiles: newChangedFiles, internalArtifacts }
  };
}
