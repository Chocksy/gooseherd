import { z } from "zod";
import { resolveSandboxRuntime, type SandboxRuntime } from "./runtime/runtime-mode.js";

const envSchema = z.object({
  APP_NAME: z.string().optional(),

  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  SLACK_COMMAND_NAME: z.string().optional(),
  SLACK_ALLOWED_CHANNELS: z.string().optional(),

  GITHUB_TOKEN: z.string().optional(),
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_APP_INSTALLATION_ID: z.string().optional(),
  GITHUB_DEFAULT_OWNER: z.string().optional(),
  REPO_ALLOWLIST: z.string().optional(),

  RUNNER_CONCURRENCY: z.string().optional(),
  WORK_ROOT: z.string().optional(),
  DATA_DIR: z.string().optional(),
  DRY_RUN: z.string().optional(),

  BRANCH_PREFIX: z.string().optional(),
  DEFAULT_BASE_BRANCH: z.string().optional(),
  GIT_AUTHOR_NAME: z.string().optional(),
  GIT_AUTHOR_EMAIL: z.string().optional(),

  AGENT_COMMAND_TEMPLATE: z.string().optional(),
  AGENT_FOLLOW_UP_TEMPLATE: z.string().optional(),
  VALIDATION_COMMAND: z.string().optional(),
  LINT_FIX_COMMAND: z.string().optional(),
  LOCAL_TEST_COMMAND: z.string().optional(),
  MAX_VALIDATION_ROUNDS: z.string().optional(),
  AGENT_TIMEOUT_SECONDS: z.string().optional(),
  SLACK_PROGRESS_HEARTBEAT_SECONDS: z.string().optional(),
  DASHBOARD_ENABLED: z.string().optional(),
  DASHBOARD_HOST: z.string().optional(),
  DASHBOARD_PORT: z.string().optional(),
  DASHBOARD_PUBLIC_URL: z.string().optional(),

  MAX_TASK_CHARS: z.string().optional(),

  WORKSPACE_CLEANUP_ENABLED: z.string().optional(),
  WORKSPACE_MAX_AGE_HOURS: z.string().optional(),
  WORKSPACE_CLEANUP_INTERVAL_MINUTES: z.string().optional(),

  CEMS_API_URL: z.string().optional(),
  CEMS_API_KEY: z.string().optional(),
  CEMS_ENABLED: z.string().optional(),
  CEMS_TEAM_ID: z.string().optional(),
  MCP_EXTENSIONS: z.string().optional(),
  PI_AGENT_EXTENSIONS: z.string().optional(),

  // OpenRouter provider routing (JSON object, e.g. {"ignore":["DeepInfra"]})
  OPENROUTER_PROVIDER_PREFERENCES: z.string().optional(),

  PIPELINE_FILE: z.string().optional(),

  OBSERVER_ENABLED: z.string().optional(),
  OBSERVER_ALERT_CHANNEL_ID: z.string().optional(),
  OBSERVER_MAX_RUNS_PER_DAY: z.string().optional(),
  OBSERVER_MAX_RUNS_PER_REPO_PER_DAY: z.string().optional(),
  OBSERVER_COOLDOWN_MINUTES: z.string().optional(),
  OBSERVER_RULES_FILE: z.string().optional(),
  OBSERVER_REPO_MAP: z.string().optional(),
  OBSERVER_SLACK_WATCHED_CHANNELS: z.string().optional(),
  OBSERVER_SLACK_BOT_ALLOWLIST: z.string().optional(),

  SENTRY_AUTH_TOKEN: z.string().optional(),
  SENTRY_ORG_SLUG: z.string().optional(),
  OBSERVER_SENTRY_POLL_INTERVAL_SECONDS: z.string().optional(),

  OBSERVER_GITHUB_WEBHOOK_SECRET: z.string().optional(),
  OBSERVER_SENTRY_WEBHOOK_SECRET: z.string().optional(),
  OBSERVER_WEBHOOK_PORT: z.string().optional(),
  OBSERVER_WEBHOOK_SECRETS: z.string().optional(),
  OBSERVER_GITHUB_POLL_INTERVAL_SECONDS: z.string().optional(),
  OBSERVER_GITHUB_WATCHED_REPOS: z.string().optional(),

  OPENROUTER_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  DEFAULT_LLM_MODEL: z.string().optional(),
  PLAN_TASK_MODEL: z.string().optional(),
  SCOPE_JUDGE_ENABLED: z.string().optional(),
  SCOPE_JUDGE_MODEL: z.string().optional(),
  SCOPE_JUDGE_MIN_PASS_SCORE: z.string().optional(),

  ORCHESTRATOR_MODEL: z.string().optional(),
  ORCHESTRATOR_TIMEOUT_MS: z.string().optional(),
  ORCHESTRATOR_WALL_CLOCK_TIMEOUT_MS: z.string().optional(),

  AUTONOMOUS_SCHEDULER_ENABLED: z.string().optional(),
  AUTONOMOUS_SCHEDULER_MAX_DEFERRED: z.string().optional(),
  AUTONOMOUS_SCHEDULER_INTERVAL_MS: z.string().optional(),

  OBSERVER_SMART_TRIAGE_ENABLED: z.string().optional(),
  OBSERVER_SMART_TRIAGE_MODEL: z.string().optional(),
  OBSERVER_SMART_TRIAGE_TIMEOUT_MS: z.string().optional(),

  BROWSER_VERIFY_ENABLED: z.string().optional(),
  REVIEW_APP_URL_PATTERN: z.string().optional(),
  SCREENSHOT_ENABLED: z.string().optional(),
  BROWSER_VERIFY_MODEL: z.string().optional(),
  BROWSER_VERIFY_EXECUTION_MODEL: z.string().optional(),
  BROWSER_VERIFY_MAX_STEPS: z.string().optional(),
  BROWSER_VERIFY_EXEC_TIMEOUT_MS: z.string().optional(),
  BROWSER_VERIFY_TEST_EMAIL: z.string().optional(),
  BROWSER_VERIFY_TEST_PASSWORD: z.string().optional(),
  BROWSER_VERIFY_EMAIL_DOMAINS: z.string().optional(),

  CI_WAIT_ENABLED: z.string().optional(),
  CI_POLL_INTERVAL_SECONDS: z.string().optional(),
  CI_PATIENCE_TIMEOUT_SECONDS: z.string().optional(),
  CI_MAX_WAIT_SECONDS: z.string().optional(),
  CI_CHECK_FILTER: z.string().optional(),
  CI_MAX_FIX_ROUNDS: z.string().optional(),

  DASHBOARD_TOKEN: z.string().optional(),

  TEAM_CHANNEL_MAP: z.string().optional(),

  SANDBOX_RUNTIME: z.string().optional(),
  SANDBOX_ENABLED: z.string().optional(),
  SANDBOX_IMAGE: z.string().optional(),
  SANDBOX_HOST_WORK_PATH: z.string().optional(),
  SANDBOX_CPUS: z.string().optional(),
  SANDBOX_MEMORY_MB: z.string().optional(),

  SUPERVISOR_ENABLED: z.string().optional(),
  SUPERVISOR_RUN_TIMEOUT_SECONDS: z.string().optional(),
  SUPERVISOR_NODE_STALE_SECONDS: z.string().optional(),
  SUPERVISOR_WATCHDOG_INTERVAL_SECONDS: z.string().optional(),
  SUPERVISOR_MAX_AUTO_RETRIES: z.string().optional(),
  SUPERVISOR_RETRY_COOLDOWN_SECONDS: z.string().optional(),
  SUPERVISOR_MAX_RETRIES_PER_DAY: z.string().optional(),

  DATABASE_URL: z.string().optional(),
  ENCRYPTION_KEY: z.string().optional(),
});

