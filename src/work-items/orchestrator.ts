import type { Database } from "../db/index.js";
import { sql } from "drizzle-orm";
import type { SandboxRuntime } from "../runtime/runtime-mode.js";
import {
  canAutoRebaseFeatureDeliveryBranch,
  nextFeatureDeliveryStateAfterAutoReview,
  nextFeatureDeliveryStateAfterEngineeringReview,
} from "./feature-delivery-policy.js";
import { RunStore } from "../store.js";
import { buildAutoReviewTask, buildBranchSyncTask, buildCiFixTask } from "./auto-review-task.js";
import { WorkItemEventsStore } from "./events-store.js";
import { WorkItemStore } from "./store.js";
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
const WORK_ITEM_SYSTEM_RUN_REQUESTERS = new Set([AUTO_REVIEW_REQUESTED_BY, CI_FIX_REQUESTED_BY]);
const ACTIVE_AUTO_REVIEW_RUN_STATUSES = new Set(["queued", "running", "validating", "pushing", "awaiting_ci", "ci_fixing"]);
const PREFETCH_FAILURE_PATTERN = /prefetch/i;

export interface WorkItemOrchestratorDeps {
  config?: {
    defaultBaseBranch: string;
    sandboxRuntime?: SandboxRuntime;
    autoReviewBranchSyncMaxBehindCommits?: number;
  };
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

      const launchPlan = resolveLaunchPlan(current);
      updatedWorkItem = await txWorkItems.updateState(workItemId, {
        state: current.state,
        substate: launchPlan.nextSubstate,
      });

      const queuedRun = await txRuns.createRun({
        repoSlug: requireWorkItemRepo(current),
        task: launchPlan.buildTask(current),
        baseBranch: current.githubPrBaseBranch ?? baseBranch,
        requestedBy: launchPlan.requestedBy,
        channelId: current.homeChannelId,
        threadTs: current.homeThreadTs,
        runtime,
        workItemId: current.id,
        autoReviewSourceSubstate: current.substate,
        pipelineHint: launchPlan.pipelineHint,
      }, "gooseherd", launchPlan.existingBranchName);
      launchedRunId = queuedRun.id;

      await txEvents.append({
        workItemId: current.id,
        eventType: "run.auto_launched",
        payload: {
          runId: queuedRun.id,
          reason,
          requestedBy: launchPlan.requestedBy,
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

    const nextStateAfterAutoReview = nextFeatureDeliveryStateAfterAutoReview({
      ciGreen: workItem.flags.includes("ci_green"),
      selfReviewDone: true,
      hasActiveAutoFixes: false,
    });
    const shouldSkipEngineeringReview =
      nextStateAfterAutoReview === "engineering_review" &&
      workItem.flags.includes("engineering_review_done");

    if (shouldSkipEngineeringReview) {
      const engineeringReview = await this.workItems.updateState(workItem.id, {
        state: "engineering_review",
        substate: nextFeatureDeliverySubstateForState("engineering_review", {
          fallback: workItem.substate,
          defaultValue: "waiting_ci",
        }),
        flagsToAdd: ["self_review_done"],
      });

      const nextState = nextFeatureDeliveryStateAfterEngineeringReview("approved");
      return this.workItems.updateState(engineeringReview.id, {
        state: nextState,
        substate: nextFeatureDeliverySubstateForState(nextState, {
          fallback: engineeringReview.substate,
          defaultValue: "waiting_ci",
        }),
      });
    }

    return this.workItems.updateState(workItem.id, {
      state: nextStateAfterAutoReview,
      substate: nextFeatureDeliverySubstateForState(nextStateAfterAutoReview, {
        fallback: workItem.substate,
        defaultValue: "waiting_ci",
      }),
      flagsToAdd: ["self_review_done"],
    });
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
      const latestAutoReview = latestRuns.find((candidate) => candidate.requestedBy === AUTO_REVIEW_REQUESTED_BY);
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
        workItemId: current.id,
        autoReviewSourceSubstate: current.substate,
        pipelineHint: "branch-sync",
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

function resolveLaunchPlan(workItem: WorkItemRecord): {
  nextSubstate: string | undefined;
  requestedBy: string;
  pipelineHint: string;
  existingBranchName?: string;
  buildTask: (current: WorkItemRecord) => string;
} {
  switch (workItem.substate as FeatureDeliveryAutoReviewSubstate | undefined) {
    case "pr_adopted":
      return {
        nextSubstate: "collecting_context",
        requestedBy: AUTO_REVIEW_REQUESTED_BY,
        pipelineHint: "pipeline",
        existingBranchName: workItem.githubPrHeadBranch,
        buildTask: (current) => buildAutoReviewTask(buildTaskInput(current)),
      };
    case "applying_review_feedback":
      return {
        nextSubstate: workItem.substate,
        requestedBy: AUTO_REVIEW_REQUESTED_BY,
        pipelineHint: "pipeline",
        existingBranchName: workItem.githubPrHeadBranch,
        buildTask: (current) => buildAutoReviewTask(buildTaskInput(current)),
      };
    case "ci_green_pending_self_review":
      return {
        nextSubstate: "collecting_context",
        requestedBy: AUTO_REVIEW_REQUESTED_BY,
        pipelineHint: "pipeline",
        existingBranchName: workItem.githubPrHeadBranch,
        buildTask: (current) => buildAutoReviewTask(buildTaskInput(current)),
      };
    case "ci_failed":
      return {
        nextSubstate: workItem.substate,
        requestedBy: CI_FIX_REQUESTED_BY,
        pipelineHint: "ci-fix",
        existingBranchName: requireWorkItemPrHeadBranch(workItem),
        buildTask: (current) => buildCiFixTask(buildTaskInput(current)),
      };
    default:
      throw new Error(`Unsupported auto_review substate for launch: ${String(workItem.substate)}`);
  }
}

function nextFeatureDeliverySubstateForState(
  state: WorkItemRecord["state"],
  input: { fallback?: string; defaultValue?: string } = {},
): string | undefined {
  switch (state) {
    case "engineering_review":
      return "waiting_engineering_review";
    case "qa_preparation":
      return "preparing_review_app";
    case "product_review":
      return "waiting_product_review";
    case "qa_review":
      return "waiting_qa_review";
    case "ready_for_merge":
      return "waiting_merge";
    case "auto_review":
      return input.defaultValue ?? "waiting_ci";
    default:
      return input.fallback;
  }
}

function isActiveWorkItemSystemRun(run: { status: string; requestedBy: string }): boolean {
  return WORK_ITEM_SYSTEM_RUN_REQUESTERS.has(run.requestedBy) && ACTIVE_AUTO_REVIEW_RUN_STATUSES.has(run.status);
}

function isSuccessfulWorkItemCheckpoint(run: { status: string; requestedBy: string }): boolean {
  if (!WORK_ITEM_SYSTEM_RUN_REQUESTERS.has(run.requestedBy)) {
    return false;
  }
  return run.status === "awaiting_ci" || run.status === "completed";
}

function isLatestRollbackCandidate(run: {
  status: string;
  requestedBy: string;
  error?: string;
  workItemId?: string;
  autoReviewSourceSubstate?: string;
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
    run.requestedBy === AUTO_REVIEW_REQUESTED_BY &&
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
