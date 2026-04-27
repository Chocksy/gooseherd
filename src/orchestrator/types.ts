import type { ChatMessage } from "../llm/caller.js";

export interface HandleMessageRequest {
  message: string;
  userId: string;
  channelId: string;
  threadTs: string;
  priorMessages?: ChatMessage[];
  existingRunRepo?: string;
  existingRunId?: string;
}

export interface HandleMessageDeps {
  enqueueRun: (
    repo: string,
    task: string,
    opts: { skipNodes?: string[]; enableNodes?: string[]; continueFrom?: string; pipeline?: string }
  ) => Promise<{ id: string; branchName: string; repoSlug: string }>;
  listRuns: (repoSlug?: string) => Promise<string>;
  getConfig: (key?: string) => Promise<string>;
  repoAllowlist: string[];
  searchMemory?: (query: string) => Promise<string>;
  searchCode?: (query: string, repoSlug: string) => Promise<string>;
  describeRepo?: (repoSlug: string) => Promise<string>;
  readFile?: (repoSlug: string, path: string) => Promise<string>;
  listFiles?: (repoSlug: string, path: string) => Promise<string>;
}

export interface HandleMessageOptions {
  /** Called when the LLM invokes a tool — use for progress updates. */
  onToolCall?: (toolName: string, args: Record<string, unknown>) => void;
  /** Per-HTTP-call timeout in ms (default: 180_000). */
  timeoutMs?: number;
  /** Overall wall-clock timeout in ms (default: 1_800_000 = 30 min). Guards against hung tool calls, not against the model thinking too long. */
  wallClockTimeoutMs?: number;
  /** Cumulative input-token budget for the whole tool-use loop. When exceeded the orchestrator returns the exhaustion fallback. Replaces the old hardcoded maxTurns cap as the cost guard. */
  maxInputTokens?: number;
}

export interface HandleMessageResult {
  response: string;
  runsQueued: Array<{ id: string; branchName: string; repoSlug: string }>;
  messages: ChatMessage[];
}
