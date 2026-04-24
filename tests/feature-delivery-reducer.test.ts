import assert from "node:assert/strict";
import test from "node:test";
import { reduceFeatureDelivery } from "../src/work-items/feature-delivery-reducer.js";
import type { WorkItemRecord } from "../src/work-items/types.js";

function makeFeatureDeliveryWorkItem(input: {
  state?: WorkItemRecord["state"];
  substate?: string;
  flags?: string[];
  workflow?: WorkItemRecord["workflow"];
} = {}): WorkItemRecord {
  return {
    id: "wi-feature-delivery",
    workflow: input.workflow ?? "feature_delivery",
    state: input.state ?? "auto_review",
    substate: input.substate ?? "waiting_ci",
    flags: input.flags ?? [],
    title: "Feature delivery",
    summary: "",
    ownerTeamId: "team-1",
    homeChannelId: "C1",
    homeThreadTs: "1.1",
    createdByUserId: "user-1",
    createdAt: "2026-04-23T00:00:00.000Z",
    updatedAt: "2026-04-23T00:00:00.000Z",
  };
}

test("reducer keeps auto_review after self-review checkpoint when ci is not green yet", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "auto_review",
      substate: "applying_review_feedback",
    }),
    { type: "run.self_review_checkpoint_succeeded" },
  );

  assert.deepEqual(decision.patches, [{
    state: "auto_review",
    substate: "waiting_ci",
    flagsToAdd: ["self_review_done"],
  }]);
  assert.deepEqual(decision.commands, []);
});

test("reducer advances auto_review to engineering_review after self-review checkpoint when ci is already green", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "auto_review",
      flags: ["ci_green"],
    }),
    { type: "run.self_review_checkpoint_succeeded" },
  );

  assert.deepEqual(decision.patches, [{
    state: "engineering_review",
    substate: "waiting_engineering_review",
    flagsToAdd: ["self_review_done"],
  }]);
  assert.deepEqual(decision.commands, []);
});

test("reducer skips engineering_review after self-review checkpoint when approval is already sticky", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "auto_review",
      flags: ["ci_green", "engineering_review_done"],
    }),
    { type: "run.self_review_checkpoint_succeeded" },
  );

  assert.deepEqual(decision.patches, [
    {
      state: "engineering_review",
      substate: "waiting_engineering_review",
      flagsToAdd: ["self_review_done"],
    },
    {
      state: "qa_preparation",
      substate: "preparing_review_app",
    },
  ]);
  assert.deepEqual(decision.commands, []);
});

test("reducer reaches ready_for_merge after self-review checkpoint when sticky approvals already satisfy downstream gates", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "auto_review",
      flags: ["ci_green", "engineering_review_done", "qa_review_done"],
    }),
    { type: "run.self_review_checkpoint_succeeded" },
    {
      skipQaPreparation: true,
      skipProductReview: true,
    },
  );

  assert.deepEqual(decision.patches, [
    {
      state: "engineering_review",
      substate: "waiting_engineering_review",
      flagsToAdd: ["self_review_done"],
    },
    {
      state: "qa_review",
      substate: "waiting_qa_review",
    },
    {
      state: "ready_for_merge",
      substate: "waiting_merge",
    },
  ]);
  assert.deepEqual(decision.commands, [{ type: "ready_for_merge_entered" }]);
});

test("reducer carries sticky product review approval through the allowed state path after self-review checkpoint", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "auto_review",
      flags: [
        "ci_green",
        "engineering_review_done",
        "product_review_required",
        "product_review_done",
      ],
    }),
    { type: "run.self_review_checkpoint_succeeded" },
  );

  assert.deepEqual(decision.patches, [
    {
      state: "engineering_review",
      substate: "waiting_engineering_review",
      flagsToAdd: ["self_review_done"],
    },
    {
      state: "qa_preparation",
      substate: "preparing_review_app",
    },
    {
      state: "product_review",
      substate: "waiting_product_review",
    },
    {
      state: "qa_review",
      substate: "waiting_qa_review",
    },
  ]);
  assert.deepEqual(decision.commands, []);
});

test("reducer turns green ci into pending self review when self review is still missing", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "auto_review",
      substate: "waiting_ci",
    }),
    {
      type: "github.ci_completed",
      conclusion: "success",
      hasActiveSystemRun: false,
      automationEnabled: false,
    },
  );

  assert.deepEqual(decision.patches, [{
    state: "auto_review",
    substate: "ci_green_pending_self_review",
    flagsToAdd: ["ci_green"],
  }]);
  assert.deepEqual(decision.commands, []);
});

