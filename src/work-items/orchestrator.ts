import type { Database } from "../db/index.js";
import { sql } from "drizzle-orm";
import type { SandboxRuntime } from "../runtime/runtime-mode.js";
import type { RunRecord } from "../types.js";
import {
  canAutoRebaseFeatureDeliveryBranch,
} from "./feature-delivery-policy.js";
import { applyWorkItemDecision } from "./feature-delivery-decision.js";
import { reduceFeatureDelivery } from "./feature-delivery-reducer.js";
import { RunStore } from "../store.js";
import {
  FEATURE_DELIVERY_BRANCH_SYNC_PIPELINE_ID,
  FEATURE_DELIVERY_CI_FIX_PIPELINE_ID,
  FEATURE_DELIVERY_READY_FOR_MERGE_PIPELINE_ID,
  FEATURE_DELIVERY_REVIEW_FEEDBACK_PIPELINE_ID,
  FEATURE_DELIVERY_SELF_REVIEW_PIPELINE_ID,
} from "../pipeline/builtin-pipelines.js";
import { buildAutoReviewTask, buildBranchSyncTask, buildCiFixTask, buildReadyForMergeTask } from "./auto-review-task.js";
import { WorkItemEventsStore } from "./events-store.js";
import { WorkItemStore } from "./store.js";
import {
  buildFeatureDeliveryApplyReviewFeedbackIntent,
  buildFeatureDeliveryFinalizePrIntent,
  buildFeatureDeliveryRepairCiIntent,
  buildFeatureDeliverySelfReviewIntent,
  buildFeatureDeliverySyncBranchIntent,
  isFeatureDeliveryAutoReviewOrRepairCiRun,
  isFeatureDeliveryAutoReviewRun,
  isSuccessfulFeatureDeliveryProgressCheckpoint,
  type FeatureDeliveryRunIntent,
} from "../runs/run-intent.js";
import {
  AI_ASSIST_DISABLED_FLAG,
  AI_ASSIST_ENABLED_FLAG,
  GITHUB_PR_ADOPTED_FLAG,
  type FeatureDeliveryAutoReviewSubstate,
  type WorkItemRecord,
} from "./types.js";

const AUTO_REVIEW_REQUESTED_BY = "work-item:auto-review";
const CI_FIX_REQUESTED_BY = "work-item:ci-fix";
const BRANCH_SYNC_REQUESTED_BY = "work-item:branch-sync";
const READY_FOR_MERGE_REQUESTED_BY = "work-item:ready-for-merge";
const ACTIVE_AUTO_REVIEW_RUN_STATUSES = new Set(["queued", "running", "validating", "pushing", "awaiting_ci", "ci_fixing"]);
const PREFETCH_FAILURE_PATTERN = /prefetch/i;

export interface WorkItemOrchestratorDeps {
  config?: {
    defaultBaseBranch: string;
    sandboxRuntime?: SandboxRuntime;
    autoReviewBranchSyncMaxBehindCommits?: number;
    featureDeliverySkipQaPreparation?: boolean;
    featureDeliverySkipProductReview?: boolean;
  };
  readyForMergeHandler?: (workItem: WorkItemRecord) => Promise<void> | void;
  runManager?: {
    requeueExistingRun(runId: string): void;
  };
}

export class WorkItemOrchestrator {
  private readonly workItems: WorkItemStore;
  private readonly runs: RunStore;
  private readonly events: WorkItemEventsStore;

  constructor(
    private readonly db: Database,
    private readonly deps: WorkItemOrchestratorDeps = {},
  ) {
    this.workItems = new WorkItemStore(db);
    this.runs = new RunStore(db);
    this.events = new WorkItemEventsStore(db);
  }

