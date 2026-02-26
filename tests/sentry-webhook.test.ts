/**
 * Tests for Sentry webhook adapter — signature verification and payload parsing.
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";
import {
  verifySentrySignature,
  parseSentryWebhook,
  type SentryWebhookHeaders
} from "../src/observer/sources/sentry-webhook-adapter.js";

// ── Helpers ──

function signBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function makeIssuePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "triggered",
    data: {
      issue: {
        id: "12345",
        title: "TypeError: Cannot read property 'foo' of undefined",
        culprit: "app/routes/index.ts",
        level: "error",
        shortId: "PROJ-1A2B",
        url: "https://sentry.io/issues/12345/",
        project: { slug: "my-project" },
        metadata: {
          type: "TypeError",
          value: "Cannot read property 'foo' of undefined"
        },
        ...overrides
      }
    }
  };
}

function makeMetricAlertPayload(status = 2): Record<string, unknown> {
  return {
    data: {
      metric_alert: {
        id: 999,
        title: "High Error Rate",
        status,
        organization: { slug: "my-org" }
      }
    }
  };
}

// ═══════════════════════════════════════════════════════
// Signature Verification
// ═══════════════════════════════════════════════════════

describe("verifySentrySignature", () => {
  const secret = "test-sentry-secret";

  test("returns true for valid signature", () => {
    const body = '{"action":"triggered"}';
    const sig = signBody(body, secret);
    assert.equal(verifySentrySignature(body, sig, secret), true);
  });

  test("returns false for invalid signature", () => {
    const body = '{"action":"triggered"}';
    assert.equal(verifySentrySignature(body, "deadbeef", secret), false);
  });

  test("returns false for undefined signature", () => {
    const body = '{"action":"triggered"}';
    assert.equal(verifySentrySignature(body, undefined, secret), false);
  });

  test("returns false when body is tampered", () => {
    const body = '{"action":"triggered"}';
    const sig = signBody(body, secret);
    assert.equal(verifySentrySignature('{"action":"TAMPERED"}', sig, secret), false);
  });

  test("returns false for wrong secret", () => {
    const body = '{"action":"triggered"}';
    const sig = signBody(body, "wrong-secret");
    assert.equal(verifySentrySignature(body, sig, secret), false);
  });
});

// ═══════════════════════════════════════════════════════
// Issue Alert Parsing
// ═══════════════════════════════════════════════════════

describe("parseSentryWebhook: issue alerts", () => {
  const headers: SentryWebhookHeaders = {
    "sentry-hook-resource": "issue",
    "sentry-hook-timestamp": new Date().toISOString()
  };

  test("parses triggered issue into TriggerEvent", () => {
    const payload = makeIssuePayload();
    const event = parseSentryWebhook(headers, payload, "C_ALERT");

    assert.ok(event);
    assert.equal(event.source, "sentry_alert");
    assert.ok(event.id.startsWith("sentry-wh-12345-"));
    assert.ok(event.suggestedTask?.includes("TypeError"));
    assert.ok(event.suggestedTask?.includes("app/routes/index.ts"));
    assert.equal(event.priority, "high"); // error level → high
    assert.equal(event.notificationTarget.channelId, "C_ALERT");

    const raw = event.rawPayload as Record<string, unknown>;
    assert.equal(raw["issueId"], "12345");
    assert.equal(raw["projectSlug"], "my-project");
  });

  test("parses created issue", () => {
    const payload = { ...makeIssuePayload(), action: "created" };
    const event = parseSentryWebhook(headers, payload, "C_ALERT");
    assert.ok(event);
    assert.equal(event.source, "sentry_alert");
  });

  test("returns null for resolved action", () => {
    const payload = { ...makeIssuePayload(), action: "resolved" };
    const event = parseSentryWebhook(headers, payload, "C_ALERT");
    assert.equal(event, null);
  });

  test("returns null for assigned action", () => {
    const payload = { ...makeIssuePayload(), action: "assigned" };
    const event = parseSentryWebhook(headers, payload, "C_ALERT");
    assert.equal(event, null);
  });

  test("maps fatal level to critical priority", () => {
    const payload = makeIssuePayload({ level: "fatal" });
    const event = parseSentryWebhook(headers, payload, "C_ALERT");
    assert.ok(event);
    assert.equal(event.priority, "critical");
  });

  test("maps warning level to medium priority", () => {
    const payload = makeIssuePayload({ level: "warning" });
    const event = parseSentryWebhook(headers, payload, "C_ALERT");
    assert.ok(event);
    assert.equal(event.priority, "medium");
  });

  test("includes sentry link in suggested task", () => {
    const payload = makeIssuePayload();
    const event = parseSentryWebhook(headers, payload, "C_ALERT");
    assert.ok(event);
    assert.ok(event.suggestedTask?.includes("https://sentry.io/issues/12345/"));
  });
});

// ═══════════════════════════════════════════════════════
// Metric Alert Parsing
// ═══════════════════════════════════════════════════════

describe("parseSentryWebhook: metric alerts", () => {
  const headers: SentryWebhookHeaders = {
    "sentry-hook-resource": "metric_alert",
    "sentry-hook-timestamp": new Date().toISOString()
  };

  test("parses critical metric alert", () => {
    const payload = makeMetricAlertPayload(2);
    const event = parseSentryWebhook(headers, payload, "C_ALERT");

    assert.ok(event);
    assert.equal(event.source, "sentry_alert");
    assert.ok(event.id.startsWith("sentry-metric-999-"));
    assert.ok(event.suggestedTask?.includes("High Error Rate"));
    assert.ok(event.suggestedTask?.includes("critical"));
    assert.equal(event.priority, "critical");
  });

  test("parses warning metric alert", () => {
    const payload = makeMetricAlertPayload(1);
    const event = parseSentryWebhook(headers, payload, "C_ALERT");

    assert.ok(event);
    assert.equal(event.priority, "high");
    assert.ok(event.suggestedTask?.includes("warning"));
  });

  test("returns null for resolved metric alert (status 0)", () => {
    const payload = makeMetricAlertPayload(0);
    const event = parseSentryWebhook(headers, payload, "C_ALERT");
    assert.equal(event, null);
  });
});

// ═══════════════════════════════════════════════════════
// Unknown Resource Types
// ═══════════════════════════════════════════════════════

describe("parseSentryWebhook: unknown types", () => {
  test("returns null for unknown resource type", () => {
    const headers: SentryWebhookHeaders = {
      "sentry-hook-resource": "event_alert"
    };
    const event = parseSentryWebhook(headers, { action: "triggered" }, "C_ALERT");
    assert.equal(event, null);
  });

  test("returns null when resource header is missing", () => {
    const headers: SentryWebhookHeaders = {};
    const event = parseSentryWebhook(headers, { action: "triggered" }, "C_ALERT");
    assert.equal(event, null);
  });
});
