import type { ReviewRequestRecord, WorkItemRecord } from "./types.js";

export interface DiscoveryReviewRoundResult {
  nextState: WorkItemRecord["state"];
  supersedePendingRequestIds: string[];
}

export function evaluateDiscoveryReviewRound(
  workItem: Pick<WorkItemRecord, "state" | "workflow">,
  requests: ReviewRequestRecord[]
): DiscoveryReviewRoundResult {
  if (workItem.workflow !== "product_discovery") {
    throw new Error("Discovery review policy can only evaluate product_discovery work items");
  }
  if (workItem.state !== "waiting_for_review") {
    throw new Error(`Discovery review policy expected waiting_for_review, got ${workItem.state}`);
  }

  const pendingRequests = requests.filter((request) => request.status === "pending");
  const changesRequested = requests.some((request) => request.status === "completed" && request.outcome === "changes_requested");

  if (changesRequested) {
    return {
      nextState: "in_progress",
      supersedePendingRequestIds: pendingRequests.map((request) => request.id),
    };
  }

  if (pendingRequests.length > 0) {
    return {
      nextState: "waiting_for_review",
      supersedePendingRequestIds: [],
    };
  }

  return {
    nextState: "waiting_for_pm_confirmation",
    supersedePendingRequestIds: [],
  };
}

export function nextDiscoveryStateAfterPmConfirmation(approved: boolean): WorkItemRecord["state"] {
  return approved ? "done" : "in_progress";
}