  async reconcileWorkItem(workItemId: string, reason = "reconcile"): Promise<WorkItemRecord | undefined> {
    let launchedRunId: string | undefined;
    let updatedWorkItem: WorkItemRecord | undefined;
    const baseBranch = this.deps.config?.defaultBaseBranch ?? "main";
    const runtime = this.deps.config?.sandboxRuntime ?? "local";

    await this.db.transaction(async (tx) => {
      const txDb = tx as unknown as Database;
      const txWorkItems = new WorkItemStore(txDb);
      const txRuns = new RunStore(txDb);
      const txEvents = new WorkItemEventsStore(txDb);

      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${workItemId}))`);

      const current = await txWorkItems.getWorkItem(workItemId);
      if (!current || !shouldAutoLaunchSystemRun(current)) {
        updatedWorkItem = current;
        return;
      }

      const existingRuns = await txRuns.listRunsForWorkItem(workItemId);
      if (existingRuns.some((run) => isActiveWorkItemSystemRun(run))) {
        updatedWorkItem = current;
        return;
      }

      const launchPlan = resolveLaunchPlan(current, reason);
      updatedWorkItem = await txWorkItems.updateState(workItemId, {
        state: current.state,
        substate: launchPlan.nextSubstate,
      });

      const queuedRun = await txRuns.createRun({
        repoSlug: requireWorkItemRepo(current),
        task: launchPlan.buildTask(current),
        baseBranch: current.githubPrBaseBranch ?? baseBranch,
        requestedBy: launchPlan.legacyRequestedBy,
        channelId: current.homeChannelId,
        threadTs: current.homeThreadTs,
        runtime,
        prUrl: current.githubPrUrl,
        prNumber: current.githubPrNumber,
        workItemId: current.id,
        autoReviewSourceSubstate: current.substate,
        pipelineHint: launchPlan.legacyPipelineHint,
        intent: launchPlan.intent,
      }, "gooseherd", launchPlan.existingBranchName);
      launchedRunId = queuedRun.id;

      await txEvents.append({
        workItemId: current.id,
        eventType: "run.auto_launched",
        payload: {
          runId: queuedRun.id,
          reason,
          requestedBy: launchPlan.legacyRequestedBy,
          intentKind: launchPlan.intent.kind,
          substate: updatedWorkItem.substate,
        },
      });
    });

    if (launchedRunId) {
      this.deps.runManager?.requeueExistingRun(launchedRunId);
    }

    return updatedWorkItem;
  }

  async writebackWorkItem(runId: string): Promise<WorkItemRecord | undefined> {
    const run = await this.runs.getRun(runId);
    if (!run?.workItemId || !isSuccessfulWorkItemCheckpoint(run)) {
      return undefined;
    }

    const workItem = await this.workItems.getWorkItem(run.workItemId);
    if (!workItem || workItem.workflow !== "feature_delivery" || workItem.state !== "auto_review") {
      return workItem;
    }

    const decision = reduceFeatureDelivery(
      workItem,
      { type: "run.self_review_checkpoint_succeeded" },
      {
        skipQaPreparation: this.deps.config?.featureDeliverySkipQaPreparation ?? false,
        skipProductReview: this.deps.config?.featureDeliverySkipProductReview ?? false,
      },
    );
    const updated = await applyWorkItemDecision(this.workItems, workItem, decision);

    for (const command of decision.commands) {
      if (command.type === "ready_for_merge_entered") {
        return this.handleReadyForMergeEntry(workItem.state, updated);
      }
    }

    return updated;
  }

  async handlePrefetchFailure(runId: string): Promise<WorkItemRecord | undefined> {
    const run = await this.runs.getRun(runId);
    if (!isLatestRollbackCandidate(run)) {
      return undefined;
    }

    let rolledBack: WorkItemRecord | undefined;
    await this.db.transaction(async (tx) => {
      const txDb = tx as unknown as Database;
      const txRuns = new RunStore(txDb);
      const txWorkItems = new WorkItemStore(txDb);

      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${run.workItemId!}))`);

      const latestRun = await txRuns.getRun(runId);
      if (!isLatestRollbackCandidate(latestRun)) {
        return;
      }

      const latestRuns = await txRuns.listRunsForWorkItem(latestRun.workItemId!);
      const latestAutoReview = latestRuns.find((candidate) => isFeatureDeliveryAutoReviewRun(candidate));
      if (!latestAutoReview || latestAutoReview.id !== latestRun.id) {
        return;
      }

