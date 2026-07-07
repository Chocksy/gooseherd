import type { AppConfig } from "../config.js";
import type { RunEnvelope, RunnerConfigPayload } from "./control-plane-types.js";
import { isRecord } from "../utils/type-guards.js";
import type { AgentProfilePolicySnapshot, AgentProfileSnapshot } from "../agent-profile-resolver.js";

type RunnerConfigSource = Pick<
  AppConfig,
  "agentCommandTemplate" | "agentFollowUpTemplate" | "activeAgentProfile" | "agentProfileCatalog" | "agentProfilePolicies"
>;

export function buildRunnerConfigPayload(config: RunnerConfigSource): RunnerConfigPayload {
  return {
    agentCommandTemplate: config.agentCommandTemplate,
    ...(config.agentFollowUpTemplate ? { agentFollowUpTemplate: config.agentFollowUpTemplate } : {}),
    ...(config.activeAgentProfile ? { activeAgentProfile: { ...config.activeAgentProfile } } : {}),
    ...(Array.isArray(config.agentProfileCatalog) ? { agentProfileCatalog: config.agentProfileCatalog.map((profile) => ({ ...profile })) } : {}),
    ...(Array.isArray(config.agentProfilePolicies) ? { agentProfilePolicies: config.agentProfilePolicies.map((policy) => ({ ...policy, members: policy.members.map((member) => ({ ...member })) })) } : {}),
  };
}

export function readRunnerConfigPayload(payload: RunEnvelope): RunnerConfigPayload | null {
  const raw = payload.payloadJson.runnerConfig;
  if (!isRecord(raw)) {
    return null;
  }

  const agentCommandTemplate = typeof raw.agentCommandTemplate === "string" && raw.agentCommandTemplate.trim() !== ""
    ? raw.agentCommandTemplate
    : undefined;
  const agentFollowUpTemplate = typeof raw.agentFollowUpTemplate === "string" && raw.agentFollowUpTemplate.trim() !== ""
    ? raw.agentFollowUpTemplate
    : undefined;

  let activeAgentProfile: RunnerConfigPayload["activeAgentProfile"];
  if (isRecord(raw.activeAgentProfile)) {
    const profile = raw.activeAgentProfile;
    if (
      typeof profile.id === "string" &&
      typeof profile.name === "string" &&
      typeof profile.runtime === "string" &&
      typeof profile.commandTemplate === "string" &&
      (profile.source === "profile" || profile.source === "env")
    ) {
      activeAgentProfile = {
        id: profile.id,
        name: profile.name,
        runtime: profile.runtime,
        ...(typeof profile.provider === "string" && profile.provider.trim() !== "" ? { provider: profile.provider } : {}),
        ...(typeof profile.model === "string" && profile.model.trim() !== "" ? { model: profile.model } : {}),
        commandTemplate: profile.commandTemplate,
        source: profile.source,
      };
    }
  }

  const agentProfileCatalog = Array.isArray(raw.agentProfileCatalog)
    ? raw.agentProfileCatalog.map(readAgentProfileSnapshot).filter((profile): profile is AgentProfileSnapshot => Boolean(profile))
    : undefined;
  const agentProfilePolicies = Array.isArray(raw.agentProfilePolicies)
    ? raw.agentProfilePolicies.map(readAgentProfilePolicySnapshot).filter((policy): policy is AgentProfilePolicySnapshot => Boolean(policy))
    : undefined;

  const hasAgentProfileCatalog = "agentProfileCatalog" in raw && Array.isArray(raw.agentProfileCatalog);
  const hasAgentProfilePolicies = "agentProfilePolicies" in raw && Array.isArray(raw.agentProfilePolicies);

  if (!agentCommandTemplate && !agentFollowUpTemplate && !activeAgentProfile && !hasAgentProfileCatalog && !hasAgentProfilePolicies) {
    return null;
  }

  return {
    ...(agentCommandTemplate ? { agentCommandTemplate } : {}),
    ...(agentFollowUpTemplate ? { agentFollowUpTemplate } : {}),
    ...(activeAgentProfile ? { activeAgentProfile } : {}),
    ...(hasAgentProfileCatalog ? { agentProfileCatalog: agentProfileCatalog ?? [] } : {}),
    ...(hasAgentProfilePolicies ? { agentProfilePolicies: agentProfilePolicies ?? [] } : {}),
  };
}