function parseList(value?: string): string[] {
  if (!value || value.trim() === "") {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

export interface AppConfig {
  appName: string;
  appSlug: string;

  slackBotToken?: string;
  slackAppToken?: string;
  slackSigningSecret?: string;
  slackCommandName: string;
  slackAllowedChannels: string[];

  githubToken?: string;
  githubAppId?: number;
  githubAppPrivateKey?: string;
  githubAppInstallationId?: number;
  githubDefaultOwner?: string;
  repoAllowlist: string[];

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

function parseRepoMap(value?: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!value || value.trim() === "") {
    return map;
  }
  for (const entry of value.split(",")) {
    const trimmed = entry.trim();
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex > 0 && colonIndex < trimmed.length - 1) {
      map.set(trimmed.slice(0, colonIndex), trimmed.slice(colonIndex + 1));
    }
  }
  return map;
}

function parseWebhookSecrets(value?: string): Record<string, string> {
  const secrets: Record<string, string> = {};
  if (!value || value.trim() === "") return secrets;
  for (const entry of value.split(",")) {
    const colonIdx = entry.indexOf(":");
    if (colonIdx > 0 && colonIdx < entry.length - 1) {
      secrets[entry.slice(0, colonIdx).trim()] = entry.slice(colonIdx + 1).trim();
    }
  }
  return secrets;
}

export function parseTeamChannelMap(value?: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!value || value.trim() === "") return map;
  try {
    const parsed = JSON.parse(value) as Record<string, string[]>;
    for (const [team, channels] of Object.entries(parsed)) {
      if (Array.isArray(channels)) {
        map.set(team, channels.map((c) => String(c).trim()).filter(Boolean));
      }
    }
  } catch {
    // Ignore invalid JSON
  }
  return map;
}

