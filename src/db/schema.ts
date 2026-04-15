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
  uniqueIndex,
  primaryKey,
  customType,
  foreignKey,
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
    runtime: text("runtime").notNull().default("local"),
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
    workItemId: uuid("work_item_id"),
  },
  (t) => [
    index("runs_runtime_idx").on(t.runtime),
    index("runs_status_idx").on(t.status),
    index("runs_channel_thread_idx").on(t.channelId, t.threadTs),
    index("runs_repo_slug_idx").on(t.repoSlug),
    index("runs_created_at_idx").on(t.createdAt),
    index("runs_work_item_id_idx")
      .on(t.workItemId)
      .where(sql`work_item_id IS NOT NULL`),
    index("runs_team_id_idx")
      .on(t.teamId)
      .where(sql`team_id IS NOT NULL`),
  ]
);

// ── run control-plane ──

export const runPayloads = pgTable(
  "run_payloads",
  {
    runId: uuid("run_id").primaryKey(),
    payloadRef: text("payload_ref").notNull(),
    payloadJson: jsonb("payload_json").notNull().$type<Record<string, unknown>>(),
    runtime: text("runtime").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.runId],
      foreignColumns: [runs.id],
      name: "run_payloads_run_id_runs_id_fk",
    }).onDelete("cascade"),
    index("run_payloads_runtime_idx").on(t.runtime),
  ]
);

export const runTokens = pgTable(
  "run_tokens",
  {
    runId: uuid("run_id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.runId],
      foreignColumns: [runs.id],
      name: "run_tokens_run_id_runs_id_fk",
    }).onDelete("cascade"),
    uniqueIndex("run_tokens_token_hash_idx").on(t.tokenHash),
  ]
);

export const runEvents = pgTable(
  "run_events",
  {
    runId: uuid("run_id").notNull(),
    eventId: text("event_id").notNull(),
    sequence: integer("sequence").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull().$type<Record<string, unknown>>().default({}),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.runId],
      foreignColumns: [runs.id],
      name: "run_events_run_id_runs_id_fk",
    }).onDelete("cascade"),
    primaryKey({ columns: [t.runId, t.eventId] }),
    uniqueIndex("run_events_run_id_sequence_idx").on(t.runId, t.sequence),
  ]
);

export const runCompletions = pgTable(
  "run_completions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: uuid("run_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull(),
    payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.runId],
      foreignColumns: [runs.id],
      name: "run_completions_run_id_runs_id_fk",
    }).onDelete("cascade"),
    uniqueIndex("run_completions_run_id_idempotency_key_idx").on(t.runId, t.idempotencyKey),
    index("run_completions_run_id_created_at_idx").on(t.runId, t.createdAt),
  ]
);

export const runArtifacts = pgTable(
  "run_artifacts",
  {
    runId: uuid("run_id").notNull(),
    artifactKey: text("artifact_key").notNull(),
    artifactClass: text("artifact_class").notNull(),
    status: text("status").notNull(),
    metadata: jsonb("metadata").notNull().$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.runId],
      foreignColumns: [runs.id],
      name: "run_artifacts_run_id_runs_id_fk",
    }).onDelete("cascade"),
    primaryKey({ columns: [t.runId, t.artifactKey] }),
    index("run_artifacts_run_id_idx").on(t.runId),
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

// ── work item identity ──

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    slackUserId: text("slack_user_id"),
    githubLogin: text("github_login"),
    jiraAccountId: text("jira_account_id"),
    displayName: text("display_name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("users_slack_user_id_idx")
      .on(t.slackUserId)
      .where(sql`slack_user_id IS NOT NULL`),
    uniqueIndex("users_github_login_idx")
      .on(t.githubLogin)
      .where(sql`github_login IS NOT NULL`),
    uniqueIndex("users_jira_account_id_idx")
      .on(t.jiraAccountId)
      .where(sql`jira_account_id IS NOT NULL`),
  ]
);

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    slackChannelId: text("slack_channel_id").notNull(),
    slackUserGroupId: text("slack_user_group_id"),
    slackUserGroupHandle: text("slack_user_group_handle"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("teams_name_idx").on(t.name),
    uniqueIndex("teams_slack_channel_id_idx").on(t.slackChannelId),
    uniqueIndex("teams_slack_user_group_id_idx")
      .on(t.slackUserGroupId)
      .where(sql`slack_user_group_id IS NOT NULL`),
  ]
);

export const teamMembers = pgTable(
  "team_members",
  {
    teamId: uuid("team_id").notNull(),
    userId: uuid("user_id").notNull(),
    functionalRoles: text("functional_roles").array().notNull().default([]),
    membershipSource: text("membership_source").notNull().default("manual"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.teamId],
      foreignColumns: [teams.id],
      name: "team_members_team_id_teams_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.userId],
      foreignColumns: [users.id],
      name: "team_members_user_id_users_id_fk",
    }).onDelete("cascade"),
    primaryKey({ columns: [t.teamId, t.userId] }),
  ]
);

export const orgRoleAssignments = pgTable(
  "org_role_assignments",
  {
    userId: uuid("user_id").notNull(),
    orgRole: text("org_role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.userId],
      foreignColumns: [users.id],
      name: "org_role_assignments_user_id_users_id_fk",
    }).onDelete("cascade"),
    primaryKey({ columns: [t.userId, t.orgRole] }),
  ]
);

// ── work items ──

