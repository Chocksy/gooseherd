import path from "node:path";
import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { runShell, shellEscape, renderTemplate } from "../shell.js";

/**
 * Implement node: run the coding agent with MCP extension.
 */
export async function implementNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const run = deps.run;
  const config = deps.config;
  const logFile = deps.logFile;
  const repoDir = ctx.getRequired<string>("repoDir");
  const promptFile = ctx.getRequired<string>("promptFile");
  const isFollowUp = ctx.get<boolean>("isFollowUp") ?? false;

  await deps.onPhase("agent");

  const template = isFollowUp && config.agentFollowUpTemplate
    ? config.agentFollowUpTemplate
    : config.agentCommandTemplate;

  const agentCommand = renderTemplate(template, {
    repo_dir: repoDir,
    prompt_file: promptFile,
    task_file: promptFile,
    run_id: run.id,
    repo_slug: run.repoSlug,
    parent_run_id: run.parentRunId ?? ""
  });

  // Append MCP extension if configured
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
