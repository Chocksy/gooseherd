import type { AppConfig } from "../config.js";
import { formatSandboxRuntimeLabel } from "../runtime/runtime-mode.js";
import type { DashboardCapabilities } from "./capabilities.js";

export interface DashboardSettingsPayload {
  appName: string;
  pipelineFile: string;
  slackConnected: boolean;
  githubAuthMode: "app" | "pat" | "none";
  capabilities: DashboardCapabilities;
  runtime: {
    sandbox: {
      mode: AppConfig["sandboxRuntime"];
      label: string;
      enabled: boolean;
    };
  };
  models: {
    default: string;
    planTask: string;
    orchestrator: string;
    browserVerify: string;
  };
  agentCommandTemplate: string;
  activeAgentProfile?: AppConfig["activeAgentProfile"];
  agentProfiles: Record<string, unknown>[];
  permissions: {
    manageUsers: boolean;
  };
  sandboxRuntime: AppConfig["sandboxRuntime"];
  sandboxRuntimeLabel: string;
  sandboxStatus: {
    enabled: boolean;
  };
}

export function buildDashboardSettingsPayload(
  config: AppConfig,
  capabilities: DashboardCapabilities,
  githubAuthMode: "app" | "pat" | "none",
  agentProfiles: Record<string, unknown>[],
): DashboardSettingsPayload {
  const sandboxRuntimeLabel = formatSandboxRuntimeLabel(config.sandboxRuntime);
  const sandboxStatus = { enabled: config.sandboxEnabled };

  return {
    appName: config.appName,
    pipelineFile: config.pipelineFile,
    slackConnected: Boolean(config.slackBotToken),
    githubAuthMode,
    capabilities,
    runtime: {
      sandbox: {
        mode: config.sandboxRuntime,
        label: sandboxRuntimeLabel,
        enabled: config.sandboxEnabled,
      },
    },
    models: {
      default: config.defaultLlmModel,
      planTask: config.planTaskModel,
      orchestrator: config.orchestratorModel,
      browserVerify: config.browserVerifyModel,
    },
    agentCommandTemplate: config.agentCommandTemplate,
    activeAgentProfile: config.activeAgentProfile,
    agentProfiles,
    permissions: {
      manageUsers: capabilities.manageUsers,
    },
    sandboxRuntime: config.sandboxRuntime,
    sandboxRuntimeLabel,
    sandboxStatus,
  };
}
