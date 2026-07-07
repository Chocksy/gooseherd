/**
 * Slot pool for per-Run isolated test databases (PG/CH/Redis).
 *
 * Backed by the `runner_db_slots` table — one row per slot id, status
 * `free` or `claimed`. acquire is atomic via UPDATE … FOR UPDATE SKIP
 * LOCKED RETURNING, so concurrent orchestrators can't collide on the
 * same slot. The slot id doubles as the Redis logical-DB index and as
 * the suffix in `goose_<slot>` PG/CH database names.
 */

import { and, eq, lt, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { runnerDbSlots } from "../db/schema.js";
import { logInfo, logWarn } from "../logger.js";

export interface RunnerDbSlot {
  id: number;
  runId: string | null;
  claimedAt: Date | null;
}

export class RunnerDbSlotStore {
  constructor(private readonly db: Database) {}

  async acquire(runId: string): Promise<number | null> {
    const rows = await this.db.execute<{ id: number }>(sql`
      UPDATE ${runnerDbSlots}
         SET status = 'claimed',
             run_id = ${runId}::uuid,
             claimed_at = now()
       WHERE id = (
         SELECT id FROM ${runnerDbSlots}
          WHERE status = 'free'
          ORDER BY id
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
       RETURNING id
    `);

    const slotId = rows[0]?.id;
    if (slotId === undefined) {
      return null;
    }

    logInfo("runner-db-slot: acquired", { runId, slotId });
    return slotId;
  }

  async release(slotId: number): Promise<void> {
    await this.db
      .update(runnerDbSlots)
      .set({ status: "free", runId: null, claimedAt: null })
      .where(eq(runnerDbSlots.id, slotId));
    logInfo("runner-db-slot: released", { slotId });
  }

  async getSlotForRun(runId: string): Promise<number | null> {
    const rows = await this.db
      .select({ id: runnerDbSlots.id })
      .from(runnerDbSlots)
      .where(eq(runnerDbSlots.runId, runId))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  /**
   * Find slots claimed earlier than `cutoff`. Caller is responsible for
   * tearing down the underlying DBs and then calling release().
   */
  async findOrphans(cutoff: Date): Promise<RunnerDbSlot[]> {
    const rows = await this.db
      .select({
        id: runnerDbSlots.id,
        runId: runnerDbSlots.runId,
        claimedAt: runnerDbSlots.claimedAt,
      })
      .from(runnerDbSlots)
      .where(and(eq(runnerDbSlots.status, "claimed"), lt(runnerDbSlots.claimedAt, cutoff)));
    if (rows.length > 0) {
      logWarn("runner-db-slot: found orphans", { count: rows.length, cutoff: cutoff.toISOString() });
    }
    return rows;
  }
}
