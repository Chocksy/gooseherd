import type { Database } from "../db/index.js";
import { RunStore } from "../store.js";
import { actorAuditFields, isAdminOverrideActor, requireUserActor, type WorkItemActor } from "./actor.js";
import { WorkItemAuthorization } from "./authorization.js";
import { WorkItemEventsStore } from "./events-store.js";
import { nextDiscoveryStateAfterPmConfirmation, evaluateDiscoveryReviewRound } from "./product-discovery-policy.js";
import { ReviewRequestStore } from "./review-request-store.js";
import { WorkItemStore } from "./store.js";
import type {
  CreateWorkItemInput,
  ReviewRequestCommentSource,
  ReviewRequestRecord,
  WorkItemRecord,
} from "./types.js";
import {
  assertCanConfirmDiscovery,
  assertCanRequestDiscoveryReview,
  assertCanResolveDiscoveryReview,
  assertStateTransitionAllowed,
} from "./workflow-policy.js";

export interface WorkItemServiceOptions {
  readyForMergeHandler?: (workItem: WorkItemRecord) => Promise<void> | void;
}

export class WorkItemService {
  private readonly workItems: WorkItemStore;
  private readonly reviewRequests: ReviewRequestStore;
  private readonly events: WorkItemEventsStore;
  private readonly runs: RunStore;
  private readonly authorization: WorkItemAuthorization;
  private readonly readyForMergeHandler?: WorkItemServiceOptions["readyForMergeHandler"];

  constructor(private readonly db: Database, options: WorkItemServiceOptions = {}) {
    this.workItems = new WorkItemStore(db);
    this.reviewRequests = new ReviewRequestStore(db);
    this.events = new WorkItemEventsStore(db);
    this.runs = new RunStore(db);
    this.authorization = new WorkItemAuthorization(db);
    this.readyForMergeHandler = options.readyForMergeHandler;
  }

  async getWorkItem(id: string): Promise<WorkItemRecord | undefined> {
    return this.workItems.getWorkItem(id);
  }

  async listReviewRequestComments(reviewRequestId: string) {
    return this.reviewRequests.listComments(reviewRequestId);
  }

  async createDiscoveryWorkItem(input: Omit<CreateWorkItemInput, "workflow" | "state">): Promise<WorkItemRecord> {
    await this.authorization.assertCanCreateWorkItem(input.createdByUserId, input.ownerTeamId);
    const workItem = await this.workItems.createWorkItem({
      ...input,
      workflow: "product_discovery",
      state: "backlog",
      flags: Array.from(new Set([...(input.flags ?? []), ...(input.jiraIssueKey ? ["jira_created"] : [])])),
    });
    await this.events.append({
      workItemId: workItem.id,
      eventType: "work_item.created",
      actorUserId: workItem.createdByUserId,
      payload: { workflow: workItem.workflow, state: workItem.state },
    });
    return workItem;
  }

  async startDiscovery(workItemId: string): Promise<WorkItemRecord> {
    const updated = await this.workItems.updateState(workItemId, {
      state: "in_progress",
      substate: "collecting_context",
    });
    await this.events.append({
      workItemId,
      eventType: "work_item.state_changed",
      actorUserId: updated.createdByUserId,
      payload: { state: updated.state, substate: updated.substate },
    });
    return updated;
  }