test("reducer requests reconcile when green ci arrives for pending self review with automation enabled", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "auto_review",
      substate: "waiting_ci",
    }),
    {
      type: "github.ci_completed",
      conclusion: "success",
      hasActiveSystemRun: false,
      automationEnabled: true,
    },
  );

  assert.deepEqual(decision.commands, [{
    type: "reconcile_work_item",
    reason: "github.ci_green_pending_self_review",
  }]);
});

test("reducer suppresses duplicate reconcile when ci was already green before repeated success", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "auto_review",
      substate: "ci_green_pending_self_review",
      flags: ["ci_green"],
    }),
    {
      type: "github.ci_completed",
      conclusion: "success",
      hasActiveSystemRun: false,
      automationEnabled: true,
    },
  );

  assert.deepEqual(decision.commands, []);
});

test("reducer suppresses reconcile when active system run already exists for pending self review", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "auto_review",
      substate: "waiting_ci",
    }),
    {
      type: "github.ci_completed",
      conclusion: "success",
      hasActiveSystemRun: true,
      automationEnabled: true,
    },
  );

  assert.deepEqual(decision.commands, []);
});

test("reducer advances qa_preparation to qa_review on green ci when product review is not required", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "qa_preparation",
      substate: "waiting_ci",
      flags: ["engineering_review_done"],
    }),
    {
      type: "github.ci_completed",
      conclusion: "success",
      hasActiveSystemRun: false,
      automationEnabled: false,
    },
  );

  assert.deepEqual(decision.patches, [{
    state: "qa_review",
    substate: "waiting_qa_review",
    flagsToAdd: ["ci_green"],
  }]);
});

test("reducer advances qa_preparation to product_review on green ci when product review is required", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "qa_preparation",
      substate: "waiting_ci",
      flags: ["engineering_review_done", "product_review_required"],
    }),
    {
      type: "github.ci_completed",
      conclusion: "success",
      hasActiveSystemRun: false,
      automationEnabled: false,
    },
  );

  assert.deepEqual(decision.patches, [{
    state: "product_review",
    substate: "waiting_product_review",
    flagsToAdd: ["ci_green"],
  }]);
});

test("reducer preserves ci_green writeback for backlog feature_delivery items on green ci", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "backlog",
      substate: "queued",
    }),
    {
      type: "github.ci_completed",
      conclusion: "success",
      hasActiveSystemRun: false,
      automationEnabled: false,
    },
  );

  assert.deepEqual(decision.patches, [{
    state: "backlog",
    substate: "queued",
    flagsToAdd: ["ci_green"],
  }]);
  assert.deepEqual(decision.commands, []);
});

test("reducer returns in_progress feature_delivery items to auto_review on failed ci", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "in_progress",
      substate: "building",
      flags: ["ci_green"],
    }),
    {
      type: "github.ci_completed",
      conclusion: "failure",
      hasActiveSystemRun: false,
      automationEnabled: false,
    },
  );

  assert.deepEqual(decision.patches, [{
    state: "auto_review",
    substate: "waiting_ci",
    flagsToRemove: ["ci_green"],
  }]);
  assert.deepEqual(decision.commands, []);
});

test("reducer ignores ci updates for done feature_delivery items", () => {
  const successDecision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "done",
      substate: "merged",
    }),
    {
      type: "github.ci_completed",
      conclusion: "success",
      hasActiveSystemRun: false,
      automationEnabled: false,
    },
  );
  const failureDecision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "done",
      substate: "merged",
    }),
    {
      type: "github.ci_completed",
      conclusion: "failure",
      hasActiveSystemRun: false,
      automationEnabled: false,
    },
  );

  assert.deepEqual(successDecision.patches, []);
  assert.deepEqual(successDecision.commands, []);
  assert.deepEqual(failureDecision.patches, []);
  assert.deepEqual(failureDecision.commands, []);
});