export function resolveTeamFromChannel(
  channelId: string,
  teamChannelMap: Map<string, string[]>
): string | undefined {
  for (const [team, channels] of teamChannelMap) {
    if (channels.includes(channelId)) return team;
  }
  return undefined;
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

function parseProviderPreferences(value?: string): Record<string, unknown> | undefined {
  if (!value || value.trim() === "") return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Invalid JSON — ignore
  }
  return undefined;
}




export function loadConfig(): AppConfig {
  const parsed = envSchema.parse(process.env);
  const sandboxRuntime = resolveSandboxRuntime(parsed);
  const sandboxRuntimeExplicit = parsed.SANDBOX_RUNTIME !== undefined;

  const appName = parsed.APP_NAME?.trim() || "Gooseherd";
  const appSlug = appName.toLowerCase().replace(/\s+/g, "-");

  return {
    appName,
    appSlug,

    slackBotToken: parsed.SLACK_BOT_TOKEN?.trim() || undefined,
    slackAppToken: parsed.SLACK_APP_TOKEN?.trim() || undefined,
    slackSigningSecret: parsed.SLACK_SIGNING_SECRET?.trim() || undefined,
    slackCommandName: parsed.SLACK_COMMAND_NAME?.trim() || appSlug,
    slackAllowedChannels: parseList(parsed.SLACK_ALLOWED_CHANNELS),

    githubToken: parsed.GITHUB_TOKEN,
    githubAppId: parsed.GITHUB_APP_ID ? parseInteger(parsed.GITHUB_APP_ID, 0) || undefined : undefined,
    githubAppPrivateKey: parsed.GITHUB_APP_PRIVATE_KEY?.trim() || undefined,
    githubAppInstallationId: parsed.GITHUB_APP_INSTALLATION_ID
      ? parseInteger(parsed.GITHUB_APP_INSTALLATION_ID, 0) || undefined
      : undefined,
    githubDefaultOwner: parsed.GITHUB_DEFAULT_OWNER,
    repoAllowlist: parseList(parsed.REPO_ALLOWLIST),

    runnerConcurrency: parseInteger(parsed.RUNNER_CONCURRENCY, 1),
    workRoot: parsed.WORK_ROOT ?? ".work",
    dataDir: parsed.DATA_DIR ?? "data",
    dryRun: parseBoolean(parsed.DRY_RUN, false),

    branchPrefix: parsed.BRANCH_PREFIX ?? appSlug,
    defaultBaseBranch: parsed.DEFAULT_BASE_BRANCH ?? "main",
    gitAuthorName: parsed.GIT_AUTHOR_NAME ?? `${appName} Bot`,
    gitAuthorEmail: parsed.GIT_AUTHOR_EMAIL ?? `${appSlug}-bot@local`,

    agentCommandTemplate:
      parsed.AGENT_COMMAND_TEMPLATE ??
      "bash scripts/dummy-agent.sh {{repo_dir}} {{prompt_file}} {{run_id}}",
    baseAgentCommandTemplate:
      parsed.AGENT_COMMAND_TEMPLATE ??
      "bash scripts/dummy-agent.sh {{repo_dir}} {{prompt_file}} {{run_id}}",
    agentFollowUpTemplate: parsed.AGENT_FOLLOW_UP_TEMPLATE?.trim() || undefined,
    validationCommand: parsed.VALIDATION_COMMAND ?? "",
    lintFixCommand: parsed.LINT_FIX_COMMAND?.trim() || "",
    localTestCommand: parsed.LOCAL_TEST_COMMAND?.trim() || "",
    maxValidationRounds: parseInteger(parsed.MAX_VALIDATION_ROUNDS, 2),
    agentTimeoutSeconds: parseInteger(parsed.AGENT_TIMEOUT_SECONDS, 600),
    slackProgressHeartbeatSeconds: parseInteger(parsed.SLACK_PROGRESS_HEARTBEAT_SECONDS, 20),
    dashboardEnabled: parseBoolean(parsed.DASHBOARD_ENABLED, true),
    dashboardHost: parsed.DASHBOARD_HOST?.trim() || "127.0.0.1",
    dashboardPort: parseInteger(parsed.DASHBOARD_PORT, 8787),
    dashboardPublicUrl: parsed.DASHBOARD_PUBLIC_URL?.trim() || undefined,

    maxTaskChars: parseInteger(parsed.MAX_TASK_CHARS, 4000),

    workspaceCleanupEnabled: parseBoolean(parsed.WORKSPACE_CLEANUP_ENABLED, true),
    workspaceMaxAgeHours: parseInteger(parsed.WORKSPACE_MAX_AGE_HOURS, 24),
    workspaceCleanupIntervalMinutes: parseInteger(parsed.WORKSPACE_CLEANUP_INTERVAL_MINUTES, 30),

    cemsApiUrl: parsed.CEMS_API_URL?.trim() || undefined,
    cemsApiKey: parsed.CEMS_API_KEY?.trim() || undefined,
    cemsEnabled: parseBoolean(parsed.CEMS_ENABLED, false),
    cemsTeamId: parsed.CEMS_TEAM_ID?.trim() || undefined,
    mcpExtensions: parseList(parsed.MCP_EXTENSIONS),
    piAgentExtensions: parseList(parsed.PI_AGENT_EXTENSIONS),
    openrouterProviderPreferences: parseProviderPreferences(parsed.OPENROUTER_PROVIDER_PREFERENCES),

    pipelineFile: parsed.PIPELINE_FILE?.trim() || "pipelines/pipeline.yml",

    observerEnabled: parseBoolean(parsed.OBSERVER_ENABLED, false),
    observerAlertChannelId: parsed.OBSERVER_ALERT_CHANNEL_ID?.trim() || "",
    observerMaxRunsPerDay: parseInteger(parsed.OBSERVER_MAX_RUNS_PER_DAY, 50),
    observerMaxRunsPerRepoPerDay: parseInteger(parsed.OBSERVER_MAX_RUNS_PER_REPO_PER_DAY, 5),
    observerCooldownMinutes: parseInteger(parsed.OBSERVER_COOLDOWN_MINUTES, 60),
    observerRulesFile: parsed.OBSERVER_RULES_FILE?.trim() || "observer-rules/default.yml",
    observerRepoMap: parseRepoMap(parsed.OBSERVER_REPO_MAP),
    observerSlackWatchedChannels: parseList(parsed.OBSERVER_SLACK_WATCHED_CHANNELS),
    observerSlackBotAllowlist: parseList(parsed.OBSERVER_SLACK_BOT_ALLOWLIST),

    sentryAuthToken: parsed.SENTRY_AUTH_TOKEN?.trim() || undefined,
    sentryOrgSlug: parsed.SENTRY_ORG_SLUG?.trim() || undefined,
    observerSentryPollIntervalSeconds: parseInteger(parsed.OBSERVER_SENTRY_POLL_INTERVAL_SECONDS, 300),

    observerGithubWebhookSecret: parsed.OBSERVER_GITHUB_WEBHOOK_SECRET?.trim() || undefined,
    observerSentryWebhookSecret: parsed.OBSERVER_SENTRY_WEBHOOK_SECRET?.trim() || undefined,
    observerWebhookPort: parseInteger(parsed.OBSERVER_WEBHOOK_PORT, 9090),
    observerWebhookSecrets: parseWebhookSecrets(parsed.OBSERVER_WEBHOOK_SECRETS),
    observerGithubPollIntervalSeconds: parseInteger(parsed.OBSERVER_GITHUB_POLL_INTERVAL_SECONDS, 300),
    observerGithubWatchedRepos: parseList(parsed.OBSERVER_GITHUB_WATCHED_REPOS),

    openrouterApiKey: parsed.OPENROUTER_API_KEY?.trim() || undefined,
    anthropicApiKey: parsed.ANTHROPIC_API_KEY?.trim() || undefined,
    openaiApiKey: parsed.OPENAI_API_KEY?.trim() || undefined,
    defaultLlmModel: parsed.DEFAULT_LLM_MODEL?.trim() || "anthropic/claude-sonnet-4-6",
    planTaskModel: parsed.PLAN_TASK_MODEL?.trim() || parsed.DEFAULT_LLM_MODEL?.trim() || "anthropic/claude-sonnet-4-6",
    scopeJudgeEnabled: parseBoolean(parsed.SCOPE_JUDGE_ENABLED, false),
    scopeJudgeModel: parsed.SCOPE_JUDGE_MODEL?.trim() || parsed.DEFAULT_LLM_MODEL?.trim() || "anthropic/claude-sonnet-4-6",
    scopeJudgeMinPassScore: parseInteger(parsed.SCOPE_JUDGE_MIN_PASS_SCORE, 60),

    orchestratorModel: parsed.ORCHESTRATOR_MODEL?.trim() || "openai/gpt-4.1-mini",
    orchestratorTimeoutMs: parseInteger(parsed.ORCHESTRATOR_TIMEOUT_MS, 180_000),
    orchestratorWallClockTimeoutMs: parseInteger(parsed.ORCHESTRATOR_WALL_CLOCK_TIMEOUT_MS, 480_000),

    autonomousSchedulerEnabled: parseBoolean(parsed.AUTONOMOUS_SCHEDULER_ENABLED, false),
    autonomousSchedulerMaxDeferred: parseInteger(parsed.AUTONOMOUS_SCHEDULER_MAX_DEFERRED, 100),
    autonomousSchedulerIntervalMs: parseInteger(parsed.AUTONOMOUS_SCHEDULER_INTERVAL_MS, 300_000),

    observerSmartTriageEnabled: parseBoolean(parsed.OBSERVER_SMART_TRIAGE_ENABLED, false),
    observerSmartTriageModel: parsed.OBSERVER_SMART_TRIAGE_MODEL?.trim() || parsed.DEFAULT_LLM_MODEL?.trim() || "anthropic/claude-sonnet-4-6",
    observerSmartTriageTimeoutMs: parseInteger(parsed.OBSERVER_SMART_TRIAGE_TIMEOUT_MS, 10_000),

    browserVerifyEnabled: parseBoolean(parsed.BROWSER_VERIFY_ENABLED, false),
    reviewAppUrlPattern: parsed.REVIEW_APP_URL_PATTERN?.trim() || undefined,
    screenshotEnabled: parseBoolean(parsed.SCREENSHOT_ENABLED, false),
    browserVerifyModel: parsed.BROWSER_VERIFY_MODEL?.trim() || parsed.DEFAULT_LLM_MODEL?.trim() || "anthropic/claude-sonnet-4-6",
    browserVerifyExecutionModel: parsed.BROWSER_VERIFY_EXECUTION_MODEL?.trim() || undefined,
    browserVerifyMaxSteps: parseInteger(parsed.BROWSER_VERIFY_MAX_STEPS, 15),
    browserVerifyExecTimeoutMs: parseInteger(parsed.BROWSER_VERIFY_EXEC_TIMEOUT_MS, 300_000),
    browserVerifyTestEmail: parsed.BROWSER_VERIFY_TEST_EMAIL?.trim() || undefined,
    browserVerifyTestPassword: parsed.BROWSER_VERIFY_TEST_PASSWORD?.trim() || undefined,
    browserVerifyEmailDomains: parseList(parsed.BROWSER_VERIFY_EMAIL_DOMAINS),

    ciWaitEnabled: parseBoolean(parsed.CI_WAIT_ENABLED, false),
    ciPollIntervalSeconds: parseInteger(parsed.CI_POLL_INTERVAL_SECONDS, 30),
    ciPatienceTimeoutSeconds: parseInteger(parsed.CI_PATIENCE_TIMEOUT_SECONDS, 300),
    ciMaxWaitSeconds: parseInteger(parsed.CI_MAX_WAIT_SECONDS, 1800),
    ciCheckFilter: parseList(parsed.CI_CHECK_FILTER),
    ciMaxFixRounds: parseInteger(parsed.CI_MAX_FIX_ROUNDS, 2),

    dashboardToken: parsed.DASHBOARD_TOKEN?.trim() || undefined,

    teamChannelMap: parseTeamChannelMap(parsed.TEAM_CHANNEL_MAP),

    sandboxRuntime,
    sandboxRuntimeExplicit,
    sandboxEnabled: sandboxRuntime === "docker",
    sandboxImage: parsed.SANDBOX_IMAGE?.trim() || "gooseherd/sandbox:default",
    sandboxHostWorkPath: parsed.SANDBOX_HOST_WORK_PATH?.trim() || "",
    sandboxCpus: parseInteger(parsed.SANDBOX_CPUS, 2),
    sandboxMemoryMb: parseInteger(parsed.SANDBOX_MEMORY_MB, 4096),

    supervisorEnabled: parseBoolean(parsed.SUPERVISOR_ENABLED, true),
    supervisorRunTimeoutSeconds: parseInteger(parsed.SUPERVISOR_RUN_TIMEOUT_SECONDS, 7200),
    supervisorNodeStaleSeconds: parseInteger(parsed.SUPERVISOR_NODE_STALE_SECONDS, 1800),
    supervisorWatchdogIntervalSeconds: parseInteger(parsed.SUPERVISOR_WATCHDOG_INTERVAL_SECONDS, 30),
    supervisorMaxAutoRetries: parseInteger(parsed.SUPERVISOR_MAX_AUTO_RETRIES, 1),
    supervisorRetryCooldownSeconds: parseInteger(parsed.SUPERVISOR_RETRY_COOLDOWN_SECONDS, 60),
    supervisorMaxRetriesPerDay: parseInteger(parsed.SUPERVISOR_MAX_RETRIES_PER_DAY, 20),

    databaseUrl: parsed.DATABASE_URL?.trim() || "postgres://gooseherd:gooseherd@postgres:5432/gooseherd",
    encryptionKey: parsed.ENCRYPTION_KEY?.trim() || undefined,
  };
}
