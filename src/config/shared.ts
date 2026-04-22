import { z } from "zod";

export const envSchema = z.object({
  APP_NAME: z.string().optional(),

  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  SLACK_COMMAND_NAME: z.string().optional(),
  SLACK_ALLOWED_CHANNELS: z.string().optional(),
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  SLACK_AUTH_REDIRECT_URI: z.string().optional(),

  GITHUB_TOKEN: z.string().optional(),
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_APP_INSTALLATION_ID: z.string().optional(),
  GITHUB_DEFAULT_OWNER: z.string().optional(),
  REPO_ALLOWLIST: z.string().optional(),

  DEFAULT_TEAM_NAME: z.string().optional(),
  DEFAULT_TEAM_SLACK_CHANNEL_ID: z.string().optional(),
  DEFAULT_TEAM_SLACK_CHANNEL_NAME: z.string().optional(),

  JIRA_BASE_URL: z.string().optional(),
  JIRA_CLOUD_ID: z.string().optional(),
  JIRA_USER: z.string().optional(),
  JIRA_API_TOKEN: z.string().optional(),
  JIRA_REQUEST_TIMEOUT_MS: z.string().optional(),

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
  AUTO_REVIEW_DEBUG_LOG_MODE: z.string().optional(),
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
  WORK_ITEMS_ENABLED: z.string().optional(),
  EVAL_ENABLED: z.string().optional(),
  SESSIONS_ENABLED: z.string().optional(),
  FEATURE_DELIVERY_RESET_ENGINEERING_REVIEW_ON_NEW_COMMITS: z.string().optional(),
  FEATURE_DELIVERY_RESET_QA_REVIEW_ON_NEW_COMMITS: z.string().optional(),
  FEATURE_DELIVERY_SKIP_QA_PREPARATION: z.string().optional(),
  FEATURE_DELIVERY_SKIP_PRODUCT_REVIEW: z.string().optional(),
  WORK_ITEM_GITHUB_ADOPTION_LABELS: z.string().optional(),
  AUTO_REVIEW_BRANCH_SYNC_ENABLED: z.string().optional(),
  AUTO_REVIEW_BRANCH_SYNC_MAX_BEHIND_COMMITS: z.string().optional(),
  AUTO_REVIEW_BRANCH_SYNC_INTERVAL_MS: z.string().optional(),

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
  ENCRYPTION_KEY_FILE: z.string().optional(),

  KUBERNETES_RUNNER_IMAGE: z.string().optional(),
  KUBERNETES_INTERNAL_BASE_URL: z.string().optional(),
  KUBERNETES_NAMESPACE: z.string().optional(),
  KUBERNETES_RUNNER_ENV_SECRET: z.string().optional(),
  KUBERNETES_RUNNER_ENV_CONFIGMAP: z.string().optional(),
});

export type ParsedEnv = z.infer<typeof envSchema>;

export function parseList(value?: string): string[] {
  if (!value || value.trim() === "") {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

export function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

export function parseAutoReviewDebugLogMode(value?: string): "off" | "failures" | "always" {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "off" || normalized === "always") {
    return normalized;
  }
  return "failures";
}

export function parseRepoMap(value?: string): Map<string, string> {
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

export function parseWebhookSecrets(value?: string): Record<string, string> {
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

export function parseProviderPreferences(value?: string): Record<string, unknown> | undefined {
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
