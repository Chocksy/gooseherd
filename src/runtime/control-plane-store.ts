import { createHash, randomBytes } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { runArtifacts, runCompletions, runEvents, runPayloads, runTokens, runs } from "../db/schema.js";
import type {
  CreateRunEnvelopeInput,
  IssuedRunToken,
  RunCompletionRecord,
  RunEnvelope,
  RunnerCompletionPayload,
  RunnerEventPayload,
} from "./control-plane-types.js";

type PayloadRow = typeof runPayloads.$inferSelect;
type CompletionRow = typeof runCompletions.$inferSelect;

function toRunEnvelope(row: PayloadRow): RunEnvelope {
  return {
    runId: row.runId,
    payloadRef: row.payloadRef,
    payloadJson: row.payloadJson as RunEnvelope["payloadJson"],
    runtime: row.runtime as RunEnvelope["runtime"],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function asJsonRecord(value: object): Record<string, unknown> {
  return { ...value };
}

function toCompletionRecord(row: CompletionRow): RunCompletionRecord {
  return {
    id: row.id,
    runId: row.runId,
    idempotencyKey: row.idempotencyKey,
    payload: row.payload as unknown as RunnerCompletionPayload,
    createdAt: row.createdAt.toISOString(),
  };
}

export class ControlPlaneConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlPlaneConflictError";
  }
}

export class ControlPlaneStore {
  constructor(private readonly db: Database) {}

  async createRunEnvelope(input: CreateRunEnvelopeInput): Promise<RunEnvelope> {
    const now = new Date();
    const inserted = await this.db
      .insert(runPayloads)
      .values({
        runId: input.runId,
        payloadRef: input.payloadRef,
        payloadJson: input.payloadJson,
        runtime: input.runtime,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: runPayloads.runId,
        set: {
          payloadRef: input.payloadRef,
          payloadJson: input.payloadJson,
          runtime: input.runtime,
          updatedAt: now,
        },
      })
      .returning();
    return toRunEnvelope(inserted[0]!);
  }

  async issueRunToken(runId: string): Promise<IssuedRunToken> {
    const now = new Date();
    const token = randomBytes(24).toString("hex");
    const tokenHash = hashToken(token);
    await this.db
      .insert(runTokens)
      .values({
        runId,
        tokenHash,
        issuedAt: now,
        usedAt: null,
      })
      .onConflictDoUpdate({
        target: runTokens.runId,
        set: {
          tokenHash,
          issuedAt: now,
          usedAt: null,
        },
      });
    return { token };
  }

  async recordCompletion(runId: string, payload: RunnerCompletionPayload): Promise<RunCompletionRecord> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${runId}))`);

      const existingForRun = await tx
        .select()
        .from(runCompletions)
        .where(eq(runCompletions.runId, runId))
        .limit(1);
      const existing = existingForRun[0];
      if (existing) {
        if (existing.idempotencyKey === payload.idempotencyKey) {
          return toCompletionRecord(existing);
        }
        throw new ControlPlaneConflictError(`Completion already recorded for run ${runId}`);
      }

      const inserted = await tx
        .insert(runCompletions)
        .values({
          runId,
          idempotencyKey: payload.idempotencyKey,
          status: payload.status,
          payload: asJsonRecord(payload),
        })
        .returning();
      const created = inserted[0];
      if (!created) {
        throw new Error(`Completion insert failed for run ${runId}`);
      }

      const now = new Date();
      await tx
        .insert(runArtifacts)
        .values({
          runId,
          artifactKey: "result",
          artifactClass: "completion",
          status: payload.artifactState,
          metadata: asJsonRecord(payload),
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [runArtifacts.runId, runArtifacts.artifactKey],
          set: {
            artifactClass: "completion",
            status: payload.artifactState,
            metadata: asJsonRecord(payload),
            updatedAt: now,
          },
        });

      return toCompletionRecord(created);
    });
  }

  async appendEvent(runId: string, event: RunnerEventPayload): Promise<void> {
    await this.db.insert(runEvents).values({
      runId,
      eventId: event.eventId,
      sequence: event.sequence,
      eventType: event.eventType,
      timestamp: new Date(event.timestamp),
      payload: event.payload ?? {},
    }).onConflictDoNothing({
      target: [runEvents.runId, runEvents.eventId],
    });
  }

  async upsertArtifact(
    runId: string,
    artifactKey: string,
    artifactClass: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const now = new Date();
    await this.db
      .insert(runArtifacts)
      .values({
        runId,
        artifactKey,
        artifactClass,
        status: "pending",
        metadata: asJsonRecord(metadata),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [runArtifacts.runId, runArtifacts.artifactKey],
        set: {
          artifactClass,
          status: "pending",
          metadata: asJsonRecord(metadata),
          updatedAt: now,
        },
      });
  }

  async getPayload(runId: string): Promise<RunEnvelope | null> {
    const rows = await this.db.select().from(runPayloads).where(eq(runPayloads.runId, runId)).limit(1);
    const row = rows[0];
    return row ? toRunEnvelope(row) : null;
  }

  async getLatestCompletion(runId: string): Promise<RunCompletionRecord | null> {
    const rows = await this.db
      .select()
      .from(runCompletions)
      .where(eq(runCompletions.runId, runId))
      .orderBy(desc(runCompletions.createdAt), desc(runCompletions.id))
      .limit(1);
    const row = rows[0];
    return row ? toCompletionRecord(row) : null;
  }

  async getCancellationState(runId: string): Promise<{ cancelRequested: boolean }> {
    const rows = await this.db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).limit(1);
    return { cancelRequested: rows[0]?.status === "cancel_requested" };
  }

  async validateRunToken(runId: string, token: string): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(runTokens)
      .where(eq(runTokens.runId, runId))
      .limit(1);
    const row = rows[0];
    if (!row || row.usedAt) {
      return false;
    }
    return row.tokenHash === hashToken(token);
  }
}
