import type { SandboxRuntime } from "./runtime/runtime-mode.js";

export type RunStatus =
  | "queued"
  | "running"
  | "validating"
  | "pushing"
  | "awaiting_ci"
  | "ci_fixing"
  | "cancel_requested"
  | "completed"
  | "failed"
  | "cancelled";

export type RunPhase =
  | "queued"
  | "cloning"
  | "agent"
  | "validating"
  | "pushing"
  | "awaiting_ci"
  | "ci_fixing"
  | "cancel_requested"
  | "completed"
  | "failed"
  | "cancelled";

export interface TokenUsage {
  qualityGateInputTokens: number;
  qualityGateOutputTokens: number;
  agentInputTokens?: number;
  agentOutputTokens?: number;
  /** Estimated cost in USD (computed from token counts × model prices). */
  costUsd?: number;
}

export interface RunFeedback {
  rating: "up" | "down";
  note?: string;
  by?: string;
  at: string;
}

export interface RunRecord {
  id: string;
  runtime: SandboxRuntime;
  status: RunStatus;
  phase?: RunPhase;
  repoSlug: string;
  task: string;
  baseBranch: string;
  branchName: string;
  requestedBy: string;
  channelId: string;
  threadTs: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  logsPath?: string;
  statusMessageTs?: string;
  commitSha?: string;
  changedFiles?: string[];
  prUrl?: string;
  feedback?: RunFeedback;
  error?: string;
  /** Direct parent run in the follow-up chain */
  parentRunId?: string;
  /** First run in the thread chain */
  rootRunId?: string;
  /** 0 for first run, 1 for first follow-up, etc. */
  chainIndex?: number;
  /** Branch inherited from parent (reused instead of creating new) */
  parentBranchName?: string;
  /** The engineer's follow-up instruction */
  feedbackNote?: string;
  /** Pipeline override hint from smart triage or trigger rule */
  pipelineHint?: string;
  /** Node IDs to skip (from orchestrator classification) */
  skipNodes?: string[];
  /** Node IDs to force-enable (overrides enabled: false in pipeline YAML) */
  enableNodes?: string[];
  /** CI fix loop attempts counter */
  ciFixAttempts?: number;
  /** Final CI conclusion after wait */
  ciConclusion?: string;
  /** PR number from GitHub */
  prNumber?: number;
  /** Short LLM-generated title (5-8 words) for dashboard display */
  title?: string;
  /** Token usage from LLM-calling nodes */
  tokenUsage?: TokenUsage;
  /** Team identifier derived from channel mapping */
  teamId?: string;
  /** Managed work item this run belongs to, when attached */
  workItemId?: string;
}

export interface NewRunInput {
  repoSlug: string;
  task: string;
  baseBranch: string;
  requestedBy: string;
  channelId: string;
  threadTs: string;
  runtime: SandboxRuntime;
  /** Link to the parent run for follow-ups */
  parentRunId?: string;
  /** The engineer's follow-up instruction */
  feedbackNote?: string;
  /** Pipeline override hint from smart triage or trigger rule */
  pipelineHint?: string;
  /** Node IDs to skip (from orchestrator classification) */
  skipNodes?: string[];
  /** Node IDs to force-enable (overrides enabled: false in pipeline YAML) */
  enableNodes?: string[];
  /** Team identifier derived from channel mapping */
  teamId?: string;
}

export interface ExecutionResult {
  branchName: string;
  logsPath: string;
  commitSha: string;
  changedFiles: string[];
  prUrl?: string;
  tokenUsage?: TokenUsage;
  title?: string;
}
