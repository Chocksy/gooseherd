import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { runShell, appendLog } from "../shell.js";
import { buildAgentCommandWithSelection } from "../agent-command.js";
import { describeAgentProfileSelection } from "../../agent-profile-resolver.js";
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
  const { command: agentCommand, selection: agentProfileSelection } = buildAgentCommandWithSelection(
    config,
    run,
    repoDir,
    fixPromptFile,
    isFollowUp,
    deps.agentProfileTarget,
  );
  await appendLog(logFile, "[agent-profile] " + describeAgentProfileSelection(agentProfileSelection) + "\n");

  await runShell(agentCommand, {
    cwd: path.resolve("."),
    logFile,
    timeoutMs: config.agentTimeoutSeconds * 1000
  });

  return { outcome: "success" };
}
