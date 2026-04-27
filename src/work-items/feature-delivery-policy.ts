import type { WorkItemRecord } from "./types.js";

type FeatureDeliveryState = Extract<WorkItemRecord["state"],
  | "auto_review"
  | "engineering_review"
  | "qa_preparation"
  | "product_review"
  | "qa_review"
  | "ready_for_merge"
>;

const AUTO_REBASE_REQUIRED_FLAGS = ["engineering_review_done", "qa_review_done"] as const;

export function canAutoRebaseFeatureDeliveryBranch(flags: readonly string[]): boolean {
  const flagSet = new Set(flags);
  return AUTO_REBASE_REQUIRED_FLAGS.every((flag) => flagSet.has(flag));
}

export function nextFeatureDeliveryStateAfterAutoReview(input: {
  ciGreen: boolean;
  selfReviewDone: boolean;
  hasActiveAutoFixes: boolean;
}): FeatureDeliveryState {
  if (input.ciGreen && input.selfReviewDone && !input.hasActiveAutoFixes) {
    return "engineering_review";
  }
  return "auto_review";
}

export function advanceFeatureDeliveryStateAfterAutoReview(input: {
  ciGreen: boolean;
  selfReviewDone: boolean;
  hasActiveAutoFixes: boolean;
  engineeringReviewDone: boolean;
  productReviewDone: boolean;
  qaReviewDone: boolean;
  productReviewRequired: boolean;
  skipProductReview?: boolean;
}): FeatureDeliveryState {
  const nextState = nextFeatureDeliveryStateAfterAutoReview({
    ciGreen: input.ciGreen,
    selfReviewDone: input.selfReviewDone,
    hasActiveAutoFixes: input.hasActiveAutoFixes,
  });

  if (nextState !== "engineering_review") {
    return nextState;
  }

  if (input.qaReviewDone) {
    return "ready_for_merge";
  }

  if (input.productReviewDone) {
    return "qa_review";
  }

  if (!input.engineeringReviewDone) {
    return "engineering_review";
  }

  return nextFeatureDeliveryStateAfterEngineeringReview("approved");
}

export function nextFeatureDeliveryStateAfterEngineeringReview(
  outcome: "approved" | "changes_requested"
): FeatureDeliveryState {
  if (outcome !== "approved") {
    return "auto_review";
  }
  return "qa_preparation";
}

export function nextFeatureDeliveryStateAfterQaPreparation(input: {
  productReviewRequired: boolean;
  qaPrepFoundIssue: boolean;
  skipProductReview?: boolean;
}): FeatureDeliveryState {
  if (input.qaPrepFoundIssue) {
    return "auto_review";
  }
  return input.productReviewRequired && !input.skipProductReview ? "product_review" : "qa_review";
}

export function nextFeatureDeliveryStateAfterProductReview(
  outcome: "approved" | "changes_requested"
): FeatureDeliveryState {
  return outcome === "approved" ? "qa_review" : "auto_review";
}

export function nextFeatureDeliveryStateAfterQaReview(
  outcome: "approved" | "changes_requested"
): FeatureDeliveryState | "ready_for_merge" {
  return outcome === "approved" ? "ready_for_merge" : "auto_review";
}

export function advanceFeatureDeliveryStateAfterQaEntry(
  state: FeatureDeliveryState | "ready_for_merge",
  input: { qaReviewDone: boolean },
): FeatureDeliveryState | "ready_for_merge" {
  if (state === "qa_review" && input.qaReviewDone) {
    return "ready_for_merge";
  }

  return state;
}

export function nextFeatureDeliveryStateAfterReadyForMergeRecovery(
  _reason: "branch_stale" | "conflicts" | "ci_failed_after_rebase"
): FeatureDeliveryState {
  return "auto_review";
}

export function shouldResetEngineeringReviewOnNewCommits(
  env: Record<string, string | undefined> = process.env
): boolean {
  return parseBooleanFlag(env.FEATURE_DELIVERY_RESET_ENGINEERING_REVIEW_ON_NEW_COMMITS);
}

export function shouldResetQaReviewOnNewCommits(
  env: Record<string, string | undefined> = process.env
): boolean {
  return parseBooleanFlag(env.FEATURE_DELIVERY_RESET_QA_REVIEW_ON_NEW_COMMITS);
}

function parseBooleanFlag(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}
