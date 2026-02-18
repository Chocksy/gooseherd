import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mapExecutorPhaseToRunStatus, RunStore } from "../src/store.js";

async function createStore(prefix = "gooseherd-test-"): Promise<{ store: RunStore; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const store = new RunStore(dir);
  await store.init();
  return { store, dir };
}

test("createRun stores queued phase and metadata updates persist", async (t) => {
  const { store, dir } = await createStore();
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = await store.createRun(
    {
      repoSlug: "owner/repo",
      task: "test task",
      baseBranch: "main",
      requestedBy: "U123",
      channelId: "C123",
      threadTs: "123.456"
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
  const { store, dir } = await createStore("gooseherd-test-list-");
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const first = await store.createRun(
    {
      repoSlug: "owner/repo",
      task: "first",
      baseBranch: "main",
      requestedBy: "U1",
      channelId: "C1",
      threadTs: "1"
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
      threadTs: "1"
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

test("mapExecutorPhaseToRunStatus handles phase mapping", () => {
  assert.equal(mapExecutorPhaseToRunStatus("validating"), "validating");
  assert.equal(mapExecutorPhaseToRunStatus("pushing"), "pushing");
  assert.equal(mapExecutorPhaseToRunStatus("agent"), "running");
  assert.equal(mapExecutorPhaseToRunStatus("cloning"), "running");
});

test("recoverInProgressRuns requeues interrupted runs", async (t) => {
  const { store, dir } = await createStore("gooseherd-test-recover-");
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = await store.createRun(
    {
      repoSlug: "owner/repo",
      task: "recover me",
      baseBranch: "main",
      requestedBy: "U1",
      channelId: "C1",
      threadTs: "1"
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