test("reducer ignores ci updates for cancelled feature_delivery items", () => {
  const successDecision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "cancelled",
      substate: "abandoned",
    }),
    {
      type: "github.ci_completed",
      conclusion: "success",
      hasActiveSystemRun: false,
      automationEnabled: false,
    },
  );
  const failureDecision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "cancelled",
      substate: "abandoned",
    }),
    {
      type: "github.ci_completed",
      conclusion: "failure",
      hasActiveSystemRun: false,
      automationEnabled: false,
    },
  );

  assert.deepEqual(successDecision.patches, []);
  assert.deepEqual(successDecision.commands, []);
  assert.deepEqual(failureDecision.patches, []);
  assert.deepEqual(failureDecision.commands, []);
});

test("reducer returns sticky-reviewed auto_review items directly to ready_for_merge after green ci", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "auto_review",
      flags: ["self_review_done", "engineering_review_done", "qa_review_done"],
    }),
    {
      type: "github.ci_completed",
      conclusion: "success",
      hasActiveSystemRun: false,
      automationEnabled: false,
    },
    {
      skipQaPreparation: true,
      skipProductReview: true,
    },
  );

  assert.deepEqual(decision.patches, [
    {
      state: "engineering_review",
      substate: "waiting_engineering_review",
      flagsToAdd: ["ci_green"],
    },
    {
      state: "qa_review",
      substate: "waiting_qa_review",
    },
    {
      state: "ready_for_merge",
      substate: "waiting_merge",
    },
  ]);
  assert.deepEqual(decision.commands, [{ type: "ready_for_merge_entered" }]);
});

test("reducer marks auto_review ci failure and requests reconcile when no system run is active", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "auto_review",
      substate: "waiting_ci",
      flags: ["ci_green"],
    }),
    {
      type: "github.ci_completed",
      conclusion: "failure",
      hasActiveSystemRun: false,
      automationEnabled: true,
    },
  );

  assert.deepEqual(decision.patches, [{
    state: "auto_review",
    substate: "ci_failed",
    flagsToRemove: ["ci_green"],
  }]);
  assert.deepEqual(decision.commands, [{
    type: "reconcile_work_item",
    reason: "github.ci_failed",
  }]);
});

test("reducer preserves current auto_review substate on ci failure while an active system run is still working", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "auto_review",
      substate: "ci_green_pending_self_review",
      flags: ["ci_green"],
    }),
    {
      type: "github.ci_completed",
      conclusion: "failure",
      hasActiveSystemRun: true,
      automationEnabled: true,
    },
  );

  assert.deepEqual(decision.patches, [{
    state: "auto_review",
    substate: "ci_green_pending_self_review",
    flagsToRemove: ["ci_green"],
  }]);
  assert.deepEqual(decision.commands, []);
});

test("reducer moves ready_for_merge back to auto_review revalidation on failed ci", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "ready_for_merge",
      substate: "waiting_merge",
      flags: ["ci_green", "engineering_review_done", "qa_review_done"],
    }),
    {
      type: "github.ci_completed",
      conclusion: "failure",
      hasActiveSystemRun: false,
      automationEnabled: true,
    },
  );

  assert.deepEqual(decision.patches, [{
    state: "auto_review",
    substate: "revalidating_after_rebase",
    flagsToRemove: ["ci_green"],
  }]);
});

test("reducer returns review states back to auto_review waiting_ci on failed ci", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "engineering_review",
      substate: "waiting_engineering_review",
      flags: ["ci_green", "self_review_done"],
    }),
    {
      type: "github.ci_completed",
      conclusion: "failure",
      hasActiveSystemRun: false,
      automationEnabled: true,
    },
  );

  assert.deepEqual(decision.patches, [{
    state: "auto_review",
    substate: "waiting_ci",
    flagsToRemove: ["ci_green"],
  }]);
});

test("reducer advances engineering_review approvals through qa preparation", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "engineering_review",
      substate: "waiting_engineering_review",
      flags: ["ci_green", "self_review_done"],
    }),
    {
      type: "github.review_submitted",
      reviewState: "approved",
      automationEnabled: true,
    },
  );

  assert.deepEqual(decision.patches, [{
    state: "qa_preparation",
    substate: "preparing_review_app",
    flagsToAdd: ["engineering_review_done"],
  }]);
  assert.deepEqual(decision.commands, []);
});

test("reducer requests reconcile when engineering review asks for changes with automation enabled", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "engineering_review",
      substate: "waiting_engineering_review",
      flags: ["ci_green", "self_review_done"],
    }),
    {
      type: "github.review_submitted",
      reviewState: "changes_requested",
      automationEnabled: true,
    },
  );

  assert.deepEqual(decision.patches, [{
    state: "auto_review",
    substate: "applying_review_feedback",
  }]);
  assert.deepEqual(decision.commands, [{
    type: "reconcile_work_item",
    reason: "github.review_changes_requested",
  }]);
});

