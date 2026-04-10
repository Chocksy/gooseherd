import type { RunStore } from "../store.js";
import type { ControlPlaneStore } from "./control-plane-store.js";

type TerminalFact = "succeeded" | "failed" | "missing" | "running";

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
    const terminalWithoutCompletion = !completion && (fact === "succeeded" || fact === "failed" || fact === "missing");

    if (completion?.payload.status === "success" && fact === "succeeded") {
      await this.runStore.updateRun(runId, {
        status: "completed",
        phase: "completed",
        finishedAt: new Date().toISOString(),
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
