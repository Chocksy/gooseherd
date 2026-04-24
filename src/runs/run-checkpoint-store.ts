import { asc, eq, isNull, and } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { runCheckpoints } from "../db/schema.js";
import { normalizeRunCheckpointEmittedAt, type RunCheckpointRecord, type RunCheckpointType } from "./run-checkpoints.js";

type RunCheckpointRow = typeof runCheckpoints.$inferSelect;

export interface EmitRunCheckpointInput {
  runId: string;
  checkpointKey: string;
  checkpointType: RunCheckpointType;
  payload?: Record<string, unknown>;
  emittedAt?: string;
}

function rowToRecord(row: RunCheckpointRow): RunCheckpointRecord {
  return {
    runId: row.runId,
    checkpointKey: row.checkpointKey,
    checkpointType: row.checkpointType as RunCheckpointType,
    payload: row.payload ?? {},
    emittedAt: row.emittedAt.toISOString(),
    processedAt: row.processedAt?.toISOString(),
    processedError: row.processedError ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class RunCheckpointStore {
  constructor(private readonly db: Database) {}

  async emit(input: EmitRunCheckpointInput): Promise<{ inserted: boolean; checkpoint: RunCheckpointRecord }> {
    const now = new Date();
    const normalizedEmittedAt = normalizeRunCheckpointEmittedAt(input.emittedAt);
    const emittedAt = normalizedEmittedAt ? new Date(normalizedEmittedAt) : now;
    const inserted = await this.db
      .insert(runCheckpoints)
      .values({
        runId: input.runId,
        checkpointKey: input.checkpointKey,
        checkpointType: input.checkpointType,
        payload: input.payload ?? {},
        emittedAt,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [runCheckpoints.runId, runCheckpoints.checkpointKey],
      })
      .returning();

    const row = inserted[0] ?? await this.get(input.runId, input.checkpointKey);
    if (!row) {
      throw new Error(`Run checkpoint missing after emit: ${input.runId}/${input.checkpointKey}`);
    }
    return { inserted: inserted.length > 0, checkpoint: rowToRecord(row) };
  }

  async markProcessed(runId: string, checkpointKey: string): Promise<void> {
    await this.db
      .update(runCheckpoints)
      .set({
        processedAt: new Date(),
        processedError: null,
        updatedAt: new Date(),
      })
      .where(and(eq(runCheckpoints.runId, runId), eq(runCheckpoints.checkpointKey, checkpointKey)));
  }

  async markProcessingError(runId: string, checkpointKey: string, error: string): Promise<void> {
    await this.db
      .update(runCheckpoints)
      .set({
        processedError: error,
        updatedAt: new Date(),
      })
      .where(and(eq(runCheckpoints.runId, runId), eq(runCheckpoints.checkpointKey, checkpointKey)));
  }

  async hasCheckpoint(runId: string, checkpointKey: string): Promise<boolean> {
    const row = await this.get(runId, checkpointKey);
    return row !== undefined;
  }

  async listUnprocessed(limit = 500): Promise<RunCheckpointRecord[]> {
    const rows = await this.db
      .select()
      .from(runCheckpoints)
      .where(isNull(runCheckpoints.processedAt))
      .orderBy(asc(runCheckpoints.emittedAt))
      .limit(Math.max(1, Math.min(limit, 1000)));
    return rows.map(rowToRecord);
  }

  private async get(runId: string, checkpointKey: string): Promise<RunCheckpointRow | undefined> {
    const rows = await this.db
      .select()
      .from(runCheckpoints)
      .where(and(eq(runCheckpoints.runId, runId), eq(runCheckpoints.checkpointKey, checkpointKey)))
      .limit(1);
    return rows[0];
  }
}
