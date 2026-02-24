import { z } from "zod";

const envSchema = z.object({
  APP_NAME: z.string().optional(),

  SLACK_BOT_TOKEN: z.string().min(1),
  SLACK_APP_TOKEN: z.string().min(1),
  SLACK_SIGNING_SECRET: z.string().min(1),
  SLACK_COMMAND_NAME: z.string().optional(),
  SLACK_ALLOWED_CHANNELS: z.string().optional(),

  GITHUB_TOKEN: z.string().optional(),
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
  MAX_VALIDATION_ROUNDS: z.string().optional(),
  AGENT_TIMEOUT_SECONDS: z.string().optional(),
  SLACK_PROGRESS_HEARTBEAT_SECONDS: z.string().optional(),
  DASHBOARD_ENABLED: z.string().optional(),
  DASHBOARD_HOST: z.string().optional(),
  DASHBOARD_PORT: z.string().optional(),

  MAX_TASK_CHARS: z.string().optional(),

  WORKSPACE_CLEANUP_ENABLED: z.string().optional(),
  WORKSPACE_MAX_AGE_HOURS: z.string().optional(),
  WORKSPACE_CLEANUP_INTERVAL_MINUTES: z.string().optional(),

  CEMS_API_URL: z.string().optional(),
  CEMS_API_KEY: z.string().optional(),
  CEMS_ENABLED: z.string().optional(),
  CEMS_MCP_COMMAND: z.string().optional(),

  PIPELINE_ENGINE_ENABLED: z.string().optional(),
  PIPELINE_FILE: z.string().optional(),

  OBSERVER_ENABLED: z.string().optional(),
  OBSERVER_ALERT_CHANNEL_ID: z.string().optional(),
  OBSERVER_MAX_RUNS_PER_DAY: z.string().optional(),
  OBSERVER_MAX_RUNS_PER_REPO_PER_DAY: z.string().optional(),
  OBSERVER_COOLDOWN_MINUTES: z.string().optional(),
  OBSERVER_RULES_FILE: z.string().optional(),
  OBSERVER_REPO_MAP: z.string().optional(),

  SENTRY_AUTH_TOKEN: z.string().optional(),
  SENTRY_ORG_SLUG: z.string().optional(),
  OBSERVER_SENTRY_POLL_INTERVAL_SECONDS: z.string().optional(),

  OBSERVER_GITHUB_WEBHOOK_SECRET: z.string().optional(),
  OBSERVER_WEBHOOK_PORT: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  SCOPE_JUDGE_ENABLED: z.string().optional(),
  SCOPE_JUDGE_MODEL: z.string().optional(),
  SCOPE_JUDGE_MIN_PASS_SCORE: z.string().optional(),

  OBSERVER_SMART_TRIAGE_ENABLED: z.string().optional(),
  OBSERVER_SMART_TRIAGE_MODEL: z.string().optional(),
  OBSERVER_SMART_TRIAGE_TIMEOUT_MS: z.string().optional(),

  BROWSER_VERIFY_ENABLED: z.string().optional(),
  REVIEW_APP_URL_PATTERN: z.string().optional(),

  CI_WAIT_ENABLED: z.string().optional(),
  CI_POLL_INTERVAL_SECONDS: z.string().optional(),
  CI_PATIENCE_TIMEOUT_SECONDS: z.string().optional(),
  CI_MAX_WAIT_SECONDS: z.string().optional(),
  CI_CHECK_FILTER: z.string().optional(),
  CI_MAX_FIX_ROUNDS: z.string().optional()
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

  slackBotToken: string;
  slackAppToken: string;
  slackSigningSecret: string;
  slackCommandName: string;
  slackAllowedChannels: string[];

  githubToken?: string;
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
  agentFollowUpTemplate?: string;
  validationCommand: string;
  lintFixCommand: string;
  maxValidationRounds: number;
  agentTimeoutSeconds: number;
  slackProgressHeartbeatSeconds: number;
  dashboardEnabled: boolean;
  dashboardHost: string;
  dashboardPort: number;

  maxTaskChars: number;

  workspaceCleanupEnabled: boolean;
  workspaceMaxAgeHours: number;
  workspaceCleanupIntervalMinutes: number;

  cemsApiUrl?: string;
  cemsApiKey?: string;
  cemsEnabled: boolean;
  cemsMcpCommand?: string;

  pipelineEngineEnabled: boolean;
  pipelineFile: string;

  observerEnabled: boolean;
  observerAlertChannelId: string;
  observerMaxRunsPerDay: number;
  observerMaxRunsPerRepoPerDay: number;
  observerCooldownMinutes: number;
  observerRulesFile: string;
  /** Sentry project → repo mapping: "proj:owner/repo,proj2:owner/repo2" */
  observerRepoMap: Map<string, string>;

  sentryAuthToken?: string;
  sentryOrgSlug?: string;
  observerSentryPollIntervalSeconds: number;

  observerGithubWebhookSecret?: string;
  observerWebhookPort: number;

  anthropicApiKey?: string;
  scopeJudgeEnabled: boolean;
  scopeJudgeModel: string;
  scopeJudgeMinPassScore: number;

  observerSmartTriageEnabled: boolean;
  observerSmartTriageModel: string;
  observerSmartTriageTimeoutMs: number;

  browserVerifyEnabled: boolean;
  reviewAppUrlPattern?: string;

  ciWaitEnabled: boolean;
  ciPollIntervalSeconds: number;
  ciPatienceTimeoutSeconds: number;
  ciMaxWaitSeconds: number;
  ciCheckFilter: string[];
  ciMaxFixRounds: number;
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

export function loadConfig(): AppConfig {
  const parsed = envSchema.parse(process.env);

  const appName = parsed.APP_NAME?.trim() || "Gooseherd";
  const appSlug = appName.toLowerCase().replace(/\s+/g, "-");

  return {
    appName,
    appSlug,

    slackBotToken: parsed.SLACK_BOT_TOKEN,
    slackAppToken: parsed.SLACK_APP_TOKEN,
    slackSigningSecret: parsed.SLACK_SIGNING_SECRET,
    slackCommandName: parsed.SLACK_COMMAND_NAME?.trim() || appSlug,
    slackAllowedChannels: parseList(parsed.SLACK_ALLOWED_CHANNELS),

    githubToken: parsed.GITHUB_TOKEN,
    githubDefaultOwner: parsed.GITHUB_DEFAULT_OWNER,
    repoAllowlist: parseList(parsed.REPO_ALLOWLIST),

    runnerConcurrency: parseInteger(parsed.RUNNER_CONCURRENCY, 1),
    workRoot: parsed.WORK_ROOT ?? ".work",
    dataDir: parsed.DATA_DIR ?? "data",
    dryRun: parseBoolean(parsed.DRY_RUN, true),

    branchPrefix: parsed.BRANCH_PREFIX ?? appSlug,
    defaultBaseBranch: parsed.DEFAULT_BASE_BRANCH ?? "main",
    gitAuthorName: parsed.GIT_AUTHOR_NAME ?? `${appName} Bot`,
    gitAuthorEmail: parsed.GIT_AUTHOR_EMAIL ?? `${appSlug}-bot@local`,

    agentCommandTemplate:
      parsed.AGENT_COMMAND_TEMPLATE ??
      "bash scripts/dummy-agent.sh {{repo_dir}} {{prompt_file}} {{run_id}}",
    agentFollowUpTemplate: parsed.AGENT_FOLLOW_UP_TEMPLATE?.trim() || undefined,
    validationCommand: parsed.VALIDATION_COMMAND ?? "",
    lintFixCommand: parsed.LINT_FIX_COMMAND?.trim() || "",
    maxValidationRounds: parseInteger(parsed.MAX_VALIDATION_ROUNDS, 2),
    agentTimeoutSeconds: parseInteger(parsed.AGENT_TIMEOUT_SECONDS, 1200),
    slackProgressHeartbeatSeconds: parseInteger(parsed.SLACK_PROGRESS_HEARTBEAT_SECONDS, 20),
    dashboardEnabled: parseBoolean(parsed.DASHBOARD_ENABLED, true),
    dashboardHost: parsed.DASHBOARD_HOST?.trim() || "127.0.0.1",
    dashboardPort: parseInteger(parsed.DASHBOARD_PORT, 8787),

    maxTaskChars: parseInteger(parsed.MAX_TASK_CHARS, 4000),

    workspaceCleanupEnabled: parseBoolean(parsed.WORKSPACE_CLEANUP_ENABLED, true),
    workspaceMaxAgeHours: parseInteger(parsed.WORKSPACE_MAX_AGE_HOURS, 24),
    workspaceCleanupIntervalMinutes: parseInteger(parsed.WORKSPACE_CLEANUP_INTERVAL_MINUTES, 30),

    cemsApiUrl: parsed.CEMS_API_URL?.trim() || undefined,
    cemsApiKey: parsed.CEMS_API_KEY?.trim() || undefined,
    cemsEnabled: parseBoolean(parsed.CEMS_ENABLED, false),
    cemsMcpCommand: parsed.CEMS_MCP_COMMAND?.trim() || undefined,

    pipelineEngineEnabled: parseBoolean(parsed.PIPELINE_ENGINE_ENABLED, false),
    pipelineFile: parsed.PIPELINE_FILE?.trim() || "pipelines/default.yml",

    observerEnabled: parseBoolean(parsed.OBSERVER_ENABLED, false),
    observerAlertChannelId: parsed.OBSERVER_ALERT_CHANNEL_ID?.trim() || "",
    observerMaxRunsPerDay: parseInteger(parsed.OBSERVER_MAX_RUNS_PER_DAY, 50),
    observerMaxRunsPerRepoPerDay: parseInteger(parsed.OBSERVER_MAX_RUNS_PER_REPO_PER_DAY, 5),
    observerCooldownMinutes: parseInteger(parsed.OBSERVER_COOLDOWN_MINUTES, 60),
    observerRulesFile: parsed.OBSERVER_RULES_FILE?.trim() || "observer-rules/default.yml",
    observerRepoMap: parseRepoMap(parsed.OBSERVER_REPO_MAP),

    sentryAuthToken: parsed.SENTRY_AUTH_TOKEN?.trim() || undefined,
    sentryOrgSlug: parsed.SENTRY_ORG_SLUG?.trim() || undefined,
    observerSentryPollIntervalSeconds: parseInteger(parsed.OBSERVER_SENTRY_POLL_INTERVAL_SECONDS, 300),

    observerGithubWebhookSecret: parsed.OBSERVER_GITHUB_WEBHOOK_SECRET?.trim() || undefined,
    observerWebhookPort: parseInteger(parsed.OBSERVER_WEBHOOK_PORT, 9090),

    anthropicApiKey: parsed.ANTHROPIC_API_KEY?.trim() || undefined,
    scopeJudgeEnabled: parseBoolean(parsed.SCOPE_JUDGE_ENABLED, false),
    scopeJudgeModel: parsed.SCOPE_JUDGE_MODEL?.trim() || "claude-haiku-4-5-20251001",
    scopeJudgeMinPassScore: parseInteger(parsed.SCOPE_JUDGE_MIN_PASS_SCORE, 60),

    observerSmartTriageEnabled: parseBoolean(parsed.OBSERVER_SMART_TRIAGE_ENABLED, false),
    observerSmartTriageModel: parsed.OBSERVER_SMART_TRIAGE_MODEL?.trim() || "claude-haiku-4-5-20251001",
    observerSmartTriageTimeoutMs: parseInteger(parsed.OBSERVER_SMART_TRIAGE_TIMEOUT_MS, 10_000),

    browserVerifyEnabled: parseBoolean(parsed.BROWSER_VERIFY_ENABLED, false),
    reviewAppUrlPattern: parsed.REVIEW_APP_URL_PATTERN?.trim() || undefined,

    ciWaitEnabled: parseBoolean(parsed.CI_WAIT_ENABLED, false),
    ciPollIntervalSeconds: parseInteger(parsed.CI_POLL_INTERVAL_SECONDS, 30),
    ciPatienceTimeoutSeconds: parseInteger(parsed.CI_PATIENCE_TIMEOUT_SECONDS, 300),
    ciMaxWaitSeconds: parseInteger(parsed.CI_MAX_WAIT_SECONDS, 1800),
    ciCheckFilter: parseList(parsed.CI_CHECK_FILTER),
    ciMaxFixRounds: parseInteger(parsed.CI_MAX_FIX_ROUNDS, 2)
  };
}
