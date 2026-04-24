import {
  advanceFeatureDeliveryStateAfterAutoReview,
  advanceFeatureDeliveryStateAfterQaEntry,
  nextFeatureDeliveryStateAfterEngineeringReview,
  nextFeatureDeliveryStateAfterProductReview,
  nextFeatureDeliveryStateAfterQaPreparation,
  nextFeatureDeliveryStateAfterQaReview,
  nextFeatureDeliveryStateAfterReadyForMergeRecovery,
} from "./feature-delivery-policy.js";
import type { UpdateWorkItemStateInput, WorkItemRecord } from "./types.js";

type FeatureDeliveryProgressState = Extract<
  WorkItemRecord["state"],
  "engineering_review" | "qa_preparation" | "product_review" | "qa_review" | "ready_for_merge"
>;

type ManagedFeatureDeliveryState = Extract<
  WorkItemRecord["state"],
  "auto_review" | FeatureDeliveryProgressState
>;

export type FeatureDeliveryReducerEvent =
  | FeatureDeliverySelfReviewCheckpointEvent
  | FeatureDeliveryCiCompletedEvent
  | FeatureDeliveryReviewSubmittedEvent
  | FeatureDeliveryReviewLabelsSyncedEvent
  | FeatureDeliveryPrSynchronizedEvent;

type FeatureDeliverySelfReviewCheckpointEvent = {
  type: "run.self_review_checkpoint_succeeded";
};

type FeatureDeliveryCiCompletedEvent = {
  type: "github.ci_completed";
  conclusion: "success" | "failure";
  hasActiveSystemRun: boolean;
  automationEnabled: boolean;
};

type FeatureDeliveryReviewSubmittedEvent = {
  type: "github.review_submitted";
  reviewState: "approved" | "changes_requested";
  automationEnabled: boolean;
};

type FeatureDeliveryReviewLabelsSyncedEvent = {
  type: "github.review_labels_synced";
  engineeringReviewDone: boolean;
  qaReviewDone: boolean;
};

type FeatureDeliveryPrSynchronizedEvent = {
  type: "github.pr_synchronized";
};

export interface FeatureDeliveryReducerPolicy {
  skipQaPreparation?: boolean;
  skipProductReview?: boolean;
  resetEngineeringReviewOnNewCommits?: boolean;
  resetQaReviewOnNewCommits?: boolean;
}

export type FeatureDeliveryCommand =
  | {
      type: "reconcile_work_item";
      reason: string;
    }
  | {
      type: "ready_for_merge_entered";
    };

export interface FeatureDeliveryDecision {
  patches: UpdateWorkItemStateInput[];
  commands: FeatureDeliveryCommand[];
}

export function reduceFeatureDelivery(
  workItem: WorkItemRecord,
  event: FeatureDeliveryReducerEvent,
  policy: FeatureDeliveryReducerPolicy = {},
): FeatureDeliveryDecision {
  if (workItem.workflow !== "feature_delivery") {
    return emptyDecision();
  }

  if (event.type === "run.self_review_checkpoint_succeeded") {
    return reduceSelfReviewCheckpoint(workItem, policy);
  }

  if (event.type === "github.ci_completed") {
    return event.conclusion === "success"
      ? reduceSuccessfulCi(workItem, event, policy)
      : reduceFailedCi(workItem, event);
  }

  if (event.type === "github.review_submitted") {
    return reduceReviewSubmitted(workItem, event, policy);
  }

  if (event.type === "github.review_labels_synced") {
    return reduceReviewLabelsSynced(workItem, event, policy);
  }

  if (event.type === "github.pr_synchronized") {
    return reducePullRequestSynchronized(workItem, policy);
  }

  return emptyDecision();
}