      rolledBack = await txWorkItems.rollbackAutoReviewCollectingContext({
        workItemId: latestRun.workItemId!,
        expectedState: "auto_review",
        expectedSubstate: "collecting_context",
        targetSubstate: latestRun.autoReviewSourceSubstate!,
      });
    });

    return rolledBack;
  }

  async queueBranchSyncRun(workItemId: string, reason = "periodic.branch_stale"): Promise<WorkItemRecord | undefined> {
    let launchedRunId: string | undefined;
    let currentWorkItem: WorkItemRecord | undefined;
    const baseBranch = this.deps.config?.defaultBaseBranch ?? "main";
    const runtime = this.deps.config?.sandboxRuntime ?? "local";
    const maxBehindCommits = this.deps.config?.autoReviewBranchSyncMaxBehindCommits ?? 5;

    await this.db.transaction(async (tx) => {
      const txDb = tx as unknown as Database;
      const txWorkItems = new WorkItemStore(txDb);
      const txRuns = new RunStore(txDb);
      const txEvents = new WorkItemEventsStore(txDb);

      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${workItemId}))`);

      const current = await txWorkItems.getWorkItem(workItemId);
      if (!current || !shouldQueueBranchSyncRun(current)) {
        currentWorkItem = current;
        return;
      }

      const existingRuns = await txRuns.listRunsForWorkItem(workItemId);
      if (existingRuns.some((run) => ACTIVE_AUTO_REVIEW_RUN_STATUSES.has(run.status) || run.status === "cancel_requested")) {
        currentWorkItem = current;
        return;
      }

      const queuedRun = await txRuns.createRun({
        repoSlug: requireWorkItemRepo(current),
        task: buildBranchSyncTask({
          ...buildTaskInput(current),
          maxBehindCommits,
        }),
        baseBranch: current.githubPrBaseBranch ?? baseBranch,
        requestedBy: BRANCH_SYNC_REQUESTED_BY,
        channelId: current.homeChannelId,
        threadTs: current.homeThreadTs,
        runtime,
        prUrl: current.githubPrUrl,
        prNumber: current.githubPrNumber,
        workItemId: current.id,
        autoReviewSourceSubstate: current.substate,
        pipelineHint: FEATURE_DELIVERY_BRANCH_SYNC_PIPELINE_ID,
        intent: buildFeatureDeliverySyncBranchIntent(current, {
          maxBehindCommits,
          triggerReason: reason,
        }),
      }, "gooseherd", requireWorkItemPrHeadBranch(current));
      launchedRunId = queuedRun.id;
      currentWorkItem = current;

      await txEvents.append({
        workItemId: current.id,
        eventType: "run.branch_sync_launched",
        payload: {
          runId: queuedRun.id,
          reason,
          requestedBy: BRANCH_SYNC_REQUESTED_BY,
        },
      });
    });

    if (launchedRunId) {
      this.deps.runManager?.requeueExistingRun(launchedRunId);
    }

    return currentWorkItem;
  }

  async queueReadyForMergeRun(
    workItemId: string,
    reason = "ready_for_merge.entered",
  ): Promise<WorkItemRecord | undefined> {
    let launchedRunId: string | undefined;
    let currentWorkItem: WorkItemRecord | undefined;
    const baseBranch = this.deps.config?.defaultBaseBranch ?? "main";
    const runtime = this.deps.config?.sandboxRuntime ?? "local";

    await this.db.transaction(async (tx) => {
      const txDb = tx as unknown as Database;
      const txWorkItems = new WorkItemStore(txDb);
      const txRuns = new RunStore(txDb);
      const txEvents = new WorkItemEventsStore(txDb);

      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${workItemId}))`);

      const current = await txWorkItems.getWorkItem(workItemId);
      if (!current || current.workflow !== "feature_delivery" || current.state !== "ready_for_merge") {
        currentWorkItem = current;
        return;
      }

      const existingRuns = await txRuns.listRunsForWorkItem(workItemId);
      if (existingRuns.some((run) => ACTIVE_AUTO_REVIEW_RUN_STATUSES.has(run.status) || run.status === "cancel_requested")) {
        currentWorkItem = current;
        return;
      }

      const queuedRun = await txRuns.createRun({
        repoSlug: requireWorkItemRepo(current),
        task: buildReadyForMergeTask(buildTaskInput(current)),
        baseBranch: current.githubPrBaseBranch ?? baseBranch,
        requestedBy: READY_FOR_MERGE_REQUESTED_BY,
        channelId: current.homeChannelId,
        threadTs: current.homeThreadTs,
        runtime,
        prUrl: current.githubPrUrl,
        prNumber: current.githubPrNumber,
        workItemId: current.id,
        autoReviewSourceSubstate: current.substate,
        pipelineHint: FEATURE_DELIVERY_READY_FOR_MERGE_PIPELINE_ID,
        intent: buildFeatureDeliveryFinalizePrIntent(current, {
          strategy: "squash",
          triggerReason: reason,
        }),
      }, "gooseherd", requireWorkItemPrHeadBranch(current));
      launchedRunId = queuedRun.id;
      currentWorkItem = current;

      await txEvents.append({
        workItemId: current.id,
        eventType: "run.ready_for_merge_launched",
        payload: {
          runId: queuedRun.id,
          reason,
          requestedBy: READY_FOR_MERGE_REQUESTED_BY,
        },
      });
    });

    if (launchedRunId) {
      this.deps.runManager?.requeueExistingRun(launchedRunId);
    }

    return currentWorkItem;
  }

  private async handleReadyForMergeEntry(
    previousState: WorkItemRecord["state"],
    workItem: WorkItemRecord,
  ): Promise<WorkItemRecord> {
    if (previousState === "ready_for_merge" || workItem.workflow !== "feature_delivery" || workItem.state !== "ready_for_merge") {
      return workItem;
    }

    await this.deps.readyForMergeHandler?.(workItem);
    return workItem;
  }
}

