/**
 * High-level façade combining slot allocation and DB provisioning. This
 * is what run-manager and the terminal hook actually call — it hides
 * the slot-store / resources / env-vars wiring behind acquireForRun /
 * releaseForRun.
 */

import type { Database } from "../db/index.js";
import { RunnerDbSlotStore } from "./runner-db-slots.js";
import { provisionRunnerDb, teardownRunnerDb } from "./runner-db-resources.js";
import type { RunnerProfile } from "./runner-profile.js";
import { resolveRunnerDbAdminUrls } from "./runner-db-env.js";
import { logError, logInfo, logWarn } from "../logger.js";

export class RunnerDbSlotManager {
  private readonly slots: RunnerDbSlotStore;

  constructor(db: Database) {
    this.slots = new RunnerDbSlotStore(db);
  }

  /**
   * Acquire and provision a slot for a Run. Returns the slot id on
   * success, null when the pool is exhausted (caller should requeue
   * the Run via the existing PQueue path). Throws on real errors so
   * the Run is marked failed by the upstream try/catch.
   */
  async acquireForRun(runId: string, profile: RunnerProfile): Promise<number | null> {
    if (!profile.needsDbSlot) return null;

    const slotId = await this.slots.acquire(runId);
    if (slotId === null) {
      logInfo("runner-db-slot: pool exhausted — Run will be requeued", { runId });
      return null;
    }

    const urls = resolveRunnerDbAdminUrls(profile.adminUrlSuffix);
    try {
      await provisionRunnerDb(slotId, profile, urls);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      logError("runner-db-slot: provision failed — releasing slot", { runId, slotId, error: message });
      await this.slots.release(slotId).catch(() => undefined);
      throw error;
    }
    return slotId;
  }

  async getSlotForRun(runId: string): Promise<number | null> {
    return this.slots.getSlotForRun(runId);
  }

  /**
   * Tear down DBs and release the slot owned by a Run. Idempotent and
   * safe when the Run never acquired one.
   */
  async releaseForRun(runId: string, profile: RunnerProfile): Promise<void> {
    if (!profile.needsDbSlot) return;
    const slotId = await this.slots.getSlotForRun(runId);
    if (slotId === null) return;

    await this.tearDownAndRelease(slotId, profile);
  }

  /**
   * Sweep slots claimed before `cutoff`, force teardown, and release.
   * Called periodically by the orphan sweeper job. The resolver is
   * given the orphan's run id (may be null) and returns the profile to
   * use for teardown — null skips teardown but still releases the slot
   * (manual ops can clean residue).
   */
  async sweepOrphans(
    cutoff: Date,
    resolveProfile: (runId: string | null) => Promise<RunnerProfile | null>,
  ): Promise<void> {
    const orphans = await this.slots.findOrphans(cutoff);
    for (const orphan of orphans) {
      logWarn("runner-db-slot: reclaiming orphan", {
        slotId: orphan.id,
        runId: orphan.runId,
        claimedAt: orphan.claimedAt?.toISOString(),
      });
      const profile = await resolveProfile(orphan.runId);
      if (!profile) {
        await this.slots.release(orphan.id).catch((error) => {
          const message = error instanceof Error ? error.message : "unknown";
          logError("runner-db-slot: orphan release failed", { slotId: orphan.id, error: message });
        });
        continue;
      }
      await this.tearDownAndRelease(orphan.id, profile);
    }
  }

  private async tearDownAndRelease(slotId: number, profile: RunnerProfile): Promise<void> {
    const urls = resolveRunnerDbAdminUrls(profile.adminUrlSuffix);
    try {
      await teardownRunnerDb(slotId, profile, urls);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      logError("runner-db-slot: teardown failed — releasing slot anyway", { slotId, error: message });
    }
    await this.slots.release(slotId).catch((error) => {
      const message = error instanceof Error ? error.message : "unknown";
      logError("runner-db-slot: release failed", { slotId, error: message });
    });
  }
}