export function featureDeliverySubstateForState(
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

function reduceSelfReviewCheckpoint(
  workItem: WorkItemRecord,
  policy: FeatureDeliveryReducerPolicy,
): FeatureDeliveryDecision {
  if (workItem.state !== "auto_review") {
    return emptyDecision();
  }

  const path = featureDeliveryStatePathAfterAutoReview(workItem, {
    ciGreen: hasFlag(workItem, "ci_green"),
    selfReviewDone: true,
    policy,
  });

  if (path.length === 0) {
    return {
      patches: [{
        state: "auto_review",
        substate: featureDeliverySubstateForState("auto_review", {
          fallback: workItem.substate,
          defaultValue: "waiting_ci",
        }),
        flagsToAdd: ["self_review_done"],
      }],
      commands: [],
    };
  }

  return decisionForStatePath(workItem.state, path, {
    firstPatchFlagsToAdd: ["self_review_done"],
    fallbackSubstate: workItem.substate,
  });
}

function reduceSuccessfulCi(
  workItem: WorkItemRecord,
  event: FeatureDeliveryCiCompletedEvent,
  policy: FeatureDeliveryReducerPolicy,
): FeatureDeliveryDecision {
  if (workItem.state === "auto_review" && !hasFlag(workItem, "self_review_done")) {
    const hadGreenCi = hasFlag(workItem, "ci_green");
    return {
      patches: [{
        state: "auto_review",
        substate: "ci_green_pending_self_review",
        flagsToAdd: ["ci_green"],
      }],
      commands: event.automationEnabled && !hadGreenCi && !event.hasActiveSystemRun
        ? [{ type: "reconcile_work_item", reason: "github.ci_green_pending_self_review" }]
        : [],
    };
  }

  if (workItem.state === "auto_review") {
    const path = featureDeliveryStatePathAfterAutoReview(workItem, {
      ciGreen: true,
      selfReviewDone: true,
      policy,
    });

    if (path.length === 0) {
      return {
        patches: [{
          state: "auto_review",
          substate: featureDeliverySubstateForState("auto_review", {
            fallback: workItem.substate,
            defaultValue: "waiting_ci",
          }),
          flagsToAdd: ["ci_green"],
        }],
        commands: [],
      };
    }

    return decisionForStatePath(workItem.state, path, {
      firstPatchFlagsToAdd: ["ci_green"],
      fallbackSubstate: workItem.substate,
    });
  }

  if (!isManagedFeatureDeliveryState(workItem.state)) {
    if (workItem.state === "backlog" || workItem.state === "in_progress") {
      return {
        patches: [{
          state: workItem.state,
          substate: workItem.substate,
          flagsToAdd: ["ci_green"],
        }],
        commands: [],
      };
    }

    return emptyDecision();
  }

  const nextState = workItem.state === "qa_preparation"
    ? nextFeatureDeliveryStateAfterQaPreparation({
        productReviewRequired: hasFlag(workItem, "product_review_required"),
        qaPrepFoundIssue: false,
        skipProductReview: policy.skipProductReview,
      })
    : workItem.state;
  const finalState = advanceFeatureDeliveryStateAfterQaEntry(nextState, {
    qaReviewDone: hasFlag(workItem, "qa_review_done"),
  });

  const patches: UpdateWorkItemStateInput[] = [{
    state: nextState,
    substate: featureDeliverySubstateForState(nextState, {
      fallback: workItem.substate,
      defaultValue: "waiting_ci",
    }),
    flagsToAdd: ["ci_green"],
  }];

  if (finalState !== nextState) {
    patches.push({
      state: finalState,
      substate: featureDeliverySubstateForState(finalState, {
        fallback: patches[0].substate,
        defaultValue: "waiting_ci",
      }),
    });
  }

  return {
    patches,
    commands: enteredReadyForMerge(workItem.state, patches) ? [{ type: "ready_for_merge_entered" }] : [],
  };
}

function reduceFailedCi(
  workItem: WorkItemRecord,
  event: FeatureDeliveryCiCompletedEvent,
): FeatureDeliveryDecision {
  if (workItem.state === "auto_review") {
    return {
      patches: [{
        state: "auto_review",
        substate: event.hasActiveSystemRun ? workItem.substate : "ci_failed",
        flagsToRemove: ["ci_green"],
      }],
      commands: event.automationEnabled && !event.hasActiveSystemRun
        ? [{ type: "reconcile_work_item", reason: "github.ci_failed" }]
        : [],
    };
  }

  if (!isManagedFeatureDeliveryState(workItem.state)) {
    if (workItem.state === "backlog" || workItem.state === "in_progress") {
      return {
        patches: [{
          state: "auto_review",
          substate: "waiting_ci",
          flagsToRemove: ["ci_green"],
        }],
        commands: [],
      };
    }

    return emptyDecision();
  }

  return {
    patches: [{
      state: workItem.state === "ready_for_merge"
        ? nextFeatureDeliveryStateAfterReadyForMergeRecovery("ci_failed_after_rebase")
        : "auto_review",
      substate: workItem.state === "ready_for_merge" ? "revalidating_after_rebase" : "waiting_ci",
      flagsToRemove: ["ci_green"],
    }],
    commands: [],
  };
}

function reduceReviewSubmitted(
  workItem: WorkItemRecord,
  event: FeatureDeliveryReviewSubmittedEvent,
  policy: FeatureDeliveryReducerPolicy,
): FeatureDeliveryDecision {
  if (
    workItem.state !== "engineering_review"
    && workItem.state !== "product_review"
    && workItem.state !== "qa_review"
  ) {
    return emptyDecision();
  }

  let nextState: WorkItemRecord["state"];
  let flagsToAdd: string[] = [];

  if (workItem.state === "engineering_review") {
    nextState = nextFeatureDeliveryStateAfterEngineeringReview(event.reviewState, {
      skipQaPreparation: policy.skipQaPreparation,
      productReviewRequired: hasFlag(workItem, "product_review_required"),
      skipProductReview: policy.skipProductReview,
    });
    if (event.reviewState === "approved") {
      flagsToAdd = ["engineering_review_done"];
    }
  } else if (workItem.state === "product_review") {
    nextState = nextFeatureDeliveryStateAfterProductReview(event.reviewState);
    if (event.reviewState === "approved") {
      flagsToAdd = ["product_review_done"];
    }
  } else {
    nextState = nextFeatureDeliveryStateAfterQaReview(event.reviewState);
    if (event.reviewState === "approved") {
      flagsToAdd = ["qa_review_done"];
    }
  }

  const qaReviewDone = event.reviewState === "approved"
    && (hasFlag(workItem, "qa_review_done") || flagsToAdd.includes("qa_review_done"));
  const finalState = isManagedFeatureDeliveryState(nextState)
    ? advanceFeatureDeliveryStateAfterQaEntry(nextState, { qaReviewDone })
    : nextState;
  const patches = [patchForState(nextState, {
    fallbackSubstate: workItem.substate,
    defaultSubstate: event.reviewState === "approved" ? "waiting_ci" : undefined,
    explicitSubstate: event.reviewState === "approved" ? undefined : "applying_review_feedback",
    flagsToAdd,
  })];

  if (finalState !== nextState) {
    patches.push(patchForState(finalState, {
      fallbackSubstate: patches[0]!.substate,
      defaultSubstate: "waiting_ci",
    }));
  }

  return {
    patches,
    commands: [
      ...(event.reviewState === "changes_requested" && event.automationEnabled
        ? [{ type: "reconcile_work_item", reason: "github.review_changes_requested" } as const]
        : []),
      ...(enteredReadyForMerge(workItem.state, patches)
        ? [{ type: "ready_for_merge_entered" } as const]
        : []),
    ],
  };
}

function reduceReviewLabelsSynced(
  workItem: WorkItemRecord,
  event: FeatureDeliveryReviewLabelsSyncedEvent,
  policy: FeatureDeliveryReducerPolicy,
): FeatureDeliveryDecision {
  if (!isManagedFeatureDeliveryState(workItem.state)) {
    return emptyDecision();
  }

  const flagsToAdd = reviewResultFlagsFromLabelSync(event);
  const normalizedFlagsToAdd = new Set(flagsToAdd);
  const flagsToRemove = REVIEW_RESULT_FLAGS.filter((flag) => !normalizedFlagsToAdd.has(flag));
  const flagsActuallyAdded = flagsToAdd.filter((flag) => !hasFlag(workItem, flag));
  const flagsActuallyRemoved = flagsToRemove.filter((flag) => hasFlag(workItem, flag));

  const nextState = workItem.state === "engineering_review" && event.engineeringReviewDone
    ? nextFeatureDeliveryStateAfterEngineeringReview("approved", {
        skipQaPreparation: policy.skipQaPreparation,
        productReviewRequired: hasFlag(workItem, "product_review_required"),
        skipProductReview: policy.skipProductReview,
      })
    : workItem.state === "qa_review" && event.qaReviewDone
      ? nextFeatureDeliveryStateAfterQaReview("approved")
      : workItem.state;
  const finalState = isManagedFeatureDeliveryState(nextState)
    ? advanceFeatureDeliveryStateAfterQaEntry(nextState, { qaReviewDone: event.qaReviewDone })
    : nextState;

  if (
    nextState === workItem.state
    && finalState === workItem.state
    && flagsActuallyAdded.length === 0
    && flagsActuallyRemoved.length === 0
  ) {
    return emptyDecision();
  }

  const patches = [patchForState(nextState, {
    explicitSubstate: nextState === workItem.state
      ? workItem.substate
      : undefined,
    fallbackSubstate: workItem.substate,
    flagsToAdd: flagsActuallyAdded,
    flagsToRemove: flagsActuallyRemoved,
  })];

  if (finalState !== nextState) {
    patches.push(patchForState(finalState, {
      fallbackSubstate: patches[0]!.substate,
    }));
  }

  return {
    patches,
    commands: enteredReadyForMerge(workItem.state, patches) ? [{ type: "ready_for_merge_entered" }] : [],
  };
}

function reducePullRequestSynchronized(
  workItem: WorkItemRecord,
  policy: FeatureDeliveryReducerPolicy,
): FeatureDeliveryDecision {
  if (!isManagedFeatureDeliveryState(workItem.state)) {
    return emptyDecision();
  }

  const flagsToRemove = new Set<string>(["ci_green"]);
  if (workItem.state === "ready_for_merge" && policy.resetEngineeringReviewOnNewCommits) {
    flagsToRemove.add("engineering_review_done");
    flagsToRemove.add("product_review_done");
    flagsToRemove.add("qa_review_done");
  } else {
    if (workItem.state === "engineering_review" && policy.resetEngineeringReviewOnNewCommits) {
      flagsToRemove.add("engineering_review_done");
    }
    if ((workItem.state === "qa_review" || workItem.state === "ready_for_merge") && policy.resetQaReviewOnNewCommits) {
      flagsToRemove.add("qa_review_done");
    }
  }

  return {
    patches: [patchForState("auto_review", {
      explicitSubstate: "waiting_ci",
      flagsToRemove: Array.from(flagsToRemove),
    })],
    commands: [],
  };
}

function featureDeliveryStatePathAfterAutoReview(
  workItem: WorkItemRecord,
  input: {
    ciGreen: boolean;
    selfReviewDone: boolean;
    policy: FeatureDeliveryReducerPolicy;
  },
): FeatureDeliveryProgressState[] {
  const finalState = advanceFeatureDeliveryStateAfterAutoReview({
    ciGreen: input.ciGreen,
    selfReviewDone: input.selfReviewDone,
    hasActiveAutoFixes: false,
    engineeringReviewDone: hasFlag(workItem, "engineering_review_done"),
    productReviewDone: hasFlag(workItem, "product_review_done"),
    qaReviewDone: hasFlag(workItem, "qa_review_done"),
    productReviewRequired: hasFlag(workItem, "product_review_required"),
    skipQaPreparation: input.policy.skipQaPreparation,
    skipProductReview: input.policy.skipProductReview,
  });
  const path: FeatureDeliveryProgressState[] = [];

  if (finalState === "auto_review") {
    return path;
  }

  path.push("engineering_review");
  if (finalState === "engineering_review" || !hasFlag(workItem, "engineering_review_done")) {
    return path;
  }

  const afterEngineeringReview = nextFeatureDeliveryStateAfterEngineeringReview("approved", {
    skipQaPreparation: input.policy.skipQaPreparation,
    productReviewRequired: hasFlag(workItem, "product_review_required"),
    skipProductReview: input.policy.skipProductReview,
  });
  if (isFeatureDeliveryProgressState(afterEngineeringReview)) {
    pushUniqueState(path, afterEngineeringReview);
  }
  if (finalState === afterEngineeringReview) {
    return path;
  }

  let currentState = afterEngineeringReview;
  if (currentState === "qa_preparation") {
    const afterQaPreparation = nextFeatureDeliveryStateAfterQaPreparation({
      productReviewRequired: hasFlag(workItem, "product_review_required"),
      qaPrepFoundIssue: false,
      skipProductReview: input.policy.skipProductReview,
    });
    if (isFeatureDeliveryProgressState(afterQaPreparation)) {
      currentState = afterQaPreparation;
      pushUniqueState(path, currentState);
    }
    if (finalState === afterQaPreparation) {
      return path;
    }
  }

  if (currentState === "product_review") {
    const afterProductReview = nextFeatureDeliveryStateAfterProductReview("approved");
    if (isFeatureDeliveryProgressState(afterProductReview)) {
      currentState = afterProductReview;
      pushUniqueState(path, currentState);
    }
    if (finalState === afterProductReview) {
      return path;
    }
  }

  if (currentState === "qa_review" && finalState === "ready_for_merge") {
    const afterQaReview = nextFeatureDeliveryStateAfterQaReview("approved");
    if (isFeatureDeliveryProgressState(afterQaReview)) {
      pushUniqueState(path, afterQaReview);
    }
  }

  return path;
}

function decisionForStatePath(
  initialState: WorkItemRecord["state"],
  path: FeatureDeliveryProgressState[],
  input: {
    firstPatchFlagsToAdd: string[];
    fallbackSubstate?: string;
  },
): FeatureDeliveryDecision {
  const patches = path.map((state, index) => {
    const patch: UpdateWorkItemStateInput = {
      state,
      substate: featureDeliverySubstateForState(state, {
        fallback: index === 0
          ? input.fallbackSubstate
          : featureDeliverySubstateForState(path[index - 1]!, { fallback: input.fallbackSubstate }),
        defaultValue: "waiting_ci",
      }),
    };

    if (index === 0) {
      patch.flagsToAdd = input.firstPatchFlagsToAdd;
    }

    return patch;
  });

  return {
    patches,
    commands: enteredReadyForMerge(initialState, patches) ? [{ type: "ready_for_merge_entered" }] : [],
  };
}

function enteredReadyForMerge(
  initialState: WorkItemRecord["state"],
  patches: UpdateWorkItemStateInput[],
): boolean {
  return initialState !== "ready_for_merge" && patches.some((patch) => patch.state === "ready_for_merge");
}

function pushUniqueState(path: FeatureDeliveryProgressState[], state: FeatureDeliveryProgressState): void {
  if (path[path.length - 1] !== state) {
    path.push(state);
  }
}

function hasFlag(workItem: WorkItemRecord, flag: string): boolean {
  return workItem.flags.includes(flag);
}

function reviewResultFlagsFromLabelSync(
  event: FeatureDeliveryReviewLabelsSyncedEvent,
): Array<typeof REVIEW_RESULT_FLAGS[number]> {
  const flags: Array<typeof REVIEW_RESULT_FLAGS[number]> = [];

  if (event.engineeringReviewDone) {
    flags.push("engineering_review_done");
  }
  if (event.qaReviewDone) {
    flags.push("qa_review_done");
  }

  return flags;
}

function patchForState(
  state: WorkItemRecord["state"],
  input: {
    explicitSubstate?: string;
    fallbackSubstate?: string;
    defaultSubstate?: string;
    flagsToAdd?: string[];
    flagsToRemove?: string[];
  },
): UpdateWorkItemStateInput {
  const patch: UpdateWorkItemStateInput = {
    state,
    substate: input.explicitSubstate ?? featureDeliverySubstateForState(state, {
      fallback: input.fallbackSubstate,
      defaultValue: input.defaultSubstate,
    }),
  };

  if (input.flagsToAdd && input.flagsToAdd.length > 0) {
    patch.flagsToAdd = input.flagsToAdd;
  }
  if (input.flagsToRemove && input.flagsToRemove.length > 0) {
    patch.flagsToRemove = input.flagsToRemove;
  }

  return patch;
}

function isManagedFeatureDeliveryState(state: WorkItemRecord["state"]): state is ManagedFeatureDeliveryState {
  return [
    "auto_review",
    "engineering_review",
    "qa_preparation",
    "product_review",
    "qa_review",
    "ready_for_merge",
  ].includes(state);
}

function emptyDecision(): FeatureDeliveryDecision {
  return { patches: [], commands: [] };
}

const REVIEW_RESULT_FLAGS = ["engineering_review_done", "qa_review_done"] as const;

function isFeatureDeliveryProgressState(state: WorkItemRecord["state"]): state is FeatureDeliveryProgressState {
  return [
    "engineering_review",
    "qa_preparation",
    "product_review",
    "qa_review",
    "ready_for_merge",
  ].includes(state);
}
