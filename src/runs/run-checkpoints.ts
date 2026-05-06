import type { RunIntentKind } from "./run-intent.js";

export type RunCheckpointType =
  | "run.waiting_external_ci"
  | "run.completed_without_external_wait"
  | "run.ci_concluded"
  | "run.ci_triage_decided";

export type FeatureDeliveryProgressCheckpointType =
  | "run.waiting_external_ci"
  | "run.completed_without_external_wait";

export type CiTriageVerdict = "fix_needed" | "rerun";

export interface CiTriageCheckpointPayload {
  verdict: CiTriageVerdict;
  reason?: string;
  evidence?: string[];
  headSha?: string;
  failedJobIds?: number[];
}

export interface RunCheckpointPayload {
  runId: string;
  checkpointKey: string;
  checkpointType: RunCheckpointType;
  intentKind?: RunIntentKind;
  emittedAt: string;
  payload?: Record<string, unknown>;
}

export interface RunCheckpointRecord extends RunCheckpointPayload {
  payload: Record<string, unknown>;
  processedAt?: string;
  processedError?: string;
  createdAt: string;
  updatedAt: string;
}

export function isRunCheckpointType(value: string): value is RunCheckpointType {
  return (
    value === "run.waiting_external_ci" ||
    value === "run.completed_without_external_wait" ||
    value === "run.ci_concluded" ||
    value === "run.ci_triage_decided"
  );
}

export function isFeatureDeliveryProgressCheckpointType(
  type: string,
): type is FeatureDeliveryProgressCheckpointType {
  return type === "run.waiting_external_ci" || type === "run.completed_without_external_wait";
}

export function isCiTriageCheckpointType(type: string): type is "run.ci_triage_decided" {
  return type === "run.ci_triage_decided";
}

export function isCiTriageVerdict(value: unknown): value is CiTriageVerdict {
  return value === "fix_needed" || value === "rerun";
}

export function normalizeRunCheckpointEmittedAt(emittedAt: unknown, fallback?: unknown): string | undefined {
  for (const candidate of [emittedAt, fallback]) {
    if (typeof candidate !== "string") {
      continue;
    }
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return undefined;
}
