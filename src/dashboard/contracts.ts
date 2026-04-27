import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChatMessage } from "../llm/caller.js";
import type { ObserverEventRecord, ObserverStateSnapshot, TriggerRule } from "../observer/types.js";
import type { ReviewRequestRecord, WorkItemEventRecord, WorkItemLinkedRunRecord, WorkItemRecord } from "../work-items/types.js";
import type { DashboardActorPrincipal, DashboardUserActorPrincipal } from "./actor-principal.js";

/** Lean interface — dashboard only reads observer state, never mutates it. */
export interface DashboardObserver {
  getStateSnapshot(): Promise<ObserverStateSnapshot>;
  getRecentEvents(limit?: number): ObserverEventRecord[];
  getRules(): TriggerRule[];
  handleWebhookHttpRequest?(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

/** Optional source for in-memory orchestrator thread messages. */
export interface DashboardConversationSource {
  get(threadKey: string): Promise<ChatMessage[] | undefined>;
}

export interface DashboardWorkItemsSource {
  listWorkItems(workflow?: string): Promise<WorkItemRecord[]>;
  getWorkItem(id: string): Promise<WorkItemRecord | undefined>;
  listRunsForWorkItem(workItemId: string): Promise<WorkItemLinkedRunRecord[]>;
  listReviewRequestsForWorkItem(workItemId: string): Promise<ReviewRequestRecord[]>;
  listReviewRequestComments(reviewRequestId: string): Promise<Array<{
    id: number;
    reviewRequestId: string;
    authorUserId?: string;
    source: string;
    body: string;
    createdAt: string;
  }>>;
  listEventsForWorkItem(workItemId: string): Promise<WorkItemEventRecord[]>;
  createDiscoveryWorkItem(input: {
    title: string;
    summary?: string;
    ownerTeamId?: string;
    homeChannelId?: string;
    homeThreadTs?: string;
    originChannelId?: string;
    originThreadTs?: string;
    jiraIssueKey?: string;
    actor: DashboardUserActorPrincipal;
  }): Promise<WorkItemRecord>;
  createReviewRequests(input: {
    workItemId: string;
    actor: DashboardUserActorPrincipal;
    requests: Array<{
      type: ReviewRequestRecord["type"];
      targetType: ReviewRequestRecord["targetType"];
      targetRef: Record<string, unknown>;
      title: string;
      requestMessage?: string;
      focusPoints?: string[];
    }>;
  }): Promise<ReviewRequestRecord[]>;
  respondToReviewRequest(input: {
    reviewRequestId: string;
    outcome: NonNullable<ReviewRequestRecord["outcome"]>;
    actor: DashboardUserActorPrincipal;
    comment?: string;
  }): Promise<WorkItemRecord>;
  confirmDiscovery(input: {
    workItemId: string;
    approved: boolean;
    actor: DashboardUserActorPrincipal;
    jiraIssueKey?: string;
  }): Promise<WorkItemRecord>;
  stopProcessing(input: {
    workItemId: string;
    actor: DashboardUserActorPrincipal;
  }): Promise<{ workItem: WorkItemRecord; stoppedRunIds: string[]; alreadyIdleRunIds: string[]; failedRunIds: string[] }>;
  guardedOverrideState(input: {
    workItemId: string;
    state: WorkItemRecord["state"];
    substate?: string;
    actor: DashboardActorPrincipal;
    reason: string;
  }): Promise<WorkItemRecord>;
}
