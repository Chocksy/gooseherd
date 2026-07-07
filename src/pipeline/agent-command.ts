import type { AppConfig } from "../config.js";
import type { RunRecord } from "../types.js";
import { renderTemplate, mapToContainerPath, buildMcpFlags, buildPiExtensionFlags } from "./shell.js";
import type { RuntimeAgentProfileTarget } from "../agent-profile-targets.js";
import { resolveAgentCommandTemplate, type AgentProfileSelection } from "../agent-profile-resolver.js";

export interface BuiltAgentCommand {
  command: string;
  selection: AgentProfileSelection;
}

/**
 * Build the shell command string for running a coding agent.
 *
 * Shared by implement, fix_validation, fix_ci, and fix_browser nodes —
 * all follow the same template selection + variable substitution pattern.
 */
export function buildAgentCommand(
  config: AppConfig,
  run: RunRecord,
  repoDir: string,
  promptFile: string,
  isFollowUp: boolean,
  target?: RuntimeAgentProfileTarget,
): string {
  return buildAgentCommandWithSelection(config, run, repoDir, promptFile, isFollowUp, target).command;
}

export function buildAgentCommandWithSelection(
  config: AppConfig,
  run: RunRecord,
  repoDir: string,
  promptFile: string,
  isFollowUp: boolean,
  target?: RuntimeAgentProfileTarget,
): BuiltAgentCommand {
  const resolved = resolveAgentCommandTemplate(config, target);
  const template = isFollowUp && config.agentFollowUpTemplate
    ? config.agentFollowUpTemplate
    : resolved.template;

  return {
    command: renderTemplate(template, {
      repo_dir: mapToContainerPath(repoDir),
      prompt_file: mapToContainerPath(promptFile),
      task_file: mapToContainerPath(promptFile),
      run_id: run.id,
      repo_slug: run.repoSlug,
      parent_run_id: run.parentRunId ?? ""
    }, {
      mcp_flags: buildMcpFlags(config.mcpExtensions),
      pi_extensions: buildPiExtensionFlags(config.piAgentExtensions)
    }),
    selection: resolved.selection,
  };
}
