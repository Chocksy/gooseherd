import { RunStore } from "../store.js";
import type { Database } from "../db/index.js";
import { WorkItemOrchestrator, type WorkItemOrchestratorDeps } from "../work-items/orchestrator.js";
import { isFeatureDeliveryAutoReviewOrRepairCiRun } from "./run-intent.js";
import { isFeatureDeliveryProgressCheckpointType, type RunCheckpointRecord } from "./run-checkpoints.js";
import { RunCheckpointStore } from "./run-checkpoint-store.js";
import { logError } from "../logger.js";

export class RunCheckpointProcessor {
  private readonly runs: RunStore;
  private readonly checkpoints: RunCheckpointStore;
  private readonly workItemOrchestrator: WorkItemOrchestrator;

  constructor(
    db: Database,
    deps: WorkItemOrchestratorDeps = {},
    checkpoints?: RunCheckpointStore,
  ) {
    this.runs = new RunStore(db);
    this.checkpoints = checkpoints ?? new RunCheckpointStore(db);
    this.workItemOrchestrator = new WorkItemOrchestrator(db, deps);
  }

  async process(checkpoint: RunCheckpointRecord): Promise<void> {
    try {
      await this.processUnchecked(checkpoint);
      await this.checkpoints.markProcessed(checkpoint.runId, checkpoint.checkpointKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.checkpoints.markProcessingError(checkpoint.runId, checkpoint.checkpointKey, message);
      throw error;
    }
  }

  async processUnprocessed(input: { limit?: number } = {}): Promise<{ processed: number; failed: number }> {
    const checkpoints = await this.checkpoints.listUnprocessed(input.limit);
    let processed = 0;
    let failed = 0;
    for (const checkpoint of checkpoints) {
      try {
        await this.process(checkpoint);
        processed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError("Failed to replay run checkpoint", {
          runId: checkpoint.runId,
          checkpointKey: checkpoint.checkpointKey,
          checkpointType: checkpoint.checkpointType,
          error: message,
        });
        failed += 1;
      }
    }
    return { processed, failed };
  }

  private async processUnchecked(checkpoint: RunCheckpointRecord): Promise<void> {
    const run = await this.runs.getRun(checkpoint.runId);
    if (!run) {
      return;
    }

    if (!isFeatureDeliveryProgressCheckpointType(checkpoint.checkpointType)) {
      return;
    }

    if (!isFeatureDeliveryAutoReviewOrRepairCiRun(run)) {
      return;
    }

    await this.workItemOrchestrator.handleRunProgressCheckpoint(run.id, checkpoint);
  }
}
