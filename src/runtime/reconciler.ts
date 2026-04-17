import type { RunStore } from "../store.js";
import type { ControlPlaneStore } from "./control-plane-store.js";
import type { TerminalFact } from "./terminal-fact.js";

interface RuntimeFactsReader {
  getTerminalFact(runId: string): Promise<TerminalFact>;
}

export class RuntimeReconciler {
  constructor(
    private readonly controlPlaneStore: Pick<ControlPlaneStore, "getLatestCompletion">,
    private readonly runtimeFacts: RuntimeFactsReader,
    private readonly runStore: RunStore,
  ) {}

  async reconcileRun(runId: string): Promise<void> {
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

    if (completion?.payload.status === "success" && fact !== "succeeded" && fact !== "running") {
      await this.runStore.updateRun(runId, {
        status: "failed",
        phase: "failed",
        finishedAt: new Date().toISOString(),
        error: "success completion contradicted by runtime state",
      });
      return;
    }

    if (completion?.payload.status === "success" && fact === "succeeded") {
      await this.runStore.updateRun(runId, {
        status: "completed",
        phase: "completed",
        finishedAt: new Date().toISOString(),
        commitSha: completion.payload.commitSha,
        changedFiles: completion.payload.changedFiles,
        internalArtifacts: completion.payload.internalArtifacts,
        prUrl: completion.payload.prUrl,
        tokenUsage: completion.payload.tokenUsage,
        title: completion.payload.title,
      });
      return;
    }

    if (completion?.payload.status === "failed" && fact !== "running") {
      await this.runStore.updateRun(runId, {
        status: "failed",
        phase: "failed",
        finishedAt: new Date().toISOString(),
        error: completion.payload.reason ?? "runtime reported failed completion",
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
}
