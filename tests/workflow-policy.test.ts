import assert from "node:assert/strict";
import test from "node:test";
import { assertStateTransitionAllowed } from "../src/work-items/workflow-policy.js";
import type { FeatureDeliveryState } from "../src/work-items/types.js";

test("feature delivery active states may transition to terminal states", () => {
  const activeStates: FeatureDeliveryState[] = [
    "backlog",
    "in_progress",
    "auto_review",
    "engineering_review",
    "qa_preparation",
    "product_review",
    "qa_review",
    "ready_for_merge",
  ];

  for (const state of activeStates) {
    assert.doesNotThrow(() => {
      assertStateTransitionAllowed({ workflow: "feature_delivery", state }, "done");
    });
    assert.doesNotThrow(() => {
      assertStateTransitionAllowed({ workflow: "feature_delivery", state }, "cancelled");
    });
  }
});

test("feature delivery cancelled automation pause may transition to done after merge polling", () => {
  assert.doesNotThrow(() => {
    assertStateTransitionAllowed({ workflow: "feature_delivery", state: "cancelled" }, "done");
  });
});
