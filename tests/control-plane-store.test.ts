import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../src/db/index.js";
import { runArtifacts, runCompletions, runEvents, runPayloads, runTokens, runs } from "../src/db/schema.js";
import { ControlPlaneStore } from "../src/runtime/control-plane-store.js";
import { RuntimeReconciler } from "../src/runtime/reconciler.js";
import { RunStore } from "../src/store.js";
import { sleep } from "../src/utils/sleep.js";

async function insertRun(db: Database, runId: string): Promise<void> {
  await db.insert(runs).values({
    id: runId,
    runtime: "kubernetes",
    status: "running",
    phase: "queued",
    repoSlug: "owner/repo",
    task: "control-plane test",
    baseBranch: "main",
    branchName: "goose/control-plane-test",
    requestedBy: "U1",
    channelId: "C1",
    threadTs: runId,
  });
}

test("control-plane store issues one run token and deduplicates completion by idempotency key", async () => {
  const { db, cleanup } = await createTestDb();
  const store = new ControlPlaneStore(db);
  const runId = "11111111-1111-1111-1111-111111111111";
  await insertRun(db, runId);

  await store.createRunEnvelope({
    runId,
    payloadRef: `payload/${runId}`,
    payloadJson: { task: "fix bug" },
    runtime: "kubernetes",
  });

  const token = await store.issueRunToken(runId);
  assert.ok(token.token.length > 20);
  const tokenRows = await db.select().from(runTokens).where(eq(runTokens.runId, runId));
  assert.equal(tokenRows.length, 1);
  assert.notEqual(tokenRows[0]?.tokenHash, token.token);
  assert.ok((tokenRows[0]?.tokenHash ?? "").length > 20);

  const first = await store.recordCompletion(runId, {
    idempotencyKey: "complete-1",
    status: "success",
    artifactState: "complete",
    commitSha: "abc123",
    changedFiles: ["a.ts", "b.ts"],
    internalArtifacts: ["AGENTS.md"],
    prUrl: "https://example.com/pr/1",
    title: "Fix bug in runtime persistence",
  });
  const second = await store.recordCompletion(runId, {
    idempotencyKey: "complete-1",
    status: "success",
    artifactState: "complete",
    commitSha: "abc123",
    changedFiles: ["a.ts", "b.ts"],
    internalArtifacts: ["AGENTS.md"],
    prUrl: "https://example.com/pr/1",
    title: "Fix bug in runtime persistence",
  });

  assert.equal(first.id, second.id);
  const completionRows = await db
    .select()
    .from(runCompletions)
    .where(eq(runCompletions.runId, runId));
  assert.equal(completionRows.length, 1);
  assert.equal(completionRows[0]?.status, "success");
  assert.equal((completionRows[0]?.payload as { commitSha?: string })?.commitSha, "abc123");

  const artifactRows = await db
    .select()
    .from(runArtifacts)
    .where(eq(runArtifacts.runId, runId));
  assert.equal(artifactRows.length, 1);
  assert.equal(artifactRows[0]?.artifactKey, "result");
  assert.equal(artifactRows[0]?.artifactClass, "completion");
  assert.equal(artifactRows[0]?.status, "complete");
  await cleanup();
});

test("control-plane store keeps the first payload envelope instead of overwriting it on retry", async () => {
  const { db, cleanup } = await createTestDb();
  const store = new ControlPlaneStore(db);
  const runId = "22222222-2222-2222-2222-222222222222";
  await insertRun(db, runId);

  await store.createRunEnvelope({
    runId,
    payloadRef: "payload/original",
    payloadJson: { task: "original" },
    runtime: "kubernetes",
  });

  const envelope = await store.createRunEnvelope({
    runId,
    payloadRef: "payload/retry",
    payloadJson: { task: "retry" },
    runtime: "local",
  });

  const rows = await db.select().from(runPayloads).where(eq(runPayloads.runId, runId));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.payloadRef, "payload/original");
  assert.deepEqual(rows[0]?.payloadJson, { task: "original" });
  assert.equal(rows[0]?.runtime, "kubernetes");
  assert.equal(envelope.payloadRef, "payload/original");
  assert.deepEqual(envelope.payloadJson, { task: "original" });
  assert.equal(envelope.runtime, "kubernetes");

  await cleanup();
});

