import type { TokenUsage, TokenUsageIncrement } from "../types.js";

export type RunStatus =
  | "queued"
  | "starting"
  | "running"
  | "cancel_requested"
  | "completed"
  | "failed"
  | "cancelled";

export type ArtifactState = "complete" | "partial" | "failed";

export interface CreateRunEnvelopeInput {
  runId: string;
  payloadRef: string;
  payloadJson: Record<string, unknown>;
  runtime: "local" | "docker" | "kubernetes";
}

export interface ActiveAgentProfileSnapshot {
  id: string;
  name: string;
  runtime: string;
  provider?: string;
  model?: string;
  commandTemplate: string;
  source: "profile" | "env";
}

export interface RunnerConfigPayload {
  agentCommandTemplate?: string;
  agentFollowUpTemplate?: string;
  activeAgentProfile?: ActiveAgentProfileSnapshot;
}

export interface RunEnvelope {
  runId: string;
  payloadRef: string;
  payloadJson: Record<string, unknown>;
  runtime: CreateRunEnvelopeInput["runtime"];
  createdAt: string;
  updatedAt: string;
}

export interface IssuedRunToken {
  token: string;
}

export interface RunnerCompletionPayload {
  idempotencyKey: string;
  status: "success" | "failed";
  reason?: string;
  artifactState: ArtifactState;
  commitSha?: string;
  changedFiles?: string[];
  internalArtifacts?: string[];
  prUrl?: string;
  prNumber?: number;
  tokenUsage?: TokenUsage;
  title?: string;
}

export type RunnerTokenUsagePayload = TokenUsageIncrement;

export interface RunCompletionRecord {
  id: number;
  runId: string;
  idempotencyKey: string;
  payload: RunnerCompletionPayload;
  createdAt: string;
}

export type RunnerEventType =
  | "run.started"
  | "run.progress"
  | "run.phase_changed"
  | "run.warning"
  | "run.artifact_status"
  | "run.cancellation_observed"
  | "run.completion_attempted";

export interface RunnerEventPayload {
  eventId: string;
  eventType: RunnerEventType;
  timestamp: string;
  sequence: number;
  payload?: Record<string, unknown>;
}
