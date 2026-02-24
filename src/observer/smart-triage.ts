/**
 * Smart Observer Triage — LLM-powered event classification.
 *
 * Instead of dumb webhook-to-run mapping, an LLM triages incoming events
 * to decide: trigger a run, discard the event, defer, or escalate.
 *
 * Uses a fast/small model (Haiku by default) with configurable timeout.
 * Falls back to rule-based routing on timeout or error.
 */

import type { TriggerEvent, TriggerRule, ObserverDecision, TriggerPriority } from "./types.js";
import { callLLMForJSON, type LLMCallerConfig } from "../llm/caller.js";
import { logInfo, logError } from "../logger.js";

/**
 * Build the system prompt for event triage.
 */
export function buildTriageSystemPrompt(rules: TriggerRule[]): string {
  const ruleDescriptions = rules.map(r =>
    `- Rule "${r.id}": source=${r.source}, repo=${r.repoSlug ?? "any"}, approval=${String(r.requiresApproval)}`
  ).join("\n");

  return [
    "You are an event triage agent for an AI coding agent orchestrator.",
    "You receive alert events from Sentry, GitHub, and Slack.",
    "Decide whether each event should trigger an automated code fix.",
    "",
    "Available trigger rules:",
    ruleDescriptions,
    "",
    "Respond ONLY with a JSON object:",
    "{",
    '  "action": "trigger" | "discard" | "defer" | "escalate",',
    '  "confidence": 0.0-1.0,',
    '  "task": "refined task description if triggering",',
    '  "pipeline": "suggested pipeline name",',
    '  "priority": "low" | "medium" | "high" | "critical",',
    '  "reason": "one-line explanation"',
    "}",
    "",
    "Guidelines:",
    "- TRIGGER: Clear bug report, CI failure, or error alert that can be fixed programmatically",
    "- DISCARD: Informational messages, duplicate alerts, non-actionable warnings",
    "- DEFER: Legitimate issue but low priority, can wait for human review",
    "- ESCALATE: Critical security or data issue requiring human intervention",
    "- When in doubt, prefer TRIGGER over DISCARD (fail toward action)"
  ].join("\n");
}

/**
 * Build the user message describing the event.
 */
export function buildTriageUserMessage(event: TriggerEvent): string {
  // Truncate raw payload for token efficiency
  let payload = "";
  try {
    const raw = JSON.stringify(event.rawPayload);
    payload = raw.length > 2000 ? `${raw.slice(0, 2000)}...` : raw;
  } catch {
    payload = "(unparseable payload)";
  }

  return [
    `Source: ${event.source}`,
    `Event ID: ${event.id}`,
    `Repo: ${event.repoSlug ?? "unknown"}`,
    `Priority: ${event.priority}`,
    `Suggested Task: ${event.suggestedTask ?? "none"}`,
    `Pipeline Hint: ${event.pipelineHint ?? "none"}`,
    "",
    "Raw Payload:",
    payload
  ].join("\n");
}

/**
 * Parse the LLM's triage response with validation.
 * Returns a safe default on parse failure (trigger with low confidence).
 */
export function parseTriageResponse(raw: unknown): ObserverDecision {
  if (!raw || typeof raw !== "object") {
    return defaultDecision("Parse error: not an object");
  }

  const obj = raw as Record<string, unknown>;

  const action = obj["action"];
  if (action !== "trigger" && action !== "discard" && action !== "defer" && action !== "escalate") {
    return defaultDecision(`Invalid action: ${String(action)}`);
  }

  const confidence = typeof obj["confidence"] === "number"
    ? Math.max(0, Math.min(1, obj["confidence"]))
    : 0.5;

  const validPriorities = ["low", "medium", "high", "critical"];
  const priority = validPriorities.includes(obj["priority"] as string)
    ? (obj["priority"] as TriggerPriority)
    : undefined;

  return {
    action,
    confidence,
    task: typeof obj["task"] === "string" ? obj["task"] : undefined,
    pipeline: typeof obj["pipeline"] === "string" ? obj["pipeline"] : undefined,
    priority,
    reason: typeof obj["reason"] === "string" ? obj["reason"] : ""
  };
}

function defaultDecision(reason: string): ObserverDecision {
  return {
    action: "trigger",
    confidence: 0,
    reason: `Triage parse error (fail-toward-action): ${reason}`
  };
}

/**
 * Run smart triage on an event using the LLM.
 *
 * @returns ObserverDecision, or null if triage should be skipped (fallback to rules).
 */
export async function triageEvent(
  event: TriggerEvent,
  matchedRule: TriggerRule,
  rules: TriggerRule[],
  llmConfig: LLMCallerConfig,
  timeoutMs: number
): Promise<ObserverDecision | null> {
  // Skip triage for rules that opt out
  if (matchedRule.skipTriage) {
    return null;
  }

  const systemPrompt = buildTriageSystemPrompt(rules);
  const userMessage = buildTriageUserMessage(event);

  try {
    const { parsed } = await callLLMForJSON<Record<string, unknown>>(llmConfig, {
      system: systemPrompt,
      userMessage,
      maxTokens: 256,
      timeoutMs
    });
    const decision = parseTriageResponse(parsed);

    logInfo("Observer: smart triage decision", {
      eventId: event.id,
      action: decision.action,
      confidence: decision.confidence,
      reason: decision.reason
    });

    return decision;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    const isTimeout = msg.includes("abort") || msg.includes("timeout");
    logInfo("Observer: smart triage failed, falling back to rules", {
      eventId: event.id,
      error: msg,
      isTimeout
    });
    return null; // null = fall back to rule-based
  }
}
