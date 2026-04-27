/**
 * Observer system tests — safety pipeline, trigger rules, run composer, source adapters.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHmac } from "node:crypto";
import { createTestDb } from "./helpers/test-db.js";

// ── Safety pipeline imports ──
import {
  buildDedupKey,
  getDedupTtl,
  checkRateLimit,
  checkBudget,
  checkPerRepoBudget,
  checkCooldown,
  checkRepoAllowlist,
  checkThresholds,
  runSafetyChecks
} from "../src/observer/safety.js";

// ── Trigger rules imports ──
import {
  loadTriggerRules,
  matchTriggerRule,
  evaluateCondition,
  TriggerRulesLoadError
} from "../src/observer/trigger-rules.js";

// ── Run composer imports ──
import { buildTask } from "../src/observer/run-composer.js";

// ── Source adapter imports ──
import { verifyGitHubSignature, parseGitHubWebhook } from "../src/observer/sources/github-webhook-adapter.js";
import { parseSlackAlert, type SlackMessageEvent, type SlackChannelAdapterConfig } from "../src/observer/sources/slack-channel-adapter.js";
import { mapSentryLevel } from "../src/observer/sources/sentry-poller.js";

// ── State store imports ──
import { ObserverStateStore } from "../src/observer/state-store.js";

import type { TriggerEvent, TriggerRule, RuleCondition } from "../src/observer/types.js";

// ─── Helpers ───

function makeSentryEvent(overrides?: Partial<TriggerEvent>): TriggerEvent {
  return {
    id: "test-sentry-1",
    source: "sentry_alert",
    timestamp: new Date().toISOString(),
    repoSlug: "org/repo",
    suggestedTask: "Fix sentry issue",
    priority: "high",
    rawPayload: {
      projectSlug: "my-project",
      fingerprint: "abc123",
      level: "error"
    },
    notificationTarget: { type: "slack", channelId: "C123" },
    ...overrides
  };
}

function makeGitHubCheckEvent(overrides?: Partial<TriggerEvent>): TriggerEvent {
  return {
    id: "test-gh-check-1",
    source: "github_webhook",
    timestamp: new Date().toISOString(),
    repoSlug: "org/repo",
    suggestedTask: "Fix CI failure",
    priority: "high",
    rawPayload: {
      eventType: "check_suite",
      repo: "org/repo",
      branch: "main",
      sha: "abc123"
    },
    notificationTarget: { type: "slack" },
    ...overrides
  };
}

function makeRule(overrides?: Partial<TriggerRule>): TriggerRule {
  return {
    id: "test-rule",
    source: "sentry_alert",
    conditions: [],
    requiresApproval: false,
    cooldownMinutes: 60,
    maxRunsPerHour: 5,
    ...overrides
  };
}

// ═══════════════════════════════════════════════════════
// Safety Pipeline Tests
// ═══════════════════════════════════════════════════════

describe("Safety Pipeline", () => {
  // ── buildDedupKey ──

  test("buildDedupKey: sentry_alert uses projectSlug:fingerprint", () => {
    const event = makeSentryEvent();
    const key = buildDedupKey(event);
    assert.equal(key, "sentry:my-project:abc123");
  });

  test("buildDedupKey: github check_suite uses repo:branch:sha", () => {
    const event = makeGitHubCheckEvent();
    const key = buildDedupKey(event);
    assert.equal(key, "gh:check:org/repo:main:abc123");
  });

  test("buildDedupKey: github PR review uses repo:prNumber:reviewId", () => {
    const event: TriggerEvent = {
      id: "test-gh-review-1",
      source: "github_webhook",
      timestamp: new Date().toISOString(),
      priority: "medium",
      rawPayload: {
        eventType: "pull_request_review",
        repo: "org/repo",
        prNumber: "42",
        reviewId: "99"
      },
      notificationTarget: { type: "slack" }
    };
    const key = buildDedupKey(event);
    assert.equal(key, "gh:review:org/repo:42:99");
  });

  test("buildDedupKey: slack_observer uses channelId:messageTs", () => {
    const event: TriggerEvent = {
      id: "test-slack-1",
      source: "slack_observer",
      timestamp: new Date().toISOString(),
      priority: "low",
      rawPayload: { channelId: "C123", messageTs: "1234.5678" },
      notificationTarget: { type: "slack" }
    };
    const key = buildDedupKey(event);
    assert.equal(key, "slack:C123:1234.5678");
  });

  // ── getDedupTtl ──

  test("getDedupTtl: sentry = 60 min, github = 30 min, slack = 30 min", () => {
    assert.equal(getDedupTtl("sentry_alert"), 60 * 60 * 1000);
    assert.equal(getDedupTtl("github_webhook"), 30 * 60 * 1000);
    assert.equal(getDedupTtl("slack_observer"), 30 * 60 * 1000);
  });

  // ── checkRateLimit ──

  test("checkRateLimit: allows when under limits", () => {
    const result = checkRateLimit("sentry_alert", [], Date.now());
    assert.equal(result.action, "allow");
  });

  test("checkRateLimit: denies when per-minute limit exceeded", () => {
    const now = Date.now();
    const timestamps = [now - 10_000, now - 20_000]; // 2 events in last minute
    const result = checkRateLimit("sentry_alert", timestamps, now);
    assert.equal(result.action, "deny");
    assert.match(result.reason, /per minute/);
  });

  test("checkRateLimit: denies when per-hour limit exceeded", () => {
    const now = Date.now();
    // 10 events spread across the last hour
    const timestamps = Array.from({ length: 10 }, (_, i) => now - (i + 1) * 5 * 60 * 1000);
    const result = checkRateLimit("sentry_alert", timestamps, now);
    assert.equal(result.action, "deny");
    assert.match(result.reason, /per hour/);
  });

  // ── checkBudget ──

  test("checkBudget: allows when under daily limit", () => {
    assert.equal(checkBudget(10, 50).action, "allow");
  });

  test("checkBudget: denies when at daily limit", () => {
    const result = checkBudget(50, 50);
    assert.equal(result.action, "deny");
    assert.match(result.reason, /daily budget/);
  });

  // ── checkPerRepoBudget ──

  test("checkPerRepoBudget: allows when under per-repo limit", () => {
    assert.equal(checkPerRepoBudget("org/repo", 3, 5).action, "allow");
  });

  test("checkPerRepoBudget: denies when at per-repo limit", () => {
    const result = checkPerRepoBudget("org/repo", 5, 5);
    assert.equal(result.action, "deny");
    assert.match(result.reason, /per-repo budget/);
  });

  // ── checkCooldown ──

  test("checkCooldown: allows when no previous run", () => {
    assert.equal(checkCooldown(undefined, 60).action, "allow");
  });

  test("checkCooldown: allows when cooldown expired", () => {
    const completedAt = Date.now() - 120 * 60 * 1000; // 2 hours ago
    assert.equal(checkCooldown(completedAt, 60).action, "allow");
  });

  test("checkCooldown: denies when within cooldown", () => {
    const completedAt = Date.now() - 10 * 60 * 1000; // 10 min ago
    const result = checkCooldown(completedAt, 60);
    assert.equal(result.action, "deny");
    assert.match(result.reason, /cooldown/);
  });

  // ── checkRepoAllowlist ──

  test("checkRepoAllowlist: allows when no allowlist configured", () => {
    assert.equal(checkRepoAllowlist("org/repo", []).action, "allow");
  });

  test("checkRepoAllowlist: allows when repo in allowlist", () => {
    assert.equal(checkRepoAllowlist("org/repo", ["org/repo", "org/other"]).action, "allow");
  });

  test("checkRepoAllowlist: denies when repo not in allowlist", () => {
    const result = checkRepoAllowlist("org/repo", ["org/other"]);
    assert.equal(result.action, "deny");
    assert.match(result.reason, /not in allowlist/);
  });

  // ── runSafetyChecks (integration) ──

  test("runSafetyChecks: allows clean event", () => {
    const event = makeSentryEvent();
    const rule = makeRule();
    const result = runSafetyChecks(event, rule, {
      isDuplicate: false,
      rateLimitTimestamps: [],
      dailyCount: 0,
      repoCount: 0,
      completedAt: undefined,
      maxDaily: 50,
      maxPerRepo: 5,
      repoAllowlist: []
    });
    assert.equal(result.action, "allow");
  });

  test("runSafetyChecks: denies duplicate", () => {
    const event = makeSentryEvent();
    const rule = makeRule();
    const result = runSafetyChecks(event, rule, {
      isDuplicate: true,
      rateLimitTimestamps: [],
      dailyCount: 0,
      repoCount: 0,
      completedAt: undefined,
      maxDaily: 50,
      maxPerRepo: 5,
      repoAllowlist: []
    });
    assert.equal(result.action, "deny");
    assert.match(result.reason, /duplicate/);
  });

  test("runSafetyChecks: denies when repo not in allowlist", () => {
    const event = makeSentryEvent({ repoSlug: "org/blocked" });
    const rule = makeRule();
    const result = runSafetyChecks(event, rule, {
      isDuplicate: false,
      rateLimitTimestamps: [],
      dailyCount: 0,
      repoCount: 0,
      completedAt: undefined,
      maxDaily: 50,
      maxPerRepo: 5,
      repoAllowlist: ["org/allowed"]
    });
    assert.equal(result.action, "deny");
    assert.match(result.reason, /not in allowlist/);
  });
});

// ═══════════════════════════════════════════════════════
// Trigger Rules Tests
// ═══════════════════════════════════════════════════════

describe("Trigger Rules", () => {
  let tmpDir: string;

  test("loadTriggerRules: returns empty array when file missing", async () => {
    const rules = await loadTriggerRules("/nonexistent/path.yml");
    assert.deepEqual(rules, []);
  });

  test("loadTriggerRules: parses valid YAML", async () => {
    tmpDir = path.join(tmpdir(), `gooseherd-test-${randomUUID().slice(0, 8)}`);
    await mkdir(tmpDir, { recursive: true });
    const yamlPath = path.join(tmpDir, "rules.yml");
    await writeFile(yamlPath, `
trigger_rules:
  - id: sentry-critical
    source: sentry_alert
    conditions:
      - field: rawPayload.level
        operator: equals
        value: fatal
    requiresApproval: false
    cooldownMinutes: 30
    maxRunsPerHour: 3
`);
    const rules = await loadTriggerRules(yamlPath);
    assert.equal(rules.length, 1);
    assert.equal(rules[0]!.id, "sentry-critical");
    assert.equal(rules[0]!.source, "sentry_alert");
    assert.equal(rules[0]!.conditions.length, 1);
    assert.equal(rules[0]!.cooldownMinutes, 30);
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("loadTriggerRules: allows unknown source with warning", async () => {
    tmpDir = path.join(tmpdir(), `gooseherd-test-${randomUUID().slice(0, 8)}`);
    await mkdir(tmpDir, { recursive: true });
    const yamlPath = path.join(tmpDir, "rules.yml");
    await writeFile(yamlPath, `
trigger_rules:
  - id: custom-rule
    source: datadog
    conditions: []
`);
    const rules = await loadTriggerRules(yamlPath);
    assert.equal(rules.length, 1);
    assert.equal(rules[0]!.id, "custom-rule");
    assert.equal(rules[0]!.source, "datadog");
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("loadTriggerRules: throws on empty source", async () => {
    tmpDir = path.join(tmpdir(), `gooseherd-test-${randomUUID().slice(0, 8)}`);
    await mkdir(tmpDir, { recursive: true });
    const yamlPath = path.join(tmpDir, "rules.yml");
    await writeFile(yamlPath, `
trigger_rules:
  - id: bad-rule
    source: "  "
    conditions: []
`);
    await assert.rejects(
      () => loadTriggerRules(yamlPath),
      (err: Error) => err instanceof TriggerRulesLoadError && err.message.includes("source must be a non-empty string")
    );
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("loadTriggerRules: throws on duplicate id", async () => {
    tmpDir = path.join(tmpdir(), `gooseherd-test-${randomUUID().slice(0, 8)}`);
    await mkdir(tmpDir, { recursive: true });
    const yamlPath = path.join(tmpDir, "rules.yml");
    await writeFile(yamlPath, `
trigger_rules:
  - id: same-id
    source: sentry_alert
    conditions: []
  - id: same-id
    source: github_webhook
    conditions: []
`);
    await assert.rejects(
      () => loadTriggerRules(yamlPath),
      (err: Error) => err instanceof TriggerRulesLoadError && err.message.includes("duplicate rule id")
    );
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── matchTriggerRule ──

  test("matchTriggerRule: matches first rule by source", () => {
    const event = makeSentryEvent();
    const rules = [
      makeRule({ id: "github-rule", source: "github_webhook" }),
      makeRule({ id: "sentry-rule", source: "sentry_alert" })
    ];
    const matched = matchTriggerRule(event, rules);
    assert.equal(matched?.id, "sentry-rule");
  });

  test("matchTriggerRule: returns null when no rules match", () => {
    const event = makeSentryEvent();
    const rules = [makeRule({ id: "github-rule", source: "github_webhook" })];
    assert.equal(matchTriggerRule(event, rules), null);
  });

  test("matchTriggerRule: checks conditions", () => {
    const event = makeSentryEvent({
      rawPayload: { projectSlug: "my-project", fingerprint: "abc", level: "fatal" }
    });
    const rules = [
      makeRule({
        id: "error-only",
        source: "sentry_alert",
        conditions: [{ field: "rawPayload.level", operator: "equals", value: "error" }]
      }),
      makeRule({
        id: "fatal-only",
        source: "sentry_alert",
        conditions: [{ field: "rawPayload.level", operator: "equals", value: "fatal" }]
      })
    ];
    const matched = matchTriggerRule(event, rules);
    assert.equal(matched?.id, "fatal-only");
  });

  // ── evaluateCondition ──

  test("evaluateCondition: equals operator", () => {
    const event = makeSentryEvent({ rawPayload: { level: "error" } });
    const cond: RuleCondition = { field: "rawPayload.level", operator: "equals", value: "error" };
    assert.equal(evaluateCondition(event, cond), true);
  });

  test("evaluateCondition: contains operator", () => {
    const event = makeSentryEvent({ suggestedTask: "Fix TypeError in handler" });
    const cond: RuleCondition = { field: "suggestedTask", operator: "contains", value: "TypeError" };
    assert.equal(evaluateCondition(event, cond), true);
  });

  test("evaluateCondition: matches operator (regex)", () => {
    const event = makeSentryEvent({ rawPayload: { title: "Error 503 Gateway" } });
    const cond: RuleCondition = { field: "rawPayload.title", operator: "matches", value: "Error \\d+" };
    assert.equal(evaluateCondition(event, cond), true);
  });

  test("evaluateCondition: exists operator", () => {
    const event = makeSentryEvent({ repoSlug: "org/repo" });
    assert.equal(
      evaluateCondition(event, { field: "repoSlug", operator: "exists" }),
      true
    );
    assert.equal(
      evaluateCondition(event, { field: "nonexistent", operator: "exists" }),
      false
    );
  });

  test("evaluateCondition: dot-path access to nested fields", () => {
    const event = makeSentryEvent({
      rawPayload: { data: { nested: { value: "deep" } } }
    });
    const cond: RuleCondition = {
      field: "rawPayload.data.nested.value",
      operator: "equals",
      value: "deep"
    };
    assert.equal(evaluateCondition(event, cond), true);
  });
});

// ═══════════════════════════════════════════════════════
// Run Composer Tests
// ═══════════════════════════════════════════════════════

describe("Run Composer", () => {
  test("buildTask: uses rule.task when present", () => {
    const event = makeSentryEvent({ suggestedTask: "event task" });
    const rule = makeRule({ task: "rule override task" });
    assert.equal(buildTask(event, rule), "rule override task");
  });

  test("buildTask: falls back to event.suggestedTask", () => {
    const event = makeSentryEvent({ suggestedTask: "event task" });
    const rule = makeRule();
    assert.equal(buildTask(event, rule), "event task");
  });

  test("buildTask: generates generic fallback when no task", () => {
    const event = makeSentryEvent({ suggestedTask: undefined });
    const rule = makeRule();
    const task = buildTask(event, rule);
    assert.match(task, /auto.*Fix issue/);
    assert.match(task, /sentry_alert/);
  });
});

// ═══════════════════════════════════════════════════════
// GitHub Webhook Adapter Tests
// ═══════════════════════════════════════════════════════

describe("GitHub Webhook Adapter", () => {
  test("verifyGitHubSignature: accepts valid signature", () => {
    const body = '{"test": true}';
    const secret = "test-secret";
    const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    assert.equal(verifyGitHubSignature(body, sig, secret), true);
  });

  test("verifyGitHubSignature: rejects invalid signature", () => {
    assert.equal(verifyGitHubSignature("body", "sha256=invalid", "secret"), false);
  });

  test("verifyGitHubSignature: rejects missing signature", () => {
    assert.equal(verifyGitHubSignature("body", undefined, "secret"), false);
  });

  test("parseGitHubWebhook: parses check_suite failure", () => {
    const payload = {
      action: "completed",
      check_suite: {
        head_branch: "main",
        head_sha: "abc123",
        conclusion: "failure",
        app: { name: "GitHub Actions" }
      },
      repository: { full_name: "org/repo" }
    };
    const event = parseGitHubWebhook(
      { "x-github-event": "check_suite", "x-github-delivery": "delivery-1" },
      payload
    );
    assert.ok(event);
    assert.equal(event.source, "github_webhook");
    assert.equal(event.repoSlug, "org/repo");
    assert.equal(event.baseBranch, "main");
    assert.match(event.suggestedTask ?? "", /CI failure/);
  });

  test("parseGitHubWebhook: ignores check_suite success", () => {
    const payload = {
      action: "completed",
      check_suite: { conclusion: "success", head_branch: "main", head_sha: "abc" },
      repository: { full_name: "org/repo" }
    };
    assert.equal(
      parseGitHubWebhook({ "x-github-event": "check_suite" }, payload),
      null
    );
  });

  test("parseGitHubWebhook: ignores PR review changes_requested", () => {
    const payload = {
      action: "submitted",
      review: {
        id: 99,
        state: "changes_requested",
        body: "Please fix the types",
        user: { login: "reviewer" }
      },
      pull_request: {
        number: 42,
        title: "Add feature",
        base: { ref: "main" }
      },
      repository: { full_name: "org/repo" }
    };
    assert.equal(
      parseGitHubWebhook(
        { "x-github-event": "pull_request_review", "x-github-delivery": "delivery-2" },
        payload
      ),
      null
    );
  });

  test("parseGitHubWebhook: ignores approved PR review", () => {
    const payload = {
      action: "submitted",
      review: { state: "approved", body: "LGTM", user: { login: "reviewer" } },
      pull_request: { number: 42, title: "Add feature", base: { ref: "main" } },
      repository: { full_name: "org/repo" }
    };
    assert.equal(
      parseGitHubWebhook({ "x-github-event": "pull_request_review" }, payload),
      null
    );
  });

  test("parseGitHubWebhook: ignores unknown event types", () => {
    assert.equal(
      parseGitHubWebhook({ "x-github-event": "push" }, { ref: "refs/heads/main" }),
      null
    );
  });
});

// ═══════════════════════════════════════════════════════
// Slack Channel Adapter Tests
// ═══════════════════════════════════════════════════════

describe("Slack Channel Adapter", () => {
  const baseConfig: SlackChannelAdapterConfig = {
    watchedChannels: ["C-alerts"],
    botAllowlist: [],
    repoMap: new Map([["my-project", "org/repo"]]),
    alertChannelId: "C-observer"
  };

  test("parseSlackAlert: parses bot message with attachment", () => {
    const msg: SlackMessageEvent = {
      type: "message",
      bot_id: "B123",
      bot_profile: { name: "Sentry" },
      text: "New alert",
      channel: "C-alerts",
      ts: "1234567890.123456",
      attachments: [{
        title: "TypeError: Cannot read property 'foo'",
        text: "Error in handler.ts:42",
        title_link: "https://sentry.io/issue/123",
        color: "danger",
        fields: [{ title: "Project", value: "my-project" }]
      }]
    };
    const event = parseSlackAlert(msg, baseConfig);
    assert.ok(event);
    assert.equal(event.source, "slack_observer");
    assert.equal(event.repoSlug, "org/repo");
    assert.match(event.suggestedTask ?? "", /TypeError/);
  });

  test("parseSlackAlert: ignores non-bot messages", () => {
    const msg: SlackMessageEvent = {
      type: "message",
      text: "Hello",
      channel: "C-alerts",
      ts: "123.456"
    };
    assert.equal(parseSlackAlert(msg, baseConfig), null);
  });

  test("parseSlackAlert: ignores messages from non-watched channels", () => {
    const msg: SlackMessageEvent = {
      type: "message",
      bot_id: "B123",
      text: "Alert",
      channel: "C-random",
      ts: "123.456"
    };
    assert.equal(parseSlackAlert(msg, baseConfig), null);
  });

  test("parseSlackAlert: respects bot allowlist", () => {
    const config = { ...baseConfig, botAllowlist: ["B-allowed"] };
    const msg: SlackMessageEvent = {
      type: "message",
      bot_id: "B-blocked",
      bot_profile: { name: "Unknown Bot" },
      text: "Alert",
      channel: "C-alerts",
      ts: "123.456"
    };
    assert.equal(parseSlackAlert(msg, config), null);
  });
});

// ═══════════════════════════════════════════════════════
// Sentry Poller Tests
// ═══════════════════════════════════════════════════════

describe("Sentry Poller", () => {
  test("mapSentryLevel: maps levels to priorities", () => {
    assert.equal(mapSentryLevel("fatal"), "critical");
    assert.equal(mapSentryLevel("error"), "high");
    assert.equal(mapSentryLevel("warning"), "medium");
    assert.equal(mapSentryLevel("info"), "low");
    assert.equal(mapSentryLevel("debug"), "low");
  });
});

// ═══════════════════════════════════════════════════════
// State Store Tests
// ═══════════════════════════════════════════════════════

describe("ObserverStateStore", { concurrency: 1 }, () => {
  async function makeStore(): Promise<{ store: ObserverStateStore; cleanup: () => Promise<void> }> {
    const testDb = await createTestDb();
    const store = new ObserverStateStore(testDb.db);
    await store.load();
    return { store, cleanup: testDb.cleanup };
  }

  test("state store: load initializes empty state when no file", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);
    assert.equal(await store.getDailyCount(), 0);
    assert.equal(await store.hasDedup("test"), false);
  });

  test("state store: dedup set/has/sweep lifecycle", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    // Set a dedup entry with long TTL
    await store.setDedup("key1", 60_000);
    assert.equal(await store.hasDedup("key1"), true);

    // Set one with 0 TTL (already expired)
    await store.setDedup("key2", 0);
    // hasDedup triggers expiry check
    assert.equal(await store.hasDedup("key2"), false);
  });

  test("state store: daily counter increments and resets", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    await store.incrementDailyCount("org/repo");
    await store.incrementDailyCount("org/repo");
    await store.incrementDailyCount("org/other");

    assert.equal(await store.getDailyCount(), 3);
    assert.equal(await store.getDailyPerRepoCount("org/repo"), 2);
    assert.equal(await store.getDailyPerRepoCount("org/other"), 1);
  });

  test("state store: flush and reload preserves state (DB is immediate)", async (t) => {
    const testDb = await createTestDb();
    t.after(async () => { await testDb.cleanup(); });

    const store = new ObserverStateStore(testDb.db);
    await store.load();

    await store.setDedup("persist-key", 300_000, "run-1");
    await store.incrementDailyCount("org/repo");
    await store.addRateLimitEvent("sentry_alert", Date.now());
    await store.flush();

    // Reload into a fresh store on same DB
    const store2 = new ObserverStateStore(testDb.db);
    await store2.load();
    assert.equal(await store2.hasDedup("persist-key"), true);
    assert.equal(await store2.getDailyCount(), 1);
    assert.equal((await store2.getRateLimitEvents("sentry_alert")).length, 1);
  });

  test("state store: rate limit events prune old entries", async (t) => {
    const { store: s, cleanup } = await makeStore();
    t.after(cleanup);

    const now = Date.now();
    await s.addRateLimitEvent("sentry_alert", now - 120 * 60 * 1000); // 2h ago
    await s.addRateLimitEvent("sentry_alert", now - 10 * 1000); // 10s ago

    const beforePrune = await s.getRateLimitEvents("sentry_alert");
    assert.equal(beforePrune.length, 2, `expected 2 before prune, got ${String(beforePrune.length)}`);

    await s.pruneRateLimitEvents("sentry_alert", 60 * 60 * 1000); // 1h window

    const afterPrune = await s.getRateLimitEvents("sentry_alert");
    assert.equal(afterPrune.length, 1, `expected 1 after prune, got ${String(afterPrune.length)}`);
  });

  test("state store: markDedupCompleted sets completedAt", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    await store.setDedup("key1", 60_000, "run-abc");
    await store.markDedupCompleted("run-abc", "success");

    const entry = await store.getDedupEntry("key1");
    assert.ok(entry);
    assert.ok(entry.completedAt);
    assert.ok(entry.completedAt > 0);
  });
});

// ═══════════════════════════════════════════════════════
// Threshold Safety Checks
// ═══════════════════════════════════════════════════════

describe("checkThresholds", () => {
  test("allows when no thresholds configured", () => {
    const event = makeSentryEvent();
    const rule = makeRule();
    const result = checkThresholds(event, rule);
    assert.equal(result.action, "allow");
  });

  test("denies when occurrences below minOccurrences", () => {
    const event = makeSentryEvent({ rawPayload: { occurrences: 2 } });
    const rule = makeRule({ minOccurrences: 5 });
    const result = checkThresholds(event, rule);
    assert.equal(result.action, "deny");
    assert.ok(result.reason.includes("minimum occurrences"));
  });

  test("allows when occurrences meet minOccurrences", () => {
    const event = makeSentryEvent({ rawPayload: { occurrences: 10 } });
    const rule = makeRule({ minOccurrences: 5 });
    const result = checkThresholds(event, rule);
    assert.equal(result.action, "allow");
  });

  test("denies when issue too young for minAgeMinutes", () => {
    const recentDate = new Date(Date.now() - 5 * 60_000).toISOString(); // 5 min ago
    const event = makeSentryEvent({ rawPayload: { firstSeen: recentDate } });
    const rule = makeRule({ minAgeMinutes: 30 });
    const result = checkThresholds(event, rule);
    assert.equal(result.action, "deny");
    assert.ok(result.reason.includes("minimum age"));
  });

  test("allows when issue old enough for minAgeMinutes", () => {
    const oldDate = new Date(Date.now() - 60 * 60_000).toISOString(); // 60 min ago
    const event = makeSentryEvent({ rawPayload: { firstSeen: oldDate } });
    const rule = makeRule({ minAgeMinutes: 30 });
    const result = checkThresholds(event, rule);
    assert.equal(result.action, "allow");
  });

  test("denies when user count below minUserCount", () => {
    const event = makeSentryEvent({ rawPayload: { userCount: 1 } });
    const rule = makeRule({ minUserCount: 5 });
    const result = checkThresholds(event, rule);
    assert.equal(result.action, "deny");
    assert.ok(result.reason.includes("minimum user count"));
  });

  test("allows when user count meets minUserCount", () => {
    const event = makeSentryEvent({ rawPayload: { userCount: 10 } });
    const rule = makeRule({ minUserCount: 5 });
    const result = checkThresholds(event, rule);
    assert.equal(result.action, "allow");
  });

  test("runSafetyChecks checks thresholds before rate limits", () => {
    const event = makeSentryEvent({ rawPayload: { occurrences: 1 } });
    const rule = makeRule({ minOccurrences: 10 });
    const result = runSafetyChecks(event, rule, {
      isDuplicate: false,
      rateLimitTimestamps: [],
      dailyCount: 0,
      repoCount: 0,
      completedAt: undefined,
      maxDaily: 50,
      maxPerRepo: 5,
      repoAllowlist: []
    });
    assert.equal(result.action, "deny");
    assert.ok(result.reason.includes("minimum occurrences"));
  });
});

// ═══════════════════════════════════════════════════════
// Trigger Rules: threshold field parsing
// ═══════════════════════════════════════════════════════

describe("loadTriggerRules: threshold fields", () => {
  test("parses minOccurrences, minAgeMinutes, minUserCount from YAML", async () => {
    const dir = path.join(tmpdir(), `rules-threshold-${randomUUID().slice(0, 8)}`);
    await mkdir(dir, { recursive: true });
    const rulesPath = path.join(dir, "rules.yml");

    await writeFile(rulesPath, `
trigger_rules:
  - id: sentry-with-thresholds
    source: sentry_alert
    minOccurrences: 5
    minAgeMinutes: 15
    minUserCount: 3
    conditions: []
`, "utf8");

    const rules = await loadTriggerRules(rulesPath);
    assert.equal(rules.length, 1);
    assert.equal(rules[0]!.minOccurrences, 5);
    assert.equal(rules[0]!.minAgeMinutes, 15);
    assert.equal(rules[0]!.minUserCount, 3);

    await rm(dir, { recursive: true, force: true });
  });

  test("threshold fields default to undefined when not set", async () => {
    const dir = path.join(tmpdir(), `rules-no-threshold-${randomUUID().slice(0, 8)}`);
    await mkdir(dir, { recursive: true });
    const rulesPath = path.join(dir, "rules.yml");

    await writeFile(rulesPath, `
trigger_rules:
  - id: basic-rule
    source: sentry_alert
    conditions: []
`, "utf8");

    const rules = await loadTriggerRules(rulesPath);
    assert.equal(rules.length, 1);
    assert.equal(rules[0]!.minOccurrences, undefined);
    assert.equal(rules[0]!.minAgeMinutes, undefined);
    assert.equal(rules[0]!.minUserCount, undefined);

    await rm(dir, { recursive: true, force: true });
  });
});