export const workItems = pgTable(
  "work_items",
  {
    id: uuid("id").primaryKey(),
    workflow: text("workflow").notNull(),
    state: text("state").notNull(),
    substate: text("substate"),
    flags: text("flags").array().notNull().default([]),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    ownerTeamId: uuid("owner_team_id").notNull(),
    homeChannelId: text("home_channel_id").notNull(),
    homeThreadTs: text("home_thread_ts").notNull(),
    originChannelId: text("origin_channel_id"),
    originThreadTs: text("origin_thread_ts"),
    jiraIssueKey: text("jira_issue_key"),
    githubPrNumber: integer("github_pr_number"),
    githubPrUrl: text("github_pr_url"),
    sourceWorkItemId: uuid("source_work_item_id"),
    createdByUserId: uuid("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      columns: [t.ownerTeamId],
      foreignColumns: [teams.id],
      name: "work_items_owner_team_id_teams_id_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.createdByUserId],
      foreignColumns: [users.id],
      name: "work_items_created_by_user_id_users_id_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.sourceWorkItemId],
      foreignColumns: [t.id],
      name: "work_items_source_work_item_id_work_items_id_fk",
    }).onDelete("set null"),
    index("work_items_workflow_state_idx").on(t.workflow, t.state),
    index("work_items_owner_team_idx").on(t.ownerTeamId),
    index("work_items_created_at_idx").on(t.createdAt),
    uniqueIndex("work_items_feature_delivery_jira_issue_key_idx")
      .on(t.jiraIssueKey)
      .where(sql`jira_issue_key IS NOT NULL AND workflow = 'feature_delivery'`),
    uniqueIndex("work_items_github_pr_number_idx")
      .on(t.githubPrNumber)
      .where(sql`github_pr_number IS NOT NULL`),
  ]
);

export const reviewRequests = pgTable(
  "review_requests",
  {
    id: uuid("id").primaryKey(),
    workItemId: uuid("work_item_id").notNull(),
    reviewRound: integer("review_round").notNull().default(1),
    type: text("type").notNull(),
    targetType: text("target_type").notNull(),
    targetRef: jsonb("target_ref").notNull().$type<Record<string, unknown>>().default({}),
    status: text("status").notNull(),
    outcome: text("outcome"),
    title: text("title").notNull(),
    requestMessage: text("request_message").notNull().default(""),
    focusPoints: jsonb("focus_points").notNull().$type<string[]>().default([]),
    requestedByUserId: uuid("requested_by_user_id").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.workItemId],
      foreignColumns: [workItems.id],
      name: "review_requests_work_item_id_work_items_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.requestedByUserId],
      foreignColumns: [users.id],
      name: "review_requests_requested_by_user_id_users_id_fk",
    }).onDelete("restrict"),
    index("review_requests_work_item_round_idx").on(t.workItemId, t.reviewRound),
    index("review_requests_status_idx").on(t.status),
  ]
);

export const reviewRequestComments = pgTable(
  "review_request_comments",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    reviewRequestId: uuid("review_request_id").notNull(),
    authorUserId: uuid("author_user_id"),
    source: text("source").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.reviewRequestId],
      foreignColumns: [reviewRequests.id],
      name: "review_request_comments_review_request_id_review_requests_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.authorUserId],
      foreignColumns: [users.id],
      name: "review_request_comments_author_user_id_users_id_fk",
    }).onDelete("set null"),
    index("review_request_comments_review_request_id_idx").on(t.reviewRequestId),
  ]
);

export const workItemEvents = pgTable(
  "work_item_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workItemId: uuid("work_item_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull().$type<Record<string, unknown>>().default({}),
    actorUserId: uuid("actor_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.workItemId],
      foreignColumns: [workItems.id],
      name: "work_item_events_work_item_id_work_items_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.actorUserId],
      foreignColumns: [users.id],
      name: "work_item_events_actor_user_id_users_id_fk",
    }).onDelete("set null"),
    index("work_item_events_work_item_id_created_at_idx").on(t.workItemId, t.createdAt),
  ]
);

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

export const dashboardAuthSessions = pgTable(
  "dashboard_auth_sessions",
  {
    id: uuid("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    principalType: text("principal_type").notNull(),
    userId: uuid("user_id"),
    authMethod: text("auth_method").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      columns: [t.userId],
      foreignColumns: [users.id],
      name: "dashboard_auth_sessions_user_id_users_id_fk",
    }).onDelete("cascade"),
    uniqueIndex("dashboard_auth_sessions_token_hash_idx").on(t.tokenHash),
    index("dashboard_auth_sessions_user_id_idx")
      .on(t.userId)
      .where(sql`user_id IS NOT NULL`),
    index("dashboard_auth_sessions_expires_at_idx").on(t.expiresAt),
    index("dashboard_auth_sessions_revoked_at_idx").on(t.revokedAt),
  ]
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

export const agentProfiles = pgTable(
  "agent_profiles",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    runtime: text("runtime").notNull(),
    provider: text("provider"),
    model: text("model"),
    tools: text("tools").array().notNull().default([]),
    mode: text("mode"),
    extensions: text("extensions").array().notNull().default([]),
    extraArgs: text("extra_args"),
    isBuiltIn: boolean("is_built_in").notNull().default(false),
    isActive: boolean("is_active").notNull().default(false),
    customCommandTemplate: text("custom_command_template"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("agent_profiles_active_idx").on(t.isActive),
    index("agent_profiles_runtime_idx").on(t.runtime),
  ]
);
