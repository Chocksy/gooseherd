import type { RunRecord } from "../types.js";
import type { WorkItemRecord } from "../work-items/types.js";
import {
  FEATURE_DELIVERY_BRANCH_SYNC_PIPELINE_ID,
  FEATURE_DELIVERY_CI_FIX_PIPELINE_ID,
  FEATURE_DELIVERY_QA_PREPARATION_PIPELINE_ID,
  FEATURE_DELIVERY_READY_FOR_MERGE_PIPELINE_ID,
  FEATURE_DELIVERY_REVIEW_FEEDBACK_PIPELINE_ID,
  FEATURE_DELIVERY_SELF_REVIEW_PIPELINE_ID,
} from "../pipeline/builtin-pipelines.js";

export type RunIntent =
  | GenericTaskRunIntent
  | FeatureDeliveryRunIntent;

export type RunIntentKind = RunIntent["kind"];

export interface BaseRunIntent {
  version: 1;
  kind: string;
  source: "work_item" | "slack" | "dashboard" | "local" | "observer" | "eval" | "api" | "unknown";
  triggerReason?: string;
}

export interface GenericTaskRunIntent extends BaseRunIntent {
  kind: "generic_task";
  requestedBy?: string;
  pipelineHint?: string;
  skipNodes?: string[];
  enableNodes?: string[];
}

interface BaseFeatureDeliveryRunIntent extends BaseRunIntent {
  source: "work_item";
  workItemId: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  headSha?: string;
  triggerReason?: string;
}

export type FeatureDeliveryRunIntent =
  | (BaseFeatureDeliveryRunIntent & {
      kind: "feature_delivery.self_review";
      sourceSubstate: "pr_adopted" | "ci_green_pending_self_review";
    })
  | (BaseFeatureDeliveryRunIntent & {
      kind: "feature_delivery.apply_review_feedback";
      sourceSubstate: "applying_review_feedback";
    })
  | (BaseFeatureDeliveryRunIntent & {
      kind: "feature_delivery.repair_ci";
      sourceSubstate: "ci_failed";
    })
  | (BaseFeatureDeliveryRunIntent & {
      kind: "feature_delivery.sync_branch";
      maxBehindCommits: number;
    })
  | (BaseFeatureDeliveryRunIntent & {
      kind: "feature_delivery.finalize_pr";
      strategy: "squash";
    })
  | (BaseFeatureDeliveryRunIntent & {
      kind: "feature_delivery.qa_preparation";
    });

const FEATURE_DELIVERY_INTENT_KINDS = new Set([
  "feature_delivery.self_review",
  "feature_delivery.apply_review_feedback",
  "feature_delivery.repair_ci",
  "feature_delivery.sync_branch",
  "feature_delivery.finalize_pr",
  "feature_delivery.qa_preparation",
]);

const FEATURE_DELIVERY_PROGRESS_KINDS = new Set([
  "feature_delivery.self_review",
  "feature_delivery.apply_review_feedback",
  "feature_delivery.repair_ci",
]);

const FEATURE_DELIVERY_AUTO_REVIEW_KINDS = new Set([
  "feature_delivery.self_review",
  "feature_delivery.apply_review_feedback",
]);

const PIPELINE_BY_INTENT_KIND: Partial<Record<RunIntentKind, string>> = {
  "feature_delivery.self_review": FEATURE_DELIVERY_SELF_REVIEW_PIPELINE_ID,
  "feature_delivery.apply_review_feedback": FEATURE_DELIVERY_REVIEW_FEEDBACK_PIPELINE_ID,
  "feature_delivery.repair_ci": FEATURE_DELIVERY_CI_FIX_PIPELINE_ID,
  "feature_delivery.sync_branch": FEATURE_DELIVERY_BRANCH_SYNC_PIPELINE_ID,
  "feature_delivery.finalize_pr": FEATURE_DELIVERY_READY_FOR_MERGE_PIPELINE_ID,
  "feature_delivery.qa_preparation": FEATURE_DELIVERY_QA_PREPARATION_PIPELINE_ID,
};

