import assert from "node:assert/strict";
import test from "node:test";
import { mapPhaseToRunStatus, RunStore } from "../src/store.js";
import { createTestDb } from "./helpers/test-db.js";

async function createStore(): Promise<{ store: RunStore; cleanup: () => Promise<void> }> {
  const testDb = await createTestDb();
  const store = new RunStore(testDb.db);
  await store.init();
  return { store, cleanup: testDb.cleanup };
}

test("createRun stores queued phase and metadata updates persist", async (t) => {
  const { store, cleanup } = await createStore();
  t.after(cleanup);

  const run = await store.createRun(
    {
      repoSlug: "owner/repo",
      task: "test task",
      baseBranch: "main",
      requestedBy: "U123",
      channelId: "C123",
      threadTs: "123.456",
      runtime: "local"
    },
    "gooseherd"
  );

  assert.equal(run.status, "queued");
  assert.equal(run.phase, "queued");

  const updated = await store.updateRun(run.id, {
    status: "running",
    phase: "agent",
    commitSha: "abc123",
    changedFiles: ["a.ts", "b.ts"],
    statusMessageTs: "1234.55"
  });

  assert.equal(updated.phase, "agent");
  assert.equal(updated.commitSha, "abc123");
  assert.deepEqual(updated.changedFiles, ["a.ts", "b.ts"]);
  assert.equal(updated.statusMessageTs, "1234.55");

  const formatted = store.formatRunStatus(updated);
  assert.match(formatted, /Commit: abc123/);
  assert.match(formatted, /Changed files: 2/);
});

test("listRuns returns newest first and feedback is saved", async (t) => {
  const { store, cleanup } = await createStore();
  t.after(cleanup);

  const first = await store.createRun(
    {
      repoSlug: "owner/repo",
      task: "first",
      baseBranch: "main",
      requestedBy: "U1",
      channelId: "C1",
      threadTs: "1",
      runtime: "local"
    },
    "gooseherd"
  );

  const second = await store.createRun(
    {
      repoSlug: "owner/repo",
      task: "second",
      baseBranch: "main",
      requestedBy: "U1",
      channelId: "C1",
      threadTs: "1",
      runtime: "local"
    },
    "gooseherd"
  );

  const listed = await store.listRuns(10);
  assert.equal(listed[0]?.id, second.id);
  assert.equal(listed[1]?.id, first.id);

  const feedbackRun = await store.saveFeedback(second.id, {
    rating: "up",
    note: "good run",
    by: "tester",
    at: new Date().toISOString()
  });

  assert.equal(feedbackRun.feedback?.rating, "up");
  assert.equal(feedbackRun.feedback?.note, "good run");
});

test("mapPhaseToRunStatus handles phase mapping", () => {
  assert.equal(mapPhaseToRunStatus("validating"), "validating");
  assert.equal(mapPhaseToRunStatus("pushing"), "pushing");
  assert.equal(mapPhaseToRunStatus("awaiting_ci"), "awaiting_ci");
  assert.equal(mapPhaseToRunStatus("ci_fixing"), "ci_fixing");
  assert.equal(mapPhaseToRunStatus("agent"), "running");
  assert.equal(mapPhaseToRunStatus("cloning"), "running");
});

test("recoverInProgressRuns requeues interrupted runs", async (t) => {
  const { store, cleanup } = await createStore();
  t.after(cleanup);

  const run = await store.createRun(
    {
      repoSlug: "owner/repo",
      task: "recover me",
      baseBranch: "main",
      requestedBy: "U1",
      channelId: "C1",
      threadTs: "1",
      runtime: "local"
    },
    "gooseherd"
  );

  await store.updateRun(run.id, {
    status: "running",
    phase: "agent",
    startedAt: new Date().toISOString()
  });

  const recovered = await store.recoverInProgressRuns("Recovered after process restart. Auto-requeued.");
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.id, run.id);
  assert.equal(recovered[0]?.status, "queued");
  assert.equal(recovered[0]?.phase, "queued");
  assert.equal(recovered[0]?.error, "Recovered after process restart. Auto-requeued.");
});
