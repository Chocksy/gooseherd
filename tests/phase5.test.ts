/**
 * Phase 5 tests — scope judge, smart triage, browser verify, per-repo config.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// ── Scope Judge imports ──
import {
  buildScopeJudgeSystemPrompt,
  buildScopeJudgeUserMessage,
  parseScopeJudgeResponse,
  type ScopeJudgeResult
} from "../src/pipeline/quality-gates/scope-judge.js";

// ── Smart Triage imports ──
import {
  buildTriageSystemPrompt,
  buildTriageUserMessage,
  parseTriageResponse
} from "../src/observer/smart-triage.js";
import type { TriggerEvent, TriggerRule, ObserverDecision } from "../src/observer/types.js";

// ── Browser Verify imports ──
import {
  parsePa11yOutput,
  buildSmokeCheck,
  aggregateChecks,
  resolveReviewAppUrl
} from "../src/pipeline/quality-gates/browser-verify.js";

// ── Per-Repo Config imports ──
import {
  parseRepoConfigYaml,
  type RepoConfig,
  type RepoQualityGateOverrides
} from "../src/pipeline/repo-config.js";


// ═══════════════════════════════════════════════
// Scope Judge
// ═══════════════════════════════════════════════

describe("Scope Judge", () => {

  test("buildScopeJudgeSystemPrompt: contains calibration guidance", () => {
    const prompt = buildScopeJudgeSystemPrompt();
    assert.ok(prompt.includes("CALIBRATION"));
    assert.ok(prompt.includes("Prefer PASS"));
    assert.ok(prompt.includes("ScopeJudge"));
    // Should specify JSON response format
    assert.ok(prompt.includes('"decision"'));
    assert.ok(prompt.includes('"score"'));
    assert.ok(prompt.includes('"violations"'));
  });

  test("buildScopeJudgeUserMessage: includes task and diff", () => {
    const msg = buildScopeJudgeUserMessage(
      "Fix login bug",
      "+  if (user.isActive) { return true; }",
      ["src/auth.ts"]
    );
    assert.ok(msg.includes("Fix login bug"));
    assert.ok(msg.includes("src/auth.ts"));
    assert.ok(msg.includes("user.isActive"));
    assert.ok(msg.includes("## Original Task"));
    assert.ok(msg.includes("## Changed Files"));
    assert.ok(msg.includes("## Diff"));
  });

  test("buildScopeJudgeUserMessage: truncates long diffs", () => {
    const longDiff = "x".repeat(10000);
    const msg = buildScopeJudgeUserMessage("task", longDiff, ["file.ts"]);
    // Should truncate to 8000 chars + truncation notice
    assert.ok(msg.includes("diff truncated"));
    assert.ok(msg.includes("2000 chars omitted"));
  });

  test("parseScopeJudgeResponse: parses valid pass response", () => {
    const result = parseScopeJudgeResponse({
      decision: "pass",
      score: 85,
      confidence: 0.9,
      violations: [],
      reason: "All changes are on-scope"
    });
    assert.equal(result.decision, "pass");
    assert.equal(result.score, 85);
    assert.equal(result.confidence, 0.9);
    assert.equal(result.violations.length, 0);
    assert.equal(result.reason, "All changes are on-scope");
  });

  test("parseScopeJudgeResponse: parses soft_fail with violations", () => {
    const result = parseScopeJudgeResponse({
      decision: "soft_fail",
      score: 40,
      confidence: 0.8,
      violations: [
        { file: "unrelated.ts", message: "Not connected to task", fixHint: "Remove this file" }
      ],
      reason: "Some off-scope changes detected"
    });
    assert.equal(result.decision, "soft_fail");
    assert.equal(result.score, 40);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].file, "unrelated.ts");
    assert.equal(result.violations[0].fixHint, "Remove this file");
  });

  test("parseScopeJudgeResponse: fail-open on null/undefined", () => {
    const result = parseScopeJudgeResponse(null);
    assert.equal(result.decision, "pass");
    assert.equal(result.score, 100);
    assert.equal(result.confidence, 0);
    assert.ok(result.reason.includes("fail-open"));
  });

  test("parseScopeJudgeResponse: fail-open on invalid decision", () => {
    const result = parseScopeJudgeResponse({ decision: "banana", score: 50 });
    assert.equal(result.decision, "pass");
    assert.ok(result.reason.includes("fail-open"));
  });

  test("parseScopeJudgeResponse: defaults score and confidence when missing", () => {
    const result = parseScopeJudgeResponse({ decision: "pass" });
    assert.equal(result.decision, "pass");
    assert.equal(result.score, 100);       // default
    assert.equal(result.confidence, 0.5);  // default
    assert.deepEqual(result.violations, []);
  });

  test("parseScopeJudgeResponse: filters invalid violations", () => {
    const result = parseScopeJudgeResponse({
      decision: "soft_fail",
      score: 30,
      violations: [
        { file: "valid.ts", message: "ok" },            // valid
        { file: 123, message: "bad file type" },         // invalid (file not string)
        { message: "no file field" },                     // invalid (missing file)
        { file: "also-valid.ts", message: "also ok" }    // valid
      ]
    });
    assert.equal(result.violations.length, 2);
    assert.equal(result.violations[0].file, "valid.ts");
    assert.equal(result.violations[1].file, "also-valid.ts");
  });

  test("parseScopeJudgeResponse: clamps score to [0, 100]", () => {
    const r1 = parseScopeJudgeResponse({ decision: "pass", score: 150 });
    assert.equal(r1.score, 100);

    const r2 = parseScopeJudgeResponse({ decision: "pass", score: -50 });
    assert.equal(r2.score, 0);
  });

  test("parseScopeJudgeResponse: clamps confidence to [0, 1]", () => {
    const r1 = parseScopeJudgeResponse({ decision: "pass", confidence: 5.0 });
    assert.equal(r1.confidence, 1.0);

    const r2 = parseScopeJudgeResponse({ decision: "pass", confidence: -1.0 });
    assert.equal(r2.confidence, 0);
  });

  test("parseScopeJudgeResponse: hard_fail decision", () => {
    const result = parseScopeJudgeResponse({
      decision: "hard_fail",
      score: 10,
      confidence: 0.95,
      violations: [{ file: ".env", message: "Hardcoded secret" }],
      reason: "Security risk"
    });
    assert.equal(result.decision, "hard_fail");
    assert.equal(result.score, 10);
    assert.equal(result.confidence, 0.95);
  });

});


// ═══════════════════════════════════════════════
// Smart Observer Triage
// ═══════════════════════════════════════════════

describe("Smart Triage", () => {

  const sampleRules: TriggerRule[] = [
    {
      id: "sentry-errors",
      source: "sentry_alert",
      conditions: [],
      requiresApproval: false,
      cooldownMinutes: 60,
      maxRunsPerHour: 5,
      repoSlug: "org/repo"
    },
    {
      id: "github-ci",
      source: "github_webhook",
      conditions: [],
      requiresApproval: true,
      cooldownMinutes: 30,
      maxRunsPerHour: 10
    }
  ];

  const sampleEvent: TriggerEvent = {
    id: "evt-123",
    source: "sentry_alert",
    timestamp: new Date().toISOString(),
    repoSlug: "org/repo",
    suggestedTask: "Fix NPE in UserService",
    priority: "high",
    rawPayload: { title: "NullPointerException" },
    notificationTarget: { type: "slack", channelId: "C123" }
  };

  test("buildTriageSystemPrompt: includes all rules", () => {
    const prompt = buildTriageSystemPrompt(sampleRules);
    assert.ok(prompt.includes("sentry-errors"));
    assert.ok(prompt.includes("github-ci"));
    assert.ok(prompt.includes("event triage agent"));
    // Should include action options
    assert.ok(prompt.includes('"trigger"'));
    assert.ok(prompt.includes('"discard"'));
    assert.ok(prompt.includes('"defer"'));
    assert.ok(prompt.includes('"escalate"'));
  });

  test("buildTriageUserMessage: includes event details", () => {
    const msg = buildTriageUserMessage(sampleEvent);
    assert.ok(msg.includes("sentry_alert"));
    assert.ok(msg.includes("evt-123"));
    assert.ok(msg.includes("org/repo"));
    assert.ok(msg.includes("Fix NPE in UserService"));
    assert.ok(msg.includes("NullPointerException"));
  });

  test("buildTriageUserMessage: truncates large payloads", () => {
    const largeEvent = {
      ...sampleEvent,
      rawPayload: { data: "x".repeat(3000) }
    };
    const msg = buildTriageUserMessage(largeEvent);
    assert.ok(msg.includes("..."));
    // Should be significantly shorter than raw 3000 chars
    assert.ok(msg.length < 3500);
  });

  test("parseTriageResponse: parses valid trigger response", () => {
    const result = parseTriageResponse({
      action: "trigger",
      confidence: 0.85,
      task: "Fix the null pointer in UserService.getProfile()",
      pipeline: "bugfix",
      priority: "high",
      reason: "Clear error report"
    });
    assert.equal(result.action, "trigger");
    assert.equal(result.confidence, 0.85);
    assert.equal(result.task, "Fix the null pointer in UserService.getProfile()");
    assert.equal(result.pipeline, "bugfix");
    assert.equal(result.priority, "high");
  });

  test("parseTriageResponse: parses discard response", () => {
    const result = parseTriageResponse({
      action: "discard",
      confidence: 0.95,
      reason: "Duplicate alert"
    });
    assert.equal(result.action, "discard");
    assert.equal(result.confidence, 0.95);
    assert.equal(result.task, undefined);
    assert.equal(result.reason, "Duplicate alert");
  });

  test("parseTriageResponse: fail-toward-action on null", () => {
    const result = parseTriageResponse(null);
    assert.equal(result.action, "trigger");
    assert.equal(result.confidence, 0);
    assert.ok(result.reason.includes("fail-toward-action"));
  });

  test("parseTriageResponse: fail-toward-action on invalid action", () => {
    const result = parseTriageResponse({ action: "unknown" });
    assert.equal(result.action, "trigger");
    assert.equal(result.confidence, 0);
  });

  test("parseTriageResponse: clamps confidence to [0, 1]", () => {
    const result1 = parseTriageResponse({ action: "trigger", confidence: 5.0 });
    assert.equal(result1.confidence, 1.0);

    const result2 = parseTriageResponse({ action: "trigger", confidence: -2.0 });
    assert.equal(result2.confidence, 0);
  });

  test("parseTriageResponse: ignores invalid priority", () => {
    const result = parseTriageResponse({
      action: "trigger",
      confidence: 0.8,
      priority: "super-urgent" // invalid
    });
    assert.equal(result.priority, undefined);
  });

  test("parseTriageResponse: accepts valid priorities", () => {
    for (const p of ["low", "medium", "high", "critical"]) {
      const result = parseTriageResponse({ action: "defer", confidence: 0.5, priority: p });
      assert.equal(result.priority, p);
    }
  });

  test("parseTriageResponse: defaults confidence when missing", () => {
    const result = parseTriageResponse({ action: "escalate" });
    assert.equal(result.confidence, 0.5);
  });

});


// ═══════════════════════════════════════════════
// Browser Verify
// ═══════════════════════════════════════════════

describe("Browser Verify", () => {

  // ── pa11y output parsing ──

  test("parsePa11yOutput: empty output → pass", () => {
    const result = parsePa11yOutput("");
    assert.equal(result.name, "accessibility");
    assert.equal(result.passed, true);
    assert.ok(result.details.includes("No violations"));
  });

  test("parsePa11yOutput: whitespace-only output → pass", () => {
    const result = parsePa11yOutput("   \n  ");
    assert.equal(result.passed, true);
  });

  test("parsePa11yOutput: warnings only → pass", () => {
    const result = parsePa11yOutput(JSON.stringify([
      { type: "warning", code: "WCAG2AA.H1", message: "Missing h1", selector: "body" },
      { type: "warning", code: "WCAG2AA.H2", message: "Skip level", selector: "div" }
    ]));
    assert.equal(result.passed, true);
    assert.ok(result.details.includes("2 warnings"));
    assert.ok(result.details.includes("0 errors"));
  });

  test("parsePa11yOutput: errors → fail", () => {
    const result = parsePa11yOutput(JSON.stringify([
      { type: "error", code: "WCAG2AA.Img", message: "Missing alt", selector: "img.hero" },
      { type: "error", code: "WCAG2AA.Label", message: "No label", selector: "input#email" },
      { type: "warning", code: "WCAG2AA.Color", message: "Low contrast", selector: "p.text" }
    ]));
    assert.equal(result.passed, false);
    assert.ok(result.details.includes("2 accessibility error"));
    assert.ok(result.details.includes("Missing alt"));
    assert.ok(result.details.includes("img.hero"));
  });

  test("parsePa11yOutput: caps at 5 errors in details", () => {
    const errors = Array.from({ length: 10 }, (_, i) => ({
      type: "error",
      code: `WCAG2AA.E${String(i)}`,
      message: `Error ${String(i)}`,
      selector: `el${String(i)}`
    }));
    const result = parsePa11yOutput(JSON.stringify(errors));
    assert.equal(result.passed, false);
    // Should report all 10 in count
    assert.ok(result.details.includes("10 accessibility error"));
    // But only show first 5 in details
    assert.ok(result.details.includes("Error 0"));
    assert.ok(result.details.includes("Error 4"));
    assert.ok(!result.details.includes("Error 5"));
  });

  test("parsePa11yOutput: invalid JSON → pass (fail-open)", () => {
    const result = parsePa11yOutput("not json at all {{{");
    assert.equal(result.passed, true);
    assert.ok(result.details.includes("parse error"));
  });

  // ── Smoke check ──

  test("buildSmokeCheck: HTTP 200 → pass", () => {
    const check = buildSmokeCheck(200, []);
    assert.equal(check.name, "smoke_test");
    assert.equal(check.passed, true);
    assert.ok(check.details.includes("200"));
  });

  test("buildSmokeCheck: HTTP 301 redirect → pass", () => {
    const check = buildSmokeCheck(301, []);
    assert.equal(check.passed, true);
  });

  test("buildSmokeCheck: HTTP 500 → fail", () => {
    const check = buildSmokeCheck(500, []);
    assert.equal(check.passed, false);
  });

  test("buildSmokeCheck: HTTP 200 with console errors → fail", () => {
    const check = buildSmokeCheck(200, ["TypeError: undefined"]);
    assert.equal(check.passed, false);
    assert.ok(check.details.includes("TypeError"));
  });

  test("buildSmokeCheck: HTTP 0 (connection refused) → fail", () => {
    const check = buildSmokeCheck(0, []);
    assert.equal(check.passed, false);
  });

  // ── Aggregation ──

  test("aggregateChecks: all pass → overall pass", () => {
    const result = aggregateChecks([
      { name: "smoke_test", passed: true, details: "HTTP 200" },
      { name: "accessibility", passed: true, details: "0 errors" }
    ]);
    assert.equal(result.overallPass, true);
    assert.equal(result.errors.length, 0);
    assert.equal(result.checks.length, 2);
  });

  test("aggregateChecks: accessibility fail without feature check → overall fail", () => {
    const result = aggregateChecks([
      { name: "smoke_test", passed: true, details: "HTTP 200" },
      { name: "accessibility", passed: false, details: "3 errors" }
    ]);
    assert.equal(result.overallPass, false);
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].includes("accessibility"));
  });

  test("aggregateChecks: accessibility fail + feature pass → overall pass (a11y demoted)", () => {
    const result = aggregateChecks([
      { name: "smoke_test", passed: true, details: "HTTP 200" },
      { name: "accessibility", passed: false, details: "286 errors" },
      { name: "feature_verification", passed: true, details: "[high] Feature implemented correctly" }
    ]);
    assert.equal(result.overallPass, true);
    // a11y warning still in errors array for reporting
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].includes("accessibility"));
  });

  test("aggregateChecks: feature fail + accessibility fail → overall fail", () => {
    const result = aggregateChecks([
      { name: "smoke_test", passed: true, details: "HTTP 200" },
      { name: "accessibility", passed: false, details: "3 errors" },
      { name: "feature_verification", passed: false, details: "Feature missing" }
    ]);
    assert.equal(result.overallPass, false);
    assert.equal(result.errors.length, 2);
  });

  test("aggregateChecks: auth-blocked feature fail demotes accessibility noise", () => {
    const result = aggregateChecks([
      { name: "smoke_test", passed: true, details: "HTTP 200" },
      { name: "accessibility", passed: false, details: "289 accessibility errors" },
      { name: "feature_verification", passed: false, details: "[high] Without access to the authenticated page, unable to verify feature." }
    ]);
    assert.equal(result.overallPass, false);
    // feature error remains blocking, accessibility becomes warning-only
    assert.equal(result.errors.length, 2);
    assert.ok(result.errors[0].includes("feature_verification") || result.errors[1].includes("feature_verification"));
  });

  test("aggregateChecks: smoke fail always blocks regardless of feature", () => {
    const result = aggregateChecks([
      { name: "smoke_test", passed: false, details: "HTTP 502" },
      { name: "feature_verification", passed: true, details: "Feature visible" }
    ]);
    assert.equal(result.overallPass, false);
    assert.ok(result.errors[0].includes("smoke_test"));
  });

  test("aggregateChecks: empty → pass", () => {
    const result = aggregateChecks([]);
    assert.equal(result.overallPass, true);
    assert.equal(result.errors.length, 0);
  });

  // ── URL resolution ──

  test("resolveReviewAppUrl: replaces prNumber", () => {
    const url = resolveReviewAppUrl("https://pr-{{prNumber}}.app.com", { prNumber: "42" });
    assert.equal(url, "https://pr-42.app.com");
  });

  test("resolveReviewAppUrl: replaces branchName", () => {
    const url = resolveReviewAppUrl("https://{{branchName}}.preview.app.com", {
      branchName: "fix-auth"
    });
    assert.equal(url, "https://fix-auth.preview.app.com");
  });

  test("resolveReviewAppUrl: replaces all variables", () => {
    const url = resolveReviewAppUrl(
      "https://{{prNumber}}-{{branchName}}.{{repoSlug}}.app.com",
      { prNumber: "5", branchName: "feat-x", repoSlug: "org/repo" }
    );
    assert.equal(url, "https://5-feat-x.org/repo.app.com");
  });

  test("resolveReviewAppUrl: leaves unreplaced vars intact", () => {
    const url = resolveReviewAppUrl("https://{{prNumber}}.app.com", {});
    assert.equal(url, "https://{{prNumber}}.app.com");
  });

  test("resolveReviewAppUrl: replaces multiple occurrences", () => {
    const url = resolveReviewAppUrl("{{prNumber}}/{{prNumber}}", { prNumber: "7" });
    assert.equal(url, "7/7");
  });

});


// ═══════════════════════════════════════════════
// Per-Repo Config (validation logic)
// ═══════════════════════════════════════════════

describe("Per-Repo Config", () => {

  // We can't test loadRepoConfig directly (needs git repo), but we can
  // test the validation/apply logic by importing the private function
  // through the public interface. Since validateRepoConfig is not exported,
  // we test via loadRepoConfig's behavior or test applyRepoConfig directly.

  test("applyRepoConfig: accepts pipeline field without crashing", async () => {
    const { applyRepoConfig } = await import("../src/pipeline/repo-config.js");
    const ctx = new Map<string, unknown>();
    const mockCtx = {
      set: (k: string, v: unknown) => ctx.set(k, v),
      get: <T>(k: string) => ctx.get(k) as T | undefined
    };

    // pipeline is stored in RepoConfig but consumed by the caller, not applyRepoConfig
    applyRepoConfig({ pipeline: "custom" }, mockCtx);
    assert.equal(ctx.size, 0, "applyRepoConfig should not set context keys for pipeline-only config");
  });

  test("applyRepoConfig: sets diff profile override", async () => {
    const { applyRepoConfig } = await import("../src/pipeline/repo-config.js");
    const ctx = new Map<string, unknown>();
    const mockCtx = {
      set: (k: string, v: unknown) => ctx.set(k, v),
      get: <T>(k: string) => ctx.get(k) as T | undefined
    };

    applyRepoConfig({
      qualityGates: { diff_size: { profile: "feature" } }
    }, mockCtx);
    assert.equal(ctx.get("repoConfigDiffProfile"), "feature");
  });

  test("applyRepoConfig: appends guarded file additions", async () => {
    const { applyRepoConfig } = await import("../src/pipeline/repo-config.js");
    const ctx = new Map<string, unknown>();
    ctx.set("repoGuardedFiles", ["*.lock"]);
    const mockCtx = {
      set: (k: string, v: unknown) => ctx.set(k, v),
      get: <T>(k: string) => ctx.get(k) as T | undefined
    };

    applyRepoConfig({
      qualityGates: {
        forbidden_files: { guarded_additions: ["db/schema.rb", "Dockerfile"] }
      }
    }, mockCtx);

    const guarded = ctx.get("repoGuardedFiles") as string[];
    assert.equal(guarded.length, 3);
    assert.ok(guarded.includes("*.lock"));
    assert.ok(guarded.includes("db/schema.rb"));
    assert.ok(guarded.includes("Dockerfile"));
  });

  test("applyRepoConfig: creates guarded files when none exist", async () => {
    const { applyRepoConfig } = await import("../src/pipeline/repo-config.js");
    const ctx = new Map<string, unknown>();
    const mockCtx = {
      set: (k: string, v: unknown) => ctx.set(k, v),
      get: <T>(k: string) => ctx.get(k) as T | undefined
    };

    applyRepoConfig({
      qualityGates: {
        forbidden_files: { guarded_additions: ["infra/"] }
      }
    }, mockCtx);

    const guarded = ctx.get("repoGuardedFiles") as string[];
    assert.deepEqual(guarded, ["infra/"]);
  });

  test("applyRepoConfig: sets scope judge enabled flag", async () => {
    const { applyRepoConfig } = await import("../src/pipeline/repo-config.js");
    const ctx = new Map<string, unknown>();
    const mockCtx = {
      set: (k: string, v: unknown) => ctx.set(k, v),
      get: <T>(k: string) => ctx.get(k) as T | undefined
    };

    applyRepoConfig({
      qualityGates: { scope_judge: { enabled: true } }
    }, mockCtx);
    assert.equal(ctx.get("repoScopeJudgeEnabled"), true);
  });

  test("applyRepoConfig: sets browser verify config", async () => {
    const { applyRepoConfig } = await import("../src/pipeline/repo-config.js");
    const ctx = new Map<string, unknown>();
    const mockCtx = {
      set: (k: string, v: unknown) => ctx.set(k, v),
      get: <T>(k: string) => ctx.get(k) as T | undefined
    };

    applyRepoConfig({
      qualityGates: {
        browser_verify: {
          enabled: true,
          review_app_url: "https://pr-{{prNumber}}.staging.app.com"
        }
      }
    }, mockCtx);
    assert.equal(ctx.get("repoBrowserVerifyEnabled"), true);
    assert.equal(ctx.get("reviewAppUrl"), "https://pr-{{prNumber}}.staging.app.com");
  });

  test("applyRepoConfig: no-op for empty config", async () => {
    const { applyRepoConfig } = await import("../src/pipeline/repo-config.js");
    const ctx = new Map<string, unknown>();
    const mockCtx = {
      set: (k: string, v: unknown) => ctx.set(k, v),
      get: <T>(k: string) => ctx.get(k) as T | undefined
    };

    applyRepoConfig({}, mockCtx);
    assert.equal(ctx.size, 0);
  });

  test("parseRepoConfigYaml: parses CI ignore checks from quality gates", () => {
    const parsed = parseRepoConfigYaml(`
quality_gates:
  ci:
    ignore_checks:
      - PR Checker
      - flaky policy gate
`);

    assert.deepEqual(parsed, {
      qualityGates: {
        ci: {
          ignore_checks: ["PR Checker", "flaky policy gate"]
        }
      }
    });
  });

});
