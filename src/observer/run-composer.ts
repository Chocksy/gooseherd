/**
 * Run Composer: build a NewRunInput from a TriggerEvent + matched TriggerRule.
 *
 * Posts a seed message to the observer alert channel to get a real Slack threadTs.
 */

import type { WebClient } from "@slack/web-api";
import type { AppConfig } from "../config.js";
import type { NewRunInput } from "../types.js";
import type { TriggerEvent, TriggerRule } from "./types.js";

/**
 * Compose a NewRunInput from an observer trigger event.
 *
 * Posts a seed message to config.observerAlertChannelId so we get a real
 * Slack message `ts` — RunManager uses this as the thread anchor.
 */
export async function composeRunInput(
  event: TriggerEvent,
  rule: TriggerRule,
  config: AppConfig,
  webClient?: WebClient
): Promise<NewRunInput> {
  const repoSlug = event.repoSlug ?? rule.repoSlug ?? "";
  const baseBranch = event.baseBranch ?? rule.baseBranch ?? config.defaultBaseBranch;
  const task = buildTask(event, rule);
  const channelId = rule.notificationChannel ?? config.observerAlertChannelId;

  // Post seed message to get a real threadTs (or generate one when Slack is absent)
  const threadTs = webClient
    ? await postSeedMessage(webClient, channelId, event, repoSlug, task)
    : `obs-${Date.now()}`;

  return {
    repoSlug,
    task,
    baseBranch,
    requestedBy: `observer:${event.source}`,
    channelId,
    threadTs,
    runtime: config.sandboxRuntime,
    pipelineHint: event.pipelineHint ?? rule.pipeline
  };
}

/**
 * Build task description from event + rule context.
 *
 * Priority: rule.task override → event.suggestedTask → generic fallback
 */
export function buildTask(event: TriggerEvent, rule: TriggerRule): string {
  if (rule.task) {
    return rule.task;
  }
  if (event.suggestedTask) {
    return event.suggestedTask;
  }
  return `[auto] Fix issue from ${event.source}: ${event.id}`;
}

/**
 * Post a seed notification to the alert channel.
 *
 * Returns the message ts (used as threadTs for the run).
 */
async function postSeedMessage(
  webClient: WebClient,
  channelId: string,
  event: TriggerEvent,
  repoSlug: string,
  task: string
): Promise<string> {
  const sourceLabel = formatSourceLabel(event.source);
  const text = [
    `🔔 *Observer trigger* — ${sourceLabel}`,
    repoSlug ? `*Repo:* \`${repoSlug}\`` : undefined,
    `*Priority:* ${event.priority}`,
    `*Task:* ${truncate(task, 200)}`,
    "Queuing run..."
  ]
    .filter(Boolean)
    .join("\n");

  const response = await webClient.chat.postMessage({
    channel: channelId,
    text
  });

  if (!response.ts) {
    throw new Error("Failed to post seed message: no ts returned from Slack");
  }

  return response.ts;
}

function formatSourceLabel(source: string): string {
  switch (source) {
    case "sentry_alert":
      return "Sentry Alert";
    case "github_webhook":
      return "GitHub Webhook";
    case "slack_observer":
      return "Slack Channel Alert";
    default:
      return source;
  }
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 3)}...`;
}
