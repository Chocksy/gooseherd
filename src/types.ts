export type RunStatus =
  | "queued"
  | "running"
  | "validating"
  | "pushing"
  | "completed"
  | "failed";

export type RunPhase =
  | "queued"
  | "cloning"
  | "agent"
  | "validating"
  | "pushing"
  | "completed"
  | "failed";

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
}

export interface ExecutionResult {
  branchName: string;
  logsPath: string;
  commitSha: string;
  changedFiles: string[];
  prUrl?: string;
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
