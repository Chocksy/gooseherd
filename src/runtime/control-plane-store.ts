import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { runArtifacts, runCompletions, runEvents, runPayloads, runTokens, runs } from "../db/schema.js";
import { safeTokenCompare } from "../dashboard/auth.js";
import type {
  CreateRunEnvelopeInput,
  IssuedRunToken,
  RunCompletionRecord,
  RunEnvelope,
  RunEventRecord,
  RunnerCompletionPayload,
  RunnerEventPayload,
} from "./control-plane-types.js";

type PayloadRow = typeof runPayloads.$inferSelect;
type CompletionRow = typeof runCompletions.$inferSelect;
type TokenRow = typeof runTokens.$inferSelect;
type EventRow = typeof runEvents.$inferSelect;

const RUN_TOKEN_CACHE_TTL_MS = 60_000;
const DEFAULT_RUN_TOKEN_TTL_MS = 20 * 60 * 1_000;

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

function toRunEventRecord(row: EventRow): RunEventRecord {
  return {
    runId: row.runId,
    eventId: row.eventId,
    eventType: row.eventType as RunEventRecord["eventType"],
    timestamp: row.timestamp.toISOString(),
    sequence: row.sequence,
    payload: row.payload ?? {},
  };
}

export class ControlPlaneConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlPlaneConflictError";
  }
}

export class ControlPlaneStore {
  private readonly tokenCache = new Map<string, {
    tokenHash: string;
    expiresAt: number;
    usedAt: Date | null;
    cachedAt: number;
  }>();

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
      .onConflictDoNothing({
        target: runPayloads.runId,
      })
      .returning();
    if (inserted[0]) {
      return toRunEnvelope(inserted[0]);
    }

    const existing = await this.getPayload(input.runId);
    if (!existing) {
      throw new Error(`Run payload missing after insert conflict for ${input.runId}`);
    }
    return existing;
  }

  async issueRunToken(runId: string, ttlMs = DEFAULT_RUN_TOKEN_TTL_MS): Promise<IssuedRunToken> {
    const now = new Date();
    const token = randomBytes(24).toString("hex");
    const tokenHash = hashToken(token);
    const expiresAt = new Date(now.getTime() + Math.max(1, ttlMs));
    const inserted = await this.db
      .insert(runTokens)
      .values({
        runId,
        tokenHash,
        issuedAt: now,
        usedAt: null,
        expiresAt,
      })
      .onConflictDoNothing({
        target: runTokens.runId,
      })
      .returning({ runId: runTokens.runId });
    if (inserted.length === 0) {
      throw new ControlPlaneConflictError(`Run token already issued for run ${runId}`);
    }
    this.tokenCache.delete(runId);
    return { token };
  }

  async revokeRunToken(runId: string): Promise<void> {
    await this.db.delete(runTokens).where(eq(runTokens.runId, runId));
    this.tokenCache.delete(runId);
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

  async listEventsAfterSequence(runId: string, afterSequence: number): Promise<RunEventRecord[]> {
    const rows = await this.db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), sql`${runEvents.sequence} > ${afterSequence}`))
      .orderBy(runEvents.sequence);
    return rows.map(toRunEventRecord);
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

  async getArtifact(runId: string, artifactKey: string): Promise<{
    artifactKey: string;
    artifactClass: string;
    status: string;
    metadata: Record<string, unknown>;
  } | null> {
    const rows = await this.db
      .select({
        artifactKey: runArtifacts.artifactKey,
        artifactClass: runArtifacts.artifactClass,
        status: runArtifacts.status,
        metadata: runArtifacts.metadata,
      })
      .from(runArtifacts)
      .where(and(eq(runArtifacts.runId, runId), eq(runArtifacts.artifactKey, artifactKey)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      artifactKey: row.artifactKey,
      artifactClass: row.artifactClass,
      status: row.status,
      metadata: row.metadata as Record<string, unknown>,
    };
  }

  async markArtifactUploaded(
    runId: string,
    artifactKey: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const existing = await this.getArtifact(runId, artifactKey);
    if (!existing) {
      throw new Error(`Artifact ${artifactKey} not found for run ${runId}`);
    }

    await this.db
      .update(runArtifacts)
      .set({
        status: "complete",
        metadata: asJsonRecord({
          ...existing.metadata,
          ...metadata,
        }),
        updatedAt: new Date(),
      })
      .where(and(eq(runArtifacts.runId, runId), eq(runArtifacts.artifactKey, artifactKey)));
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
    const tokenHash = hashToken(token);
    const cached = this.readCachedRunToken(runId);
    if (cached) {
      if (!safeTokenCompare(cached.tokenHash, tokenHash)) {
        return false;
      }
      await this.stampTokenUse(runId, cached.usedAt);
      return true;
    }

    const rows = await this.db.select().from(runTokens).where(eq(runTokens.runId, runId)).limit(1);
    const row = rows[0];
    if (!row || row.expiresAt.getTime() <= Date.now()) {
      this.tokenCache.delete(runId);
      return false;
    }
    if (!safeTokenCompare(row.tokenHash, tokenHash)) {
      return false;
    }

    await this.stampTokenUse(runId, row.usedAt);
    if (!row.usedAt) {
      row.usedAt = new Date();
    }
    this.cacheRunToken(runId, row);
    return true;
  }

  private readCachedRunToken(runId: string): { tokenHash: string; expiresAt: number; usedAt: Date | null; cachedAt: number } | null {
    const cached = this.tokenCache.get(runId);
    if (!cached) {
      return null;
    }
    if (cached.cachedAt + RUN_TOKEN_CACHE_TTL_MS <= Date.now() || cached.expiresAt <= Date.now()) {
      this.tokenCache.delete(runId);
      return null;
    }
    return cached;
  }

  private cacheRunToken(runId: string, row: TokenRow): void {
    this.tokenCache.set(runId, {
      tokenHash: row.tokenHash,
      expiresAt: row.expiresAt.getTime(),
      usedAt: row.usedAt,
      cachedAt: Date.now(),
    });
  }

  private async stampTokenUse(runId: string, usedAt: Date | null): Promise<void> {
    if (usedAt) {
      return;
    }

    const stampedAt = new Date();
    await this.db
      .update(runTokens)
      .set({ usedAt: stampedAt })
      .where(eq(runTokens.runId, runId));

    const cached = this.tokenCache.get(runId);
    if (cached) {
      cached.usedAt = stampedAt;
      cached.cachedAt = Date.now();
    }
  }
}
