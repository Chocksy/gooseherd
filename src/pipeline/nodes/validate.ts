import path from "node:path";
import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { runShellCapture, renderTemplate, appendLog } from "../shell.js";

/**
 * Validate node: run validation command, return structured result.
 *
 * The loop/retry logic is handled by the pipeline engine's on_failure handler,
 * not inside this node. This node just runs once and reports success/failure.
 */
export async function validateNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const config = deps.config;
  const logFile = deps.logFile;
  const repoDir = ctx.getRequired<string>("repoDir");
  const promptFile = ctx.getRequired<string>("promptFile");
  const run = deps.run;

  if (!config.validationCommand.trim()) {
    return { outcome: "skipped" };
  }

  await deps.onPhase("validating");

  const templateVars = {
    repo_dir: repoDir,
    run_id: run.id,
    repo_slug: run.repoSlug,
    prompt_file: promptFile,
    task_file: promptFile,
    parent_run_id: run.parentRunId ?? ""
  };

  const validationCmd = renderTemplate(config.validationCommand, templateVars);
  await appendLog(logFile, "\n[pipeline] validate: running validation\n");

  const result = await runShellCapture(validationCmd, { cwd: path.resolve("."), logFile });

  if (result.code === 0) {
    await appendLog(logFile, "\n[pipeline] validate: passed\n");
    return { outcome: "success" };
  }

  // Validation failed — return structured output for the engine's loop handler
  const rawOutput = (result.stderr || result.stdout);
  await appendLog(logFile, "\n[pipeline] validate: failed\n");

  return {
    outcome: "failure",
    error: `Validation failed with exit code ${String(result.code)}`,
    rawOutput
  };
}
