export type WorkItemWorkflow = "product_discovery" | "feature_delivery";

export type ProductDiscoveryState =
  | "backlog"
  | "in_progress"
  | "waiting_for_review"
  | "waiting_for_pm_confirmation"
  | "done"
  | "cancelled";

export type FeatureDeliveryState =
  | "backlog"
  | "in_progress"
  | "auto_review"
  | "engineering_review"
  | "qa_preparation"
  | "product_review"
  | "qa_review"
  | "ready_for_merge"
  | "done"
  | "cancelled";

export type WorkItemState = ProductDiscoveryState | FeatureDeliveryState;

export type ReviewRequestType = "review" | "approval";
export type ReviewRequestTargetType = "user" | "team" | "team_role" | "org_role";
export type ReviewRequestStatus = "pending" | "completed" | "cancelled" | "superseded";
export type ReviewRequestOutcome = "approved" | "changes_requested" | "commented" | "no_response";
export type ReviewRequestCommentSource = "slack" | "dashboard" | "system";

export interface WorkItemRecord {
  id: string;
  workflow: WorkItemWorkflow;
  state: WorkItemState;
  substate?: string;
  flags: string[];
  title: string;
  summary: string;
  ownerTeamId: string;
  homeChannelId: string;
  homeThreadTs: string;
  originChannelId?: string;
  originThreadTs?: string;
  jiraIssueKey?: string;
  githubPrNumber?: number;
  githubPrUrl?: string;
  sourceWorkItemId?: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface CreateWorkItemInput {
  workflow: WorkItemWorkflow;
  state: WorkItemState;
  substate?: string;
  flags?: string[];
  title: string;
  summary?: string;
  ownerTeamId: string;
  homeChannelId: string;
  homeThreadTs: string;
  originChannelId?: string;
  originThreadTs?: string;
  jiraIssueKey?: string;
  githubPrNumber?: number;
  githubPrUrl?: string;
  sourceWorkItemId?: string;
  createdByUserId: string;
}

export interface UpdateWorkItemStateInput {
  state: WorkItemState;
  substate?: string;
  flagsToAdd?: string[];
  flagsToRemove?: string[];
}

export interface ReviewRequestRecord {
  id: string;
  workItemId: string;
  reviewRound: number;
  type: ReviewRequestType;
  targetType: ReviewRequestTargetType;
  targetRef: Record<string, unknown>;
  status: ReviewRequestStatus;
  outcome?: ReviewRequestOutcome;
  title: string;
  requestMessage: string;
  focusPoints: string[];
  requestedByUserId: string;
  requestedAt: string;
  resolvedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateReviewRequestInput {
  workItemId: string;
  reviewRound: number;
  type: ReviewRequestType;
  targetType: ReviewRequestTargetType;
  targetRef: Record<string, unknown>;
  status: ReviewRequestStatus;
  title: string;
  requestMessage?: string;
  focusPoints?: string[];
  requestedByUserId: string;
}

export interface CompleteReviewRequestInput {
  outcome: ReviewRequestOutcome;
  resolvedAt?: string;
}

export interface CreateReviewRequestCommentInput {
  reviewRequestId: string;
  authorUserId?: string;
  source: ReviewRequestCommentSource;
  body: string;
}

export interface ReviewRequestCommentRecord {
  id: number;
  reviewRequestId: string;
  authorUserId?: string;
  source: ReviewRequestCommentSource;
  body: string;
  createdAt: string;
}

export interface WorkItemEventRecord {
  id: number;
  workItemId: string;
  eventType: string;
  payload: Record<string, unknown>;
  actorUserId?: string;
  createdAt: string;
}

export interface AppendWorkItemEventInput {
  workItemId: string;
  eventType: string;
  payload?: Record<string, unknown>;
  actorUserId?: string;
}