  async requestReview(input: {
    workItemId: string;
    actor: WorkItemActor;
    requests: Array<{
      type: ReviewRequestRecord["type"];
      targetType: ReviewRequestRecord["targetType"];
      targetRef: Record<string, unknown>;
      title: string;
      requestMessage?: string;
      focusPoints?: string[];
    }>;
  }): Promise<ReviewRequestRecord[]> {
    const workItem = await this.requireWorkItem(input.workItemId);
    const actor = requireUserActor(input.actor);
    await this.authorization.assertCanRequestReview(actor.userId, workItem);
    assertCanRequestDiscoveryReview(workItem);
    const currentRequests = await this.reviewRequests.listReviewRequestsForWorkItem(workItem.id);
    const nextReviewRound = Math.max(0, ...currentRequests.map((request) => request.reviewRound)) + 1;

    const created: ReviewRequestRecord[] = [];
    for (const request of input.requests) {
      created.push(await this.reviewRequests.createReviewRequest({
        workItemId: input.workItemId,
        reviewRound: nextReviewRound,
        type: request.type,
        targetType: request.targetType,
        targetRef: request.targetRef,
        status: "pending",
        title: request.title,
        requestMessage: request.requestMessage,
        focusPoints: request.focusPoints,
        requestedByUserId: actor.userId,
      }));
    }

    const updated = await this.workItems.updateState(input.workItemId, {
      state: "waiting_for_review",
      substate: "waiting_review_responses",
    });

    await this.events.append({
      workItemId: input.workItemId,
      eventType: "review_request.created",
      actorUserId: actor.userId,
      payload: {
        reviewRound: nextReviewRound,
        reviewRequestIds: created.map((request) => request.id),
        ...actorAuditFields(actor),
      },
    });
    await this.events.append({
      workItemId: input.workItemId,
      eventType: "work_item.state_changed",
      actorUserId: actor.userId,
      payload: { state: updated.state, substate: updated.substate, ...actorAuditFields(actor) },
    });

    return created;
  }

  async recordReviewOutcome(input: {
    reviewRequestId: string;
    actor: WorkItemActor;
    outcome: NonNullable<ReviewRequestRecord["outcome"]>;
    comment?: string;
    source?: ReviewRequestCommentSource;
  }): Promise<WorkItemRecord> {
    const actor = requireUserActor(input.actor);
    const existingReviewRequest = await this.reviewRequests.getReviewRequest(input.reviewRequestId);
    if (!existingReviewRequest) {
      throw new Error(`ReviewRequest not found: ${input.reviewRequestId}`);
    }
    const workItem = await this.requireWorkItem(existingReviewRequest.workItemId);
    await this.authorization.assertCanRespondToReviewRequest(actor.userId, workItem, existingReviewRequest);
    assertCanResolveDiscoveryReview(workItem);

    const completed = await this.reviewRequests.completeReviewRequest(input.reviewRequestId, {
      outcome: input.outcome,
    });

    if (input.comment) {
      await this.reviewRequests.addComment({
        reviewRequestId: input.reviewRequestId,
        authorUserId: actor.userId,
        source: input.source ?? "dashboard",
        body: input.comment,
      });
      await this.events.append({
        workItemId: completed.workItemId,
        eventType: "review_request.comment_added",
        actorUserId: actor.userId,
        payload: {
          reviewRequestId: input.reviewRequestId,
          source: input.source ?? "dashboard",
          ...actorAuditFields(actor),
        },
      });
      if (input.source === "slack") {
        await this.events.append({
          workItemId: completed.workItemId,
          eventType: "slack.action_observed",
          actorUserId: actor.userId,
          payload: { reviewRequestId: input.reviewRequestId, outcome: input.outcome, ...actorAuditFields(actor) },
        });
      }
    }

    const currentRound = await this.reviewRequests.listReviewRequestsForWorkItem(completed.workItemId, completed.reviewRound);
    const roundResult = evaluateDiscoveryReviewRound(workItem, currentRound);

    for (const requestId of roundResult.supersedePendingRequestIds) {
      await this.reviewRequests.setStatus(requestId, "superseded");
    }

    const updated = await this.workItems.updateState(workItem.id, {
      state: roundResult.nextState,
      substate: roundResult.nextState === "waiting_for_pm_confirmation" ? "awaiting_pm_decision" : "applying_review_feedback",
      flagsToAdd: roundResult.nextState === "waiting_for_pm_confirmation" ? ["all_required_reviews_received"] : [],
    });

    await this.events.append({
      workItemId: workItem.id,
      eventType: "review_request.completed",
      actorUserId: actor.userId,
      payload: { reviewRequestId: input.reviewRequestId, outcome: input.outcome, ...actorAuditFields(actor) },
    });
    await this.events.append({
      workItemId: workItem.id,
      eventType: "work_item.state_changed",
      actorUserId: actor.userId,
      payload: { state: updated.state, substate: updated.substate, ...actorAuditFields(actor) },
    });

    return updated;
  }