const LEGACY_WORK_ITEM_SYSTEM_REQUESTERS = new Set([
  "work-item:auto-review",
  "work-item:ci-fix",
  "work-item:branch-sync",
  "work-item:ready-for-merge",
  "work-item:qa-preparation",
]);

const LEGACY_WORK_ITEM_PROGRESS_REQUESTERS = new Set([
  "work-item:auto-review",
  "work-item:ci-fix",
]);

const RUN_INTENT_SOURCES = new Set([
  "work_item",
  "slack",
  "dashboard",
  "local",
  "observer",
  "eval",
  "api",
  "unknown",
]);

export function runIntentKind(intent: RunIntent | undefined): RunIntentKind | undefined {
  return intent?.kind;
}

export function isRunIntent(value: unknown): value is RunIntent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const intent = value as Record<string, unknown>;
  if (intent.version !== 1 || typeof intent.kind !== "string") {
    return false;
  }
  if (intent.kind === "generic_task") {
    return isGenericTaskIntent(intent);
  }
  if (!isBaseFeatureDeliveryIntent(intent)) {
    return false;
  }
  switch (intent.kind) {
    case "feature_delivery.self_review":
      return intent.sourceSubstate === "pr_adopted" || intent.sourceSubstate === "ci_green_pending_self_review";
    case "feature_delivery.apply_review_feedback":
      return intent.sourceSubstate === "applying_review_feedback";
    case "feature_delivery.repair_ci":
      return intent.sourceSubstate === "ci_failed";
    case "feature_delivery.sync_branch": {
      const maxBehindCommits = intent.maxBehindCommits;
      return Number.isInteger(maxBehindCommits) && typeof maxBehindCommits === "number" && maxBehindCommits >= 0;
    }
    case "feature_delivery.finalize_pr":
      return intent.strategy === "squash";
    case "feature_delivery.qa_preparation":
      return true;
    default:
      return false;
  }
}

function isGenericTaskIntent(intent: Record<string, unknown>): boolean {
  return (
    RUN_INTENT_SOURCES.has(String(intent.source)) &&
    optionalString(intent.requestedBy) &&
    optionalString(intent.pipelineHint) &&
    optionalString(intent.triggerReason) &&
    optionalStringArray(intent.skipNodes) &&
    optionalStringArray(intent.enableNodes)
  );
}

export function isFeatureDeliveryIntent(intent: RunIntent | undefined): intent is FeatureDeliveryRunIntent {
  return Boolean(intent && FEATURE_DELIVERY_INTENT_KINDS.has(intent.kind));
}

export function isFeatureDeliveryAutoReviewIntent(intent: RunIntent | undefined): boolean {
  return Boolean(intent && FEATURE_DELIVERY_AUTO_REVIEW_KINDS.has(intent.kind));
}

export function isFeatureDeliveryAutoReviewOrRepairCiIntent(intent: RunIntent | undefined): boolean {
  return Boolean(intent && FEATURE_DELIVERY_PROGRESS_KINDS.has(intent.kind));
}

export function isFeatureDeliverySystemIntent(intent: RunIntent | undefined): boolean {
  return isFeatureDeliveryIntent(intent);
}

export function selectPipelineIdForIntent(
  intent: RunIntent | undefined,
  legacyPipelineHint?: string,
): string | undefined {
  if (!intent) {
    return legacyPipelineHint;
  }
  if (intent.kind === "generic_task") {
    return intent.pipelineHint ?? legacyPipelineHint;
  }
  return PIPELINE_BY_INTENT_KIND[intent.kind] ?? legacyPipelineHint;
}

