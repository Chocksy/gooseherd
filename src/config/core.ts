import type { AppConfig } from "../config.js";
import type { ParsedEnv } from "./shared.js";
import {
  parseAutoReviewDebugLogMode,
  parseBoolean,
  parseInteger,
} from "./shared.js";

interface ConfigIdentity {
  appName: string;
  appSlug: string;
}

type CoreConfigSlice = Pick<
  AppConfig,
  | "appName"
  | "appSlug"
  | "runnerConcurrency"
  | "workRoot"
  | "dataDir"
  | "dryRun"
  | "branchPrefix"
  | "defaultBaseBranch"
  | "gitAuthorName"
  | "gitAuthorEmail"
  | "agentCommandTemplate"
  | "baseAgentCommandTemplate"
  | "agentFollowUpTemplate"
  | "validationCommand"
  | "lintFixCommand"
  | "localTestCommand"
  | "autoReviewDebugLogMode"
  | "maxValidationRounds"
  | "agentTimeoutSeconds"
  | "slackProgressHeartbeatSeconds"
  | "maxTaskChars"
  | "workspaceCleanupEnabled"
  | "workspaceMaxAgeHours"
  | "workspaceCleanupIntervalMinutes"
  | "pipelineFile"
  | "databaseUrl"
  | "encryptionKey"
>;

export function loadCoreConfig(parsed: ParsedEnv, identity: ConfigIdentity): CoreConfigSlice {
  const defaultAgentCommand =
    parsed.AGENT_COMMAND_TEMPLATE ??
    "bash scripts/dummy-agent.sh {{repo_dir}} {{prompt_file}} {{run_id}}";

  return {
    appName: identity.appName,
    appSlug: identity.appSlug,
    runnerConcurrency: parseInteger(parsed.RUNNER_CONCURRENCY, 1),
    workRoot: parsed.WORK_ROOT ?? ".work",
    dataDir: parsed.DATA_DIR ?? "data",
    dryRun: parseBoolean(parsed.DRY_RUN, false),
    branchPrefix: parsed.BRANCH_PREFIX ?? identity.appSlug,
    defaultBaseBranch: parsed.DEFAULT_BASE_BRANCH ?? "main",
    gitAuthorName: parsed.GIT_AUTHOR_NAME ?? `${identity.appName} Bot`,
    gitAuthorEmail: parsed.GIT_AUTHOR_EMAIL ?? `${identity.appSlug}-bot@local`,
    agentCommandTemplate: defaultAgentCommand,
    baseAgentCommandTemplate: defaultAgentCommand,
    agentFollowUpTemplate: parsed.AGENT_FOLLOW_UP_TEMPLATE?.trim() || undefined,
    validationCommand: parsed.VALIDATION_COMMAND ?? "",
    lintFixCommand: parsed.LINT_FIX_COMMAND?.trim() || "",
    localTestCommand: parsed.LOCAL_TEST_COMMAND?.trim() || "",
    autoReviewDebugLogMode: parseAutoReviewDebugLogMode(parsed.AUTO_REVIEW_DEBUG_LOG_MODE),
    maxValidationRounds: parseInteger(parsed.MAX_VALIDATION_ROUNDS, 2),
    agentTimeoutSeconds: parseInteger(parsed.AGENT_TIMEOUT_SECONDS, 600),
    slackProgressHeartbeatSeconds: parseInteger(parsed.SLACK_PROGRESS_HEARTBEAT_SECONDS, 20),
    maxTaskChars: parseInteger(parsed.MAX_TASK_CHARS, 4000),
    workspaceCleanupEnabled: parseBoolean(parsed.WORKSPACE_CLEANUP_ENABLED, true),
    workspaceMaxAgeHours: parseInteger(parsed.WORKSPACE_MAX_AGE_HOURS, 24),
    workspaceCleanupIntervalMinutes: parseInteger(parsed.WORKSPACE_CLEANUP_INTERVAL_MINUTES, 30),
    pipelineFile: parsed.PIPELINE_FILE?.trim() || "pipelines/pipeline.yml",
    databaseUrl: parsed.DATABASE_URL?.trim() || "postgres://gooseherd:gooseherd@postgres:5432/gooseherd",
    encryptionKey: parsed.ENCRYPTION_KEY?.trim() || undefined,
  };
}
