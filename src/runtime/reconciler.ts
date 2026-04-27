import type { RunStore } from "../store.js";
import type { ControlPlaneStore } from "./control-plane-store.js";
import type { TerminalFact } from "./terminal-fact.js";
import type { RunCheckpointProcessor } from "../runs/run-checkpoint-processor.js";
import type { RunCheckpointStore } from "../runs/run-checkpoint-store.js";
import { isRunCheckpointType, normalizeRunCheckpointEmittedAt } from "../runs/run-checkpoints.js";
import { isFeatureDeliveryAutoReviewOrRepairCiRun } from "../runs/run-intent.js";
import { isRecord } from "../utils/type-guards.js";
import { logError } from "../logger.js";

interface RuntimeFactsReader {
  getTerminalFact(runId: string): Promise<TerminalFact>;
}

export class RuntimeReconciler {
  constructor(
    private readonly controlPlaneStore: Pick<ControlPlaneStore, "getLatestCompletion" | "listEventsAfterSequence">,
    private readonly runtimeFacts: RuntimeFactsReader,
    private readonly runStore: RunStore,
    private readonly checkpointStore?: RunCheckpointStore,
    private readonly checkpointProcessor?: RunCheckpointProcessor,
  ) {}

  async reconcileRun(runId: string): Promise<void> {
    await this.drainCheckpointEvents(runId);
    const completion = await this.controlPlaneStore.getLatestCompletion(runId);
    const fact = await this.runtimeFacts.getTerminalFact(runId);
    const run = await this.runStore.getRun(runId);
    const terminalWithoutCompletion = !completion && (fact === "succeeded" || fact === "failed" || fact === "missing");

    if (run?.status === "cancel_requested" && fact !== "running") {
      await this.runStore.updateRun(runId, {
        status: "cancelled",
        phase: "cancelled",
        finishedAt: new Date().toISOString(),
        error: run.error,
      });
      return;
    }

    if (run?.status === "cancelled" && fact !== "running" && !completion) {
      return;
    }

    if (completion?.payload.status === "success" && fact === "failed") {
      await this.runStore.updateRun(runId, {
        status: "failed",
        phase: "failed",
        finishedAt: new Date().toISOString(),
        error: "success completion contradicted by runtime state",
      });
      return;
    }

    if (completion?.payload.status === "success" && (fact === "succeeded" || fact === "missing")) {
      await this.runStore.updateRun(runId, {
        status: "completed",
        phase: "completed",
        finishedAt: new Date().toISOString(),
        commitSha: completion.payload.commitSha,
        changedFiles: completion.payload.changedFiles,
        internalArtifacts: completion.payload.internalArtifacts,
        prUrl: completion.payload.prUrl,
        prNumber: completion.payload.prNumber,
        tokenUsage: completion.payload.tokenUsage,
        title: completion.payload.title,
      });
      if (run) {
        await this.maybeEmitTerminalProgressCheckpoint(run, completion.payload);
      }
      return;
    }

    if (completion?.payload.status === "failed" && fact !== "running") {
      await this.runStore.updateRun(runId, {
        status: "failed",
        phase: "failed",
        finishedAt: new Date().toISOString(),
        error: completion.payload.reason ?? "runtime reported failed completion",
        internalArtifacts: completion.payload.internalArtifacts,
      });
      return;
    }

    if (terminalWithoutCompletion) {
      await this.runStore.updateRun(runId, {
        status: "failed",
        phase: "failed",
        finishedAt: new Date().toISOString(),
        error: "completion missing after terminal runtime state",
      });
    }
  }

  private async drainCheckpointEvents(runId: string): Promise<void> {
    if (!this.checkpointStore) {
      return;
    }

    const events = await this.controlPlaneStore.listEventsAfterSequence(runId, 0);
    for (const event of events) {
      if (event.eventType !== "run.checkpoint") {
        continue;
      }

      const { checkpointKey, checkpointType, payload, emittedAt } = event.payload;
      if (typeof checkpointKey !== "string" || typeof checkpointType !== "string" || !isRunCheckpointType(checkpointType)) {
        continue;
      }

      await this.emitAndProcessCheckpoint({
        runId,
        checkpointKey,
        checkpointType,
        payload: isRecord(payload) ? payload : undefined,
        emittedAt: normalizeRunCheckpointEmittedAt(emittedAt, event.timestamp),
      });
    }
  }

  private async maybeEmitTerminalProgressCheckpoint(
    run: Awaited<ReturnType<RunStore["getRun"]>> & {},
    completion: NonNullable<Awaited<ReturnType<ControlPlaneStore["getLatestCompletion"]>>>["payload"],
  ): Promise<void> {
    if (!this.checkpointStore || !run || !isFeatureDeliveryAutoReviewOrRepairCiRun(run)) {
      return;
    }
    if (await this.checkpointStore.hasCheckpoint(run.id, "external_ci_wait_started")) {
      return;
    }

    await this.emitAndProcessCheckpoint({
      runId: run.id,
      checkpointKey: "terminal_progress_without_external_wait",
      checkpointType: "run.completed_without_external_wait",
      payload: {
        reason: "reconciled_completed_without_external_ci_wait",
        commitSha: completion.commitSha,
        changedFiles: completion.changedFiles,
      },
    });
  }

  private async emitAndProcessCheckpoint(input: Parameters<RunCheckpointStore["emit"]>[0]): Promise<void> {
    if (!this.checkpointStore) {
      return;
    }

    const emitted = await this.checkpointStore.emit(input);
    if (!this.checkpointProcessor || (!emitted.inserted && emitted.checkpoint.processedAt)) {
      return;
    }

    try {
      await this.checkpointProcessor.process(emitted.checkpoint);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError("Failed to process reconciled run checkpoint", {
        runId: input.runId,
        checkpointKey: input.checkpointKey,
        error: message,
      });
    }
  }
}
