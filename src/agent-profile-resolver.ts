import type { AppConfig } from "./config.js";
import type { AgentProfile, AgentProfileInput } from "./agent-profile.js";
import { renderAgentProfileTemplate } from "./agent-profile.js";
import type { LLMCallerConfig } from "./llm/caller.js";
import {
  actionCatalogEntry,
  buildCandidateTargetKeys,
  runtimeTargetRequiresCapabilities,
  type AgentProfileCapability,
  type AgentProfilePolicyMode,
  type RuntimeAgentProfileTarget,
} from "./agent-profile-targets.js";

export interface AgentProfileSnapshot {
  id: string;
  name: string;
  description?: string;
  runtime: string;
  provider?: string;
  model?: string;
  tools?: string[];
  mode?: string;
  extensions?: string[];
  extraArgs?: string;
  isBuiltin?: boolean;
  isActive?: boolean;
  customCommandTemplate?: string;
  commandTemplate?: string;
  source?: "profile" | "env";
}

export interface AgentProfilePolicyMemberSnapshot {
  id?: string;
  policyId?: string;
  profileId: string;
  role?: string;
  ordinal: number;
  weight?: number;
  enabled: boolean;
}

export interface AgentProfilePolicySnapshot {
  id: string;
  scope: string;
  pipelineId?: string;
  intentKind?: string;
  nodeId?: string;
  action?: string;
  purpose?: string;
  targetKey: string;
  mode: AgentProfilePolicyMode | string;
  enabled: boolean;
  members: AgentProfilePolicyMemberSnapshot[];
}

export interface AgentProfileSelection {
  profile?: AgentProfileSnapshot;
  policy?: AgentProfilePolicySnapshot;
  member?: AgentProfilePolicyMemberSnapshot;
  targetKey?: string;
  candidateKeys: string[];
  source: "policy" | "default" | "env";
}

export interface AgentProfileLLMSelection extends AgentProfileSelection {
  model: string;
  llmConfig: LLMCallerConfig;
}

export function profileSupportsCapability(profile: AgentProfileSnapshot | AgentProfile, capability: AgentProfileCapability): boolean {
  const commandTemplate = "commandTemplate" in profile ? profile.commandTemplate : undefined;
  if (capability === "cli_agent") {
    if (profile.runtime === "custom") {
      return Boolean(profile.customCommandTemplate || commandTemplate);
    }
    return Boolean(profile.runtime && (profile.model || commandTemplate));
  }

  // The current direct LLM caller uses the OpenRouter Chat Completions API.
  // Other providers remain valid for CLI-agent profiles and browser Stagehand routing,
  // but direct LLM nodes should only select OpenRouter-backed profile models for now.
  if (capability === "llm_text" || capability === "llm_json" || capability === "llm_vision") {
    return profile.provider === "openrouter" && typeof profile.model === "string" && profile.model.trim() !== "";
  }

  return false;
}

export function resolveAgentProfileSelection(
  config: Pick<AppConfig, "agentProfilePolicies" | "agentProfileCatalog" | "activeAgentProfile">,
  target: RuntimeAgentProfileTarget | undefined,
  capability?: AgentProfileCapability,
): AgentProfileSelection {
  const targetAction = target?.nodeAction ? actionCatalogEntry(target.nodeAction) : undefined;
  const isRoutableTarget = !targetAction || targetAction.routable;
  const candidateKeys = target && isRoutableTarget ? buildCandidateTargetKeys(target) : [];
  const policies = config.agentProfilePolicies ?? [];
  const profiles = new Map((config.agentProfileCatalog ?? []).map((profile) => [profile.id, profile]));

  for (const targetKey of candidateKeys) {
    const policy = policies.find((entry) => entry.enabled && entry.targetKey === targetKey);
    if (!policy) continue;
    const members = policy.members
      .filter((member) => member.enabled)
      .sort((a, b) => a.ordinal - b.ordinal);
    for (const member of members) {
      const profile = profiles.get(member.profileId);
      if (!profile) continue;
      if (capability && !profileSupportsCapability(profile, capability)) continue;
      return { profile, policy, member, targetKey, candidateKeys, source: "policy" };
    }
  }

  const defaultProfile = config.activeAgentProfile;
  if (defaultProfile && (!capability || profileSupportsCapability(defaultProfile, capability))) {
    return { profile: defaultProfile, candidateKeys, source: defaultProfile.source === "env" ? "env" : "default" };
  }

  return { candidateKeys, source: "env" };
}

export function resolveAgentCommandTemplate(
  config: Pick<AppConfig, "agentCommandTemplate" | "activeAgentProfile" | "agentProfileCatalog" | "agentProfilePolicies">,
  target: RuntimeAgentProfileTarget | undefined,
): { template: string; selection: AgentProfileSelection } {
  const selection = resolveAgentProfileSelection(config, target, "cli_agent");
  if (selection.profile) {
    const rendered = selection.profile.commandTemplate ?? renderAgentProfileTemplate(selection.profile as AgentProfileInput);
    if (rendered.trim()) {
      return { template: rendered, selection };
    }
  }
  return { template: config.agentCommandTemplate, selection: { ...selection, source: "env" } };
}

export function resolveLLMProfileSelection(
  config: Pick<AppConfig, "openrouterApiKey" | "openrouterProviderPreferences" | "agentProfilePolicies" | "agentProfileCatalog" | "activeAgentProfile">,
  target: RuntimeAgentProfileTarget | undefined,
  capability: Extract<AgentProfileCapability, "llm_text" | "llm_json" | "llm_vision">,
  fallbackModel: string,
  defaultTimeoutMs: number,
): AgentProfileLLMSelection | undefined {
  if (!config.openrouterApiKey) {
    return undefined;
  }

  const selection = resolveAgentProfileSelection(config, target, capability);
  const selectedModel = selection.profile?.model
    ? normalizeOpenRouterDirectModel(selection.profile.model)
    : normalizeOpenRouterDirectModel(fallbackModel);

  if (!selectedModel) {
    return undefined;
  }

  return {
    ...selection,
    model: selectedModel,
    llmConfig: {
      apiKey: config.openrouterApiKey,
      defaultModel: selectedModel,
      defaultTimeoutMs,
      providerPreferences: config.openrouterProviderPreferences,
    },
  };
}

export function describeAgentProfileSelection(selection: AgentProfileSelection | undefined): string {
  if (!selection) return "source=env";
  const target = selection.targetKey ? ` target=${JSON.stringify(selection.targetKey)}` : "";
  if (selection.profile) {
    const model = selection.profile.model ? ` model=${JSON.stringify(selection.profile.model)}` : "";
    return `source=${selection.source}${target} profile=${JSON.stringify(selection.profile.name)}${model}`;
  }
  return `source=${selection.source}${target}`;
}

export function requiredCapabilityForRuntimeTarget(target: RuntimeAgentProfileTarget | undefined): AgentProfileCapability[] {
  return target ? runtimeTargetRequiresCapabilities(target) : [];
}

function normalizeOpenRouterDirectModel(model: string | undefined): string {
  const trimmed = (model ?? "").trim();
  if (trimmed.toLowerCase().startsWith("openrouter/")) {
    return trimmed.slice("openrouter/".length);
  }
  return trimmed;
}
