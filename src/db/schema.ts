/**
 * Drizzle ORM schema — all Gooseherd tables.
 *
 * Migrated from 7 JSON-file stores + 1 new setup table.
 */

import {
  pgTable,
  text,
  uuid,
  timestamp,
  boolean,
  integer,
  bigint,
  bigserial,
  numeric,
  jsonb,
  date,
  index,
  primaryKey,
  customType,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Custom bytea type for encrypted fields
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// ── runs ──

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey(),
    status: text("status").notNull(),
    phase: text("phase"),
    repoSlug: text("repo_slug").notNull(),
    task: text("task").notNull(),
    baseBranch: text("base_branch").notNull(),
    branchName: text("branch_name").notNull(),
    requestedBy: text("requested_by").notNull(),
    channelId: text("channel_id").notNull(),
    threadTs: text("thread_ts").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    logsPath: text("logs_path"),
    statusMessageTs: text("status_message_ts"),
    commitSha: text("commit_sha"),
    changedFiles: text("changed_files").array(),
    prUrl: text("pr_url"),
    feedback: jsonb("feedback"),
    error: text("error"),
    parentRunId: uuid("parent_run_id"),
    rootRunId: uuid("root_run_id"),
    chainIndex: integer("chain_index"),
    parentBranchName: text("parent_branch_name"),
    feedbackNote: text("feedback_note"),
    pipelineHint: text("pipeline_hint"),
    skipNodes: text("skip_nodes").array(),
    enableNodes: text("enable_nodes").array(),
    ciFixAttempts: integer("ci_fix_attempts"),
    ciConclusion: text("ci_conclusion"),
    prNumber: integer("pr_number"),
    title: text("title"),
    tokenUsage: jsonb("token_usage"),
    teamId: text("team_id"),
  },
  (t) => [
    index("runs_status_idx").on(t.status),
    index("runs_channel_thread_idx").on(t.channelId, t.threadTs),
    index("runs_repo_slug_idx").on(t.repoSlug),
    index("runs_created_at_idx").on(t.createdAt),
    index("runs_team_id_idx")
      .on(t.teamId)
      .where(sql`team_id IS NOT NULL`),
  ]
);

// ── learning_outcomes ──

export const learningOutcomes = pgTable(
  "learning_outcomes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: text("run_id").notNull(),
    ruleId: text("rule_id"),
    source: text("source").notNull(),
    repoSlug: text("repo_slug").notNull(),
    status: text("status").notNull(),
    errorCategory: text("error_category"),
    durationMs: integer("duration_ms").notNull(),
    costUsd: numeric("cost_usd", { precision: 10, scale: 4 }).notNull(),
    changedFiles: integer("changed_files").notNull().default(0),
    pipelineId: text("pipeline_id"),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("lo_repo_slug_idx").on(t.repoSlug),
    index("lo_rule_id_idx")
      .on(t.ruleId)
      .where(sql`rule_id IS NOT NULL`),
    index("lo_source_idx").on(t.source),
    index("lo_timestamp_idx").on(t.timestamp),
  ]
);

// ── observer_dedup ──

export const observerDedup = pgTable("observer_dedup", {
  key: text("key").primaryKey(),
  seenAt: bigint("seen_at", { mode: "number" }).notNull(),
  ttlMs: bigint("ttl_ms", { mode: "number" }).notNull(),
  runId: text("run_id"),
  ruleId: text("rule_id"),
  completedAt: bigint("completed_at", { mode: "number" }),
});

// ── observer_rate_events ──

export const observerRateEvents = pgTable(
  "observer_rate_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    source: text("source").notNull(),
    timestampMs: bigint("timestamp_ms", { mode: "number" }).notNull(),
  },
  (t) => [index("ore_source_ts_idx").on(t.source, t.timestampMs)]
);

// ── observer_daily_counters ──

export const observerDailyCounters = pgTable("observer_daily_counters", {
  counterDay: date("counter_day").primaryKey(),
  dailyCount: integer("daily_count").notNull().default(0),
  perRepo: jsonb("per_repo").notNull().$type<Record<string, number>>().default({}),
});

