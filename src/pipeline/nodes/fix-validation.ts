import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { runShell, shellEscape, renderTemplate, appendLog } from "../shell.js";
import { parseErrors } from "../error-parser.js";

/**
 * Fix validation node: re-run agent with structured error context.
 * This is the "agent_node" called by the engine's loop handler when validate fails.
 */
export async function fixValidationNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const config = deps.config;
  const logFile = deps.logFile;
  const repoDir = ctx.getRequired<string>("repoDir");
  const run = deps.run;
  const isFollowUp = ctx.get<boolean>("isFollowUp") ?? false;

  // Get the raw error output from the failed validation
  const rawError = ctx.get<string>("lastFailureRawOutput") ?? "";
  const attempt = ctx.get<number>("loopAttempt") ?? 1;

  await deps.onPhase("agent");
  await appendLog(logFile, `\n[pipeline] fix-validation: re-running agent (attempt ${String(attempt)})\n`);

  // Build structured error context
  const structuredErrors = parseErrors(rawError);

  const runDir = ctx.getRequired<string>("runDir");
  const fixPromptFile = path.join(runDir, `fix-round-${String(attempt)}.md`);
  const fixPrompt = [
    `Validation failed (attempt ${String(attempt)}).`,
    "",
    "Fix the following errors. Only change what is necessary — do not refactor unrelated code.",
    "",
    structuredErrors
  ].join("\n");
  await writeFile(fixPromptFile, fixPrompt, "utf8");

  // Re-run agent with fix prompt
  const template = isFollowUp && config.agentFollowUpTemplate
    ? config.agentFollowUpTemplate
    : config.agentCommandTemplate;

  const agentCommand = renderTemplate(template, {
    repo_dir: repoDir,
    prompt_file: fixPromptFile,
    task_file: fixPromptFile,
    run_id: run.id,
    repo_slug: run.repoSlug,
    parent_run_id: run.parentRunId ?? ""
  });

  let cmd = agentCommand;
  if (config.cemsMcpCommand) {
    cmd = `${cmd} --with-extension ${shellEscape(config.cemsMcpCommand)}`;
  }

  await runShell(cmd, {
    cwd: path.resolve("."),
    logFile,
    timeoutMs: config.agentTimeoutSeconds * 1000
  });

  return { outcome: "success" };
}
