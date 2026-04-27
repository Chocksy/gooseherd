import type { RunIntentKind } from "./run-intent.js";

export type RunCheckpointType =
  | "run.waiting_external_ci"
  | "run.completed_without_external_wait"
  | "run.ci_concluded";

export type FeatureDeliveryProgressCheckpointType =
  | "run.waiting_external_ci"
  | "run.completed_without_external_wait";

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
    value === "run.ci_concluded"
  );
}

export function isFeatureDeliveryProgressCheckpointType(
  type: string,
): type is FeatureDeliveryProgressCheckpointType {
  return type === "run.waiting_external_ci" || type === "run.completed_without_external_wait";
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
