import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateDiscoveryReviewRound,
  nextDiscoveryStateAfterPmConfirmation,
} from "../src/work-items/product-discovery-policy.js";
import {
  nextFeatureDeliveryStateAfterAutoReview,
  nextFeatureDeliveryStateAfterEngineeringReview,
  nextFeatureDeliveryStateAfterQaPreparation,
  nextFeatureDeliveryStateAfterQaReview,
  nextFeatureDeliveryStateAfterReadyForMergeRecovery,
  shouldResetEngineeringReviewOnNewCommits,
  shouldResetQaReviewOnNewCommits,
} from "../src/work-items/feature-delivery-policy.js";
import type { ReviewRequestRecord, WorkItemRecord } from "../src/work-items/types.js";

function makeDiscoveryWorkItem(state: WorkItemRecord["state"]): WorkItemRecord {
  return {
    id: "wi-discovery-1",
    workflow: "product_discovery",
    state,
    flags: [],
    title: "Discovery",
    summary: "",
    ownerTeamId: "team-1",
    homeChannelId: "C1",
    homeThreadTs: "1.1",
    createdByUserId: "user-1",
    createdAt: "2026-04-11T00:00:00.000Z",
    updatedAt: "2026-04-11T00:00:00.000Z",
  };
}

function makeReviewRequest(
  id: string,
  status: ReviewRequestRecord["status"],
  outcome?: ReviewRequestRecord["outcome"]
): ReviewRequestRecord {
  return {
    id,
    workItemId: "wi-discovery-1",
    reviewRound: 1,
    type: "review",
    targetType: "team",
    targetRef: { teamId: "team-1" },
    status,
    outcome,
    title: `Request ${id}`,
    requestMessage: "",
    focusPoints: [],
    requestedByUserId: "user-1",
    requestedAt: "2026-04-11T00:00:00.000Z",
    createdAt: "2026-04-11T00:00:00.000Z",
    updatedAt: "2026-04-11T00:00:00.000Z",
  };
}

test("discovery review round stays waiting while requests are pending", () => {
  const result = evaluateDiscoveryReviewRound(makeDiscoveryWorkItem("waiting_for_review"), [
    makeReviewRequest("rr-1", "completed", "approved"),
    makeReviewRequest("rr-2", "pending"),
  ]);

  assert.equal(result.nextState, "waiting_for_review");
  assert.deepEqual(result.supersedePendingRequestIds, []);
});

test("discovery review round returns to in_progress and supersedes pending requests on changes_requested", () => {
  const result = evaluateDiscoveryReviewRound(makeDiscoveryWorkItem("waiting_for_review"), [
    makeReviewRequest("rr-1", "completed", "changes_requested"),
    makeReviewRequest("rr-2", "pending"),
    makeReviewRequest("rr-3", "completed", "approved"),
  ]);

  assert.equal(result.nextState, "in_progress");
  assert.deepEqual(result.supersedePendingRequestIds, ["rr-2"]);
});

test("discovery review round advances to waiting_for_pm_confirmation when all required requests complete cleanly", () => {
  const result = evaluateDiscoveryReviewRound(makeDiscoveryWorkItem("waiting_for_review"), [
    makeReviewRequest("rr-1", "completed", "approved"),
    makeReviewRequest("rr-2", "completed", "commented"),
  ]);

  assert.equal(result.nextState, "waiting_for_pm_confirmation");
});

test("PM confirmation returns discovery to in_progress when more changes are requested", () => {
  assert.equal(nextDiscoveryStateAfterPmConfirmation(false), "in_progress");
});

test("PM confirmation completes discovery when approved", () => {
  assert.equal(nextDiscoveryStateAfterPmConfirmation(true), "done");
});

test("feature delivery moves from auto_review to engineering_review when gates are satisfied", () => {
  assert.equal(
    nextFeatureDeliveryStateAfterAutoReview({ ciGreen: true, selfReviewDone: true, hasActiveAutoFixes: false }),
    "engineering_review"
  );
});

test("feature delivery stays in auto_review when gates are not ready", () => {
  assert.equal(
    nextFeatureDeliveryStateAfterAutoReview({ ciGreen: false, selfReviewDone: true, hasActiveAutoFixes: false }),
    "auto_review"
  );
});

test("feature delivery returns to auto_review when engineering review requests changes", () => {
  assert.equal(nextFeatureDeliveryStateAfterEngineeringReview("changes_requested"), "auto_review");
});

test("feature delivery advances to qa_preparation when engineering review is approved", () => {
  assert.equal(nextFeatureDeliveryStateAfterEngineeringReview("approved"), "qa_preparation");
});

test("feature delivery routes qa preparation based on product review requirement", () => {
  assert.equal(nextFeatureDeliveryStateAfterQaPreparation({ productReviewRequired: true, qaPrepFoundIssue: false }), "product_review");
  assert.equal(nextFeatureDeliveryStateAfterQaPreparation({ productReviewRequired: false, qaPrepFoundIssue: false }), "qa_review");
});

test("feature delivery returns to auto_review when qa preparation finds an issue", () => {
  assert.equal(nextFeatureDeliveryStateAfterQaPreparation({ productReviewRequired: false, qaPrepFoundIssue: true }), "auto_review");
});

test("feature delivery returns to auto_review when QA requests changes", () => {
  assert.equal(nextFeatureDeliveryStateAfterQaReview("changes_requested"), "auto_review");
});

test("feature delivery advances to ready_for_merge when QA approves", () => {
  assert.equal(nextFeatureDeliveryStateAfterQaReview("approved"), "ready_for_merge");
});

test("feature delivery returns to auto_review for ready_for_merge recovery paths", () => {
  assert.equal(nextFeatureDeliveryStateAfterReadyForMergeRecovery("branch_stale"), "auto_review");
  assert.equal(nextFeatureDeliveryStateAfterReadyForMergeRecovery("conflicts"), "auto_review");
  assert.equal(nextFeatureDeliveryStateAfterReadyForMergeRecovery("ci_failed_after_rebase"), "auto_review");
});

test("engineering review reset policy is controlled by env-like config", () => {
  assert.equal(shouldResetEngineeringReviewOnNewCommits({ FEATURE_DELIVERY_RESET_ENGINEERING_REVIEW_ON_NEW_COMMITS: "true" }), true);
  assert.equal(shouldResetEngineeringReviewOnNewCommits({ FEATURE_DELIVERY_RESET_ENGINEERING_REVIEW_ON_NEW_COMMITS: "false" }), false);
});

test("QA review reset policy is controlled by env-like config", () => {
  assert.equal(shouldResetQaReviewOnNewCommits({ FEATURE_DELIVERY_RESET_QA_REVIEW_ON_NEW_COMMITS: "true" }), true);
  assert.equal(shouldResetQaReviewOnNewCommits({ FEATURE_DELIVERY_RESET_QA_REVIEW_ON_NEW_COMMITS: "false" }), false);
});