test("control-plane store stamps token first use and rejects expired tokens", async () => {
  const { db, cleanup } = await createTestDb();
  const store = new ControlPlaneStore(db);
  const runId = "33333333-3333-3333-3333-333333333333";
  await insertRun(db, runId);

  await store.createRunEnvelope({
    runId,
    payloadRef: `payload/${runId}`,
    payloadJson: { task: "validate token" },
    runtime: "kubernetes",
  });

  const issued = await store.issueRunToken(runId, 50);
  assert.equal(await store.validateRunToken(runId, issued.token), true);

  let tokenRows = await db.select().from(runTokens).where(eq(runTokens.runId, runId));
  assert.ok(tokenRows[0]?.usedAt);
  assert.ok(tokenRows[0]?.expiresAt);
  assert.equal(await store.validateRunToken(runId, issued.token), true);

  await sleep(75);
  assert.equal(await store.validateRunToken(runId, issued.token), false);

  tokenRows = await db.select().from(runTokens).where(eq(runTokens.runId, runId));
  assert.equal(tokenRows.length, 1);
  await cleanup();
});

test("control-plane store updates uploaded artifact to complete", async () => {
  const { db, cleanup } = await createTestDb();
  const store = new ControlPlaneStore(db);
  const runId = "3f1ce7c7-c7cf-4bd6-8b8e-2a5d77e62f41";
  await insertRun(db, runId);

  await store.upsertArtifact(runId, "run.log", "raw_run_log", {
    storage: "file",
    path: "/tmp/run.log",
  });

  await (store as unknown as { markArtifactUploaded: (runId: string, artifactKey: string, metadata: Record<string, unknown>) => Promise<void> })
    .markArtifactUploaded(runId, "run.log", { storage: "file", path: "/tmp/run.log", sizeBytes: 12 });

  const artifactRows = await db.select().from(runArtifacts).where(eq(runArtifacts.runId, runId));
  assert.equal(artifactRows[0]?.status, "complete");
  assert.equal((artifactRows[0]?.metadata as { sizeBytes?: number })?.sizeBytes, 12);
  await cleanup();
});

test("control-plane store deduplicates events by eventId within a run", async () => {
  const { db, cleanup } = await createTestDb();
  const store = new ControlPlaneStore(db);
  const runId = "44444444-4444-4444-4444-444444444444";
  await insertRun(db, runId);
  await store.createRunEnvelope({
    runId,
    payloadRef: `payload/${runId}`,
    payloadJson: { task: "emit event" },
    runtime: "kubernetes",
  });

  await store.appendEvent(runId, {
    eventId: "evt-1",
    eventType: "run.phase_changed",
    timestamp: new Date().toISOString(),
    sequence: 1,
    payload: { phase: "running" },
  });
  await store.appendEvent(runId, {
    eventId: "evt-1",
    eventType: "run.phase_changed",
    timestamp: new Date().toISOString(),
    sequence: 1,
    payload: { phase: "running" },
  });

  const eventRows = await db.select().from(runEvents).where(eq(runEvents.runId, runId));
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
    internalArtifacts: ["AGENTS.md"],
    prNumber: 42 as never,
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
  assert.equal(updated?.commitSha, "abc123");
  assert.deepEqual(updated?.changedFiles, ["a.ts"]);
  assert.deepEqual(updated?.internalArtifacts, ["AGENTS.md"]);
  assert.equal(updated?.prNumber, 42);
  assert.equal(updated?.title, "Complete run");
  await cleanup();
});

test("reconciler preserves internal artifacts on failed completions", async () => {
  const { db, cleanup } = await createTestDb();
  const controlPlaneStore = new ControlPlaneStore(db);
  const runStore = new RunStore(db);
  await runStore.init();

  const run = await runStore.createRun(
    {
      repoSlug: "owner/repo",
      task: "reconcile failed-with-artifacts",
      baseBranch: "main",
      requestedBy: "U1",
      channelId: "C1",
      threadTs: "1",
      runtime: "kubernetes",
    },
    "gooseherd",
  );

  await controlPlaneStore.recordCompletion(run.id, {
    idempotencyKey: "completion-failed-1",
    status: "failed",
    artifactState: "failed",
    reason: "summary parse failed",
    internalArtifacts: ["agent-stdout.log", "auto-review-summary.json"],
  });

  const reconciler = new RuntimeReconciler(
    controlPlaneStore,
    {
      getTerminalFact: async () => "failed" as const,
    },
    runStore,
  );

  await reconciler.reconcileRun(run.id);
  const updated = await runStore.getRun(run.id);

  assert.equal(updated?.status, "failed");
  assert.equal(updated?.phase, "failed");
  assert.equal(updated?.error, "summary parse failed");
  assert.deepEqual(updated?.internalArtifacts, ["agent-stdout.log", "auto-review-summary.json"]);

  await cleanup();
});