export async function reconcileWorkItem(
  db: Database,
  workItemId: string,
  reasonOrDeps: string | WorkItemOrchestratorDeps = "reconcile",
  deps?: WorkItemOrchestratorDeps,
): Promise<WorkItemRecord | undefined> {
  const reason = typeof reasonOrDeps === "string" ? reasonOrDeps : "reconcile";
  const resolvedDeps = typeof reasonOrDeps === "string" ? deps : reasonOrDeps;
  return new WorkItemOrchestrator(db, resolvedDeps).reconcileWorkItem(workItemId, reason);
}

export async function writebackWorkItem(
  db: Database,
  runId: string,
  deps?: WorkItemOrchestratorDeps,
): Promise<WorkItemRecord | undefined> {
  return new WorkItemOrchestrator(db, deps).writebackWorkItem(runId);
}

export async function handlePrefetchFailure(
  db: Database,
  runId: string,
  deps?: WorkItemOrchestratorDeps,
): Promise<WorkItemRecord | undefined> {
  return new WorkItemOrchestrator(db, deps).handlePrefetchFailure(runId);
}

export async function queueBranchSyncRun(
  db: Database,
  workItemId: string,
  reason = "periodic.branch_stale",
  deps?: WorkItemOrchestratorDeps,
): Promise<WorkItemRecord | undefined> {
  return new WorkItemOrchestrator(db, deps).queueBranchSyncRun(workItemId, reason);
}

export async function queueReadyForMergeRun(
  db: Database,
  workItemId: string,
  reason = "ready_for_merge.entered",
  deps?: WorkItemOrchestratorDeps,
): Promise<WorkItemRecord | undefined> {
  return new WorkItemOrchestrator(db, deps).queueReadyForMergeRun(workItemId, reason);
}

function shouldAutoLaunchSystemRun(workItem: WorkItemRecord): boolean {
  if (
    workItem.workflow !== "feature_delivery" ||
    workItem.state !== "auto_review" ||
    !isAiAssistAutomationEnabled(workItem)
  ) {
    return false;
  }

  return (
    workItem.substate === "pr_adopted" ||
    workItem.substate === "ci_green_pending_self_review" ||
    workItem.substate === "applying_review_feedback" ||
    workItem.substate === "ci_failed"
  );
}

function shouldQueueBranchSyncRun(workItem: WorkItemRecord): boolean {
  return (
    workItem.workflow === "feature_delivery" &&
    workItem.state !== "done" &&
    workItem.state !== "cancelled" &&
    isAiAssistAutomationEnabled(workItem) &&
    canAutoRebaseFeatureDeliveryBranch(workItem.flags) &&
    typeof workItem.repo === "string" &&
    workItem.repo.length > 0 &&
    typeof workItem.githubPrBaseBranch === "string" &&
    workItem.githubPrBaseBranch.length > 0 &&
    typeof workItem.githubPrHeadBranch === "string" &&
    workItem.githubPrHeadBranch.length > 0
  );
}

function requireWorkItemRepo(workItem: WorkItemRecord): string {
  if (!workItem.repo) {
    throw new Error(`Work item ${workItem.id} is missing repo metadata`);
  }
  return workItem.repo;
}

function requireWorkItemPrNumber(workItem: WorkItemRecord): number {
  if (!workItem.githubPrNumber) {
    throw new Error(`Work item ${workItem.id} is missing GitHub PR number`);
  }
  return workItem.githubPrNumber;
}

function requireWorkItemPrUrl(workItem: WorkItemRecord): string {
  if (!workItem.githubPrUrl) {
    throw new Error(`Work item ${workItem.id} is missing GitHub PR URL`);
  }
  return workItem.githubPrUrl;
}

function requireWorkItemPrHeadBranch(workItem: WorkItemRecord): string {
  const branch = workItem.githubPrHeadBranch?.trim();
  if (!branch) {
    throw new Error(`Work item ${workItem.id} is missing GitHub PR head branch`);
  }
  return branch;
}

function buildTaskInput(workItem: WorkItemRecord) {
  return {
    repo: requireWorkItemRepo(workItem),
    prNumber: requireWorkItemPrNumber(workItem),
    prUrl: requireWorkItemPrUrl(workItem),
    jiraIssueKey: workItem.jiraIssueKey,
    title: workItem.title,
    summary: workItem.summary,
  };
}

