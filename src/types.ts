import type { RunPrefetchContext } from "./runtime/run-context-types.js";
import type { SandboxRuntime } from "./runtime/runtime-mode.js";
import type { RunIntent, RunIntentKind } from "./runs/run-intent.js";

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
  | "rebasing"
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
  byModel?: Array<{
    model: string;
    input: number;
    output: number;
    costUsd?: number;
  }>;
  missingPriceModels?: string[];
  costIncomplete?: boolean;
  /** Estimated cost in USD (computed from token counts × model prices). */
  costUsd?: number;
}

export interface TokenUsageIncrement {
  model: string;
  input: number;
  output: number;
  source?: "quality_gate" | "agent";
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
  internalArtifacts?: string[];
  prUrl?: string;
  feedback?: RunFeedback;
  error?: string;
  /** Direct parent run in the follow-up chain */
  parentRunId?: string;
  /** First run in the thread chain */
  rootRunId?: string;
  /** 0 for first run, 1 for first follow-up, etc. */
  chainIndex?: number;
  /** Existing branch to reuse instead of creating a fresh one */
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
  /** Managed work item this run belongs to, whether linked at creation or later */
  workItemId?: string;
  prefetchContext?: RunPrefetchContext;
  autoReviewSourceSubstate?: string;
  intent?: RunIntent;
  intentKind?: RunIntentKind;
}

export interface NewRunInput {
  repoSlug: string;
  task: string;
  baseBranch: string;
  requestedBy: string;
  channelId: string;
  threadTs: string;
  runtime: SandboxRuntime;
  /** Managed work item this run belongs to, when created in-band */
  workItemId?: string;
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
  /** Existing PR metadata for runs that operate on an already-linked PR */
  prUrl?: string;
  prNumber?: number;
  prefetchContext?: RunPrefetchContext;
  autoReviewSourceSubstate?: string;
  intent?: RunIntent;
}

export interface ExecutionResult {
  branchName: string;
  logsPath: string;
  commitSha: string;
  changedFiles: string[];
  internalArtifacts?: string[];
  prUrl?: string;
  prNumber?: number;
  tokenUsage?: TokenUsage;
  title?: string;
}