test("reconciler gives cancellation precedence to terminal kubernetes runs", async () => {
  const { db, cleanup } = await createTestDb();
  const controlPlaneStore = new ControlPlaneStore(db);
  const runStore = new RunStore(db);
  await runStore.init();

  const run = await runStore.createRun(
    {
      repoSlug: "owner/repo",
      task: "reconcile cancelled-with-terminal-fact",
      baseBranch: "main",
      requestedBy: "U1",
      channelId: "C1",
      threadTs: "1",
      runtime: "kubernetes",
    },
    "gooseherd",
  );

  await runStore.updateRun(run.id, {
    status: "cancel_requested",
    phase: "cancel_requested",
  });

  const fakeRuntimeFacts = {
    getTerminalFact: async () => "failed" as const,
  };

  const reconciler = new RuntimeReconciler(controlPlaneStore, fakeRuntimeFacts, runStore);
  await reconciler.reconcileRun(run.id);
  const updated = await runStore.getRun(run.id);

  assert.equal(updated?.status, "cancelled");
  assert.equal(updated?.phase, "cancelled");
  assert.ok(updated?.finishedAt);
  await cleanup();
});

test("reconciler preserves already-cancelled kubernetes runs when runtime fact is missing and completion never arrived", async () => {
  const { db, cleanup } = await createTestDb();
  const controlPlaneStore = new ControlPlaneStore(db);
  const runStore = new RunStore(db);
  await runStore.init();

  const run = await runStore.createRun(
    {
      repoSlug: "owner/repo",
      task: "reconcile already-cancelled-missing",
      baseBranch: "main",
      requestedBy: "U1",
      channelId: "C1",
      threadTs: "1",
      runtime: "kubernetes",
    },
    "gooseherd",
  );

  const finishedAt = new Date().toISOString();
  await runStore.updateRun(run.id, {
    status: "cancelled",
    phase: "cancelled",
    finishedAt,
    error: "Run cancelled",
  });

  const fakeRuntimeFacts = {
    getTerminalFact: async () => "missing" as const,
  };

  const reconciler = new RuntimeReconciler(controlPlaneStore, fakeRuntimeFacts, runStore);
  await reconciler.reconcileRun(run.id);
  const updated = await runStore.getRun(run.id);

  assert.equal(updated?.status, "cancelled");
  assert.equal(updated?.phase, "cancelled");
  assert.equal(updated?.error, "Run cancelled");
  assert.equal(updated?.finishedAt, finishedAt);
  await cleanup();
});

test("reconciler fails runs when a success completion contradicts failed runtime state", async () => {
  const { db, cleanup } = await createTestDb();
  const controlPlaneStore = new ControlPlaneStore(db);
  const runStore = new RunStore(db);
  await runStore.init();

  const run = await runStore.createRun(
    {
      repoSlug: "owner/repo",
      task: "reconcile contradictory-success",
      baseBranch: "main",
      requestedBy: "U1",
      channelId: "C1",
      threadTs: "1",
      runtime: "kubernetes",
    },
    "gooseherd",
  );

  await controlPlaneStore.recordCompletion(run.id, {
    idempotencyKey: "completion-success-1",
    status: "success",
    artifactState: "complete",
    commitSha: "abc123",
    changedFiles: ["src/index.ts"],
    title: "Unexpected success",
  });

  const reconciler = new RuntimeReconciler(
    controlPlaneStore,
    {
      getTerminalFact: async () => "failed" as const,
    },
    runStore,
  );

  await reconciler.reconcileRun(run.id);
  const updated = await runStore.getRun(run.id);

  assert.equal(updated?.status, "failed");
  assert.equal(updated?.phase, "failed");
  assert.equal(updated?.error, "success completion contradicted by runtime state");

  await cleanup();
});

test("reconciler preserves success completion when kubernetes job is already missing", async () => {
  const { db, cleanup } = await createTestDb();
  const controlPlaneStore = new ControlPlaneStore(db);
  const runStore = new RunStore(db);
  await runStore.init();

  const run = await runStore.createRun(
    {
      repoSlug: "owner/repo",
      task: "reconcile success-after-cleanup",
      baseBranch: "main",
      requestedBy: "U1",
      channelId: "C1",
      threadTs: "1",
      runtime: "kubernetes",
    },
    "gooseherd",
  );

  await controlPlaneStore.recordCompletion(run.id, {
    idempotencyKey: "completion-success-missing-1",
    status: "success",
    artifactState: "complete",
    commitSha: "abc123",
    changedFiles: ["src/index.ts"],
    prUrl: "https://example.com/pr/1",
    title: "Completed before cleanup",
  });

  const reconciler = new RuntimeReconciler(
    controlPlaneStore,
    {
      getTerminalFact: async () => "missing" as const,
    },
    runStore,
  );

  await reconciler.reconcileRun(run.id);
  const updated = await runStore.getRun(run.id);

  assert.equal(updated?.status, "completed");
  assert.equal(updated?.phase, "completed");
  assert.equal(updated?.commitSha, "abc123");
  assert.deepEqual(updated?.changedFiles, ["src/index.ts"]);
  assert.equal(updated?.prUrl, "https://example.com/pr/1");
  assert.equal(updated?.title, "Completed before cleanup");

  await cleanup();
});