function resolveLaunchPlan(workItem: WorkItemRecord, reason?: string): {
  nextSubstate: string | undefined;
  intent: FeatureDeliveryRunIntent;
  legacyRequestedBy: string;
  legacyPipelineHint: string;
  existingBranchName?: string;
  buildTask: (current: WorkItemRecord) => string;
} {
  switch (workItem.substate as FeatureDeliveryAutoReviewSubstate | undefined) {
    case "pr_adopted":
      return {
        nextSubstate: "collecting_context",
        intent: buildFeatureDeliverySelfReviewIntent(workItem, {
          sourceSubstate: "pr_adopted",
          triggerReason: reason,
        }),
        legacyRequestedBy: AUTO_REVIEW_REQUESTED_BY,
        legacyPipelineHint: FEATURE_DELIVERY_SELF_REVIEW_PIPELINE_ID,
        existingBranchName: workItem.githubPrHeadBranch,
        buildTask: (current) => buildAutoReviewTask(buildTaskInput(current)),
      };
    case "applying_review_feedback":
      return {
        nextSubstate: workItem.substate,
        intent: buildFeatureDeliveryApplyReviewFeedbackIntent(workItem, { triggerReason: reason }),
        legacyRequestedBy: AUTO_REVIEW_REQUESTED_BY,
        legacyPipelineHint: FEATURE_DELIVERY_REVIEW_FEEDBACK_PIPELINE_ID,
        existingBranchName: workItem.githubPrHeadBranch,
        buildTask: (current) => buildAutoReviewTask(buildTaskInput(current)),
      };
    case "ci_green_pending_self_review":
      return {
        nextSubstate: "collecting_context",
        intent: buildFeatureDeliverySelfReviewIntent(workItem, {
          sourceSubstate: "ci_green_pending_self_review",
          triggerReason: reason,
        }),
        legacyRequestedBy: AUTO_REVIEW_REQUESTED_BY,
        legacyPipelineHint: FEATURE_DELIVERY_SELF_REVIEW_PIPELINE_ID,
        existingBranchName: workItem.githubPrHeadBranch,
        buildTask: (current) => buildAutoReviewTask(buildTaskInput(current)),
      };
    case "ci_failed":
      return {
        nextSubstate: workItem.substate,
        intent: buildFeatureDeliveryRepairCiIntent(workItem, { triggerReason: reason }),
        legacyRequestedBy: CI_FIX_REQUESTED_BY,
        legacyPipelineHint: FEATURE_DELIVERY_CI_FIX_PIPELINE_ID,
        existingBranchName: requireWorkItemPrHeadBranch(workItem),
        buildTask: (current) => buildCiFixTask(buildTaskInput(current)),
      };
    default:
      throw new Error(`Unsupported auto_review substate for launch: ${String(workItem.substate)}`);
  }
}

function isActiveWorkItemSystemRun(run: RunRecord): boolean {
  return isFeatureDeliveryAutoReviewOrRepairCiRun(run) && ACTIVE_AUTO_REVIEW_RUN_STATUSES.has(run.status);
}

function isSuccessfulWorkItemCheckpoint(run: RunRecord): boolean {
  return isSuccessfulFeatureDeliveryProgressCheckpoint(run);
}

function isLatestRollbackCandidate(run: {
  status: string;
  requestedBy: string;
  error?: string;
  workItemId?: string;
  autoReviewSourceSubstate?: string;
  intent?: RunRecord["intent"];
} | undefined): run is {
  status: string;
  requestedBy: string;
  error: string;
  workItemId: string;
  autoReviewSourceSubstate: string;
} {
  if (!run) {
    return false;
  }
  return (
    run.status === "failed" &&
    isFeatureDeliveryAutoReviewRun(run as RunRecord) &&
    typeof run.error === "string" &&
    PREFETCH_FAILURE_PATTERN.test(run.error) &&
    typeof run.workItemId === "string" &&
    typeof run.autoReviewSourceSubstate === "string" &&
    run.autoReviewSourceSubstate.length > 0
  );
}

function isAiAssistAutomationEnabled(workItem: Pick<WorkItemRecord, "flags">): boolean {
  if (workItem.flags.includes(AI_ASSIST_DISABLED_FLAG)) {
    return false;
  }

  return workItem.flags.includes(AI_ASSIST_ENABLED_FLAG) || workItem.flags.includes(GITHUB_PR_ADOPTED_FLAG);
}