export function deriveRunIntentFromLegacy(input: {
  requestedBy: string;
  pipelineHint?: string;
  workItemId?: string;
  autoReviewSourceSubstate?: string;
  repoSlug?: string;
  prNumber?: number;
  prUrl?: string;
  skipNodes?: string[];
  enableNodes?: string[];
}): RunIntent {
  const baseFeature = deriveBaseFeatureIntent(input);
  if (baseFeature && input.requestedBy === "work-item:auto-review") {
    if (input.autoReviewSourceSubstate === "applying_review_feedback") {
      return {
        ...baseFeature,
        kind: "feature_delivery.apply_review_feedback",
        sourceSubstate: "applying_review_feedback",
      };
    }
    return {
      ...baseFeature,
      kind: "feature_delivery.self_review",
      sourceSubstate:
        input.autoReviewSourceSubstate === "ci_green_pending_self_review"
          ? "ci_green_pending_self_review"
          : "pr_adopted",
    };
  }
  if (baseFeature && input.requestedBy === "work-item:ci-fix") {
    return {
      ...baseFeature,
      kind: "feature_delivery.repair_ci",
      sourceSubstate: "ci_failed",
    };
  }
  if (baseFeature && input.requestedBy === "work-item:branch-sync") {
    return {
      ...baseFeature,
      kind: "feature_delivery.sync_branch",
      maxBehindCommits: 0,
    };
  }
  if (baseFeature && input.requestedBy === "work-item:ready-for-merge") {
    return {
      ...baseFeature,
      kind: "feature_delivery.finalize_pr",
      strategy: "squash",
    };
  }
  if (baseFeature && input.requestedBy === "work-item:qa-preparation") {
    return {
      ...baseFeature,
      kind: "feature_delivery.qa_preparation",
    };
  }

  return {
    version: 1,
    kind: "generic_task",
    source: deriveGenericSource(input.requestedBy),
    requestedBy: input.requestedBy,
    pipelineHint: input.pipelineHint,
    skipNodes: input.skipNodes,
    enableNodes: input.enableNodes,
  };
}

export function buildFeatureDeliverySelfReviewIntent(
  workItem: WorkItemRecord,
  input: { sourceSubstate: "pr_adopted" | "ci_green_pending_self_review"; triggerReason?: string },
): FeatureDeliveryRunIntent {
  return {
    ...buildFeatureDeliveryBaseIntent(workItem, input.triggerReason),
    kind: "feature_delivery.self_review",
    sourceSubstate: input.sourceSubstate,
  };
}

export function buildFeatureDeliveryApplyReviewFeedbackIntent(
  workItem: WorkItemRecord,
  input: { triggerReason?: string },
): FeatureDeliveryRunIntent {
  return {
    ...buildFeatureDeliveryBaseIntent(workItem, input.triggerReason),
    kind: "feature_delivery.apply_review_feedback",
    sourceSubstate: "applying_review_feedback",
  };
}

export function buildFeatureDeliveryRepairCiIntent(
  workItem: WorkItemRecord,
  input: { triggerReason?: string },
): FeatureDeliveryRunIntent {
  return {
    ...buildFeatureDeliveryBaseIntent(workItem, input.triggerReason),
    kind: "feature_delivery.repair_ci",
    sourceSubstate: "ci_failed",
  };
}

export function buildFeatureDeliverySyncBranchIntent(
  workItem: WorkItemRecord,
  input: { maxBehindCommits: number; triggerReason?: string },
): FeatureDeliveryRunIntent {
  return {
    ...buildFeatureDeliveryBaseIntent(workItem, input.triggerReason),
    kind: "feature_delivery.sync_branch",
    maxBehindCommits: input.maxBehindCommits,
  };
}

export function buildFeatureDeliveryFinalizePrIntent(
  workItem: WorkItemRecord,
  input: { strategy: "squash"; triggerReason?: string },
): FeatureDeliveryRunIntent {
  return {
    ...buildFeatureDeliveryBaseIntent(workItem, input.triggerReason),
    kind: "feature_delivery.finalize_pr",
    strategy: input.strategy,
  };
}

export function buildFeatureDeliveryQaPreparationIntent(
  workItem: WorkItemRecord,
  input: { triggerReason?: string } = {},
): FeatureDeliveryRunIntent {
  return {
    ...buildFeatureDeliveryBaseIntent(workItem, input.triggerReason),
    kind: "feature_delivery.qa_preparation",
  };
}

