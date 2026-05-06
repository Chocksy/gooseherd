import type { Database } from "../db/index.js";
import { sql } from "drizzle-orm";
import type { SandboxRuntime } from "../runtime/runtime-mode.js";
import type { RunRecord } from "../types.js";
import type {
  CiTriageCheckpointPayload,
  CiTriageVerdict,
  FeatureDeliveryProgressCheckpointType,
  RunCheckpointRecord,
} from "../runs/run-checkpoints.js";
import { isCiTriageVerdict } from "../runs/run-checkpoints.js";
import {
  canAutoRebaseFeatureDeliveryBranch,
  isAiAssistAutomationEnabled,
} from "./feature-delivery-policy.js";
import { applyWorkItemDecision } from "./feature-delivery-decision.js";
import { reduceFeatureDelivery } from "./feature-delivery-reducer.js";
import { RunStore } from "../store.js";
import {
  FEATURE_DELIVERY_BRANCH_SYNC_PIPELINE_ID,
  FEATURE_DELIVERY_CI_FIX_PIPELINE_ID,
  FEATURE_DELIVERY_QA_PREPARATION_PIPELINE_ID,
  FEATURE_DELIVERY_READY_FOR_MERGE_PIPELINE_ID,
  FEATURE_DELIVERY_REVIEW_FEEDBACK_PIPELINE_ID,
  FEATURE_DELIVERY_SELF_REVIEW_PIPELINE_ID,
  FEATURE_DELIVERY_TRIAGE_CI_PIPELINE_ID,
} from "../pipeline/builtin-pipelines.js";
import {
  buildAutoReviewTask,
  buildBranchSyncTask,
  buildCiFixTask,
  buildCiTriageTask,
  buildQaPreparationTask,
  buildReadyForMergeTask,
} from "./auto-review-task.js";
import { WorkItemEventsStore } from "./events-store.js";
import { WorkItemStore } from "./store.js";
import {
  buildFeatureDeliveryApplyReviewFeedbackIntent,
  buildFeatureDeliveryFinalizePrIntent,
  buildFeatureDeliveryQaPreparationIntent,
  buildFeatureDeliveryRepairCiIntent,
  buildFeatureDeliverySelfReviewIntent,
  buildFeatureDeliverySyncBranchIntent,
  buildFeatureDeliveryTriageCiIntent,
  isFeatureDeliveryAutoReviewOrRepairCiRun,
  isFeatureDeliveryAutoReviewRun,
  isFeatureDeliverySystemRun,
  isSuccessfulFeatureDeliveryProgressCheckpoint,
  type FeatureDeliveryRunIntent,
} from "../runs/run-intent.js";
import {
  CI_RERUN_EXHAUSTED_FLAG,
  CI_TRIAGE_FIX_DECIDED_FLAG,
  type FeatureDeliveryAutoReviewSubstate,
  type WorkItemRecord,
} from "./types.js";
import { logError, logInfo, logWarn } from "../logger.js";
import type { GitHubService } from "../github.js";
import { RunCheckpointStore } from "../runs/run-checkpoint-store.js";

const AUTO_REVIEW_REQUESTED_BY = "work-item:auto-review";
const CI_FIX_REQUESTED_BY = "work-item:ci-fix";
const CI_TRIAGE_REQUESTED_BY = "work-item:ci-triage";
const BRANCH_SYNC_REQUESTED_BY = "work-item:branch-sync";
const READY_FOR_MERGE_REQUESTED_BY = "work-item:ready-for-merge";
const QA_PREPARATION_REQUESTED_BY = "work-item:qa-preparation";
const MAX_CI_RERUN_ATTEMPTS_PER_HEAD_SHA = 2;
const CI_RERUN_TRIGGERED_EVENT = "ci.rerun_triggered";
const CI_RERUN_EXHAUSTED_EVENT = "ci.rerun_exhausted";
const CI_TRIAGE_DECIDED_EVENT = "ci.triage_decided";
const ACTIVE_AUTO_REVIEW_RUN_STATUSES = new Set([
  "queued",
  "running",
  "validating",
  "pushing",
  "awaiting_ci",
  "ci_fixing",
  "cancel_requested",
]);
const PREFETCH_FAILURE_PATTERN = /prefetch/i;