test("reducer advances product_review approvals into qa_review", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "product_review",
      substate: "waiting_product_review",
      flags: ["ci_green", "self_review_done", "engineering_review_done", "product_review_required"],
    }),
    {
      type: "github.review_submitted",
      reviewState: "approved",
      automationEnabled: false,
    },
  );

  assert.deepEqual(decision.patches, [{
    state: "qa_review",
    substate: "waiting_qa_review",
    flagsToAdd: ["product_review_done"],
  }]);
  assert.deepEqual(decision.commands, []);
});

test("reducer returns product_review to auto_review when changes are requested", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "product_review",
      substate: "waiting_product_review",
      flags: ["ci_green", "self_review_done", "engineering_review_done", "product_review_required"],
    }),
    {
      type: "github.review_submitted",
      reviewState: "changes_requested",
      automationEnabled: false,
    },
  );

  assert.deepEqual(decision.patches, [{
    state: "auto_review",
    substate: "applying_review_feedback",
  }]);
  assert.deepEqual(decision.commands, []);
});

test("reducer advances qa_review approvals into ready_for_merge", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "qa_review",
      substate: "waiting_qa_review",
      flags: ["ci_green", "self_review_done", "engineering_review_done"],
    }),
    {
      type: "github.review_submitted",
      reviewState: "approved",
      automationEnabled: false,
    },
  );

  assert.deepEqual(decision.patches, [{
    state: "ready_for_merge",
    substate: "waiting_merge",
    flagsToAdd: ["qa_review_done"],
  }]);
  assert.deepEqual(decision.commands, [{ type: "ready_for_merge_entered" }]);
});

test("reducer requests reconcile when qa review asks for changes with automation enabled", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "qa_review",
      substate: "waiting_qa_review",
      flags: ["ci_green", "self_review_done", "engineering_review_done"],
    }),
    {
      type: "github.review_submitted",
      reviewState: "changes_requested",
      automationEnabled: true,
    },
  );

  assert.deepEqual(decision.patches, [{
    state: "auto_review",
    substate: "applying_review_feedback",
  }]);
  assert.deepEqual(decision.commands, [{
    type: "reconcile_work_item",
    reason: "github.review_changes_requested",
  }]);
});

test("reducer ignores review submission outside review states", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "auto_review",
      substate: "waiting_ci",
      flags: ["ci_green", "self_review_done"],
    }),
    {
      type: "github.review_submitted",
      reviewState: "approved",
      automationEnabled: true,
    },
  );

  assert.deepEqual(decision.patches, []);
  assert.deepEqual(decision.commands, []);
});

test("reducer advances engineering_review when review labels confirm engineering approval", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "engineering_review",
      substate: "waiting_engineering_review",
      flags: ["ci_green", "self_review_done"],
    }),
    {
      type: "github.review_labels_synced",
      engineeringReviewDone: true,
      qaReviewDone: false,
    },
  );

  assert.deepEqual(decision.patches, [{
    state: "qa_preparation",
    substate: "preparing_review_app",
    flagsToAdd: ["engineering_review_done"],
  }]);
  assert.deepEqual(decision.commands, []);
});

test("reducer advances qa_review when review labels confirm qa approval", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "qa_review",
      substate: "waiting_qa_review",
      flags: ["engineering_review_done"],
    }),
    {
      type: "github.review_labels_synced",
      engineeringReviewDone: true,
      qaReviewDone: true,
    },
  );

  assert.deepEqual(decision.patches, [{
    state: "ready_for_merge",
    substate: "waiting_merge",
    flagsToAdd: ["qa_review_done"],
  }]);
  assert.deepEqual(decision.commands, [{ type: "ready_for_merge_entered" }]);
});

test("reducer removes review flags when labels disappear without moving state backward", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "engineering_review",
      substate: "waiting_engineering_review",
      flags: ["engineering_review_done", "qa_review_done"],
    }),
    {
      type: "github.review_labels_synced",
      engineeringReviewDone: false,
      qaReviewDone: false,
    },
  );

  assert.deepEqual(decision.patches, [{
    state: "engineering_review",
    substate: "waiting_engineering_review",
    flagsToRemove: ["engineering_review_done", "qa_review_done"],
  }]);
  assert.deepEqual(decision.commands, []);
});