// ── observer_poll_cursors ──

export const observerPollCursors = pgTable(
  "observer_poll_cursors",
  {
    sourceType: text("source_type").notNull(),
    sourceKey: text("source_key").notNull(),
    cursorValue: text("cursor_value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sourceType, t.sourceKey] })]
);

// ── observer_rule_outcomes ──

export const observerRuleOutcomes = pgTable("observer_rule_outcomes", {
  ruleId: text("rule_id").primaryKey(),
  success: integer("success").notNull().default(0),
  failure: integer("failure").notNull().default(0),
  lastOutcome: text("last_outcome").notNull().default(""),
  lastAt: timestamp("last_at", { withTimezone: true }),
});

// ── pipelines ──

export const pipelines = pgTable("pipelines", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  yaml: text("yaml").notNull(),
  isBuiltIn: boolean("is_built_in").notNull().default(false),
  nodeCount: integer("node_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── sessions ──

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey(),
    goal: text("goal").notNull(),
    repoSlug: text("repo_slug").notNull(),
    baseBranch: text("base_branch").notNull(),
    status: text("status").notNull(),
    plan: jsonb("plan").notNull().$type<unknown[]>().default([]),
    context: jsonb("context").notNull().$type<Record<string, unknown>>().default({}),
    maxRuns: integer("max_runs").notNull().default(10),
    completedRuns: integer("completed_runs").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    requestedBy: text("requested_by").notNull(),
    channelId: text("channel_id").notNull(),
    threadTs: text("thread_ts").notNull(),
    error: text("error"),
  },
  (t) => [index("sessions_status_idx").on(t.status)]
);

// ── conversations ──

export const conversations = pgTable(
  "conversations",
  {
    threadKey: text("thread_key").primaryKey(),
    messages: jsonb("messages").notNull().$type<unknown[]>().default([]),
    lastAccess: timestamp("last_access", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("conversations_last_access_idx").on(t.lastAccess)]
);

// ── auth_credentials ──

export const authCredentials = pgTable("auth_credentials", {
  domain: text("domain").primaryKey(),
  emailEnc: bytea("email_enc").notNull(),
  passwordEnc: bytea("password_enc").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  loginSuccessful: boolean("login_successful").notNull().default(false),
});

// ── eval_results ──

export const evalResults = pgTable(
  "eval_results",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    scenarioName: text("scenario_name").notNull(),
    runId: uuid("run_id").notNull(),
    configLabel: text("config_label"),
    pipeline: text("pipeline"),
    model: text("model"),
    overallPass: boolean("overall_pass").notNull(),
    overallScore: integer("overall_score").notNull(),
    judgeResults: jsonb("judge_results").notNull().$type<Array<{ judge: string; pass: boolean; score: number; reason: string }>>(),
    durationMs: integer("duration_ms").notNull(),
    costUsd: numeric("cost_usd", { precision: 10, scale: 4 }).notNull(),
    tags: text("tags").array(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("eval_scenario_idx").on(t.scenarioName),
    index("eval_created_at_idx").on(t.createdAt),
  ]
);

// ── setup (single-row config) ──

export const setup = pgTable("setup", {
  id: integer("id").primaryKey().default(1),
  passwordHash: text("password_hash"),
  githubConfig: jsonb("github_config").$type<Record<string, unknown>>(),
  githubTokenEnc: bytea("github_token_enc"),
  githubAppKeyEnc: bytea("github_app_key_enc"),
  llmConfig: jsonb("llm_config").$type<Record<string, unknown>>(),
  llmApiKeyEnc: bytea("llm_api_key_enc"),
  slackConfig: jsonb("slack_config").$type<Record<string, unknown>>(),
  slackBotTokenEnc: bytea("slack_bot_token_enc"),
  slackAppTokenEnc: bytea("slack_app_token_enc"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const configSections = pgTable("config_sections", {
  section: text("section").primaryKey(),
  config: jsonb("config").notNull().$type<Record<string, unknown>>().default({}),
  secretsEnc: bytea("secrets_enc"),
  overrideFromEnv: boolean("override_from_env").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
