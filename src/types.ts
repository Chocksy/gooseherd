export type RunStatus =
  | "queued"
  | "running"
  | "validating"
  | "pushing"
  | "awaiting_ci"
  | "ci_fixing"
  | "completed"
  | "failed";

export type RunPhase =
  | "queued"
  | "cloning"
  | "agent"
  | "validating"
  | "pushing"
  | "awaiting_ci"
  | "ci_fixing"
  | "completed"
  | "failed";

export interface TokenUsage {
  qualityGateInputTokens: number;
  qualityGateOutputTokens: number;
  agentInputTokens?: number;
  agentOutputTokens?: number;
}

export interface RunFeedback {
  rating: "up" | "down";
  note?: string;
  by?: string;
  at: string;
}

export interface RunRecord {
  id: string;
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
  /** CI fix loop attempts counter */
  ciFixAttempts?: number;
  /** Final CI conclusion after wait */
  ciConclusion?: string;
  /** PR number from GitHub */
  prNumber?: number;
  /** Token usage from LLM-calling nodes */
  tokenUsage?: TokenUsage;
  /** Team identifier derived from channel mapping */
  teamId?: string;
}

export interface NewRunInput {
  repoSlug: string;
  task: string;
  baseBranch: string;
  requestedBy: string;
  channelId: string;
  threadTs: string;
  /** Link to the parent run for follow-ups */
  parentRunId?: string;
  /** The engineer's follow-up instruction */
  feedbackNote?: string;
  /** Pipeline override hint from smart triage or trigger rule */
  pipelineHint?: string;
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
}

export interface CommandRunRequest {
  repoSlug: string;
  task: string;
  baseBranch?: string;
}

export type ParsedCommand =
  | { type: "help" }
  | { type: "status"; runId?: string }
  | { type: "tail"; runId?: string }
  | { type: "run"; payload: CommandRunRequest }
  | { type: "invalid"; reason: string };
