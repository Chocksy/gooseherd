/**
 * Sentry Poller — polls Sentry REST API for new unresolved issues.
 *
 * Converts Sentry issues into TriggerEvents for the observer safety pipeline.
 */

import { randomUUID } from "node:crypto";
import { logError, logInfo } from "../../logger.js";
import type { TriggerEvent, TriggerPriority } from "../types.js";
import type { ObserverStateStore } from "../state-store.js";

export interface SentryPollerConfig {
  authToken: string;
  orgSlug: string;
  /** Sentry project slug → repo slug mapping */
  repoMap: Map<string, string>;
  pollIntervalSeconds: number;
  alertChannelId: string;
}

interface SentryIssue {
  id: string;
  title: string;
  culprit: string;
  level: string;
  firstSeen: string;
  lastSeen: string;
  count: string;
  project: { slug: string };
  metadata: { type?: string; value?: string; filename?: string };
  shortId: string;
  permalink: string;
}

interface SentryEventEntry {
  type: string;
  data: {
    values?: Array<{
      type: string;
      value: string;
      stacktrace?: {
        frames: Array<{
          filename: string;
          function: string;
          lineNo: number;
          inApp: boolean;
        }>;
      };
    }>;
  };
}

interface SentryEvent {
  entries: SentryEventEntry[];
}

const SENTRY_API_BASE = "https://sentry.io/api/0";

/**
 * Poll Sentry for new unresolved issues across configured projects.
 *
 * Returns TriggerEvents for issues not yet seen (based on state store cursor).
 */
export async function pollSentry(
  config: SentryPollerConfig,
  stateStore: ObserverStateStore
): Promise<TriggerEvent[]> {
  const events: TriggerEvent[] = [];

  for (const [projectSlug, repoSlug] of config.repoMap) {
    try {
      const newEvents = await pollProject(config, projectSlug, repoSlug, stateStore);
      events.push(...newEvents);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      logError("Sentry poll failed for project", { project: projectSlug, error: msg });
    }
  }

  return events;
}

async function pollProject(
  config: SentryPollerConfig,
  projectSlug: string,
  repoSlug: string,
  stateStore: ObserverStateStore
): Promise<TriggerEvent[]> {
  const lastPoll = stateStore.getSentryLastPoll(projectSlug);
  const since = lastPoll ?? new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const issues = await fetchNewIssues(config, projectSlug, since);
  if (issues.length === 0) return [];

  logInfo("Sentry: new issues found", { project: projectSlug, count: issues.length });

  // Update cursor to latest issue timestamp
  const latestTimestamp = issues.reduce(
    (max, issue) => (issue.lastSeen > max ? issue.lastSeen : max),
    since
  );
  stateStore.setSentryLastPoll(projectSlug, latestTimestamp);

  const events: TriggerEvent[] = [];

  for (const issue of issues) {
    const stackContext = await fetchLatestEventContext(config, issue.id);
    const suggestedTask = buildSentryTask(issue, stackContext);

    events.push({
      id: `sentry-${issue.id}-${randomUUID().slice(0, 8)}`,
      source: "sentry_alert",
      timestamp: issue.lastSeen,
      repoSlug,
      suggestedTask,
      priority: mapSentryLevel(issue.level),
      rawPayload: {
        projectSlug,
        fingerprint: issue.shortId,
        issueId: issue.id,
        title: issue.title,
        culprit: issue.culprit,
        level: issue.level,
        count: issue.count,
        permalink: issue.permalink
      },
      notificationTarget: {
        type: "slack" as const,
        channelId: config.alertChannelId
      }
    });
  }

  return events;
}

async function fetchNewIssues(
  config: SentryPollerConfig,
  projectSlug: string,
  since: string
): Promise<SentryIssue[]> {
  const url = `${SENTRY_API_BASE}/projects/${config.orgSlug}/${projectSlug}/issues/?query=is:unresolved&sort=date&statsPeriod=&start=${encodeURIComponent(since)}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${config.authToken}`,
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Sentry API ${String(response.status)}: ${response.statusText}`);
  }

  return (await response.json()) as SentryIssue[];
}

async function fetchLatestEventContext(
  config: SentryPollerConfig,
  issueId: string
): Promise<string> {
  try {
    const url = `${SENTRY_API_BASE}/issues/${issueId}/events/latest/`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.authToken}`,
        "Content-Type": "application/json"
      }
    });

    if (!response.ok) return "";

    const event = (await response.json()) as SentryEvent;
    return extractStackContext(event);
  } catch {
    return "";
  }
}

function extractStackContext(event: SentryEvent): string {
  const exceptionEntry = event.entries.find(e => e.type === "exception");
  if (!exceptionEntry?.data.values?.length) return "";

  const exception = exceptionEntry.data.values[0];
  if (!exception) return "";

  const lines: string[] = [];
  lines.push(`${exception.type}: ${exception.value}`);

  const frames = exception.stacktrace?.frames ?? [];
  const inAppFrames = frames.filter(f => f.inApp).slice(-5);

  for (const frame of inAppFrames) {
    lines.push(`  at ${frame.function} (${frame.filename}:${String(frame.lineNo)})`);
  }

  return lines.join("\n");
}

function buildSentryTask(issue: SentryIssue, stackContext: string): string {
  const lines: string[] = [];
  lines.push(`Fix Sentry issue: ${issue.title}`);

  if (issue.culprit) {
    lines.push(`Location: ${issue.culprit}`);
  }

  if (issue.metadata.type && issue.metadata.value) {
    lines.push(`Error: ${issue.metadata.type}: ${issue.metadata.value}`);
  }

  if (stackContext) {
    lines.push("", "Stack trace:", stackContext);
  }

  lines.push("", `Sentry link: ${issue.permalink}`);

  return lines.join("\n");
}

export function mapSentryLevel(level: string): TriggerPriority {
  switch (level) {
    case "fatal":
      return "critical";
    case "error":
      return "high";
    case "warning":
      return "medium";
    default:
      return "low";
  }
}
