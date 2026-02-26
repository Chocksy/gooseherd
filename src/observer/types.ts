/**
 * Observer/Trigger system types.
 *
 * The observer watches external sources (Sentry, GitHub, Slack channels)
 * and produces TriggerEvents that flow through a safety pipeline into
 * RunManager.enqueueRun().
 */

// ── Trigger sources ──

export type TriggerSource =
  | "sentry_alert"
  | "github_webhook"
  | "slack_observer";

export type TriggerPriority = "low" | "medium" | "high" | "critical";

// ── TriggerEvent ──

export interface TriggerEvent {
  /** Unique event ID (for deduplication) */
  id: string;
  source: TriggerSource;
  timestamp: string;
  repoSlug?: string;
  suggestedTask?: string;
  baseBranch?: string;
  priority: TriggerPriority;
  rawPayload: unknown;
  /** Pipeline hint: "bugfix" | "chore" | "follow-up" */
  pipelineHint?: string;
  /** Where to send notifications about this trigger */
  notificationTarget: {
    type: "slack" | "dashboard_only";
    channelId?: string;
  };
}

// ── Trigger rules ──

export type ConditionOperator = "equals" | "contains" | "matches" | "exists";

export interface RuleCondition {
  field: string;
  operator: ConditionOperator;
  value?: string;
}

export interface TriggerRule {
  id: string;
  source: TriggerSource;
  conditions: RuleCondition[];
  pipeline?: string;
  requiresApproval: boolean;
  notificationChannel?: string;
  cooldownMinutes: number;
  maxRunsPerHour: number;
  /** Override repo slug for this rule */
  repoSlug?: string;
  /** Override task for this rule */
  task?: string;
  /** Override base branch */
  baseBranch?: string;
  /** Skip smart triage for high-confidence rules (e.g. cron triggers) */
  skipTriage?: boolean;
  /** Minimum occurrences before triggering (prevents one-off noise) */
  minOccurrences?: number;
  /** Minimum age in minutes before triggering (debounce new issues) */
  minAgeMinutes?: number;
  /** Minimum affected user count before triggering */
  minUserCount?: number;
}

// ── Safety pipeline ──

export interface SafetyDecision {
  action: "allow" | "deny";
  reason: string;
}

export interface RateLimitCounters {
  /** Timestamps of recent events per source */
  events: Map<TriggerSource, number[]>;
  /** Daily run count (global) */
  dailyCount: number;
  /** Daily run count per repo */
  dailyPerRepo: Map<string, number>;
  /** Day string for counter reset (YYYY-MM-DD) */
  counterDay: string;
}

// ── Smart triage decision ──

export interface ObserverDecision {
  action: "trigger" | "discard" | "defer" | "escalate";
  confidence: number;
  task?: string;
  pipeline?: string;
  priority?: TriggerPriority;
  reason: string;
}

// ── Dedup store entry ──

export interface DedupEntry {
  seenAt: number;
  ttlMs: number;
  /** Run ID if a run was created for this dedup key */
  runId?: string;
  /** Trigger rule that matched this event */
  ruleId?: string;
  /** Timestamp when the run completed (for cooldown) */
  completedAt?: number;
}

/** Per-rule outcome stats for the learning loop. */
export interface RuleOutcomeStats {
  success: number;
  failure: number;
  lastOutcome: string;
  lastAt: string;
}

// ── Observer state snapshot (for dashboard) ──

export interface ObserverStateSnapshot {
  dedupCount: number;
  activeDedups: number;
  dailyCount: number;
  dailyPerRepo: Record<string, number>;
  counterDay: string;
  ruleOutcomes: Record<string, RuleOutcomeStats>;
  rateLimitSources: Record<string, number>;
}

/** Processed event record for the dashboard event feed. */
export interface ObserverEventRecord {
  eventId: string;
  source: TriggerSource;
  timestamp: string;
  repoSlug?: string;
  matchedRuleId?: string;
  outcome: "triggered" | "denied" | "no_match" | "approval_required";
  reason: string;
  runId?: string;
  processedAt: string;
}

// ── Observer state (persisted to disk) ──

export interface ObserverState {
  dedupEntries: Record<string, DedupEntry>;
  rateLimitEvents: Record<string, number[]>;
  dailyCount: number;
  dailyPerRepo: Record<string, number>;
  counterDay: string;
  /** Last poll timestamp per Sentry project */
  sentryLastPoll: Record<string, string>;
  /** Last checked workflow run ID per GitHub repo */
  githubLastRunId: Record<string, number>;
  /** Per-rule outcome tracking for the learning loop */
  ruleOutcomes: Record<string, RuleOutcomeStats>;
}