test("reducer ignores review label sync when flags already match and no state change is needed", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "qa_preparation",
      substate: "preparing_review_app",
      flags: ["engineering_review_done"],
    }),
    {
      type: "github.review_labels_synced",
      engineeringReviewDone: true,
      qaReviewDone: false,
    },
  );

  assert.deepEqual(decision.patches, []);
  assert.deepEqual(decision.commands, []);
});

test("reducer ignores review label sync for done feature_delivery items", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "done",
      substate: "merged",
      flags: ["engineering_review_done", "qa_review_done"],
    }),
    {
      type: "github.review_labels_synced",
      engineeringReviewDone: false,
      qaReviewDone: false,
    },
  );

  assert.deepEqual(decision.patches, []);
  assert.deepEqual(decision.commands, []);
});

test("reducer resets managed work items to auto_review on synchronize", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "product_review",
      substate: "waiting_product_review",
      flags: ["ci_green", "self_review_done", "engineering_review_done", "product_review_done"],
    }),
    {
      type: "github.pr_synchronized",
    },
  );

  assert.deepEqual(decision.patches, [{
    state: "auto_review",
    substate: "waiting_ci",
    flagsToRemove: ["ci_green"],
  }]);
  assert.deepEqual(decision.commands, []);
});

test("reducer clears downstream sticky approvals on ready_for_merge synchronize when engineering reset is enabled", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "ready_for_merge",
      substate: "waiting_merge",
      flags: [
        "ci_green",
        "self_review_done",
        "engineering_review_done",
        "product_review_done",
        "qa_review_done",
      ],
    }),
    {
      type: "github.pr_synchronized",
    },
    {
      resetEngineeringReviewOnNewCommits: true,
    },
  );

  assert.deepEqual(decision.patches, [{
    state: "auto_review",
    substate: "waiting_ci",
    flagsToRemove: ["ci_green", "engineering_review_done", "product_review_done", "qa_review_done"],
  }]);
  assert.deepEqual(decision.commands, []);
});

test("reducer clears sticky engineering approval on engineering_review synchronize when configured", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "engineering_review",
      substate: "waiting_engineering_review",
      flags: ["ci_green", "self_review_done", "engineering_review_done"],
    }),
    {
      type: "github.pr_synchronized",
    },
    {
      resetEngineeringReviewOnNewCommits: true,
    },
  );

  assert.deepEqual(decision.patches, [{
    state: "auto_review",
    substate: "waiting_ci",
    flagsToRemove: ["ci_green", "engineering_review_done"],
  }]);
  assert.deepEqual(decision.commands, []);
});

test("reducer clears sticky qa approval on synchronize when qa reset is enabled", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "ready_for_merge",
      substate: "waiting_merge",
      flags: ["ci_green", "self_review_done", "engineering_review_done", "product_review_done", "qa_review_done"],
    }),
    {
      type: "github.pr_synchronized",
    },
    {
      resetQaReviewOnNewCommits: true,
    },
  );

  assert.deepEqual(decision.patches, [{
    state: "auto_review",
    substate: "waiting_ci",
    flagsToRemove: ["ci_green", "qa_review_done"],
  }]);
  assert.deepEqual(decision.commands, []);
});

test("reducer ignores synchronize for done and cancelled feature_delivery items", () => {
  const doneDecision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "done",
      substate: "merged",
      flags: ["ci_green"],
    }),
    { type: "github.pr_synchronized" },
  );
  const cancelledDecision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      state: "cancelled",
      substate: "abandoned",
      flags: ["ci_green"],
    }),
    { type: "github.pr_synchronized" },
  );

  assert.deepEqual(doneDecision.patches, []);
  assert.deepEqual(doneDecision.commands, []);
  assert.deepEqual(cancelledDecision.patches, []);
  assert.deepEqual(cancelledDecision.commands, []);
});

test("reducer ignores non feature_delivery work items", () => {
  const decision = reduceFeatureDelivery(
    makeFeatureDeliveryWorkItem({
      workflow: "product_discovery",
      state: "in_progress",
    }),
    { type: "run.self_review_checkpoint_succeeded" },
  );

  assert.deepEqual(decision.patches, []);
  assert.deepEqual(decision.commands, []);
});
