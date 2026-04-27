import type { SandboxRuntime } from "./runtime/runtime-mode.js";
import { loadCoreConfig } from "./config/core.js";
import { loadDashboardConfig } from "./config/dashboard.js";
import { loadFeatureConfig, loadFeatureFlags } from "./config/features.js";
import { loadIntegrationConfig } from "./config/integrations.js";
import { loadRuntimeConfig } from "./config/runtime.js";
import { envSchema } from "./config/shared.js";
export { parseTeamChannelMap, resolveTeamFromChannel } from "./config/dashboard.js";

export type AutoReviewDebugLogMode = "off" | "failures" | "always";

export interface AppFeatures {
  observer: boolean;
  workItems: boolean;
  browserVerify: boolean;
  ciWait: boolean;
  supervisor: boolean;
  sessions: boolean;
  eval: boolean;
  autonomousScheduler: boolean;
}


export interface AppConfig {
  appName: string;
  appSlug: string;

  slackBotToken?: string;
  slackAppToken?: string;
  slackSigningSecret?: string;
  slackCommandName: string;
  slackAllowedChannels: string[];
  slackClientId?: string;
  slackClientSecret?: string;
  slackAuthRedirectUri?: string;

  githubToken?: string;
  githubAppId?: number;
  githubAppPrivateKey?: string;
  githubAppInstallationId?: number;
  githubDefaultOwner?: string;
  repoAllowlist: string[];
  defaultTeamName: string;
  defaultTeamSlackChannelId?: string;

  /** Canonical Jira read-access config for future discovery/work-items integrations. */
  jiraBaseUrl?: string;
  jiraCloudId?: string;
  jiraUser?: string;
  jiraApiToken?: string;
  jiraRequestTimeoutMs: number;

  runnerConcurrency: number;
  workRoot: string;
  dataDir: string;
  dryRun: boolean;

  branchPrefix: string;
  defaultBaseBranch: string;
  gitAuthorName: string;
  gitAuthorEmail: string;

  agentCommandTemplate: string;
  baseAgentCommandTemplate?: string;
  agentFollowUpTemplate?: string;
  validationCommand: string;
  lintFixCommand: string;
  localTestCommand: string;
  autoReviewDebugLogMode?: AutoReviewDebugLogMode;
  maxValidationRounds: number;
  agentTimeoutSeconds: number;
  slackProgressHeartbeatSeconds: number;
  dashboardEnabled: boolean;
  dashboardHost: string;
  dashboardPort: number;
  dashboardPublicUrl?: string;

  maxTaskChars: number;

  workspaceCleanupEnabled: boolean;
  workspaceMaxAgeHours: number;
  workspaceCleanupIntervalMinutes: number;

  cemsApiUrl?: string;
  cemsApiKey?: string;
  cemsEnabled: boolean;
  cemsTeamId?: string;
  mcpExtensions: string[];
  piAgentExtensions: string[];
  /** OpenRouter provider routing preferences (passed as `provider` in request body). */
  openrouterProviderPreferences?: Record<string, unknown>;

  pipelineFile: string;

  features: AppFeatures;

  observerEnabled: boolean;
  observerAlertChannelId: string;
  observerMaxRunsPerDay: number;
  observerMaxRunsPerRepoPerDay: number;
  observerCooldownMinutes: number;
  observerRulesFile: string;
  /** Sentry project → repo mapping: "proj:owner/repo,proj2:owner/repo2" */
  observerRepoMap: Map<string, string>;
  /** Slack channels to watch for alert bot messages */
  observerSlackWatchedChannels: string[];
  /** Optional: only process messages from these bot IDs */
  observerSlackBotAllowlist: string[];

  sentryAuthToken?: string;
  sentryOrgSlug?: string;
  observerSentryPollIntervalSeconds: number;

  observerGithubWebhookSecret?: string;
  observerSentryWebhookSecret?: string;
  observerWebhookPort: number;
  /** Per-source webhook secrets for custom adapters: { source: secret } */
  observerWebhookSecrets: Record<string, string>;
  observerGithubPollIntervalSeconds: number;
  /** Repos to watch for failed GitHub Actions: "owner/repo,owner2/repo2" */
  observerGithubWatchedRepos: string[];

