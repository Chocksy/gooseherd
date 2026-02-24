/**
 * Observer safety pipeline — pure functions for dedup, rate limiting, budget, cooldown.
 *
 * All functions are pure (side-effect-free) and testable without external dependencies.
 * The ObserverStateStore handles persistence; these functions only read/check state.
 */

import type { TriggerEvent, TriggerRule, SafetyDecision, TriggerSource } from "./types.js";

// ── Rate limit defaults per source (per hour) ──

const DEFAULT_RATE_LIMITS: Record<TriggerSource, { perMinute: number; perHour: number }> = {
  sentry_alert: { perMinute: 2, perHour: 10 },
  github_webhook: { perMinute: 3, perHour: 15 },
  slack_observer: { perMinute: 1, perHour: 5 }
};

// ── Dedup key TTLs (milliseconds) ──

const DEDUP_TTL: Record<TriggerSource, number> = {
  sentry_alert: 60 * 60 * 1000,      // 60 minutes
  github_webhook: 30 * 60 * 1000,    // 30 minutes
  slack_observer: 30 * 60 * 1000     // 30 minutes
};

// ── Pure functions ──

/**
 * Build a dedup key for a TriggerEvent.
 *
 * Keys are source-specific:
 * - Sentry: sentry:${projectSlug}:${fingerprint}
 * - GitHub check_suite: gh:check:${repo}:${branch}:${sha}
 * - GitHub PR review: gh:review:${repo}:${prNumber}:${reviewId}
 * - Slack: slack:${channelId}:${messageTs}
 */
export function buildDedupKey(event: TriggerEvent): string {
  const payload = event.rawPayload as Record<string, unknown>;

  switch (event.source) {
    case "sentry_alert": {
      const data = payload as Record<string, unknown>;
      const projectSlug = String(data["projectSlug"] ?? "unknown");
      const fingerprint = String(data["fingerprint"] ?? event.id);
      return `sentry:${projectSlug}:${fingerprint}`;
    }
    case "github_webhook": {
      const eventType = String(payload["eventType"] ?? "unknown");
      if (eventType === "check_suite") {
        const repo = String(payload["repo"] ?? "");
        const branch = String(payload["branch"] ?? "");
        const sha = String(payload["sha"] ?? "");
        return `gh:check:${repo}:${branch}:${sha}`;
      }
      // PR review — unique per review ID
      const repo = String(payload["repo"] ?? "");
      const prNumber = String(payload["prNumber"] ?? "");
      const reviewId = String(payload["reviewId"] ?? event.id);
      return `gh:review:${repo}:${prNumber}:${reviewId}`;
    }
    case "slack_observer": {
      const channelId = String(payload["channelId"] ?? "");
      const messageTs = String(payload["messageTs"] ?? event.id);
      return `slack:${channelId}:${messageTs}`;
    }
    default:
      return `unknown:${event.id}`;
  }
}

/**
 * Get the TTL for a dedup entry based on event source.
 */
export function getDedupTtl(source: TriggerSource): number {
  return DEDUP_TTL[source] ?? 30 * 60 * 1000;
}

/**
 * Check per-source rate limit against sliding window.
 *
 * @param source - event source
 * @param recentTimestamps - timestamps of recent events for this source
 * @param now - current timestamp
 * @returns SafetyDecision
 */
export function checkRateLimit(
  source: TriggerSource,
  recentTimestamps: number[],
  now: number = Date.now()
): SafetyDecision {
  const limits = DEFAULT_RATE_LIMITS[source];
  if (!limits) {
    return { action: "allow", reason: "no rate limit configured" };
  }

  // Check per-minute limit
  const oneMinuteAgo = now - 60 * 1000;
  const recentMinute = recentTimestamps.filter(t => t > oneMinuteAgo).length;
  if (recentMinute >= limits.perMinute) {
    return { action: "deny", reason: `rate limit: ${String(recentMinute)}/${String(limits.perMinute)} per minute for ${source}` };
  }

  // Check per-hour limit
  const oneHourAgo = now - 60 * 60 * 1000;
  const recentHour = recentTimestamps.filter(t => t > oneHourAgo).length;
  if (recentHour >= limits.perHour) {
    return { action: "deny", reason: `rate limit: ${String(recentHour)}/${String(limits.perHour)} per hour for ${source}` };
  }

  return { action: "allow", reason: "within rate limits" };
}

