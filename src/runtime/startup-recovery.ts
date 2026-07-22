import type { RunRecord } from "../types.js";

interface StartupRecoveryStore {
  recoverInProgressRuns(reason: string): Promise<RunRecord[]>;
  getInProgressRuns(): Promise<RunRecord[]>;
}

interface StartupRecoveryRunManager {
  requeueExistingRun(runId: string): void;
}

interface StartupRecoveryReconciler {
  reconcileRun(runId: string, options?: { completionGraceMs?: number }): Promise<void>;
}

export async function recoverRunsAfterRestart(
  store: StartupRecoveryStore,
  runManager: StartupRecoveryRunManager,
  runtimeReconciler: StartupRecoveryReconciler,
  reason: string,
): Promise<{
  recoveredRuns: RunRecord[];
  kubernetesRuns: RunRecord[];
  requeuedCount: number;
  skippedLocalCount: number;
}> {
  const recoveredRuns = await store.recoverInProgressRuns(reason);
  let requeuedCount = 0;
  let skippedLocalCount = 0;

  for (const run of recoveredRuns) {
    if (run.channelId === "local") {
      skippedLocalCount += 1;
      continue;
    }

    runManager.requeueExistingRun(run.id);
    requeuedCount += 1;
  }

  const kubernetesRuns = (await store.getInProgressRuns())
    .filter((run) => run.runtime === "kubernetes");
  // No completion grace here: this runs before the HTTP listener is up, so a late
  // completion callback cannot arrive during the wait — it would only delay boot
  // (and /healthz) by the full grace window per Promise.all.
  await Promise.all(kubernetesRuns.map(async (run) => runtimeReconciler.reconcileRun(run.id, { completionGraceMs: 0 })));

  return {
    recoveredRuns,
    kubernetesRuns,
    requeuedCount,
    skippedLocalCount,
  };
}