  openrouterApiKey?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  /** Shared default model for all LLM features (plan_task, scope_judge, smart_triage, browser_verify). Individual overrides take precedence. */
  defaultLlmModel: string;
  planTaskModel: string;
  scopeJudgeEnabled: boolean;
  scopeJudgeModel: string;
  scopeJudgeMinPassScore: number;

  orchestratorModel: string;
  orchestratorTimeoutMs: number;
  orchestratorWallClockTimeoutMs: number;
  /** Optional cumulative input-token budget for the orchestrator's tool-use loop. Undefined = no token cap (rely on wall-clock timeout only). */
  orchestratorMaxInputTokens?: number;

  autonomousSchedulerEnabled: boolean;
  autonomousSchedulerMaxDeferred: number;
  autonomousSchedulerIntervalMs: number;

  observerSmartTriageEnabled: boolean;
  observerSmartTriageModel: string;
  observerSmartTriageTimeoutMs: number;

  browserVerifyEnabled: boolean;
  reviewAppUrlPattern?: string;
  screenshotEnabled: boolean;
  browserVerifyModel: string;
  browserVerifyExecutionModel?: string;
  browserVerifyMaxSteps: number;
  browserVerifyExecTimeoutMs: number;
  /** Override email for browser verify auth. When set, used as the primary test credential. */
  browserVerifyTestEmail?: string;
  /** Override password for browser verify auth. */
  browserVerifyTestPassword?: string;
  /** Comma-separated email domains for signup rotation (e.g. "gmail.com,outlook.com"). */
  browserVerifyEmailDomains: string[];

  ciWaitEnabled: boolean;
  ciPollIntervalSeconds: number;
  ciPatienceTimeoutSeconds: number;
  ciMaxWaitSeconds: number;
  ciCheckFilter: string[];
  ciMaxFixRounds: number;
  featureDeliveryResetEngineeringReviewOnNewCommits: boolean;
  featureDeliveryResetQaReviewOnNewCommits: boolean;
  featureDeliverySkipProductReview: boolean;
  workItemGithubAdoptionLabels: string[];
  autoReviewBranchSyncEnabled: boolean;
  autoReviewBranchSyncMaxBehindCommits: number;
  autoReviewBranchSyncIntervalMs: number;

  dashboardToken?: string;

  /** Team → channel IDs mapping. JSON format: {"team1":["C123","C456"]} */
  teamChannelMap: Map<string, string[]>;

  sandboxRuntime: SandboxRuntime;
  sandboxRuntimeExplicit: boolean;
  sandboxEnabled: boolean;
  sandboxImage: string;
  /** Host-side path that maps to workRoot. Required when sandboxEnabled=true for DooD volume mounts. */
  sandboxHostWorkPath: string;
  sandboxCpus: number;
  sandboxMemoryMb: number;

  supervisorEnabled: boolean;
  supervisorRunTimeoutSeconds: number;
  supervisorNodeStaleSeconds: number;
  supervisorWatchdogIntervalSeconds: number;
  supervisorMaxAutoRetries: number;
  supervisorRetryCooldownSeconds: number;
  supervisorMaxRetriesPerDay: number;

  databaseUrl: string;
  encryptionKey?: string;
  activeAgentProfile?: {
    id: string;
    name: string;
    runtime: string;
    provider?: string;
    model?: string;
    commandTemplate: string;
    source: "profile" | "env";
  };
}

export function resolveGitHubAuthMode(config: AppConfig): "app" | "pat" | "none" {
  if (config.githubAppId && config.githubAppPrivateKey && config.githubAppInstallationId) {
    return "app";
  }
  if (config.githubToken) {
    return "pat";
  }
  return "none";
}

export function loadConfig(): AppConfig {
  const parsed = envSchema.parse(process.env);
  const features = loadFeatureFlags(parsed);
  const appName = parsed.APP_NAME?.trim() || "Gooseherd";
  const appSlug = appName.toLowerCase().replace(/\s+/g, "-");
  const coreConfig = loadCoreConfig(parsed, { appName, appSlug });
  const integrationConfig = loadIntegrationConfig(parsed, { appSlug });
  const dashboardConfig = loadDashboardConfig(parsed);
  const featureConfig = loadFeatureConfig(parsed, features);
  const runtimeConfig = loadRuntimeConfig(parsed, features);

  return {
    ...coreConfig,
    ...integrationConfig,
    ...dashboardConfig,
    ...featureConfig,
    ...runtimeConfig,
  };
}
