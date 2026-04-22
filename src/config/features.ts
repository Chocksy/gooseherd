import type { AppConfig, AppFeatures } from "../config.js";
import type { ParsedEnv } from "./shared.js";
import {
  parseBoolean,
  parseInteger,
  parseList,
  parseProviderPreferences,
  parseRepoMap,
  parseWebhookSecrets,
} from "./shared.js";

type FeatureConfigSlice = Pick<
  AppConfig,
  | "features"
  | "observerEnabled"
  | "observerAlertChannelId"
  | "observerMaxRunsPerDay"
  | "observerMaxRunsPerRepoPerDay"
  | "observerCooldownMinutes"
  | "observerRulesFile"
  | "observerRepoMap"
  | "observerSlackWatchedChannels"
  | "observerSlackBotAllowlist"
  | "sentryAuthToken"
  | "sentryOrgSlug"
  | "observerSentryPollIntervalSeconds"
  | "observerGithubWebhookSecret"
  | "observerSentryWebhookSecret"
  | "observerWebhookPort"
  | "observerWebhookSecrets"
  | "observerGithubPollIntervalSeconds"
  | "observerGithubWatchedRepos"
  | "openrouterApiKey"
  | "anthropicApiKey"
  | "openaiApiKey"
  | "openrouterProviderPreferences"
  | "defaultLlmModel"
  | "planTaskModel"
  | "scopeJudgeEnabled"
  | "scopeJudgeModel"
  | "scopeJudgeMinPassScore"
  | "orchestratorModel"
  | "orchestratorTimeoutMs"
  | "orchestratorWallClockTimeoutMs"
  | "autonomousSchedulerEnabled"
  | "autonomousSchedulerMaxDeferred"
  | "autonomousSchedulerIntervalMs"
  | "observerSmartTriageEnabled"
  | "observerSmartTriageModel"
  | "observerSmartTriageTimeoutMs"
  | "browserVerifyEnabled"
  | "reviewAppUrlPattern"
  | "screenshotEnabled"
  | "browserVerifyModel"
  | "browserVerifyExecutionModel"
  | "browserVerifyMaxSteps"
  | "browserVerifyExecTimeoutMs"
  | "browserVerifyTestEmail"
  | "browserVerifyTestPassword"
  | "browserVerifyEmailDomains"
  | "ciWaitEnabled"
  | "ciPollIntervalSeconds"
  | "ciPatienceTimeoutSeconds"
  | "ciMaxWaitSeconds"
  | "ciCheckFilter"
  | "ciMaxFixRounds"
  | "featureDeliveryResetEngineeringReviewOnNewCommits"
  | "featureDeliveryResetQaReviewOnNewCommits"
  | "featureDeliverySkipQaPreparation"
  | "featureDeliverySkipProductReview"
  | "workItemGithubAdoptionLabels"
  | "autoReviewBranchSyncEnabled"
  | "autoReviewBranchSyncMaxBehindCommits"
  | "autoReviewBranchSyncIntervalMs"
>;

export function loadFeatureFlags(parsed: ParsedEnv): AppFeatures {
  return {
    observer: parseBoolean(parsed.OBSERVER_ENABLED, false),
    workItems: parseBoolean(parsed.WORK_ITEMS_ENABLED, false),
    browserVerify: parseBoolean(parsed.BROWSER_VERIFY_ENABLED, false),
    ciWait: parseBoolean(parsed.CI_WAIT_ENABLED, false),
    supervisor: parseBoolean(parsed.SUPERVISOR_ENABLED, true),
    sessions: parseBoolean(parsed.SESSIONS_ENABLED, false),
    eval: parseBoolean(parsed.EVAL_ENABLED, false),
    autonomousScheduler: parseBoolean(parsed.AUTONOMOUS_SCHEDULER_ENABLED, false),
  };
}

