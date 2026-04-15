import type { WebClient } from "@slack/web-api";
import type { Block, KnownBlock } from "@slack/types";
import type { AppConfig } from "../config.js";
import type { ReviewRequestRecord, WorkItemRecord } from "./types.js";
import { WorkItemIdentityStore } from "./identity-store.js";

export interface WorkItemSlackActionPayload {
  reviewRequestId: string;
  workItemId: string;
  homeChannelId: string;
  homeThreadTs: string;
  requestTitle: string;
  detailUrl?: string;
}

export interface BuildWorkItemReviewBlocksInput {
  appName: string;
  workItemTitle: string;
  workItemDisplayId: string;
  requestTitle: string;
  requestMessage?: string;
  focusPoints?: string[];
  detailUrl?: string;
  actionValue: string;
}

export type SlackReviewDestination =
  | { kind: "channel"; channelId: string; label: string }
  | { kind: "dm"; slackUserId: string; label: string };

function normalizeBaseUrl(url: string | undefined): string | undefined {
  return url?.trim().replace(/\/+$/, "") || undefined;
}

export function buildWorkItemDetailUrl(baseUrl: string | undefined, workItemId: string): string | undefined {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    return undefined;
  }
  return `${normalized}/#work-item/${encodeURIComponent(workItemId)}`;
}

export function buildWorkItemSlackActionValue(payload: WorkItemSlackActionPayload): string {
  return JSON.stringify(payload);
}

export function parseWorkItemSlackActionValue(value: string | undefined): WorkItemSlackActionPayload | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as Partial<WorkItemSlackActionPayload>;
    if (!parsed.reviewRequestId || !parsed.workItemId || !parsed.homeChannelId || !parsed.homeThreadTs || !parsed.requestTitle) {
      return undefined;
    }
    return {
      reviewRequestId: parsed.reviewRequestId,
      workItemId: parsed.workItemId,
      homeChannelId: parsed.homeChannelId,
      homeThreadTs: parsed.homeThreadTs,
      requestTitle: parsed.requestTitle,
      detailUrl: parsed.detailUrl,
    };
  } catch {
    return undefined;
  }
}

export function buildWorkItemReviewBlocks(input: BuildWorkItemReviewBlocksInput): Array<KnownBlock | Block> {
  const secondaryLines = [
    input.requestMessage?.trim() || "",
    ...(input.focusPoints?.length
      ? [`*Focus points*\n${input.focusPoints.map((point) => `• ${point}`).join("\n")}`]
      : []),
    input.detailUrl ? `<${input.detailUrl}|Open work item>` : "",
  ].filter(Boolean);

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${input.appName} review request*\n*${input.workItemDisplayId}* — ${input.workItemTitle}\n*Request:* ${input.requestTitle}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: secondaryLines.join("\n\n"),
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "work_item_review_approve",
          style: "primary",
          text: { type: "plain_text", text: "Approve", emoji: true },
          value: input.actionValue,
        },
        {
          type: "button",
          action_id: "work_item_review_changes",
          text: { type: "plain_text", text: "Request changes", emoji: true },
          value: input.actionValue,
        },
      ],
    },
  ];
}