export function applyRunnerConfigPayload(config: AppConfig, payload: RunEnvelope): void {
  const runnerConfig = readRunnerConfigPayload(payload);
  if (!runnerConfig) {
    return;
  }

  if (runnerConfig.agentCommandTemplate) {
    config.agentCommandTemplate = runnerConfig.agentCommandTemplate;
  }
  if (runnerConfig.agentFollowUpTemplate) {
    config.agentFollowUpTemplate = runnerConfig.agentFollowUpTemplate;
  }
  if (runnerConfig.activeAgentProfile) {
    config.activeAgentProfile = { ...runnerConfig.activeAgentProfile };
  }
  if ("agentProfileCatalog" in runnerConfig) {
    config.agentProfileCatalog = (runnerConfig.agentProfileCatalog ?? []).map((profile) => ({ ...profile }));
  }
  if ("agentProfilePolicies" in runnerConfig) {
    config.agentProfilePolicies = (runnerConfig.agentProfilePolicies ?? []).map((policy) => ({
      ...policy,
      members: policy.members.map((member) => ({ ...member })),
    }));
  }
}

function readAgentProfileSnapshot(raw: unknown): AgentProfileSnapshot | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.id !== "string" || typeof raw.name !== "string" || typeof raw.runtime !== "string") {
    return undefined;
  }
  return {
    id: raw.id,
    name: raw.name,
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    runtime: raw.runtime,
    ...(typeof raw.provider === "string" ? { provider: raw.provider } : {}),
    ...(typeof raw.model === "string" ? { model: raw.model } : {}),
    ...(Array.isArray(raw.tools) ? { tools: raw.tools.filter((value): value is string => typeof value === "string") } : {}),
    ...(typeof raw.mode === "string" ? { mode: raw.mode } : {}),
    ...(Array.isArray(raw.extensions) ? { extensions: raw.extensions.filter((value): value is string => typeof value === "string") } : {}),
    ...(typeof raw.extraArgs === "string" ? { extraArgs: raw.extraArgs } : {}),
    ...(typeof raw.isBuiltin === "boolean" ? { isBuiltin: raw.isBuiltin } : {}),
    ...(typeof raw.isActive === "boolean" ? { isActive: raw.isActive } : {}),
    ...(typeof raw.customCommandTemplate === "string" ? { customCommandTemplate: raw.customCommandTemplate } : {}),
    ...(typeof raw.commandTemplate === "string" ? { commandTemplate: raw.commandTemplate } : {}),
    ...(raw.source === "profile" || raw.source === "env" ? { source: raw.source } : {}),
  };
}

function readAgentProfilePolicySnapshot(raw: unknown): AgentProfilePolicySnapshot | undefined {
  if (!isRecord(raw)) return undefined;
  if (
    typeof raw.id !== "string" ||
    typeof raw.scope !== "string" ||
    typeof raw.targetKey !== "string" ||
    typeof raw.mode !== "string" ||
    typeof raw.enabled !== "boolean" ||
    !Array.isArray(raw.members)
  ) {
    return undefined;
  }
  return {
    id: raw.id,
    scope: raw.scope,
    ...(typeof raw.pipelineId === "string" ? { pipelineId: raw.pipelineId } : {}),
    ...(typeof raw.intentKind === "string" ? { intentKind: raw.intentKind } : {}),
    ...(typeof raw.nodeId === "string" ? { nodeId: raw.nodeId } : {}),
    ...(typeof raw.action === "string" ? { action: raw.action } : {}),
    ...(typeof raw.purpose === "string" ? { purpose: raw.purpose } : {}),
    targetKey: raw.targetKey,
    mode: raw.mode,
    enabled: raw.enabled,
    members: raw.members.map(readAgentProfilePolicyMemberSnapshot).filter((member): member is NonNullable<ReturnType<typeof readAgentProfilePolicyMemberSnapshot>> => Boolean(member)),
  };
}

function readAgentProfilePolicyMemberSnapshot(raw: unknown) {
  if (!isRecord(raw) || typeof raw.profileId !== "string") return undefined;
  return {
    ...(typeof raw.id === "string" ? { id: raw.id } : {}),
    ...(typeof raw.policyId === "string" ? { policyId: raw.policyId } : {}),
    profileId: raw.profileId,
    ...(typeof raw.role === "string" ? { role: raw.role } : {}),
    ordinal: typeof raw.ordinal === "number" ? raw.ordinal : 0,
    ...(typeof raw.weight === "number" ? { weight: raw.weight } : {}),
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
  };
}
