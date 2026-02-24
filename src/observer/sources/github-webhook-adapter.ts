/**
 * GitHub Webhook Adapter — verifies and parses GitHub webhook payloads
 * into TriggerEvents.
 *
 * Handles:
 * - check_suite completed with failure → CI failure trigger
 * - pull_request_review submitted with changes_requested → review trigger
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { TriggerEvent, TriggerPriority } from "../types.js";

export interface GitHubWebhookHeaders {
  "x-github-event"?: string;
  "x-hub-signature-256"?: string;
  "x-github-delivery"?: string;
}

/**
 * Verify the X-Hub-Signature-256 HMAC signature.
 *
 * Returns true if the signature is valid, false otherwise.
 * Uses timingSafeEqual to prevent timing attacks.
 */
export function verifyGitHubSignature(
  body: string,
  signature: string | undefined,
  secret: string
): boolean {
  if (!signature) return false;

  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  // Both must be the same length for timingSafeEqual
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);

  if (sigBuf.length !== expectedBuf.length) return false;

  return timingSafeEqual(sigBuf, expectedBuf);
}

/**
 * Parse a GitHub webhook payload into a TriggerEvent.
 *
 * Returns null if the event type or payload is not actionable.
 */
export function parseGitHubWebhook(
  headers: GitHubWebhookHeaders,
  payload: Record<string, unknown>
): TriggerEvent | null {
  const eventType = headers["x-github-event"];
  const deliveryId = headers["x-github-delivery"] ?? randomUUID();

  switch (eventType) {
    case "check_suite":
      return parseCheckSuite(payload, deliveryId);
    case "pull_request_review":
      return parsePullRequestReview(payload, deliveryId);
    default:
      return null;
  }
}

function parseCheckSuite(
  payload: Record<string, unknown>,
  deliveryId: string
): TriggerEvent | null {
  const action = payload["action"] as string | undefined;
  const checkSuite = payload["check_suite"] as Record<string, unknown> | undefined;
  const repo = payload["repository"] as Record<string, unknown> | undefined;

  if (action !== "completed" || !checkSuite || !repo) return null;

  const conclusion = checkSuite["conclusion"] as string | undefined;
  if (conclusion !== "failure" && conclusion !== "timed_out") return null;

  const repoFullName = repo["full_name"] as string | undefined;
  const headBranch = checkSuite["head_branch"] as string | undefined;
  const headSha = checkSuite["head_sha"] as string | undefined;
  const appName = (checkSuite["app"] as Record<string, unknown> | undefined)?.["name"] as string | undefined;

  return {
    id: `gh-check-${deliveryId}`,
    source: "github_webhook",
    timestamp: new Date().toISOString(),
    repoSlug: repoFullName,
    baseBranch: headBranch,
    suggestedTask: buildCheckSuiteTask(repoFullName, headBranch, conclusion, appName),
    priority: "high" as TriggerPriority,
    rawPayload: {
      eventType: "check_suite",
      repo: repoFullName,
      branch: headBranch,
      sha: headSha,
      conclusion,
      app: appName
    },
    notificationTarget: { type: "slack" }
  };
}

function parsePullRequestReview(
  payload: Record<string, unknown>,
  deliveryId: string
): TriggerEvent | null {
  const action = payload["action"] as string | undefined;
  const review = payload["review"] as Record<string, unknown> | undefined;
  const pr = payload["pull_request"] as Record<string, unknown> | undefined;
  const repo = payload["repository"] as Record<string, unknown> | undefined;

  if (action !== "submitted" || !review || !pr || !repo) return null;

  const state = review["state"] as string | undefined;
  if (state !== "changes_requested") return null;

  const repoFullName = repo["full_name"] as string | undefined;
  const prNumber = pr["number"] as number | undefined;
  const prTitle = pr["title"] as string | undefined;
  const baseBranch = (pr["base"] as Record<string, unknown> | undefined)?.["ref"] as string | undefined;
  const reviewBody = review["body"] as string | undefined;
  const reviewId = review["id"] as number | undefined;
  const reviewer = (review["user"] as Record<string, unknown> | undefined)?.["login"] as string | undefined;

  return {
    id: `gh-review-${deliveryId}`,
    source: "github_webhook",
    timestamp: new Date().toISOString(),
    repoSlug: repoFullName,
    baseBranch,
    suggestedTask: buildReviewTask(prTitle, prNumber, reviewer, reviewBody),
    priority: "medium" as TriggerPriority,
    rawPayload: {
      eventType: "pull_request_review",
      repo: repoFullName,
      prNumber: prNumber ? String(prNumber) : undefined,
      reviewId: reviewId ? String(reviewId) : undefined,
      prTitle,
      reviewer,
      reviewBody,
      state
    },
    notificationTarget: { type: "slack" }
  };
}

function buildCheckSuiteTask(
  repo: string | undefined,
  branch: string | undefined,
  conclusion: string,
  app: string | undefined
): string {
  const lines: string[] = [];
  lines.push(`Fix CI failure on ${repo ?? "unknown repo"}`);
  if (branch) lines.push(`Branch: ${branch}`);
  lines.push(`Conclusion: ${conclusion}`);
  if (app) lines.push(`CI System: ${app}`);
  return lines.join("\n");
}

function buildReviewTask(
  prTitle: string | undefined,
  prNumber: number | undefined,
  reviewer: string | undefined,
  reviewBody: string | undefined
): string {
  const lines: string[] = [];
  lines.push(`Address PR review feedback`);
  if (prTitle) lines.push(`PR: #${String(prNumber ?? "")} ${prTitle}`);
  if (reviewer) lines.push(`Reviewer: @${reviewer}`);
  if (reviewBody) {
    const trimmed = reviewBody.length > 500 ? `${reviewBody.slice(0, 497)}...` : reviewBody;
    lines.push("", "Feedback:", trimmed);
  }
  return lines.join("\n");
}