  async confirmDiscovery(input: {
    workItemId: string;
    approved: boolean;
    actor: WorkItemActor;
    jiraIssueKey?: string;
  }): Promise<WorkItemRecord> {
    const workItem = await this.requireWorkItem(input.workItemId);
    const actor = requireUserActor(input.actor);
    await this.authorization.assertCanApplyManualTransition(actor.userId, workItem);
    assertCanConfirmDiscovery(workItem);

    if (input.approved) {
      const jiraIssueKey = input.jiraIssueKey?.trim() || workItem.jiraIssueKey;
      if (!jiraIssueKey) {
        throw new Error("Jira issue key is required before completing discovery");
      }

      try {
        return await this.db.transaction(async (tx) => {
          const txDb = tx as unknown as Database;
          const txWorkItems = new WorkItemStore(txDb);
          const txEvents = new WorkItemEventsStore(txDb);

          const currentWorkItem = await txWorkItems.getWorkItem(input.workItemId);
          if (!currentWorkItem) {
            throw new Error(`WorkItem not found: ${input.workItemId}`);
          }
          assertCanConfirmDiscovery(currentWorkItem);

          const currentJiraIssueKey = input.jiraIssueKey?.trim() || currentWorkItem.jiraIssueKey;
          if (!currentJiraIssueKey) {
            throw new Error("Jira issue key is required before completing discovery");
          }

          const existingDeliveries = await txWorkItems.listFeatureDeliveriesBySourceWorkItemId(currentWorkItem.id);
          if (existingDeliveries.length > 0) {
            throw new Error(`Delivery work item already exists for discovery ${currentWorkItem.id}`);
          }

          if (!currentWorkItem.jiraIssueKey) {
            await txWorkItems.setJiraIssueKey(currentWorkItem.id, currentJiraIssueKey);
          }

          const delivery = await txWorkItems.createWorkItem({
            workflow: "feature_delivery",
            state: "backlog",
            title: currentWorkItem.title,
            summary: currentWorkItem.summary,
            ownerTeamId: currentWorkItem.ownerTeamId,
            homeChannelId: currentWorkItem.homeChannelId,
            homeThreadTs: currentWorkItem.homeThreadTs,
            originChannelId: currentWorkItem.originChannelId,
            originThreadTs: currentWorkItem.originThreadTs,
            jiraIssueKey: currentJiraIssueKey,
            sourceWorkItemId: currentWorkItem.id,
            createdByUserId: actor.userId,
            flags: [],
          });

          const updated = await txWorkItems.updateState(input.workItemId, {
            state: "done",
            flagsToAdd: ["pm_approved", "jira_created", "delivery_work_item_created"],
          });

          await txEvents.append({
            workItemId: input.workItemId,
            eventType: "work_item.state_changed",
            actorUserId: actor.userId,
            payload: { state: updated.state, approved: input.approved, jiraIssueKey: currentJiraIssueKey, ...actorAuditFields(actor) },
          });
          await txEvents.append({
            workItemId: delivery.id,
            eventType: "work_item.created",
            actorUserId: actor.userId,
            payload: {
              workflow: delivery.workflow,
              sourceWorkItemId: currentWorkItem.id,
              jiraIssueKey: currentJiraIssueKey,
              ...actorAuditFields(actor),
            },
          });

          return updated;
        });
      } catch (error) {
        throw this.rewriteDeliveryCreationConflict(error, workItem.id, jiraIssueKey);
      }
    }

    const nextState = nextDiscoveryStateAfterPmConfirmation(input.approved);
    const updated = await this.workItems.updateState(input.workItemId, {
      state: nextState,
      substate: nextState === "done" ? undefined : "applying_review_feedback",
      flagsToAdd: input.approved ? ["pm_approved"] : [],
    });

    await this.events.append({
      workItemId: input.workItemId,
      eventType: "work_item.state_changed",
      actorUserId: actor.userId,
      payload: { state: updated.state, approved: input.approved, ...actorAuditFields(actor) },
    });

    return updated;
  }

