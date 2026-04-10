import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "./helpers/test-db.js";
import { runArtifacts, runCompletions, runEvents, runTokens } from "../src/db/schema.js";
import { ControlPlaneStore } from "../src/runtime/control-plane-store.js";
import { RuntimeReconciler } from "../src/runtime/reconciler.js";
import { RunStore } from "../src/store.js";

test("control-plane store issues one run token and deduplicates completion by idempotency key", async () => {
  const { db, cleanup } = await createTestDb();
  const store = new ControlPlaneStore(db);

  await store.createRunEnvelope({
    runId: "run-1",
    payloadRef: "payload/run-1",
    payloadJson: { task: "fix bug" },
    runtime: "kubernetes",
  });

  const token = await store.issueRunToken("run-1");
  assert.ok(token.token.length > 20);
  const tokenRows = await db.select().from(runTokens).where(eq(runTokens.runId, "run-1"));
  assert.equal(tokenRows.length, 1);
  assert.notEqual(tokenRows[0]?.tokenHash, token.token);
  assert.ok((tokenRows[0]?.tokenHash ?? "").length > 20);

  const first = await store.recordCompletion("run-1", {
    idempotencyKey: "complete-1",
    status: "success",
    artifactState: "complete",
    commitSha: "abc123",
    changedFiles: ["a.ts", "b.ts"],
    prUrl: "https://example.com/pr/1",
    title: "Fix bug in runtime persistence",
  });
  const second = await store.recordCompletion("run-1", {
    idempotencyKey: "complete-1",
    status: "success",
    artifactState: "complete",
    commitSha: "abc123",
    changedFiles: ["a.ts", "b.ts"],
    prUrl: "https://example.com/pr/1",
    title: "Fix bug in runtime persistence",
  });

  assert.equal(first.id, second.id);
  const completionRows = await db
    .select()
    .from(runCompletions)
    .where(eq(runCompletions.runId, "run-1"));
  assert.equal(completionRows.length, 1);
  assert.equal(completionRows[0]?.status, "success");
  assert.equal((completionRows[0]?.payload as { commitSha?: string })?.commitSha, "abc123");

  const artifactRows = await db
    .select()
    .from(runArtifacts)
    .where(eq(runArtifacts.runId, "run-1"));
  assert.equal(artifactRows.length, 1);
  assert.equal(artifactRows[0]?.artifactKey, "result");
  assert.equal(artifactRows[0]?.artifactClass, "completion");
  assert.equal(artifactRows[0]?.status, "complete");
  await cleanup();
});

test("control-plane store deduplicates events by eventId within a run", async () => {
  const { db, cleanup } = await createTestDb();
  const store = new ControlPlaneStore(db);
  await store.createRunEnvelope({
    runId: "run-events-1",
    payloadRef: "payload/run-events-1",
    payloadJson: { task: "emit event" },
    runtime: "kubernetes",
  });

  await store.appendEvent("run-events-1", {
    eventId: "evt-1",
    eventType: "run.phase_changed",
    timestamp: new Date().toISOString(),
    sequence: 1,
    payload: { phase: "running" },
  });
  await store.appendEvent("run-events-1", {
    eventId: "evt-1",
    eventType: "run.phase_changed",
    timestamp: new Date().toISOString(),
    sequence: 1,
    payload: { phase: "running" },
  });

  const eventRows = await db.select().from(runEvents).where(eq(runEvents.runId, "run-events-1"));
  assert.equal(eventRows.length, 1);
  assert.equal(eventRows[0]?.eventId, "evt-1");
  assert.equal(eventRows[0]?.sequence, 1);
  assert.equal(eventRows[0]?.eventType, "run.phase_changed");
  await cleanup();
});

test("reconciler finalizes failed when job is terminal and no completion arrives in time", async () => {
  const { db, cleanup } = await createTestDb();
  const controlPlaneStore = new ControlPlaneStore(db);
  const runStore = new RunStore(db);
  await runStore.init();

  const run = await runStore.createRun(
    {
      repoSlug: "owner/repo",
      task: "reconcile terminal-without-completion",
      baseBranch: "main",
      requestedBy: "U1",
      channelId: "C1",
      threadTs: "1",
      runtime: "kubernetes",
    },
    "gooseherd",
  );

  const fakeRuntimeFacts = {
    getTerminalFact: async () => "failed" as const,
  };

  const reconciler = new RuntimeReconciler(controlPlaneStore, fakeRuntimeFacts, runStore);
  await reconciler.reconcileRun(run.id);
  const updated = await runStore.getRun(run.id);

  assert.equal(updated?.status, "failed");
  assert.equal(updated?.phase, "failed");
  assert.equal(updated?.error, "completion missing after terminal runtime state");
  await cleanup();
});

test("reconciler finalizes completed when completion exists and runtime reports succeeded", async () => {
  const { db, cleanup } = await createTestDb();
  const controlPlaneStore = new ControlPlaneStore(db);
  const runStore = new RunStore(db);
  await runStore.init();

  const run = await runStore.createRun(
    {
      repoSlug: "owner/repo",
      task: "reconcile completed-with-completion",
      baseBranch: "main",
      requestedBy: "U1",
      channelId: "C1",
      threadTs: "1",
      runtime: "kubernetes",
    },
    "gooseherd",
  );

  await controlPlaneStore.recordCompletion(run.id, {
    idempotencyKey: "completion-1",
    status: "success",
    artifactState: "complete",
    commitSha: "abc123",
    changedFiles: ["a.ts"],
    title: "Complete run",
  });

  const fakeRuntimeFacts = {
    getTerminalFact: async () => "succeeded" as const,
  };

  const reconciler = new RuntimeReconciler(controlPlaneStore, fakeRuntimeFacts, runStore);
  await reconciler.reconcileRun(run.id);
  const updated = await runStore.getRun(run.id);

  assert.equal(updated?.status, "completed");
  assert.equal(updated?.phase, "completed");
  assert.ok(updated?.finishedAt);
  await cleanup();
});
