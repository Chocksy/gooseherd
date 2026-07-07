import type { RunRecord, RunStatus } from "../types.js";
import type { RunStore } from "../store.js";
import type { ControlPlaneStore } from "./control-plane-store.js";
import type { RunCompletionRecord } from "./control-plane-types.js";
import type { TerminalFact } from "./terminal-fact.js";
import type { RunCheckpointProcessor } from "../runs/run-checkpoint-processor.js";
import type { RunCheckpointStore } from "../runs/run-checkpoint-store.js";
import { isRunCheckpointType, normalizeRunCheckpointEmittedAt } from "../runs/run-checkpoints.js";
import { isFeatureDeliveryAutoReviewOrRepairCiRun } from "../runs/run-intent.js";
import { isRecord } from "../utils/type-guards.js";
import { sleep } from "../utils/sleep.js";
import { logError } from "../logger.js";

interface RuntimeFactsReader {
  getTerminalFact(runId: string): Promise<TerminalFact>;
}

/**
 * How long the reconciler will re-poll for a completion record after seeing a
 * terminal runtime fact before declaring it genuinely missing, and how often it
 * polls within that window. The runner posts its completion callback over HTTP
 * as its final step, so the record can lag the job/pod reaching a terminal state
 * (and a server restart can race the callback). Mirrors the live backend's
 * completion grace window. Overridable in tests to keep them fast.
 */
export interface RuntimeReconcilerOptions {
  completionGraceMs?: number;
  completionPollMs?: number;
}

const DEFAULT_COMPLETION_GRACE_MS = 15_000;
const DEFAULT_COMPLETION_POLL_MS = 1_500;

function isTerminalRunStatus(status: RunStatus | undefined): boolean {
  return status === "failed" || status === "completed" || status === "cancelled";
}

function isTerminalFact(fact: TerminalFact): boolean {
  return fact === "succeeded" || fact === "failed" || fact === "missing";
}

export class RuntimeReconciler {
  private readonly completionGraceMs: number;
  private readonly completionPollMs: number;

  constructor(
    private readonly controlPlaneStore: Pick<ControlPlaneStore, "getLatestCompletion" | "listEventsAfterSequence">,
    private readonly runtimeFacts: RuntimeFactsReader,
    private readonly runStore: RunStore,
    private readonly checkpointStore?: RunCheckpointStore,
    private readonly checkpointProcessor?: RunCheckpointProcessor,
    options?: RuntimeReconcilerOptions,
  ) {
    this.completionGraceMs = Math.max(0, options?.completionGraceMs ?? DEFAULT_COMPLETION_GRACE_MS);
    this.completionPollMs = Math.max(1, options?.completionPollMs ?? DEFAULT_COMPLETION_POLL_MS);
  }

  async reconcileRun(runId: string): Promise<void> {
    await this.drainCheckpointEvents(runId);
    let completion = await this.controlPlaneStore.getLatestCompletion(runId);
    const run = await this.runStore.getRun(runId);

    if (!run) {
      return;
    }

    if (!completion && isTerminalRunStatus(run.status)) {
      return;
    }

    const fact = await this.runtimeFacts.getTerminalFact(runId);

    if (run.status === "cancel_requested" && fact !== "running") {
      await this.runStore.updateRun(runId, {
        status: "cancelled",
        phase: "cancelled",
        finishedAt: new Date().toISOString(),
        error: run.error,
      });
      return;
    }

    if (run.status === "cancelled" && fact !== "running" && !completion) {
      return;
    }

    // Terminal runtime but no completion yet: the completion callback can lag the
    // pod reaching a terminal state, so re-poll for a bounded grace window before
    // declaring it missing. This never delays the happy path (completion already
    // present) or a still-running job.
    if (!completion && isTerminalFact(fact)) {
      completion = await this.waitForLateCompletion(runId);
    }

    if (completion && (await this.applyCompletion(runId, run, completion, fact))) {
      return;
    }

    if (!completion && isTerminalFact(fact)) {
      await this.runStore.updateRun(runId, {
        status: "failed",
        phase: "failed",
        finishedAt: new Date().toISOString(),
        error: await this.buildMissingCompletionDiagnostic(runId, fact),
      });
    }
  }

  /**
   * Apply a present completion record against the observed runtime fact. Returns
   * true when it finalized the run (so the caller stops), false when the
   * completion/fact combination is not itself terminal (e.g. a success
   * completion while the job still reads as running).
   */
  private async applyCompletion(
    runId: string,
    run: RunRecord,
    completion: RunCompletionRecord,
    fact: TerminalFact,
  ): Promise<boolean> {
    if (completion.payload.status === "success" && fact === "failed") {
      await this.runStore.updateRun(runId, {
        status: "failed",
        phase: "failed",
        finishedAt: new Date().toISOString(),
        error: "success completion contradicted by runtime state",
      });
      return true;
    }

    if (completion.payload.status === "success" && (fact === "succeeded" || fact === "missing")) {
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
      await this.maybeEmitTerminalProgressCheckpoint(run, completion.payload);
      return true;
    }

    if (completion.payload.status === "failed" && fact !== "running") {
      await this.runStore.updateRun(runId, {
        status: "failed",
        phase: "failed",
        finishedAt: new Date().toISOString(),
        error: completion.payload.reason ?? "runtime reported failed completion",
        internalArtifacts: completion.payload.internalArtifacts,
      });
      return true;
    }

    return false;
  }

  private async waitForLateCompletion(runId: string): Promise<RunCompletionRecord | null> {
    const deadline = Date.now() + this.completionGraceMs;
    while (Date.now() < deadline) {
      await sleep(Math.min(this.completionPollMs, Math.max(1, deadline - Date.now())));
      const completion = await this.controlPlaneStore.getLatestCompletion(runId);
      if (completion) {
        return completion;
      }
    }
    return null;
  }

  /**
   * Build a diagnostic for a run whose pod reached a terminal state without a
   * completion record. The `run.completion_attempted` event distinguishes a lost
   * callback (runner tried to report, control plane never stored it) from a pod
   * that died before it could report (OOMKill/eviction/node loss/hard crash).
   */
  private async buildMissingCompletionDiagnostic(runId: string, fact: TerminalFact): Promise<string> {
    const prefix = `completion missing after terminal runtime state (job ${fact})`;
    let attempt: { status?: string; reason?: string } | undefined;
    try {
      const events = await this.controlPlaneStore.listEventsAfterSequence(runId, 0);
      for (const event of events) {
        if (event.eventType === "run.completion_attempted") {
          const status = typeof event.payload.status === "string" ? event.payload.status : undefined;
          const reason = typeof event.payload.reason === "string" ? event.payload.reason : undefined;
          attempt = { status, reason };
        }
      }
    } catch (error) {
      logError("Failed to read completion-attempt events during reconcile", {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (attempt) {
      const attemptStatus = attempt.status ?? "unknown";
      const runnerError = attempt.reason ? `; runner error: ${attempt.reason}` : "";
      return `${prefix}: runner reported a ${attemptStatus} completion attempt but the control plane never recorded it — likely a lost completion callback${runnerError}.`;
    }

    return `${prefix}: runner pod terminated before reporting completion — possible OOMKill, eviction, node loss, or hard crash.`;
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
