import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveRunIntentFromLegacy,
  isFeatureDeliveryAutoReviewOrRepairCiRun,
  isFeatureDeliveryAutoReviewRun,
  isFeatureDeliverySystemRun,
  isRunIntent,
  selectPipelineIdForIntent,
  type RunIntent,
} from "../src/runs/run-intent.js";

const BASE_FEATURE = {
  version: 1,
  source: "work_item",
  workItemId: "11111111-1111-1111-1111-111111111111",
  repo: "owner/repo",
  prNumber: 12,
  prUrl: "https://github.com/owner/repo/pull/12",
} as const;

test("selectPipelineIdForIntent maps feature-delivery intents to built-in pipelines", () => {
  const cases: Array<[RunIntent, string]> = [
    [{ ...BASE_FEATURE, kind: "feature_delivery.self_review", sourceSubstate: "pr_adopted" }, "pipeline"],
    [{ ...BASE_FEATURE, kind: "feature_delivery.apply_review_feedback", sourceSubstate: "applying_review_feedback" }, "pipeline"],
    [{ ...BASE_FEATURE, kind: "feature_delivery.repair_ci", sourceSubstate: "ci_failed" }, "ci-fix"],
    [{ ...BASE_FEATURE, kind: "feature_delivery.sync_branch", maxBehindCommits: 5 }, "branch-sync"],
    [{ ...BASE_FEATURE, kind: "feature_delivery.finalize_pr", strategy: "squash" }, "ready-for-merge"],
  ];

  for (const [intent, expected] of cases) {
    assert.equal(selectPipelineIdForIntent(intent, "wrong"), expected);
  }
});

test("selectPipelineIdForIntent preserves generic pipeline override fallback", () => {
  assert.equal(
    selectPipelineIdForIntent({ version: 1, kind: "generic_task", source: "slack", pipelineHint: "custom" }, "legacy"),
    "custom",
  );
  assert.equal(
    selectPipelineIdForIntent({ version: 1, kind: "generic_task", source: "slack" }, "legacy"),
    "legacy",
  );
});

test("deriveRunIntentFromLegacy converts work-item requesters to feature-delivery intents", () => {
  const common = {
    workItemId: BASE_FEATURE.workItemId,
    repoSlug: BASE_FEATURE.repo,
    prNumber: BASE_FEATURE.prNumber,
    prUrl: BASE_FEATURE.prUrl,
  };

  assert.equal(deriveRunIntentFromLegacy({ ...common, requestedBy: "work-item:auto-review" }).kind, "feature_delivery.self_review");
  assert.equal(
    deriveRunIntentFromLegacy({
      ...common,
      requestedBy: "work-item:auto-review",
      autoReviewSourceSubstate: "applying_review_feedback",
    }).kind,
    "feature_delivery.apply_review_feedback",
  );
  assert.equal(deriveRunIntentFromLegacy({ ...common, requestedBy: "work-item:ci-fix" }).kind, "feature_delivery.repair_ci");
  assert.equal(deriveRunIntentFromLegacy({ ...common, requestedBy: "work-item:branch-sync" }).kind, "feature_delivery.sync_branch");
  assert.equal(deriveRunIntentFromLegacy({ ...common, requestedBy: "work-item:ready-for-merge" }).kind, "feature_delivery.finalize_pr");
});

test("deriveRunIntentFromLegacy falls back to generic when feature metadata is incomplete", () => {
  const intent = deriveRunIntentFromLegacy({
    requestedBy: "work-item:auto-review",
    pipelineHint: "pipeline",
  });

  assert.equal(intent.kind, "generic_task");
  assert.equal(selectPipelineIdForIntent(intent), "pipeline");
});

test("deriveRunIntentFromLegacy treats local-trigger as local generic source", () => {
  const intent = deriveRunIntentFromLegacy({
    requestedBy: "local-trigger",
  });

  assert.equal(intent.kind, "generic_task");
  assert.equal(intent.source, "local");
});

test("isRunIntent rejects malformed feature-delivery intents", () => {
  assert.equal(isRunIntent({ version: 1, kind: "feature_delivery.repair_ci" }), false);
  assert.equal(isRunIntent({ ...BASE_FEATURE, kind: "feature_delivery.repair_ci" }), false);
  assert.equal(isRunIntent({ ...BASE_FEATURE, kind: "feature_delivery.repair_ci", sourceSubstate: "ci_failed" }), true);
  assert.equal(isRunIntent({ ...BASE_FEATURE, prNumber: 0, kind: "feature_delivery.repair_ci", sourceSubstate: "ci_failed" }), false);
  assert.equal(isRunIntent({ ...BASE_FEATURE, kind: "feature_delivery.sync_branch" }), false);
  assert.equal(isRunIntent({ ...BASE_FEATURE, kind: "feature_delivery.sync_branch", maxBehindCommits: 5 }), true);
  assert.equal(isRunIntent({ ...BASE_FEATURE, kind: "feature_delivery.sync_branch", maxBehindCommits: -1 }), false);
  assert.equal(isRunIntent({ ...BASE_FEATURE, kind: "feature_delivery.sync_branch", maxBehindCommits: 1.5 }), false);
});

test("isRunIntent rejects malformed generic intents", () => {
  assert.equal(isRunIntent({ version: 1, kind: "generic_task" }), false);
  assert.equal(isRunIntent({ version: 1, kind: "generic_task", source: "invalid" }), false);
  assert.equal(isRunIntent({ version: 1, kind: "generic_task", source: "slack", requestedBy: 123 }), false);
  assert.equal(isRunIntent({ version: 1, kind: "generic_task", source: "slack", skipNodes: ["a", 1] }), false);
  assert.equal(isRunIntent({ version: 1, kind: "generic_task", source: "slack", enableNodes: ["a"] }), true);
});

test("run intent predicates keep legacy requestedBy fallback", () => {
  const selfReview = {
    intent: { ...BASE_FEATURE, kind: "feature_delivery.self_review", sourceSubstate: "pr_adopted" },
    requestedBy: "manual:dashboard",
  } as const;
  const repairCi = {
    intent: { ...BASE_FEATURE, kind: "feature_delivery.repair_ci", sourceSubstate: "ci_failed" },
    requestedBy: "manual:dashboard",
  } as const;

  assert.equal(isFeatureDeliveryAutoReviewRun(selfReview), true);
  assert.equal(isFeatureDeliveryAutoReviewOrRepairCiRun(repairCi), true);
  assert.equal(isFeatureDeliverySystemRun(repairCi), true);
  assert.equal(isFeatureDeliveryAutoReviewRun({ intent: undefined, requestedBy: "work-item:auto-review" }), true);
  assert.equal(isFeatureDeliveryAutoReviewOrRepairCiRun({ intent: undefined, requestedBy: "work-item:ci-fix" }), true);
});
