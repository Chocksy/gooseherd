import type { AppConfig } from "../config.js";
import type { RunRecord } from "../types.js";
import type { TokenUsageIncrement } from "../types.js";
import type { GitHubService } from "../github.js";
import type { RunLifecycleHooks } from "../hooks/run-lifecycle.js";
import type { ContextBag } from "./context-bag.js";
import type { RunCheckpointType } from "../runs/run-checkpoints.js";

// ── Node categories ──

export type NodeCategory = "deterministic" | "agentic" | "conditional" | "async";

// ── Pipeline YAML config types ──

export interface LoopConfig {
  action: "loop";
  agent_node: string;
  max_rounds: number | string;
  until?: string;
  on_exhausted?: "fail_run" | "complete_with_warning";
}

export interface NodeConfig {
  id: string;
  type: NodeCategory;
  action: string;
  config?: Record<string, unknown>;
  if?: string;
  enabled?: boolean;
  on_failure?: LoopConfig;
  on_soft_fail?: "warn" | "fail_run";
  on_hard_fail?: "fail_run";
}

export interface PipelineConfig {
  version: number;
  name: string;
  description?: string;
  context?: Record<string, unknown>;
  nodes: NodeConfig[];
}

// ── Node execution ──

export type NodeOutcome = "success" | "failure" | "skipped" | "soft_fail";

export interface NodeResult {
  outcome: NodeOutcome;
  outputs?: Record<string, unknown>;
  error?: string;
  /** Raw stderr/stdout for error re-prompting */
  rawOutput?: string;
}

export interface NodeDeps {
  config: AppConfig;
  run: RunRecord;
  githubService?: GitHubService;
  hooks?: RunLifecycleHooks;
  logFile: string;
  workRoot: string;
  onPhase: (phase: string) => Promise<void>;
  emitRunCheckpoint?: (checkpoint: {
    checkpointKey: string;
    checkpointType: RunCheckpointType;
    payload?: Record<string, unknown>;
  }) => Promise<void>;
  /** Send a detail string to the Slack run card (throttled by caller). */
  onDetail?: (detail: string) => Promise<void>;
  /** Persist token usage immediately after each successful AI response. */
  recordTokenUsage?: (entry: TokenUsageIncrement) => Promise<void>;
  /** When set, shell commands route through this Docker sandbox container. */
  sandboxId?: string;
  /** Request deferred sandbox creation with a specific image. Used by setup_sandbox node. */
  requestSandbox?: (image: string) => Promise<void>;
  /** Container manager reference for image resolution (build/check). */
  containerManager?: import("../sandbox/container-manager.js").ContainerManager;
}

export type NodeHandler = (
  nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
) => Promise<NodeResult>;

// ── Pipeline events (JSONL) ──

export type PipelineEventType = "node_start" | "node_end" | "phase_change" | "artifact" | "error";

export interface PipelineEvent {
  type: PipelineEventType;
  timestamp: string;
  nodeId?: string;
  phase?: string;
  outcome?: string;
  durationMs?: number;
  error?: string;
  artifact?: string;
}

// ── Node event callbacks (real-time monitoring) ──

export interface NodeEvent {
  runId: string;
  nodeId: string;
  action: string;
  type: "start" | "end";
  outcome?: NodeOutcome;
  durationMs?: number;
  error?: string;
}

export type NodeEventListener = (event: NodeEvent) => void;

// ── Pipeline result ──

export interface PipelineStepResult {
  nodeId: string;
  outcome: NodeOutcome;
  durationMs: number;
  error?: string;
}

export interface PipelineResult {
  outcome: "success" | "failure" | "completed_with_warnings";
  steps: PipelineStepResult[];
  warnings: string[];
}
