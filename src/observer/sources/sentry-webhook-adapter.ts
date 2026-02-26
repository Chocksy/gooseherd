/**
 * Sentry Webhook Adapter — verifies and parses Sentry webhook payloads
 * into TriggerEvents.
 *
 * Handles:
 * - Issue alerts (new Sentry issues matching alert rules)
 * - Metric alerts (threshold breaches)
 *
 * Sentry webhook headers:
 *   sentry-hook-resource: "issue" | "metric_alert" | ...
 *   sentry-hook-timestamp: ISO timestamp
 *   sentry-hook-signature: HMAC-SHA256 of request body
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { TriggerEvent } from "../types.js";
import { mapSentryLevel } from "./sentry-poller.js";

export interface SentryWebhookHeaders {
  "sentry-hook-resource"?: string;
  "sentry-hook-timestamp"?: string;
  "sentry-hook-signature"?: string;
}

/**
 * Verify the sentry-hook-signature HMAC-SHA256 signature.
 *
 * Sentry signs the raw request body with the client secret
 * using HMAC-SHA256 and sends the hex digest.
 */
export function verifySentrySignature(
  body: string,
  signature: string | undefined,
  secret: string
): boolean {
  if (!signature) return false;

  const expected = createHmac("sha256", secret).update(body).digest("hex");

  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);

  if (sigBuf.length !== expectedBuf.length) return false;

  return timingSafeEqual(sigBuf, expectedBuf);
}

/**
 * Parse a Sentry webhook payload into a TriggerEvent.
 *
 * Returns null if the event type or payload is not actionable.
 */
export function parseSentryWebhook(
  headers: SentryWebhookHeaders,
  payload: Record<string, unknown>,
  alertChannelId: string
): TriggerEvent | null {
  const resource = headers["sentry-hook-resource"];

  switch (resource) {
    case "issue":
      return parseIssueAlert(payload, alertChannelId);
    case "metric_alert":
      return parseMetricAlert(payload, alertChannelId);
    default:
      return null;
  }
}

function parseIssueAlert(
  payload: Record<string, unknown>,
  alertChannelId: string
): TriggerEvent | null {
  const action = payload["action"] as string | undefined;
  // Only act on new issues being triggered (not resolved, assigned, etc.)
  if (action !== "triggered" && action !== "created") return null;

  const data = payload["data"] as Record<string, unknown> | undefined;
  if (!data) return null;

  const issue = data["issue"] as Record<string, unknown> | undefined;
  if (!issue) return null;

  const issueId = issue["id"] as string | undefined;
  const title = issue["title"] as string | undefined;
  const culprit = issue["culprit"] as string | undefined;
  const level = issue["level"] as string | undefined;
  const shortId = issue["shortId"] as string | undefined;
  const permalink = issue["url"] as string | undefined;
  const project = issue["project"] as Record<string, unknown> | undefined;
  const projectSlug = project?.["slug"] as string | undefined;

  const metadata = issue["metadata"] as Record<string, unknown> | undefined;
  const errorType = metadata?.["type"] as string | undefined;
  const errorValue = metadata?.["value"] as string | undefined;

  const taskLines: string[] = [];
  taskLines.push(`Fix Sentry issue: ${title ?? "Unknown issue"}`);
  if (culprit) taskLines.push(`Location: ${culprit}`);
  if (errorType && errorValue) taskLines.push(`Error: ${errorType}: ${errorValue}`);
  if (permalink) taskLines.push(`\nSentry link: ${permalink}`);

  return {
    id: `sentry-wh-${issueId ?? randomUUID().slice(0, 8)}-${randomUUID().slice(0, 8)}`,
    source: "sentry_alert",
    timestamp: new Date().toISOString(),
    suggestedTask: taskLines.join("\n"),
    priority: mapSentryLevel(level ?? "error"),
    rawPayload: {
      eventType: "issue",
      projectSlug,
      issueId,
      shortId,
      title,
      culprit,
      level,
      permalink
    },
    notificationTarget: {
      type: "slack" as const,
      channelId: alertChannelId
    }
  };
}

function parseMetricAlert(
  payload: Record<string, unknown>,
  alertChannelId: string
): TriggerEvent | null {
  const data = payload["data"] as Record<string, unknown> | undefined;
  if (!data) return null;

  const metricAlert = data["metric_alert"] as Record<string, unknown> | undefined;
  if (!metricAlert) return null;

  const alertId = metricAlert["id"] as number | undefined;
  const alertTitle = metricAlert["title"] as string | undefined;
  const status = metricAlert["status"] as number | undefined;

  // status: 0 = resolved, 1 = warning, 2 = critical
  // Only trigger on warning/critical
  if (status === 0) return null;

  const organization = metricAlert["organization"] as Record<string, unknown> | undefined;
  const orgSlug = organization?.["slug"] as string | undefined;

  const taskLines: string[] = [];
  taskLines.push(`Investigate Sentry metric alert: ${alertTitle ?? "Unknown alert"}`);
  taskLines.push(`Status: ${status === 2 ? "critical" : "warning"}`);

  return {
    id: `sentry-metric-${String(alertId ?? randomUUID().slice(0, 8))}-${randomUUID().slice(0, 8)}`,
    source: "sentry_alert",
    timestamp: new Date().toISOString(),
    suggestedTask: taskLines.join("\n"),
    priority: status === 2 ? "critical" : "high",
    rawPayload: {
      eventType: "metric_alert",
      alertId: alertId ? String(alertId) : undefined,
      alertTitle,
      status,
      orgSlug
    },
    notificationTarget: {
      type: "slack" as const,
      channelId: alertChannelId
    }
  };
}
