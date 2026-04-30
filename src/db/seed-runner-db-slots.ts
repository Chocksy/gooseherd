import type { Database } from "./index.js";
import { runnerDbSlots } from "./schema.js";
import { SLOT_ID_OFFSET } from "../runtime/runner-db-env.js";

/**
 * Idempotently seeds the runner_db_slots pool. Called once on startup
 * after migrations. Safe to re-run with a different poolSize: existing
 * rows are preserved, missing ids are inserted, surplus ids stay
 * (manual ops job to shrink). ids start at SLOT_ID_OFFSET to leave
 * Redis indexes 0/1 free for system/probing use.
 */
export async function seedRunnerDbSlots(db: Database, poolSize: number): Promise<void> {
  if (poolSize < 1) return;

  const rows = Array.from({ length: poolSize }, (_, i) => ({
    id: SLOT_ID_OFFSET + i,
    status: "free" as const,
  }));

  await db.insert(runnerDbSlots).values(rows).onConflictDoNothing();
}