  async createDeliveryFromDiscovery(input: {
    discoveryWorkItemId: string;
    jiraIssueKey: string;
    createdByUserId: string;
  }): Promise<WorkItemRecord> {
    const discovery = await this.requireWorkItem(input.discoveryWorkItemId);
    if (discovery.workflow !== "product_discovery") {
      throw new Error(`Expected product_discovery source, got ${discovery.workflow}`);
    }
    if (discovery.state !== "done") {
      throw new Error(`Discovery work item must be done before creating delivery, got ${discovery.state}`);
    }

    const delivery = await this.workItems.createWorkItem({
      workflow: "feature_delivery",
      state: "backlog",
      title: discovery.title,
      summary: discovery.summary,
      ownerTeamId: discovery.ownerTeamId,
      homeChannelId: discovery.homeChannelId,
      homeThreadTs: discovery.homeThreadTs,
      originChannelId: discovery.originChannelId,
      originThreadTs: discovery.originThreadTs,
      jiraIssueKey: input.jiraIssueKey,
      sourceWorkItemId: discovery.id,
      createdByUserId: input.createdByUserId,
      flags: [],
    });

    await this.workItems.addFlags(discovery.id, ["delivery_work_item_created"]);
    await this.events.append({
      workItemId: discovery.id,
      eventType: "work_item.flags_updated",
      actorUserId: input.createdByUserId,
      payload: { flagsAdded: ["delivery_work_item_created"], deliveryWorkItemId: delivery.id },
    });
    await this.events.append({
      workItemId: delivery.id,
      eventType: "work_item.created",
      actorUserId: input.createdByUserId,
      payload: { workflow: delivery.workflow, sourceWorkItemId: discovery.id, jiraIssueKey: input.jiraIssueKey },
    });

    return delivery;
  }

  async createDeliveryFromJira(input: {
    title: string;
    summary?: string;
    ownerTeamId: string;
    homeChannelId: string;
    homeThreadTs: string;
    originChannelId?: string;
    originThreadTs?: string;
    jiraIssueKey: string;
    createdByUserId: string;
    repo?: string;
    githubPrNumber?: number;
    githubPrUrl?: string;
    githubPrBaseBranch?: string;
    githubPrHeadBranch?: string;
    githubPrHeadSha?: string;
    initialState?: Extract<WorkItemRecord["state"], "backlog" | "auto_review">;
    initialSubstate?: string;
    flags?: string[];
  }): Promise<WorkItemRecord> {
    return this.createFeatureDelivery({
      title: input.title,
      summary: input.summary,
      ownerTeamId: input.ownerTeamId,
      homeChannelId: input.homeChannelId,
      homeThreadTs: input.homeThreadTs,
      originChannelId: input.originChannelId,
      originThreadTs: input.originThreadTs,
      jiraIssueKey: input.jiraIssueKey,
      repo: input.repo,
      createdByUserId: input.createdByUserId,
      githubPrNumber: input.githubPrNumber,
      githubPrUrl: input.githubPrUrl,
      githubPrBaseBranch: input.githubPrBaseBranch,
      githubPrHeadBranch: input.githubPrHeadBranch,
      githubPrHeadSha: input.githubPrHeadSha,
      initialState: input.initialState,
      initialSubstate: input.initialSubstate,
      flags: input.flags,
    });
  }

