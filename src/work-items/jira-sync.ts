import type { Database } from "../db/index.js";
import { WorkItemEventsStore } from "./events-store.js";
import { WorkItemService } from "./service.js";
import { WorkItemStore } from "./store.js";
import type { WorkItemRecord } from "./types.js";
import type { ResolveWorkItemContextInput, ResolvedWorkItemContext } from "./context-resolver.js";

export interface JiraWorkItemWebhookPayload {
  issueKey: string;
  title: string;
  summary?: string;
  labels: string[];
  actorJiraAccountId?: string;
  ownerTeamId?: string;
  originChannelId?: string;
  originThreadTs?: string;
}

export interface JiraWorkItemSyncOptions {
  discoveryLabels?: string[];
  deliveryLabels?: string[];
  resolveDiscoveryContext: (input: ResolveWorkItemContextInput) => Promise<ResolvedWorkItemContext>;
  resolveDeliveryContext: (input: ResolveWorkItemContextInput) => Promise<ResolvedWorkItemContext>;
}

export function parseJiraWorkItemWebhookPayload(payload: Record<string, unknown>): JiraWorkItemWebhookPayload | undefined {
  const issue = payload["issue"] as Record<string, unknown> | undefined;
  const issueFields = issue?.["fields"] as Record<string, unknown> | undefined;
  const issueKey = issue?.["key"] as string | undefined;
  const title = issueFields?.["summary"] as string | undefined;
  if (!issueKey || !title) {
    return undefined;
  }

  const labels = Array.isArray(issueFields?.["labels"])
    ? (issueFields?.["labels"] as unknown[]).filter((label): label is string => typeof label === "string")
    : [];

  return {
    issueKey,
    title,
    summary: readJiraDescription(issueFields?.["description"]),
    labels,
    actorJiraAccountId:
      (payload["user"] as Record<string, unknown> | undefined)?.["accountId"] as string | undefined
      ?? (issueFields?.["reporter"] as Record<string, unknown> | undefined)?.["accountId"] as string | undefined,
    ownerTeamId: readStringField(issueFields, "ownerTeamId", "customfield_owner_team_id", "customfield_team_id"),
    originChannelId: readStringField(issueFields, "slackChannelId", "customfield_slack_channel_id"),
    originThreadTs: readStringField(issueFields, "slackThreadTs", "customfield_slack_thread_ts"),
  };
}

function readStringField(target: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!target) return undefined;
  for (const key of keys) {
    const value = target[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readJiraDescription(description: unknown): string | undefined {
  if (typeof description === "string" && description.trim()) {
    return description.trim();
  }
  return undefined;
}

export class JiraWorkItemSync {
  private readonly workItems: WorkItemStore;
  private readonly service: WorkItemService;
  private readonly events: WorkItemEventsStore;
  private readonly discoveryLabels: string[];
  private readonly deliveryLabels: string[];
  private readonly resolveDiscoveryContext: JiraWorkItemSyncOptions["resolveDiscoveryContext"];
  private readonly resolveDeliveryContext: JiraWorkItemSyncOptions["resolveDeliveryContext"];

  constructor(db: Database, options: JiraWorkItemSyncOptions) {
    this.workItems = new WorkItemStore(db);
    this.service = new WorkItemService(db);
    this.events = new WorkItemEventsStore(db);
    this.discoveryLabels = (options.discoveryLabels ?? ["automation"]).map((label) => label.toLowerCase());
    this.deliveryLabels = (options.deliveryLabels ?? ["ai_delivery"]).map((label) => label.toLowerCase());
    this.resolveDiscoveryContext = options.resolveDiscoveryContext;
    this.resolveDeliveryContext = options.resolveDeliveryContext;
  }

  async handleWebhookPayload(payload: JiraWorkItemWebhookPayload): Promise<WorkItemRecord | undefined> {
    const labels = payload.labels.map((label) => label.toLowerCase());
    const existing = await this.workItems.findByJiraIssueKey(payload.issueKey);
    if (existing) {
      return existing;
    }

    if (labels.some((label) => this.deliveryLabels.includes(label))) {
      const context = await this.resolveDeliveryContext({
        actorJiraAccountId: payload.actorJiraAccountId,
        ownerTeamId: payload.ownerTeamId,
        originChannelId: payload.originChannelId,
        originThreadTs: payload.originThreadTs,
        title: payload.title,
      });
      const workItem = await this.service.createDeliveryFromJira({
        title: payload.title,
        summary: payload.summary,
        ownerTeamId: context.ownerTeamId,
        homeChannelId: context.homeChannelId,
        homeThreadTs: context.homeThreadTs,
        originChannelId: context.originChannelId,
        originThreadTs: context.originThreadTs,
        jiraIssueKey: payload.issueKey,
        createdByUserId: context.createdByUserId,
      });
      await this.events.append({
        workItemId: workItem.id,
        eventType: "jira.issue_created",
        actorUserId: context.createdByUserId,
        payload: { issueKey: payload.issueKey, labels: payload.labels, workflow: workItem.workflow },
      });
      return workItem;
    }

    if (labels.some((label) => this.discoveryLabels.includes(label))) {
      const context = await this.resolveDiscoveryContext({
        actorJiraAccountId: payload.actorJiraAccountId,
        ownerTeamId: payload.ownerTeamId,
        originChannelId: payload.originChannelId,
        originThreadTs: payload.originThreadTs,
        title: payload.title,
      });
      const workItem = await this.service.createDiscoveryWorkItem({
        title: payload.title,
        summary: payload.summary,
        ownerTeamId: context.ownerTeamId,
        homeChannelId: context.homeChannelId,
        homeThreadTs: context.homeThreadTs,
        originChannelId: context.originChannelId,
        originThreadTs: context.originThreadTs,
        jiraIssueKey: payload.issueKey,
        createdByUserId: context.createdByUserId,
      });
      await this.events.append({
        workItemId: workItem.id,
        eventType: "jira.issue_created",
        actorUserId: context.createdByUserId,
        payload: { issueKey: payload.issueKey, labels: payload.labels, workflow: workItem.workflow },
      });
      return workItem;
    }

    return undefined;
  }
}
