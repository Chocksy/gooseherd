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

  const rendered = renderJiraAdfNode(description).replace(/\n{3,}/g, "\n\n").trim();
  return rendered || undefined;
}

const JIRA_ADF_BLOCK_NODES = new Set([
  "bulletList",
  "blockquote",
  "codeBlock",
  "doc",
  "expand",
  "heading",
  "listItem",
  "mediaSingle",
  "nestedExpand",
  "orderedList",
  "panel",
  "paragraph",
  "rule",
  "table",
  "tableCell",
  "tableHeader",
  "tableRow",
]);

function renderJiraAdfNode(node: unknown): string {
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map(renderJiraAdfNode).join("");
  }
  if (!isRecord(node)) {
    return "";
  }

  const type = typeof node.type === "string" ? node.type : undefined;
  if (type === "text") {
    return typeof node.text === "string" ? node.text : "";
  }
  if (type === "hardBreak") {
    return "\n";
  }
  if (type === "mention" || type === "status") {
    return readJiraAdfAttrText(node, "text");
  }
  if (type === "emoji") {
    return readJiraAdfAttrText(node, "text", "shortName");
  }

  const content = Array.isArray(node.content) ? node.content.map(renderJiraAdfNode).join("") : "";
  if (content) {
    if (type && JIRA_ADF_BLOCK_NODES.has(type)) {
      return `${content.trim()}\n`;
    }
    return content;
  }

  return readJiraAdfAttrText(node, "text");
}

function readJiraAdfAttrText(node: Record<string, unknown>, ...keys: string[]): string {
  const attrs = isRecord(node.attrs) ? node.attrs : undefined;
  if (!attrs) {
    return "";
  }

  for (const key of keys) {
    const value = attrs[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
    this.deliveryLabels = (options.deliveryLabels ?? ["ai:delivery"]).map((label) => label.toLowerCase());
    this.resolveDiscoveryContext = options.resolveDiscoveryContext;
    this.resolveDeliveryContext = options.resolveDeliveryContext;
  }

  async handleWebhookPayload(payload: JiraWorkItemWebhookPayload): Promise<WorkItemRecord | undefined> {
    const labels = payload.labels.map((label) => label.toLowerCase());
    if (labels.some((label) => this.deliveryLabels.includes(label))) {
      const existingDeliveries = await this.workItems.listFeatureDeliveriesByJiraIssueKey(payload.issueKey);
      if (existingDeliveries[0]) {
        return existingDeliveries[0];
      }

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
      const existingDiscovery = await this.workItems.findProductDiscoveryByJiraIssueKey(payload.issueKey);
      if (existingDiscovery) {
        return existingDiscovery;
      }

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