  async createDeliveryFromPullRequest(input: {
    title: string;
    summary?: string;
    ownerTeamId: string;
    homeChannelId: string;
    homeThreadTs: string;
    originChannelId?: string;
    originThreadTs?: string;
    createdByUserId: string;
    repo?: string;
    githubPrNumber?: number;
    githubPrUrl?: string;
    githubPrBaseBranch?: string;
    githubPrHeadBranch?: string;
    githubPrHeadSha?: string;
    initialState?: Extract<WorkItemRecord["state"], "backlog" | "auto_review">;
    initialSubstate?: string;
    flags?: string[];
  }): Promise<WorkItemRecord> {
    return this.createFeatureDelivery({
      title: input.title,
      summary: input.summary,
      ownerTeamId: input.ownerTeamId,
      homeChannelId: input.homeChannelId,
      homeThreadTs: input.homeThreadTs,
      originChannelId: input.originChannelId,
      originThreadTs: input.originThreadTs,
      repo: input.repo,
      createdByUserId: input.createdByUserId,
      githubPrNumber: input.githubPrNumber,
      githubPrUrl: input.githubPrUrl,
      githubPrBaseBranch: input.githubPrBaseBranch,
      githubPrHeadBranch: input.githubPrHeadBranch,
      githubPrHeadSha: input.githubPrHeadSha,
      initialState: input.initialState,
      initialSubstate: input.initialSubstate,
      flags: input.flags,
    });
  }

  private async createFeatureDelivery(input: {
    title: string;
    summary?: string;
    ownerTeamId: string;
    homeChannelId: string;
    homeThreadTs: string;
    originChannelId?: string;
    originThreadTs?: string;
    jiraIssueKey?: string;
    createdByUserId: string;
    repo?: string;
    githubPrNumber?: number;
    githubPrUrl?: string;
    githubPrBaseBranch?: string;
    githubPrHeadBranch?: string;
    githubPrHeadSha?: string;
    initialState?: Extract<WorkItemRecord["state"], "backlog" | "auto_review">;
    initialSubstate?: string;
    flags?: string[];
  }): Promise<WorkItemRecord> {
    const delivery = await this.workItems.createWorkItem({
      workflow: "feature_delivery",
      state: input.initialState ?? "backlog",
      substate: input.initialSubstate,
      title: input.title,
      summary: input.summary,
      ownerTeamId: input.ownerTeamId,
      homeChannelId: input.homeChannelId,
      homeThreadTs: input.homeThreadTs,
      originChannelId: input.originChannelId,
      originThreadTs: input.originThreadTs,
      jiraIssueKey: input.jiraIssueKey,
      repo: input.repo,
      githubPrNumber: input.githubPrNumber,
      githubPrUrl: input.githubPrUrl,
      githubPrBaseBranch: input.githubPrBaseBranch,
      githubPrHeadBranch: input.githubPrHeadBranch,
      githubPrHeadSha: input.githubPrHeadSha,
      createdByUserId: input.createdByUserId,
      flags: input.flags ?? [],
    });

    await this.events.append({
      workItemId: delivery.id,
      eventType: "work_item.created",
      actorUserId: input.createdByUserId,
      payload: {
        workflow: delivery.workflow,
        state: delivery.state,
        jiraIssueKey: delivery.jiraIssueKey,
        githubPrNumber: delivery.githubPrNumber,
      },
    });

    return delivery;
  }

  async guardedOverrideState(input: {
    workItemId: string;
    state: WorkItemRecord["state"];
    substate?: string;
    actor: WorkItemActor;
    reason: string;
    hasActiveProcessing?: (workItem: WorkItemRecord) => Promise<boolean>;
  }): Promise<WorkItemRecord> {
    const workItem = await this.requireWorkItem(input.workItemId);
    const actor = input.actor;
    if (!isAdminOverrideActor(actor)) {
      const userActor = requireUserActor(actor);
      await this.authorization.assertCanOverrideWorkItem(userActor.userId);
    }
    if (input.hasActiveProcessing && await input.hasActiveProcessing(workItem)) {
      throw new Error("Cannot override state while work item processing is active");
    }

    await this.events.append({
      workItemId: workItem.id,
      eventType: "override.requested",
      actorUserId: actor.principalType === "user" ? actor.userId : undefined,
      payload: {
        requestedState: input.state,
        requestedSubstate: input.substate,
        reason: input.reason,
        ...actorAuditFields(actor),
      },
    });

    const updated = await this.workItems.updateState(workItem.id, {
      state: this.assertOverrideTransitionAllowed(workItem, input.state),
      substate: input.substate,
    });
    await this.events.append({
      workItemId: workItem.id,
      eventType: "override.applied",
      actorUserId: actor.principalType === "user" ? actor.userId : undefined,
      payload: {
        previousState: workItem.state,
        previousSubstate: workItem.substate,
        nextState: updated.state,
        nextSubstate: updated.substate,
        reason: input.reason,
        ...actorAuditFields(actor),
      },
    });

    await this.handleReadyForMerge(updated);

    return updated;
  }