function readStringField(targetRef: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = targetRef[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export async function resolveReviewRequestDestinations(
  identityStore: WorkItemIdentityStore,
  workItem: WorkItemRecord,
  reviewRequest: ReviewRequestRecord,
): Promise<SlackReviewDestination[]> {
  const resolved: SlackReviewDestination[] = [];

  if (reviewRequest.targetType === "user") {
    const userId = readStringField(reviewRequest.targetRef, "userId");
    if (!userId) return resolved;
    const user = await identityStore.getUser(userId);
    if (user?.slackUserId && user.isActive) {
      resolved.push({ kind: "dm", slackUserId: user.slackUserId, label: user.displayName });
    }
    return resolved;
  }

  if (reviewRequest.targetType === "team") {
    const teamId = readStringField(reviewRequest.targetRef, "teamId") || workItem.ownerTeamId;
    const team = await identityStore.getTeam(teamId);
    if (team?.slackChannelId) {
      resolved.push({ kind: "channel", channelId: team.slackChannelId, label: team.name });
    }
    return resolved;
  }

  if (reviewRequest.targetType === "team_role") {
    const teamId = readStringField(reviewRequest.targetRef, "teamId") || workItem.ownerTeamId;
    const role = readStringField(reviewRequest.targetRef, "role", "teamRole");
    if (!role) return resolved;

    const users = await identityStore.listUsersForTeamRole(teamId, role);
    for (const user of users) {
      if (user.slackUserId) {
        resolved.push({ kind: "dm", slackUserId: user.slackUserId, label: `${user.displayName} (${role})` });
      }
    }
    return resolved;
  }

  if (reviewRequest.targetType === "org_role") {
    const role = readStringField(reviewRequest.targetRef, "role", "orgRole");
    if (!role) return resolved;

    const users = await identityStore.listUsersForOrgRole(role);
    for (const user of users) {
      if (user.slackUserId) {
        resolved.push({ kind: "dm", slackUserId: user.slackUserId, label: `${user.displayName} (${role})` });
      }
    }
  }

  return resolved;
}

export async function postWorkItemReviewNotifications(
  client: WebClient,
  config: AppConfig,
  identityStore: WorkItemIdentityStore,
  workItem: WorkItemRecord,
  reviewRequests: ReviewRequestRecord[],
): Promise<void> {
  const detailUrl = buildWorkItemDetailUrl(config.dashboardPublicUrl, workItem.id);
  const usernameOpt = config.slackCommandName ? { username: config.slackCommandName } : {};

  for (const reviewRequest of reviewRequests) {
    const actionValue = buildWorkItemSlackActionValue({
      reviewRequestId: reviewRequest.id,
      workItemId: workItem.id,
      homeChannelId: workItem.homeChannelId,
      homeThreadTs: workItem.homeThreadTs,
      requestTitle: reviewRequest.title,
      detailUrl,
    });

    await client.chat.postMessage({
      channel: workItem.homeChannelId,
      thread_ts: workItem.homeThreadTs,
      text: `Review requested for ${workItem.jiraIssueKey ?? workItem.id}: ${reviewRequest.title}`,
      blocks: buildWorkItemReviewBlocks({
        appName: config.appName,
        workItemTitle: workItem.title,
        workItemDisplayId: workItem.jiraIssueKey ?? workItem.id.slice(0, 8),
        requestTitle: reviewRequest.title,
        requestMessage: reviewRequest.requestMessage,
        focusPoints: reviewRequest.focusPoints,
        detailUrl,
        actionValue,
      }),
      ...usernameOpt,
    });

    const destinations = await resolveReviewRequestDestinations(identityStore, workItem, reviewRequest);
    const sentKeys = new Set<string>();

    for (const destination of destinations) {
      if (destination.kind === "channel") {
        const key = `channel:${destination.channelId}`;
        if (sentKeys.has(key)) continue;
        sentKeys.add(key);

        await client.chat.postMessage({
          channel: destination.channelId,
          text: `Review requested for ${workItem.jiraIssueKey ?? workItem.id}: ${reviewRequest.title}`,
          blocks: buildWorkItemReviewBlocks({
            appName: config.appName,
            workItemTitle: workItem.title,
            workItemDisplayId: workItem.jiraIssueKey ?? workItem.id.slice(0, 8),
            requestTitle: reviewRequest.title,
            requestMessage: reviewRequest.requestMessage,
            focusPoints: reviewRequest.focusPoints,
            detailUrl,
            actionValue,
          }),
          ...usernameOpt,
        });
        continue;
      }

      const key = `dm:${destination.slackUserId}`;
      if (sentKeys.has(key)) continue;
      sentKeys.add(key);

      const dm = await client.conversations.open({ users: destination.slackUserId });
      const dmChannelId = dm.channel?.id;
      if (!dmChannelId) continue;

      await client.chat.postMessage({
        channel: dmChannelId,
        text: `Review requested for ${workItem.jiraIssueKey ?? workItem.id}: ${reviewRequest.title}`,
        blocks: buildWorkItemReviewBlocks({
          appName: config.appName,
          workItemTitle: workItem.title,
          workItemDisplayId: workItem.jiraIssueKey ?? workItem.id.slice(0, 8),
          requestTitle: reviewRequest.title,
          requestMessage: reviewRequest.requestMessage,
          focusPoints: reviewRequest.focusPoints,
          detailUrl,
          actionValue,
        }),
          ...usernameOpt,
      });
    }
  }
}