export function loadFeatureConfig(parsed: ParsedEnv, features: AppFeatures): FeatureConfigSlice {
  const defaultModel = parsed.DEFAULT_LLM_MODEL?.trim() || "anthropic/claude-sonnet-4-6";
  const workItemGithubAdoptionLabels = parseList(parsed.WORK_ITEM_GITHUB_ADOPTION_LABELS);

  return {
    features,
    observerEnabled: features.observer,
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
    openrouterProviderPreferences: parseProviderPreferences(parsed.OPENROUTER_PROVIDER_PREFERENCES),
    defaultLlmModel: defaultModel,
    planTaskModel: parsed.PLAN_TASK_MODEL?.trim() || parsed.DEFAULT_LLM_MODEL?.trim() || "anthropic/claude-sonnet-4-6",
    scopeJudgeEnabled: parseBoolean(parsed.SCOPE_JUDGE_ENABLED, false),
    scopeJudgeModel: parsed.SCOPE_JUDGE_MODEL?.trim() || parsed.DEFAULT_LLM_MODEL?.trim() || "anthropic/claude-sonnet-4-6",
    scopeJudgeMinPassScore: parseInteger(parsed.SCOPE_JUDGE_MIN_PASS_SCORE, 60),
    orchestratorModel: parsed.ORCHESTRATOR_MODEL?.trim() || "openai/gpt-4.1-mini",
    orchestratorTimeoutMs: parseInteger(parsed.ORCHESTRATOR_TIMEOUT_MS, 180_000),
    orchestratorWallClockTimeoutMs: parseInteger(parsed.ORCHESTRATOR_WALL_CLOCK_TIMEOUT_MS, 480_000),
    autonomousSchedulerEnabled: features.autonomousScheduler,
    autonomousSchedulerMaxDeferred: parseInteger(parsed.AUTONOMOUS_SCHEDULER_MAX_DEFERRED, 100),
    autonomousSchedulerIntervalMs: parseInteger(parsed.AUTONOMOUS_SCHEDULER_INTERVAL_MS, 300_000),
    observerSmartTriageEnabled: parseBoolean(parsed.OBSERVER_SMART_TRIAGE_ENABLED, false),
    observerSmartTriageModel: parsed.OBSERVER_SMART_TRIAGE_MODEL?.trim() || parsed.DEFAULT_LLM_MODEL?.trim() || "anthropic/claude-sonnet-4-6",
    observerSmartTriageTimeoutMs: parseInteger(parsed.OBSERVER_SMART_TRIAGE_TIMEOUT_MS, 10_000),
    browserVerifyEnabled: features.browserVerify,
    reviewAppUrlPattern: parsed.REVIEW_APP_URL_PATTERN?.trim() || undefined,
    screenshotEnabled: parseBoolean(parsed.SCREENSHOT_ENABLED, false),
    browserVerifyModel: parsed.BROWSER_VERIFY_MODEL?.trim() || parsed.DEFAULT_LLM_MODEL?.trim() || "anthropic/claude-sonnet-4-6",
    browserVerifyExecutionModel: parsed.BROWSER_VERIFY_EXECUTION_MODEL?.trim() || undefined,
    browserVerifyMaxSteps: parseInteger(parsed.BROWSER_VERIFY_MAX_STEPS, 15),
    browserVerifyExecTimeoutMs: parseInteger(parsed.BROWSER_VERIFY_EXEC_TIMEOUT_MS, 300_000),
    browserVerifyTestEmail: parsed.BROWSER_VERIFY_TEST_EMAIL?.trim() || undefined,
    browserVerifyTestPassword: parsed.BROWSER_VERIFY_TEST_PASSWORD?.trim() || undefined,
    browserVerifyEmailDomains: parseList(parsed.BROWSER_VERIFY_EMAIL_DOMAINS),
    ciWaitEnabled: features.ciWait,
    ciPollIntervalSeconds: parseInteger(parsed.CI_POLL_INTERVAL_SECONDS, 30),
    ciPatienceTimeoutSeconds: parseInteger(parsed.CI_PATIENCE_TIMEOUT_SECONDS, 300),
    ciMaxWaitSeconds: parseInteger(parsed.CI_MAX_WAIT_SECONDS, 1800),
    ciCheckFilter: parseList(parsed.CI_CHECK_FILTER),
    ciMaxFixRounds: parseInteger(parsed.CI_MAX_FIX_ROUNDS, 2),
    featureDeliveryResetEngineeringReviewOnNewCommits: parseBoolean(
      parsed.FEATURE_DELIVERY_RESET_ENGINEERING_REVIEW_ON_NEW_COMMITS,
      false,
    ),
    featureDeliveryResetQaReviewOnNewCommits: parseBoolean(
      parsed.FEATURE_DELIVERY_RESET_QA_REVIEW_ON_NEW_COMMITS,
      false,
    ),
    featureDeliverySkipQaPreparation: parseBoolean(
      parsed.FEATURE_DELIVERY_SKIP_QA_PREPARATION,
      false,
    ),
    featureDeliverySkipProductReview: parseBoolean(
      parsed.FEATURE_DELIVERY_SKIP_PRODUCT_REVIEW,
      false,
    ),
    workItemGithubAdoptionLabels: workItemGithubAdoptionLabels.length > 0
      ? workItemGithubAdoptionLabels
      : ["ai:assist"],
    autoReviewBranchSyncEnabled: parseBoolean(parsed.AUTO_REVIEW_BRANCH_SYNC_ENABLED, true),
    autoReviewBranchSyncMaxBehindCommits: parseInteger(parsed.AUTO_REVIEW_BRANCH_SYNC_MAX_BEHIND_COMMITS, 5),
    autoReviewBranchSyncIntervalMs: parseInteger(parsed.AUTO_REVIEW_BRANCH_SYNC_INTERVAL_MS, 900_000),
  };
}