/**
 * Check global daily budget.
 */
export function checkBudget(dailyCount: number, maxDaily: number): SafetyDecision {
  if (dailyCount >= maxDaily) {
    return { action: "deny", reason: `daily budget exhausted: ${String(dailyCount)}/${String(maxDaily)} runs today` };
  }
  return { action: "allow", reason: "within daily budget" };
}

/**
 * Check per-repo daily budget.
 */
export function checkPerRepoBudget(
  repoSlug: string,
  repoCount: number,
  maxPerRepo: number
): SafetyDecision {
  if (repoCount >= maxPerRepo) {
    return { action: "deny", reason: `per-repo budget exhausted: ${repoSlug} has ${String(repoCount)}/${String(maxPerRepo)} runs today` };
  }
  return { action: "allow", reason: "within per-repo budget" };
}

/**
 * Check cooldown after a previous run completed for this dedup key.
 */
export function checkCooldown(
  completedAt: number | undefined,
  cooldownMinutes: number,
  now: number = Date.now()
): SafetyDecision {
  if (completedAt === undefined) {
    return { action: "allow", reason: "no previous run completed" };
  }
  const cooldownMs = cooldownMinutes * 60 * 1000;
  const elapsed = now - completedAt;
  if (elapsed < cooldownMs) {
    const remaining = Math.ceil((cooldownMs - elapsed) / 60_000);
    return { action: "deny", reason: `cooldown active: ${String(remaining)} minutes remaining` };
  }
  return { action: "allow", reason: "cooldown expired" };
}

/**
 * Check if repo is in the allowlist (if allowlist is configured).
 */
export function checkRepoAllowlist(
  repoSlug: string,
  allowlist: string[]
): SafetyDecision {
  if (allowlist.length === 0) {
    return { action: "allow", reason: "no repo allowlist configured" };
  }
  if (allowlist.includes(repoSlug)) {
    return { action: "allow", reason: "repo in allowlist" };
  }
  return { action: "deny", reason: `repo ${repoSlug} not in allowlist` };
}

/**
 * Run the full safety pipeline for a trigger event.
 *
 * Returns the first denial reason, or "allow" if all checks pass.
 * Callers should update the state store based on the result.
 */
export function runSafetyChecks(
  event: TriggerEvent,
  rule: TriggerRule,
  opts: {
    isDuplicate: boolean;
    rateLimitTimestamps: number[];
    dailyCount: number;
    repoCount: number;
    completedAt: number | undefined;
    maxDaily: number;
    maxPerRepo: number;
    repoAllowlist: string[];
  }
): SafetyDecision {
  const repoSlug = event.repoSlug ?? rule.repoSlug ?? "";

  // 1. Dedup
  if (opts.isDuplicate) {
    return { action: "deny", reason: "duplicate event" };
  }

  // 2. Repo allowlist
  if (repoSlug) {
    const allowResult = checkRepoAllowlist(repoSlug, opts.repoAllowlist);
    if (allowResult.action === "deny") return allowResult;
  }

  // 3. Rate limit
  const rateResult = checkRateLimit(event.source, opts.rateLimitTimestamps);
  if (rateResult.action === "deny") return rateResult;

  // 4. Global budget
  const budgetResult = checkBudget(opts.dailyCount, opts.maxDaily);
  if (budgetResult.action === "deny") return budgetResult;

  // 5. Per-repo budget
  if (repoSlug) {
    const repoResult = checkPerRepoBudget(repoSlug, opts.repoCount, opts.maxPerRepo);
    if (repoResult.action === "deny") return repoResult;
  }

  // 6. Cooldown
  const cooldownResult = checkCooldown(
    opts.completedAt,
    rule.cooldownMinutes
  );
  if (cooldownResult.action === "deny") return cooldownResult;

  return { action: "allow", reason: "all safety checks passed" };
}