  async hasActiveProcessing(workItemId: string): Promise<boolean> {
    const runs = await this.runs.listRunsForWorkItem(workItemId);
    return runs.some((run) => isActivelyProcessingStatus(run.status));
  }

  async stopProcessing(input: {
    workItemId: string;
    actor: WorkItemActor;
    cancelRun: (runId: string) => Promise<boolean>;
  }): Promise<{ workItem: WorkItemRecord; stoppedRunIds: string[]; alreadyIdleRunIds: string[]; failedRunIds: string[] }> {
    const workItem = await this.requireWorkItem(input.workItemId);
    const actor = requireUserActor(input.actor);
    await this.authorization.assertCanApplyManualTransition(actor.userId, workItem);
    const runs = await this.runs.listRunsForWorkItem(workItem.id);

    const stoppedRunIds: string[] = [];
    const alreadyIdleRunIds: string[] = [];
    const failedRunIds: string[] = [];

    for (const run of runs) {
      if (!isActivelyProcessingStatus(run.status)) {
        alreadyIdleRunIds.push(run.id);
        continue;
      }

      const cancelled = await input.cancelRun(run.id);
      if (cancelled) {
        stoppedRunIds.push(run.id);
      } else {
        failedRunIds.push(run.id);
      }
    }

    await this.events.append({
      workItemId: workItem.id,
      eventType: "processing.stop_requested",
      actorUserId: actor.userId,
      payload: { stoppedRunIds, alreadyIdleRunIds, failedRunIds, ...actorAuditFields(actor) },
    });

    return { workItem, stoppedRunIds, alreadyIdleRunIds, failedRunIds };
  }

  async attachRunToWorkItem(input: {
    workItemId: string;
    runId: string;
    actorUserId?: string;
  }): Promise<WorkItemRecord> {
    const workItem = await this.requireWorkItem(input.workItemId);
    await this.runs.linkToWorkItem(input.runId, input.workItemId);
    await this.events.append({
      workItemId: workItem.id,
      eventType: "run.attached",
      actorUserId: input.actorUserId,
      payload: { runId: input.runId },
    });
    return workItem;
  }

  private async requireWorkItem(id: string): Promise<WorkItemRecord> {
    const workItem = await this.workItems.getWorkItem(id);
    if (!workItem) throw new Error(`WorkItem not found: ${id}`);
    return workItem;
  }

  private assertOverrideTransitionAllowed(workItem: WorkItemRecord, nextState: WorkItemRecord["state"]): WorkItemRecord["state"] {
    assertStateTransitionAllowed(workItem, nextState);
    return nextState;
  }

  private async handleReadyForMerge(workItem: WorkItemRecord): Promise<void> {
    if (!this.readyForMergeHandler || workItem.workflow !== "feature_delivery" || workItem.state !== "ready_for_merge") {
      return;
    }

    await this.readyForMergeHandler(workItem);
  }

  private rewriteDeliveryCreationConflict(error: unknown, workItemId: string, jiraIssueKey: string): Error {
    if (!isUniqueConstraintError(error)) {
      return error instanceof Error ? error : new Error(String(error));
    }

    return error instanceof Error ? error : new Error(String(error));
  }
}

function isActivelyProcessingStatus(status: string): boolean {
  return ["queued", "running", "validating", "pushing", "awaiting_ci", "ci_fixing"].includes(status);
}

function isUniqueConstraintError(error: unknown): error is Error & { code: string; constraint_name?: string } {
  return error instanceof Error && "code" in error && (error as { code?: string }).code === "23505";
}
