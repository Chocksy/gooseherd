import type { WorkItemRecord, WorkItemState, WorkItemWorkflow } from "./types.js";

type WorkflowStateSubject = Pick<WorkItemRecord, "workflow" | "state">;

const WORKFLOW_STATES: Record<WorkItemWorkflow, ReadonlySet<WorkItemState>> = {
  product_discovery: new Set([
    "backlog",
    "in_progress",
    "waiting_for_review",
    "waiting_for_pm_confirmation",
    "done",
    "cancelled",
  ]),
  feature_delivery: new Set([
    "backlog",
    "in_progress",
    "auto_review",
    "engineering_review",
    "qa_preparation",
    "product_review",
    "qa_review",
    "ready_for_merge",
    "done",
    "cancelled",
  ]),
};

const ALLOWED_STATE_TRANSITIONS: Record<WorkItemWorkflow, Record<WorkItemState, ReadonlySet<WorkItemState>>> = {
  product_discovery: {
    backlog: new Set(["in_progress", "cancelled"]),
    in_progress: new Set(["waiting_for_review", "cancelled"]),
    waiting_for_review: new Set(["in_progress", "waiting_for_pm_confirmation", "cancelled"]),
    waiting_for_pm_confirmation: new Set(["in_progress", "done", "cancelled"]),
    done: new Set(),
    cancelled: new Set(),
    auto_review: new Set(),
    engineering_review: new Set(),
    qa_preparation: new Set(),
    product_review: new Set(),
    qa_review: new Set(),
    ready_for_merge: new Set(),
  },
  feature_delivery: {
    backlog: new Set(["in_progress", "auto_review", "cancelled"]),
    in_progress: new Set(["auto_review", "cancelled"]),
    waiting_for_review: new Set(),
    waiting_for_pm_confirmation: new Set(),
    auto_review: new Set(["engineering_review", "cancelled"]),
    engineering_review: new Set(["auto_review", "qa_preparation", "product_review", "qa_review", "cancelled"]),
    qa_preparation: new Set(["auto_review", "product_review", "qa_review", "cancelled"]),
    product_review: new Set(["auto_review", "qa_review", "cancelled"]),
    qa_review: new Set(["auto_review", "ready_for_merge", "cancelled"]),
    ready_for_merge: new Set(["auto_review", "done", "cancelled"]),
    done: new Set(),
    cancelled: new Set(["auto_review"]),
  },
};

export function assertStateMatchesWorkflow(workflow: WorkItemWorkflow, state: WorkItemState): void {
  if (!WORKFLOW_STATES[workflow].has(state)) {
    throw new Error(`State ${state} is not valid for workflow ${workflow}`);
  }
}

export function assertStateTransitionAllowed(workItem: WorkflowStateSubject, nextState: WorkItemState): void {
  assertStateMatchesWorkflow(workItem.workflow, workItem.state);
  assertStateMatchesWorkflow(workItem.workflow, nextState);

  if (workItem.state === nextState) {
    return;
  }

  if (ALLOWED_STATE_TRANSITIONS[workItem.workflow][workItem.state].has(nextState)) {
    return;
  }

  throw new Error(`State transition ${workItem.workflow}.${workItem.state} -> ${nextState} is not allowed`);
}

export function assertCanRequestDiscoveryReview(workItem: WorkflowStateSubject): void {
  if (workItem.workflow !== "product_discovery") {
    throw new Error(`Review requests may only be created for product_discovery work items, got ${workItem.workflow}`);
  }
  if (workItem.state !== "in_progress") {
    throw new Error(`Review requests may only be created when discovery is in_progress, got ${workItem.state}`);
  }
}

export function assertCanResolveDiscoveryReview(workItem: WorkflowStateSubject): void {
  if (workItem.workflow !== "product_discovery") {
    throw new Error(`Review responses may only be recorded for product_discovery work items, got ${workItem.workflow}`);
  }
  if (workItem.state !== "waiting_for_review") {
    throw new Error(`Review responses may only be recorded while discovery is waiting_for_review, got ${workItem.state}`);
  }
}

export function assertCanConfirmDiscovery(workItem: WorkflowStateSubject): void {
  if (workItem.workflow !== "product_discovery") {
    throw new Error(`Discovery confirmation may only be used for product_discovery work items, got ${workItem.workflow}`);
  }
  if (workItem.state !== "waiting_for_pm_confirmation") {
    throw new Error(`Discovery confirmation requires waiting_for_pm_confirmation, got ${workItem.state}`);
  }
}
