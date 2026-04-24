import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../src/db/index.js";
import { runCheckpoints, runs } from "../src/db/schema.js";
import { RunCheckpointStore } from "../src/runs/run-checkpoint-store.js";

async function insertRun(db: Database, runId: string): Promise<void> {
  await db.insert(runs).values({
    id: runId,
    runtime: "local",
    status: "running",
    phase: "agent",
    repoSlug: "owner/repo",
    task: "checkpoint test",
    baseBranch: "main",
    branchName: "goose/checkpoint-test",
    requestedBy: "U1",
    channelId: "C1",
    threadTs: runId,
  });
}

test("RunCheckpointStore emits checkpoints idempotently and tracks processing state", async (t) => {
  const { db, cleanup } = await createTestDb();
  t.after(cleanup);
  const store = new RunCheckpointStore(db);
  const runId = "11111111-1111-1111-1111-111111111111";
  await insertRun(db, runId);

  const first = await store.emit({
    runId,
    checkpointKey: "external_ci_wait_started",
    checkpointType: "run.waiting_external_ci",
    payload: { source: "test" },
  });
  const second = await store.emit({
    runId,
    checkpointKey: "external_ci_wait_started",
    checkpointType: "run.waiting_external_ci",
    payload: { source: "duplicate" },
  });

  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  assert.deepEqual(second.checkpoint.payload, { source: "test" });

  let pending = await store.listUnprocessed();
  assert.equal(pending.length, 1);

  await store.markProcessingError(runId, "external_ci_wait_started", "temporary");
  const rowsAfterError = await db
    .select()
    .from(runCheckpoints)
    .where(eq(runCheckpoints.runId, runId));
  assert.equal(rowsAfterError[0]?.processedError, "temporary");
  assert.equal(rowsAfterError[0]?.processedAt, null);

  await store.markProcessed(runId, "external_ci_wait_started");
  pending = await store.listUnprocessed();
  assert.equal(pending.length, 0);

  const rowsAfterProcessed = await db
    .select()
    .from(runCheckpoints)
    .where(eq(runCheckpoints.runId, runId));
  assert.ok(rowsAfterProcessed[0]?.processedAt);
  assert.equal(rowsAfterProcessed[0]?.processedError, null);
  assert.equal(await store.hasCheckpoint(runId, "external_ci_wait_started"), true);
});