export interface WorkItemOrchestratorDeps {
  config?: {
    defaultBaseBranch: string;
    sandboxRuntime?: SandboxRuntime;
    autoReviewBranchSyncMaxBehindCommits?: number;
    featureDeliverySkipProductReview?: boolean;
    featureDeliverySelfReviewEnabled?: boolean;
    featureDeliveryApplyReviewFeedbackEnabled?: boolean;
  };
  qaPreparationHandler?: (workItem: WorkItemRecord) => Promise<void> | void;
  readyForMergeHandler?: (workItem: WorkItemRecord) => Promise<void> | void;
  runManager?: {
    requeueExistingRun(runId: string): void;
  };
  githubService?: Pick<GitHubService, "rerunFailedJobsForCheckRuns" | "getPullRequestCiSnapshot">;
  checkpointStore?: Pick<RunCheckpointStore, "hasCheckpointOfType">;
}

export class WorkItemOrchestrator {
  private readonly workItems: WorkItemStore;
  private readonly runs: RunStore;
  private readonly events: WorkItemEventsStore;
  private readonly checkpointStore: Pick<RunCheckpointStore, "hasCheckpointOfType">;

  constructor(
    private readonly db: Database,
    private readonly deps: WorkItemOrchestratorDeps = {},
  ) {
    this.workItems = new WorkItemStore(db);
    this.runs = new RunStore(db);
    this.events = new WorkItemEventsStore(db);
    this.checkpointStore = deps.checkpointStore ?? new RunCheckpointStore(db);
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

      if (current.substate === "ci_failed") {
        const headSha = current.githubPrHeadSha;
        const rerunCount = headSha
          ? await countCiRerunEventsForHeadSha(txEvents, current.id, headSha)
          : 0;
        if (rerunCount >= MAX_CI_RERUN_ATTEMPTS_PER_HEAD_SHA) {
          updatedWorkItem = await txWorkItems.updateState(workItemId, {
            state: current.state,
            substate: current.substate,
            flagsToAdd: [CI_RERUN_EXHAUSTED_FLAG],
          });
          await txEvents.append({
            workItemId: current.id,
            eventType: CI_RERUN_EXHAUSTED_EVENT,
            payload: {
              headSha,
              rerunCount,
              limit: MAX_CI_RERUN_ATTEMPTS_PER_HEAD_SHA,
              reason,
            },
          });
          logInfo("CI rerun budget exhausted; skipping triage launch", {
            workItemId: current.id,
            headSha,
            rerunCount,
          });
          return;
        }
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

    const checkpointType: FeatureDeliveryProgressCheckpointType =
      run.phase === "awaiting_ci" || run.status === "awaiting_ci"
        ? "run.waiting_external_ci"
        : "run.completed_without_external_wait";
    return this.applyRunProgressCheckpoint(run as RunRecord & { workItemId: string }, { checkpointType, payload: { source: "legacy_writeback" } });
  }

  async handleRunProgressCheckpoint(
    runId: string,
    checkpoint: Pick<RunCheckpointRecord, "checkpointType" | "payload">,
  ): Promise<WorkItemRecord | undefined> {
    const run = await this.runs.getRun(runId);
    if (!run?.workItemId || !isFeatureDeliveryAutoReviewOrRepairCiRun(run)) {
      return undefined;
    }

    return this.applyRunProgressCheckpoint(run as RunRecord & { workItemId: string }, {
      checkpointType: checkpoint.checkpointType,
      payload: checkpoint.payload,
    });
  }

  async handleCiTriageCheckpoint(
    runId: string,
    checkpoint: Pick<RunCheckpointRecord, "checkpointType" | "payload">,
  ): Promise<WorkItemRecord | undefined> {
    if (checkpoint.checkpointType !== "run.ci_triage_decided") {
      return undefined;
    }

    const run = await this.runs.getRun(runId);
    if (!run?.workItemId) {
      return undefined;
    }
    if (run.intent?.kind !== "feature_delivery.triage_ci" && run.requestedBy !== CI_TRIAGE_REQUESTED_BY) {
      return undefined;
    }

    const verdict = checkpoint.payload?.["verdict"];
    if (!isCiTriageVerdict(verdict)) {
      logWarn("CI triage checkpoint missing valid verdict; ignoring", {
        runId,
        workItemId: run.workItemId,
        verdict,
      });
      return undefined;
    }

    const reason = typeof checkpoint.payload?.["reason"] === "string"
      ? checkpoint.payload["reason"]
      : undefined;
    const evidence = Array.isArray(checkpoint.payload?.["evidence"])
      ? (checkpoint.payload["evidence"] as unknown[])
          .filter((item): item is string => typeof item === "string")
      : undefined;
    const headSha = typeof checkpoint.payload?.["headSha"] === "string"
      ? checkpoint.payload["headSha"]
      : undefined;
    const failedJobIds = Array.isArray(checkpoint.payload?.["failedJobIds"])
      ? (checkpoint.payload["failedJobIds"] as unknown[])
          .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
      : [];

    return this.applyCiTriageVerdict(run as RunRecord & { workItemId: string }, {
      verdict,
      reason,
      evidence,
      headSha,
      failedJobIds,
    });
  }

  private async applyCiTriageVerdict(
    run: RunRecord & { workItemId: string },
    payload: CiTriageCheckpointPayload,
  ): Promise<WorkItemRecord | undefined> {
    const workItem = await this.workItems.getWorkItem(run.workItemId);
    if (!workItem || workItem.workflow !== "feature_delivery") {
      return workItem;
    }

    await this.events.append({
      workItemId: workItem.id,
      eventType: CI_TRIAGE_DECIDED_EVENT,
      payload: {
        runId: run.id,
        verdict: payload.verdict,
        reason: payload.reason,
        evidence: payload.evidence,
        headSha: payload.headSha ?? workItem.githubPrHeadSha,
      },
    });

    if (payload.verdict === "fix_needed") {
      return this.transitionToCiFailedFix(workItem, run.id);
    }

    return this.handleCiTriageRerun(workItem, payload, run);
  }

  private async transitionToCiFailedFix(
    workItem: WorkItemRecord,
    reasonSuffix: string,
  ): Promise<WorkItemRecord | undefined> {
    const needsSubstate = workItem.state === "auto_review" && workItem.substate !== "ci_failed";
    const needsFlag = !workItem.flags.includes(CI_TRIAGE_FIX_DECIDED_FLAG);
    let updated: WorkItemRecord = workItem;
    if (needsSubstate || needsFlag) {
      updated = await this.workItems.updateState(workItem.id, {
        state: "auto_review",
        substate: "ci_failed",
        flagsToAdd: needsFlag ? [CI_TRIAGE_FIX_DECIDED_FLAG] : undefined,
        flagsToRemove: needsSubstate ? ["ci_green"] : undefined,
      });
    }
    return (await this.reconcileWorkItem(workItem.id, `ci.triage_fix_needed:${reasonSuffix}`)) ?? updated;
  }

  async handleCiTriageRunFailure(runId: string): Promise<WorkItemRecord | undefined> {
    const run = await this.runs.getRun(runId);
    if (!run?.workItemId || run.status !== "failed") {
      return undefined;
    }
    if (run.intent?.kind !== "feature_delivery.triage_ci" && run.requestedBy !== CI_TRIAGE_REQUESTED_BY) {
      return undefined;
    }

    const verdictAlreadyEmitted = await this.checkpointStore.hasCheckpointOfType(
      run.id,
      "run.ci_triage_decided",
    );
    if (verdictAlreadyEmitted) {
      return undefined;
    }

    const workItem = await this.workItems.getWorkItem(run.workItemId);
    if (!workItem || workItem.workflow !== "feature_delivery") {
      return workItem;
    }

    await this.events.append({
      workItemId: workItem.id,
      eventType: CI_TRIAGE_DECIDED_EVENT,
      payload: {
        runId: run.id,
        verdict: "fix_needed",
        reason: "triage_run_failed_fallback",
        headSha: workItem.githubPrHeadSha,
        fallback: true,
      },
    });
    logInfo("CI triage run failed without a verdict; falling back to fix_needed", {
      workItemId: workItem.id,
      runId: run.id,
    });
    return this.transitionToCiFailedFix(workItem, run.id);
  }

  private async markCiRerunUnavailable(
    workItem: WorkItemRecord,
    run: RunRecord,
    reasonCode: string,
    detail: Record<string, unknown>,
  ): Promise<WorkItemRecord> {
    const flagAlreadySet = workItem.flags.includes(CI_RERUN_EXHAUSTED_FLAG);
    const updated = flagAlreadySet
      ? workItem
      : await this.workItems.updateState(workItem.id, {
          state: workItem.state,
          substate: workItem.substate,
          flagsToAdd: [CI_RERUN_EXHAUSTED_FLAG],
        });

    await this.events.append({
      workItemId: workItem.id,
      eventType: CI_RERUN_EXHAUSTED_EVENT,
      payload: {
        runId: run.id,
        reason: reasonCode,
        ...detail,
      },
    });

    logInfo("CI rerun unavailable; flagged work item to halt automatic retries", {
      workItemId: workItem.id,
      runId: run.id,
      reason: reasonCode,
    });

    return updated;
  }

  private async handleCiTriageRerun(
    workItem: WorkItemRecord,
    payload: CiTriageCheckpointPayload,
    run: RunRecord,
  ): Promise<WorkItemRecord | undefined> {
    const headSha = payload.headSha ?? workItem.githubPrHeadSha;
    const repoSlug = workItem.repo;
    const githubService = this.deps.githubService;
    const failedJobIds = payload.failedJobIds ?? [];

    if (!githubService) {
      logWarn("CI triage verdict=rerun but githubService is not configured; halting auto-rerun", {
        workItemId: workItem.id,
        runId: run.id,
      });
      return this.markCiRerunUnavailable(workItem, run, "github_service_unconfigured", { headSha });
    }
    if (!repoSlug) {
      logWarn("CI triage verdict=rerun but work item has no repo; halting auto-rerun", {
        workItemId: workItem.id,
        runId: run.id,
      });
      return this.markCiRerunUnavailable(workItem, run, "missing_repo", { headSha });
    }
    if (failedJobIds.length === 0) {
      logWarn("CI triage verdict=rerun but no failedJobIds available; halting auto-rerun", {
        workItemId: workItem.id,
        runId: run.id,
      });
      return this.markCiRerunUnavailable(workItem, run, "missing_failed_job_ids", { headSha });
    }

    let rerunRunIds: number[] = [];
    let unresolvedJobIds: number[] = [];
    let failedRunIds: number[] = [];
    try {
      const result = await githubService.rerunFailedJobsForCheckRuns(repoSlug, failedJobIds);
      rerunRunIds = result.rerunRunIds;
      unresolvedJobIds = result.unresolvedJobIds;
      failedRunIds = result.failedRunIds;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError("Failed to trigger GitHub Actions rerun for failed jobs", {
        workItemId: workItem.id,
        runId: run.id,
        repoSlug,
        failedJobIds,
        error: message,
      });
      return this.markCiRerunUnavailable(workItem, run, "github_rerun_request_failed", {
        headSha,
        failedJobIds,
        error: message,
      });
    }

    if (rerunRunIds.length === 0) {
      logWarn("CI triage verdict=rerun but no workflow runs were rerun (all unresolved or failed)", {
        workItemId: workItem.id,
        runId: run.id,
        unresolvedJobIds,
        failedRunIds,
      });
      return this.markCiRerunUnavailable(workItem, run, "no_workflow_runs_rerun", {
        headSha,
        failedJobIds,
        unresolvedJobIds,
        failedRunIds,
      });
    }

    const updated = await this.workItems.updateState(workItem.id, {
      state: "auto_review",
      substate: "ci_rerunning",
      flagsToRemove: ["ci_green"],
    });

    await this.events.append({
      workItemId: workItem.id,
      eventType: CI_RERUN_TRIGGERED_EVENT,
      payload: {
        runId: run.id,
        headSha,
        failedJobIds,
        rerunRunIds,
        unresolvedJobIds,
        failedRunIds,
      },
    });

    logInfo("CI rerun triggered after triage verdict", {
      workItemId: workItem.id,
      runId: run.id,
      headSha,
      rerunRunIds,
    });

    return updated;
  }

  private async applyRunProgressCheckpoint(
    run: RunRecord & { workItemId: string },
    checkpoint: { checkpointType: string; payload?: Record<string, unknown> },
  ): Promise<WorkItemRecord | undefined> {
    if (checkpoint.checkpointType !== "run.waiting_external_ci" && checkpoint.checkpointType !== "run.completed_without_external_wait") {
      return undefined;
    }

    const workItem = await this.workItems.getWorkItem(run.workItemId);
    if (!workItem || workItem.workflow !== "feature_delivery" || workItem.state !== "auto_review") {
      return workItem;
    }

    const decision = reduceFeatureDelivery(
      workItem,
      {
        type: "run.feature_delivery_progress_ready",
        checkpointType: checkpoint.checkpointType,
        intentKind: deriveFeatureDeliveryProgressIntentKind(run),
      },
      {
        skipProductReview: this.deps.config?.featureDeliverySkipProductReview ?? false,
        selfReviewEnabled: this.deps.config?.featureDeliverySelfReviewEnabled ?? false,
        applyReviewFeedbackEnabled: this.deps.config?.featureDeliveryApplyReviewFeedbackEnabled ?? false,
      },
    );
    const updated = await applyWorkItemDecision(this.workItems, workItem, decision);

    await this.handleFeatureDeliveryCommands(workItem.state, updated, decision);

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
      if (existingRuns.some((run) => ACTIVE_AUTO_REVIEW_RUN_STATUSES.has(run.status))) {
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
      if (existingRuns.some((run) => ACTIVE_AUTO_REVIEW_RUN_STATUSES.has(run.status))) {
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

  async queueQaPreparationRun(
    workItemId: string,
    reason = "qa_preparation.entered",
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
      if (!current || current.workflow !== "feature_delivery" || current.state !== "qa_preparation") {
        currentWorkItem = current;
        return;
      }

      const existingRuns = await txRuns.listRunsForWorkItem(workItemId);
      if (existingRuns.some((run) => isFeatureDeliverySystemRun(run) && ACTIVE_AUTO_REVIEW_RUN_STATUSES.has(run.status))) {
        currentWorkItem = current;
        return;
      }

      const queuedRun = await txRuns.createRun({
        repoSlug: requireWorkItemRepo(current),
        task: buildQaPreparationTask(buildTaskInput(current)),
        baseBranch: current.githubPrBaseBranch ?? baseBranch,
        requestedBy: QA_PREPARATION_REQUESTED_BY,
        channelId: current.homeChannelId,
        threadTs: current.homeThreadTs,
        runtime,
        prUrl: current.githubPrUrl,
        prNumber: current.githubPrNumber,
        workItemId: current.id,
        autoReviewSourceSubstate: current.substate,
        pipelineHint: FEATURE_DELIVERY_QA_PREPARATION_PIPELINE_ID,
        intent: buildFeatureDeliveryQaPreparationIntent(current, {
          triggerReason: reason,
        }),
      }, "gooseherd", requireWorkItemPrHeadBranch(current));
      launchedRunId = queuedRun.id;
      currentWorkItem = current;

      await txEvents.append({
        workItemId: current.id,
        eventType: "run.qa_preparation_launched",
        payload: {
          runId: queuedRun.id,
          reason,
          requestedBy: QA_PREPARATION_REQUESTED_BY,
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

  private async handleFeatureDeliveryCommands(
    previousState: WorkItemRecord["state"],
    workItem: WorkItemRecord,
    decision: ReturnType<typeof reduceFeatureDelivery>,
  ): Promise<void> {
    for (const command of decision.commands) {
      if (
        command.type === "qa_preparation_entered" &&
        previousState !== "qa_preparation" &&
        workItem.workflow === "feature_delivery" &&
        workItem.state === "qa_preparation"
      ) {
        await this.deps.qaPreparationHandler?.(workItem);
      }

      if (command.type === "ready_for_merge_entered") {
        await this.handleReadyForMergeEntry(previousState, workItem);
      }
    }
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

export async function queueQaPreparationRun(
  db: Database,
  workItemId: string,
  reason = "qa_preparation.entered",
  deps?: WorkItemOrchestratorDeps,
): Promise<WorkItemRecord | undefined> {
  return new WorkItemOrchestrator(db, deps).queueQaPreparationRun(workItemId, reason);
}

async function countCiRerunEventsForHeadSha(
  events: WorkItemEventsStore,
  workItemId: string,
  headSha: string,
): Promise<number> {
  return events.countForWorkItemByEventTypeAndHeadSha(
    workItemId,
    CI_RERUN_TRIGGERED_EVENT,
    headSha,
  );
}

function shouldAutoLaunchSystemRun(workItem: WorkItemRecord): boolean {
  if (
    workItem.workflow !== "feature_delivery" ||
    workItem.state !== "auto_review" ||
    !isAiAssistAutomationEnabled(workItem)
  ) {
    return false;
  }

  if (workItem.flags.includes(CI_RERUN_EXHAUSTED_FLAG)) {
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
    case "ci_failed": {
      if (workItem.flags.includes(CI_TRIAGE_FIX_DECIDED_FLAG)) {
        return buildRepairCiLaunchPlan(workItem, reason);
      }
      return {
        nextSubstate: "ci_failed",
        intent: buildFeatureDeliveryTriageCiIntent(workItem, {
          sourceSubstate: "ci_failed",
          triggerReason: reason,
        }),
        legacyRequestedBy: CI_TRIAGE_REQUESTED_BY,
        legacyPipelineHint: FEATURE_DELIVERY_TRIAGE_CI_PIPELINE_ID,
        existingBranchName: requireWorkItemPrHeadBranch(workItem),
        buildTask: (current) => buildCiTriageTask(buildTaskInput(current)),
      };
    }
    case "ci_rerunning":
      // ci_rerunning is a passive waiting state: GitHub Actions reruns are in
      // flight. The reducer transitions us out of this substate when a CI
      // webhook arrives, so reconcileWorkItem must not auto-launch anything
      // while CI is still running. Reaching here means a stale call slipped
      // through shouldAutoLaunchSystemRun.
      throw new Error(
        `Cannot auto-launch a system run while substate is ci_rerunning (work item ${workItem.id})`,
      );
    default:
      throw new Error(`Unsupported auto_review substate for launch: ${String(workItem.substate)}`);
  }
}

function buildRepairCiLaunchPlan(workItem: WorkItemRecord, reason?: string): {
  nextSubstate: string | undefined;
  intent: FeatureDeliveryRunIntent;
  legacyRequestedBy: string;
  legacyPipelineHint: string;
  existingBranchName?: string;
  buildTask: (current: WorkItemRecord) => string;
} {
  return {
    nextSubstate: "ci_failed",
    intent: buildFeatureDeliveryRepairCiIntent(workItem, { triggerReason: reason }),
    legacyRequestedBy: CI_FIX_REQUESTED_BY,
    legacyPipelineHint: FEATURE_DELIVERY_CI_FIX_PIPELINE_ID,
    existingBranchName: requireWorkItemPrHeadBranch(workItem),
    buildTask: (current) => buildCiFixTask(buildTaskInput(current)),
  };
}

function isActiveWorkItemSystemRun(run: RunRecord): boolean {
  return isFeatureDeliveryAutoReviewOrRepairCiRun(run) && ACTIVE_AUTO_REVIEW_RUN_STATUSES.has(run.status);
}

function isSuccessfulWorkItemCheckpoint(run: RunRecord): boolean {
  return isSuccessfulFeatureDeliveryProgressCheckpoint(run);
}

function deriveFeatureDeliveryProgressIntentKind(run: RunRecord):
  | "feature_delivery.self_review"
  | "feature_delivery.apply_review_feedback"
  | "feature_delivery.repair_ci" {
  if (
    run.intent?.kind === "feature_delivery.self_review" ||
    run.intent?.kind === "feature_delivery.apply_review_feedback" ||
    run.intent?.kind === "feature_delivery.repair_ci"
  ) {
    return run.intent.kind;
  }
  if (run.requestedBy === CI_FIX_REQUESTED_BY) {
    return "feature_delivery.repair_ci";
  }
  return "feature_delivery.self_review";
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