export function isFeatureDeliverySystemRun(run: Pick<RunRecord, "intent" | "requestedBy">): boolean {
  if (isFeatureDeliverySystemIntent(run.intent)) {
    return true;
  }
  return LEGACY_WORK_ITEM_SYSTEM_REQUESTERS.has(run.requestedBy);
}

export function isFeatureDeliveryAutoReviewRun(run: Pick<RunRecord, "intent" | "requestedBy">): boolean {
  if (isFeatureDeliveryAutoReviewIntent(run.intent)) {
    return true;
  }
  return run.requestedBy === "work-item:auto-review";
}

export function isFeatureDeliveryAutoReviewOrRepairCiRun(
  run: Pick<RunRecord, "intent" | "requestedBy">,
): boolean {
  if (isFeatureDeliveryAutoReviewOrRepairCiIntent(run.intent)) {
    return true;
  }
  return LEGACY_WORK_ITEM_PROGRESS_REQUESTERS.has(run.requestedBy);
}

export function isSuccessfulFeatureDeliveryProgressCheckpoint(
  run: Pick<RunRecord, "status" | "phase" | "intent" | "requestedBy">,
): boolean {
  if (run.phase !== "awaiting_ci" && run.status !== "awaiting_ci" && run.status !== "completed") {
    return false;
  }
  if (isFeatureDeliveryAutoReviewOrRepairCiIntent(run.intent)) {
    return true;
  }
  return LEGACY_WORK_ITEM_PROGRESS_REQUESTERS.has(run.requestedBy);
}

function deriveBaseFeatureIntent(input: {
  workItemId?: string;
  repoSlug?: string;
  prNumber?: number;
  prUrl?: string;
}): Omit<BaseFeatureDeliveryRunIntent, "kind"> | undefined {
  if (!input.workItemId || !input.repoSlug || !input.prNumber || !input.prUrl) {
    return undefined;
  }
  return {
    version: 1,
    source: "work_item",
    workItemId: input.workItemId,
    repo: input.repoSlug,
    prNumber: input.prNumber,
    prUrl: input.prUrl,
  };
}

function isBaseFeatureDeliveryIntent(intent: Record<string, unknown>): boolean {
  const prNumber = intent.prNumber;
  return (
    FEATURE_DELIVERY_INTENT_KINDS.has(String(intent.kind)) &&
    intent.source === "work_item" &&
    typeof intent.workItemId === "string" &&
    intent.workItemId.length > 0 &&
    typeof intent.repo === "string" &&
    intent.repo.length > 0 &&
    Number.isInteger(prNumber) &&
    typeof prNumber === "number" &&
    prNumber > 0 &&
    typeof intent.prUrl === "string" &&
    intent.prUrl.length > 0
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalStringArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

function buildFeatureDeliveryBaseIntent(
  workItem: WorkItemRecord,
  triggerReason?: string,
): Omit<BaseFeatureDeliveryRunIntent, "kind"> {
  if (!workItem.repo || !workItem.githubPrNumber || !workItem.githubPrUrl) {
    throw new Error(`Work item ${workItem.id} is missing feature-delivery PR metadata`);
  }
  return {
    version: 1,
    source: "work_item",
    workItemId: workItem.id,
    repo: workItem.repo,
    prNumber: workItem.githubPrNumber,
    prUrl: workItem.githubPrUrl,
    headSha: workItem.githubPrHeadSha,
    triggerReason,
  };
}

function deriveGenericSource(requestedBy: string): GenericTaskRunIntent["source"] {
  if (requestedBy === "local" || requestedBy === "local-trigger" || requestedBy.startsWith("local:")) return "local";
  if (requestedBy === "eval") return "eval";
  if (requestedBy.startsWith("dashboard") || requestedBy === "manual:dashboard") return "dashboard";
  if (requestedBy.startsWith("observer")) return "observer";
  if (requestedBy.startsWith("api")) return "api";
  if (requestedBy.startsWith("slack") || requestedBy.startsWith("U")) return "slack";
  return "unknown";
}
