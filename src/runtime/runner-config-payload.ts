import type { AppConfig } from "../config.js";
import type { RunEnvelope, RunnerConfigPayload } from "./control-plane-types.js";
import { isRecord } from "../utils/type-guards.js";

type RunnerConfigSource = Pick<AppConfig, "agentCommandTemplate" | "agentFollowUpTemplate" | "activeAgentProfile">;

export function buildRunnerConfigPayload(config: RunnerConfigSource): RunnerConfigPayload {
  return {
    agentCommandTemplate: config.agentCommandTemplate,
    ...(config.agentFollowUpTemplate ? { agentFollowUpTemplate: config.agentFollowUpTemplate } : {}),
    ...(config.activeAgentProfile ? { activeAgentProfile: { ...config.activeAgentProfile } } : {}),
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

  if (!agentCommandTemplate && !agentFollowUpTemplate && !activeAgentProfile) {
    return null;
  }

  return {
    ...(agentCommandTemplate ? { agentCommandTemplate } : {}),
    ...(agentFollowUpTemplate ? { agentFollowUpTemplate } : {}),
    ...(activeAgentProfile ? { activeAgentProfile } : {}),
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
}
