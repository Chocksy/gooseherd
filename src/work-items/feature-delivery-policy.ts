import type { WorkItemRecord } from "./types.js";

type FeatureDeliveryState = Extract<WorkItemRecord["state"],
  | "auto_review"
  | "engineering_review"
  | "qa_preparation"
  | "product_review"
  | "qa_review"
  | "ready_for_merge"
>;

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

export function nextFeatureDeliveryStateAfterEngineeringReview(
  outcome: "approved" | "changes_requested"
): FeatureDeliveryState {
  return outcome === "approved" ? "qa_preparation" : "auto_review";
}

export function nextFeatureDeliveryStateAfterQaPreparation(input: {
  productReviewRequired: boolean;
  qaPrepFoundIssue: boolean;
}): FeatureDeliveryState {
  if (input.qaPrepFoundIssue) {
    return "auto_review";
  }
  return input.productReviewRequired ? "product_review" : "qa_review";
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
