import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { runShell, runShellCapture, shellEscape, renderTemplate, appendLog, buildMcpFlags, mapToContainerPath } from "../shell.js";
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
  const template = isFollowUp && config.agentFollowUpTemplate
    ? config.agentFollowUpTemplate
    : config.agentCommandTemplate;

  const agentCommand = renderTemplate(template, {
    repo_dir: mapToContainerPath(repoDir),
    prompt_file: mapToContainerPath(fixPromptFile),
    task_file: mapToContainerPath(fixPromptFile),
    run_id: run.id,
    repo_slug: run.repoSlug,
    parent_run_id: run.parentRunId ?? ""
  });

  let cmd = agentCommand;
  const mcpFlags = buildMcpFlags(config.mcpExtensions);
  if (mcpFlags) {
    cmd = `${cmd} ${mcpFlags}`;
  }

  await runShell(cmd, {
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

  // Commit the fix
  await runShell("git add -A", { cwd: repoDir, logFile });

  const commitMsg = `${config.appSlug}: fix CI (attempt ${String(attempt)})`;
  await runShell(`git commit -m ${shellEscape(commitMsg)}`, { cwd: repoDir, logFile });

  // Capture new commit SHA
  const shaResult = await runShellCapture("git rev-parse HEAD", { cwd: repoDir, logFile });
  const newSha = shaResult.stdout.trim().split("\n").pop()?.trim() ?? "";

  // Push the fix
  await runShell(`git push origin ${shellEscape(run.branchName)}`, {
    cwd: repoDir,
    logFile
  });

  // Update commitSha so the next wait_ci iteration polls the new commit
  ctx.set("commitSha", newSha);

  // Update changed files
  const filesResult = await runShellCapture("git show --name-only --pretty='' HEAD", { cwd: repoDir, logFile });
  if (filesResult.code === 0) {
    const newChangedFiles = filesResult.stdout
      .split("\n")
      .map(f => f.trim())
      .filter(f => f.length > 0 && !f.startsWith("---"));
    ctx.set("changedFiles", newChangedFiles);
  }

  await appendLog(logFile, `\n[ci:fix] pushed fix commit ${newSha.slice(0, 8)}\n`);

  return {
    outcome: "success",
    outputs: { commitSha: newSha }
  };
}
