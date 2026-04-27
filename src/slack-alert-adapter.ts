/**
 * Slack alert adapter — parses monitored Slack channel messages into TriggerEvents.
 *
 * This lives outside observer/ so Slack runtime wiring does not pull observer
 * source modules into the core startup path when the observer feature is off.
 */

import { randomUUID } from "node:crypto";
import type { TriggerEvent, TriggerPriority } from "./observer/types.js";

/** Known alert bot patterns (partial bot_id or app name matches) */
const KNOWN_ALERT_BOTS: Record<string, string> = {
  sentry: "sentry",
  pagerduty: "pagerduty",
  datadog: "datadog",
  opsgenie: "opsgenie"
};

export interface SlackMessageEvent {
  type: string;
  subtype?: string;
  bot_id?: string;
  bot_profile?: {
    name?: string;
  };
  text?: string;
  channel: string;
  ts: string;
  attachments?: Array<{
    title?: string;
    text?: string;
    title_link?: string;
    color?: string;
    fields?: Array<{ title: string; value: string }>;
  }>;
  blocks?: Array<{
    type: string;
    text?: { text: string };
    elements?: Array<{ text?: string }>;
  }>;
}

export interface SlackChannelAdapterConfig {
  /** Channels to watch for alert messages */
  watchedChannels: string[];
  /** Optional bot ID allowlist — only process messages from these bots */
  botAllowlist: string[];
  /** Sentry project → repo mapping for resolving repo from alert content */
  repoMap: Map<string, string>;
  alertChannelId: string;
}

/**
 * Parse a Slack message event from a watched channel into a TriggerEvent.
 *
 * Returns null if the message is not from a recognized alert bot or
 * doesn't contain actionable content.
 */
export function parseSlackAlert(
  event: SlackMessageEvent,
  config: SlackChannelAdapterConfig
): TriggerEvent | null {
  // Only process bot messages
  if (!event.bot_id) return null;

  // Check if channel is watched
  if (!config.watchedChannels.includes(event.channel)) return null;

  // Check bot allowlist (if configured)
  if (config.botAllowlist.length > 0 && !config.botAllowlist.includes(event.bot_id)) {
    return null;
  }

  const botName = event.bot_profile?.name?.toLowerCase() ?? "";
  const alertSource = identifyAlertSource(botName, event.bot_id);

  // Extract alert content
  const content = extractAlertContent(event);
  if (!content.title) return null;

  // Try to resolve repo from alert content
  const repoSlug = resolveRepoFromAlert(content, config.repoMap);

  return {
    id: `slack-${event.channel}-${event.ts}-${randomUUID().slice(0, 8)}`,
    source: "slack_observer",
    timestamp: new Date(Number.parseFloat(event.ts) * 1000).toISOString(),
    repoSlug: repoSlug ?? undefined,
    suggestedTask: buildSlackAlertTask(alertSource, content),
    priority: inferPriority(content),
    rawPayload: {
      channelId: event.channel,
      messageTs: event.ts,
      botId: event.bot_id,
      botName,
      alertSource,
      title: content.title,
      detail: content.detail,
      link: content.link
    },
    notificationTarget: {
      type: "slack" as const,
      channelId: config.alertChannelId
    }
  };
}

interface AlertContent {
  title: string | undefined;
  detail: string | undefined;
  link: string | undefined;
  project: string | undefined;
  severity: string | undefined;
}

function extractAlertContent(event: SlackMessageEvent): AlertContent {
  // Try attachments first (Sentry, PagerDuty use these)
  if (event.attachments?.length) {
    const att = event.attachments[0]!;
    const severityField = att.fields?.find(
      (f) => f.title.toLowerCase().includes("level") || f.title.toLowerCase().includes("severity")
    );
    const projectField = att.fields?.find(
      (f) => f.title.toLowerCase().includes("project")
    );

    return {
      title: att.title ?? event.text,
      detail: att.text,
      link: att.title_link,
      project: projectField?.value,
      severity: severityField?.value ?? colorToSeverity(att.color)
    };
  }

  // Fallback: parse blocks or plain text
  return {
    title: event.text,
    detail: undefined,
    link: undefined,
    project: undefined,
    severity: undefined
  };
}

function identifyAlertSource(botName: string, _botId: string): string {
  for (const [pattern, source] of Object.entries(KNOWN_ALERT_BOTS)) {
    if (botName.includes(pattern)) return source;
  }
  return "unknown";
}

function resolveRepoFromAlert(
  content: AlertContent,
  repoMap: Map<string, string>
): string | null {
  if (content.project) {
    const mapped = repoMap.get(content.project);
    if (mapped) return mapped;
  }
  return null;
}

function buildSlackAlertTask(alertSource: string, content: AlertContent): string {
  const lines: string[] = [];

  lines.push(`Fix alert from ${alertSource}: ${content.title ?? "unknown"}`);
  if (content.detail) {
    const trimmed = content.detail.length > 300
      ? `${content.detail.slice(0, 297)}...`
      : content.detail;
    lines.push(trimmed);
  }
  if (content.link) {
    lines.push(`Alert link: ${content.link}`);
  }

  return lines.join("\n");
}

function inferPriority(content: AlertContent): TriggerPriority {
  const severity = content.severity?.toLowerCase() ?? "";

  if (severity.includes("fatal") || severity.includes("critical") || severity.includes("p1")) {
    return "critical";
  }
  if (severity.includes("error") || severity.includes("high") || severity.includes("p2")) {
    return "high";
  }
  if (severity.includes("warning") || severity.includes("medium") || severity.includes("p3")) {
    return "medium";
  }
  return "low";
}

function colorToSeverity(color: string | undefined): string | undefined {
  if (!color) return undefined;
  // Slack attachment colors: danger = red, warning = yellow
  if (color === "danger" || color === "#E03E2F") return "error";
  if (color === "warning" || color === "#ECB22E") return "warning";
  return undefined;
}
