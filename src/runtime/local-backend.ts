import type { PipelineEngine } from "../pipeline/pipeline-engine.js";
import type { ExecutionResult, RunRecord } from "../types.js";
import type { RunExecutionBackend, RunExecutionContext } from "./backend.js";

export class LocalExecutionBackend implements RunExecutionBackend<"local"> {
  readonly runtime = "local" as const;

  constructor(private readonly pipelineEngine: PipelineEngine) {}

  execute(run: RunRecord & { runtime: "local" }, ctx: RunExecutionContext): Promise<ExecutionResult> {
    return this.pipelineEngine.execute(
      run,
      ctx.onPhase,
      ctx.pipelineFile,
      ctx.onDetail,
      run.skipNodes,
      run.enableNodes,
      ctx.abortSignal
    );
  }
}
