import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "./helpers/test-db.js";
import { runnerDbSlots } from "../src/db/schema.js";
import { RunnerDbSlotStore } from "../src/runtime/runner-db-slots.js";
import { seedRunnerDbSlots } from "../src/db/seed-runner-db-slots.js";

const RUN_A = "11111111-1111-1111-1111-111111111111";
const RUN_B = "22222222-2222-2222-2222-222222222222";
const RUN_C = "33333333-3333-3333-3333-333333333333";

test("RunnerDbSlotStore: acquire returns slot id and marks it claimed", async () => {
  const { db, cleanup } = await createTestDb();
  try {
    await seedRunnerDbSlots(db, 3);
    const store = new RunnerDbSlotStore(db);

    const slot = await store.acquire(RUN_A);
    assert.equal(typeof slot, "number");
    assert.equal(slot, 2);

    const row = await db.select().from(runnerDbSlots).where(eq(runnerDbSlots.id, 2));
    assert.equal(row[0]?.status, "claimed");
    assert.equal(row[0]?.runId, RUN_A);
    assert.ok(row[0]?.claimedAt);
  } finally {
    await cleanup();
  }
});

test("RunnerDbSlotStore: acquire hands out distinct ids in order", async () => {
  const { db, cleanup } = await createTestDb();
  try {
    await seedRunnerDbSlots(db, 3);
    const store = new RunnerDbSlotStore(db);

    const a = await store.acquire(RUN_A);
    const b = await store.acquire(RUN_B);
    const c = await store.acquire(RUN_C);

    assert.deepEqual([a, b, c], [2, 3, 4]);
  } finally {
    await cleanup();
  }
});

test("RunnerDbSlotStore: acquire returns null when pool is exhausted", async () => {
  const { db, cleanup } = await createTestDb();
  try {
    await seedRunnerDbSlots(db, 1);
    const store = new RunnerDbSlotStore(db);

    assert.equal(await store.acquire(RUN_A), 2);
    assert.equal(await store.acquire(RUN_B), null);
  } finally {
    await cleanup();
  }
});

test("RunnerDbSlotStore: release frees a slot for re-acquisition", async () => {
  const { db, cleanup } = await createTestDb();
  try {
    await seedRunnerDbSlots(db, 1);
    const store = new RunnerDbSlotStore(db);

    const first = await store.acquire(RUN_A);
    assert.equal(first, 2);
    assert.equal(await store.acquire(RUN_B), null);

    await store.release(2);
    const second = await store.acquire(RUN_B);
    assert.equal(second, 2);
  } finally {
    await cleanup();
  }
});

test("RunnerDbSlotStore: getSlotForRun looks up the slot owned by a run", async () => {
  const { db, cleanup } = await createTestDb();
  try {
    await seedRunnerDbSlots(db, 2);
    const store = new RunnerDbSlotStore(db);

    await store.acquire(RUN_A);
    await store.acquire(RUN_B);

    assert.equal(await store.getSlotForRun(RUN_A), 2);
    assert.equal(await store.getSlotForRun(RUN_B), 3);
    assert.equal(await store.getSlotForRun(RUN_C), null);
  } finally {
    await cleanup();
  }
});

test("RunnerDbSlotStore: parallel acquire never hands the same slot to two runs", async () => {
  const { db, cleanup } = await createTestDb();
  try {
    await seedRunnerDbSlots(db, 5);
    const store = new RunnerDbSlotStore(db);

    const runIds = [
      "aaaaaaaa-0000-0000-0000-000000000001",
      "aaaaaaaa-0000-0000-0000-000000000002",
      "aaaaaaaa-0000-0000-0000-000000000003",
      "aaaaaaaa-0000-0000-0000-000000000004",
      "aaaaaaaa-0000-0000-0000-000000000005",
    ];
    const slots = await Promise.all(runIds.map((r) => store.acquire(r)));
    const filled = slots.filter((s): s is number => s !== null);
    assert.equal(filled.length, 5);
    assert.equal(new Set(filled).size, 5);
  } finally {
    await cleanup();
  }
});

test("RunnerDbSlotStore: findOrphans returns slots claimed before cutoff", async () => {
  const { db, cleanup } = await createTestDb();
  try {
    await seedRunnerDbSlots(db, 2);
    const store = new RunnerDbSlotStore(db);

    await store.acquire(RUN_A);
    await store.acquire(RUN_B);

    const inFuture = new Date(Date.now() + 60_000);
    const orphans = await store.findOrphans(inFuture);
    assert.equal(orphans.length, 2);
    assert.deepEqual(
      orphans.map((o) => o.id).sort((a, b) => a - b),
      [2, 3]
    );

    const inPast = new Date(Date.now() - 60_000);
    const noOrphans = await store.findOrphans(inPast);
    assert.equal(noOrphans.length, 0);
  } finally {
    await cleanup();
  }
});

test("seedRunnerDbSlots: idempotent — re-running preserves existing claims", async () => {
  const { db, cleanup } = await createTestDb();
  try {
    await seedRunnerDbSlots(db, 2);
    const store = new RunnerDbSlotStore(db);
    await store.acquire(RUN_A);

    await seedRunnerDbSlots(db, 4);

    const row = await db.select().from(runnerDbSlots).where(eq(runnerDbSlots.id, 2));
    assert.equal(row[0]?.status, "claimed");
    assert.equal(row[0]?.runId, RUN_A);

    const all = await db.select().from(runnerDbSlots);
    assert.equal(all.length, 4);
  } finally {
    await cleanup();
  }
});
