import path from "node:path";
import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { runShellCapture, renderTemplate, appendLog } from "../shell.js";

/**
 * Lint fix node: run auto-fix lint command.
 */
export async function lintFixNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const config = deps.config;
  const logFile = deps.logFile;
  const repoDir = ctx.getRequired<string>("repoDir");
  const promptFile = ctx.getRequired<string>("promptFile");
  const run = deps.run;

  if (!config.lintFixCommand) {
    return { outcome: "skipped" };
  }

  await appendLog(logFile, "\n[pipeline] lint-fix: running auto-fix\n");

  const templateVars = {
    repo_dir: repoDir,
    run_id: run.id,
    repo_slug: run.repoSlug,
    prompt_file: promptFile,
    task_file: promptFile,
    parent_run_id: run.parentRunId ?? ""
  };

  const lintCmd = renderTemplate(config.lintFixCommand, templateVars);
  const result = await runShellCapture(lintCmd, { cwd: path.resolve("."), logFile });

  if (result.code !== 0) {
    await appendLog(logFile, `\n[pipeline] lint-fix exited with code ${String(result.code)} (continuing)\n`);
  }

  // Lint fix never fails the pipeline — it's best-effort
  return { outcome: "success" };
}
