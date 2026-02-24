import type { AppConfig } from "../config.js";
import type { RunRecord } from "../types.js";
import type { GitHubService } from "../github.js";
import type { RunLifecycleHooks } from "../hooks/run-lifecycle.js";
import type { ContextBag } from "./context-bag.js";

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
}

export type NodeHandler = (
  nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
) => Promise<NodeResult>;

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
