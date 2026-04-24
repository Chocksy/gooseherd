import type { ExecutionResult, RunRecord } from "../types.js";
import type { TokenUsageIncrement } from "../types.js";
import type { PipelinePhase } from "../pipeline/pipeline-engine.js";

export interface RunExecutionContext {
  onPhase: (phase: PipelinePhase) => Promise<void>;
  onDetail?: (detail: string) => Promise<void>;
  recordTokenUsage?: (entry: TokenUsageIncrement) => Promise<void>;
  abortSignal?: AbortSignal;
  pipelineFile?: string;
}

export interface RunExecutionBackend<Runtime extends RunRecord["runtime"] = RunRecord["runtime"]> {
  readonly runtime: Runtime;
  execute(run: RunRecord & { runtime: Runtime }, ctx: RunExecutionContext): Promise<ExecutionResult>;
}

export type RuntimeRegistry = {
  [Runtime in RunRecord["runtime"]]: RunExecutionBackend<Runtime> | undefined;
};

export function getRuntimeBackend<Runtime extends RunRecord["runtime"]>(
  runtimeRegistry: RuntimeRegistry,
  runtime: Runtime
): RunExecutionBackend<Runtime> {
  const backend = runtimeRegistry[runtime];
  if (backend) {
    return backend;
  }
  throw new Error(`No execution backend registered for runtime: ${runtime}`);
}
