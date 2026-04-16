import type { Database } from "../db/index.js";
import { sql } from "drizzle-orm";
import type { SandboxRuntime } from "../runtime/runtime-mode.js";
import { nextFeatureDeliveryStateAfterAutoReview } from "./feature-delivery-policy.js";
import { RunStore } from "../store.js";
import { buildAutoReviewTask } from "./auto-review-task.js";
import { WorkItemEventsStore } from "./events-store.js";
import { WorkItemStore } from "./store.js";
import type { WorkItemRecord } from "./types.js";

const AUTO_REVIEW_REQUESTED_BY = "work-item:auto-review";
const ACTIVE_AUTO_REVIEW_RUN_STATUSES = new Set(["queued", "running", "validating", "pushing", "awaiting_ci", "ci_fixing"]);

export interface WorkItemOrchestratorDeps {
  config?: {
    defaultBaseBranch: string;
    sandboxRuntime?: SandboxRuntime;
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
      if (!current || !shouldAutoLaunchAutoReview(current)) {
        updatedWorkItem = current;
        return;
      }

      const existingRuns = await txRuns.listRunsForWorkItem(workItemId);
      if (existingRuns.some((run) => isActiveAutoReviewRun(run))) {
        updatedWorkItem = current;
        return;
      }

      const nextSubstate = current.substate === "pr_adopted" ? "collecting_context" : current.substate;
      updatedWorkItem = await txWorkItems.updateState(workItemId, {
        state: current.state,
        substate: nextSubstate,
      });

      const queuedRun = await txRuns.createRun({
        repoSlug: requireWorkItemRepo(current),
        task: buildAutoReviewTask({
          repo: requireWorkItemRepo(current),
          prNumber: requireWorkItemPrNumber(current),
          prUrl: requireWorkItemPrUrl(current),
          jiraIssueKey: current.jiraIssueKey,
          title: current.title,
          summary: current.summary,
        }),
        baseBranch: current.githubPrBaseBranch ?? baseBranch,
        requestedBy: AUTO_REVIEW_REQUESTED_BY,
        channelId: current.homeChannelId,
        threadTs: current.homeThreadTs,
        runtime,
        workItemId: current.id,
        pipelineHint: "pipeline",
      }, "gooseherd", current.githubPrHeadBranch);
      launchedRunId = queuedRun.id;

      await txEvents.append({
        workItemId: current.id,
        eventType: "run.auto_launched",
        payload: {
          runId: queuedRun.id,
          reason,
          requestedBy: AUTO_REVIEW_REQUESTED_BY,
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
    if (!run?.workItemId || !isSuccessfulAutoReviewCheckpoint(run)) {
      return undefined;
    }

    const workItem = await this.workItems.getWorkItem(run.workItemId);
    if (!workItem || workItem.workflow !== "feature_delivery" || workItem.state !== "auto_review") {
      return workItem;
    }

    const nextState = nextFeatureDeliveryStateAfterAutoReview({
      ciGreen: workItem.flags.includes("ci_green"),
      selfReviewDone: true,
      hasActiveAutoFixes: false,
    });

    return this.workItems.updateState(workItem.id, {
      state: nextState,
      substate: nextFeatureDeliverySubstateForState(nextState, {
        fallback: workItem.substate,
        defaultValue: "waiting_ci",
      }),
      flagsToAdd: ["self_review_done"],
    });
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

function shouldAutoLaunchAutoReview(workItem: WorkItemRecord): boolean {
  if (workItem.workflow !== "feature_delivery" || workItem.state !== "auto_review") {
    return false;
  }

  return workItem.substate === "pr_adopted" || workItem.substate === "applying_review_feedback";
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

function isActiveAutoReviewRun(run: { status: string; requestedBy: string }): boolean {
  return run.requestedBy === AUTO_REVIEW_REQUESTED_BY && ACTIVE_AUTO_REVIEW_RUN_STATUSES.has(run.status);
}

function isSuccessfulAutoReviewCheckpoint(run: { status: string; requestedBy: string }): boolean {
  if (run.requestedBy !== AUTO_REVIEW_REQUESTED_BY) {
    return false;
  }
  return run.status === "awaiting_ci" || run.status === "completed";
}
