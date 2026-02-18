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

  CEMS_API_URL: z.string().optional(),
  CEMS_API_KEY: z.string().optional(),
  CEMS_ENABLED: z.string().optional(),
  CEMS_MCP_COMMAND: z.string().optional()
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

  cemsApiUrl?: string;
  cemsApiKey?: string;
  cemsEnabled: boolean;
  cemsMcpCommand?: string;
}

export function loadConfig(): AppConfig {
  const parsed = envSchema.parse(process.env);

  const appName = parsed.APP_NAME?.trim() || "Gooseherd";
  const appSlug = appName.toLowerCase().replace(/\s+/g, "-");

  return {
    appName,

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

    cemsApiUrl: parsed.CEMS_API_URL?.trim() || undefined,
    cemsApiKey: parsed.CEMS_API_KEY?.trim() || undefined,
    cemsEnabled: parseBoolean(parsed.CEMS_ENABLED, false),
    cemsMcpCommand: parsed.CEMS_MCP_COMMAND?.trim() || undefined
  };
}
