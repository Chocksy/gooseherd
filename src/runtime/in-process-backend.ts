import type { PipelineEngine } from "../pipeline/pipeline-engine.js";
import type { ExecutionResult, RunRecord } from "../types.js";
import type { RunExecutionBackend, RunExecutionContext } from "./backend.js";

export class InProcessExecutionBackend<Runtime extends "local" | "docker"> implements RunExecutionBackend<Runtime> {
  constructor(
    readonly runtime: Runtime,
    private readonly pipelineEngine: PipelineEngine,
  ) {}

  execute(run: RunRecord & { runtime: Runtime }, ctx: RunExecutionContext): Promise<ExecutionResult> {
    return this.pipelineEngine.execute(
      run,
      ctx.onPhase,
      ctx.pipelineFile,
      ctx.onDetail,
      run.skipNodes,
      run.enableNodes,
      ctx.abortSignal,
      ctx.recordTokenUsage,
      ctx.onCheckpoint,
    );
  }
}
