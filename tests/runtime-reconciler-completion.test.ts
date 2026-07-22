import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeReconciler, type RuntimeReconcilerOptions } from "../src/runtime/reconciler.js";
import type { RunRecord } from "../src/types.js";
import type { RunCompletionRecord } from "../src/runtime/control-plane-types.js";
import type { TerminalFact } from "../src/runtime/terminal-fact.js";

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    runtime: "kubernetes",
    status: "running",
    phase: "agent",
    repoSlug: "org/repo",
    task: "do the thing",
    baseBranch: "main",
    branchName: "goose/thing",
    requestedBy: "user",
    channelId: "C1",
    threadTs: "1",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function successCompletion(runId: string): RunCompletionRecord {
  return {
    id: 1,
    runId,
    idempotencyKey: "complete-1",
    payload: {
      idempotencyKey: "complete-1",
      status: "success",
      artifactState: "complete",
      commitSha: "abc123",
      changedFiles: ["a.ts"],
    },
    createdAt: new Date().toISOString(),
  };
}

function makeReconciler(deps: {
  completions: Array<RunCompletionRecord | null>;
  fact: TerminalFact;
  run: RunRecord;
  events?: unknown[];
  updates: Array<Record<string, unknown>>;
  options?: RuntimeReconcilerOptions;
  completionCalls?: { count: number };
}): RuntimeReconciler {
  let index = 0;
  return new RuntimeReconciler(
    {
      getLatestCompletion: async () => {
        if (deps.completionCalls) {
          deps.completionCalls.count += 1;
        }
        const value = deps.completions[Math.min(index, deps.completions.length - 1)] ?? null;
        index += 1;
        return value;
      },
      listEventsAfterSequence: async () => (deps.events ?? []) as never,
    },
    { getTerminalFact: async () => deps.fact },
    {
      getRun: async () => deps.run,
      updateRun: async (_id: string, patch: Record<string, unknown>) => {
        deps.updates.push(patch);
        return deps.run;
      },
    } as never,
    undefined,
    undefined,
    deps.options,
  );
}

test("reconciler completes a run when the completion record arrives during the grace window", async () => {
  const run = makeRun();
  const updates: Array<Record<string, unknown>> = [];
  const reconciler = makeReconciler({
    // First two polls return null (record not yet written), third returns success.
    completions: [null, null, successCompletion(run.id)],
    fact: "succeeded",
    run,
    updates,
    options: { completionGraceMs: 500, completionPollMs: 5 },
  });

  await reconciler.reconcileRun(run.id);

  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.status, "completed");
  assert.equal(updates[0]?.commitSha, "abc123");
});

test("reconciler does not re-poll when the completion is already present (happy path is not delayed)", async () => {
  const run = makeRun();
  const updates: Array<Record<string, unknown>> = [];
  const completionCalls = { count: 0 };
  const reconciler = makeReconciler({
    completions: [successCompletion(run.id)],
    fact: "succeeded",
    run,
    updates,
    completionCalls,
    // A large grace window would make this test slow if it were (wrongly) entered.
    options: { completionGraceMs: 60_000, completionPollMs: 1_000 },
  });

  await reconciler.reconcileRun(run.id);

  assert.equal(updates[0]?.status, "completed");
  assert.equal(completionCalls.count, 1, "should read completion exactly once, never entering the grace loop");
});

test("reconciler fails with a lost-callback diagnostic when the runner attempted completion but none was recorded", async () => {
  const run = makeRun();
  const updates: Array<Record<string, unknown>> = [];
  const reconciler = makeReconciler({
    completions: [null],
    fact: "failed",
    run,
    updates,
    events: [
      {
        runId: run.id,
        eventId: "evt-1",
        eventType: "run.completion_attempted",
        timestamp: "2026-06-01T00:00:00.000Z",
        sequence: 1,
        payload: { status: "failed", reason: "push rejected" },
      },
    ],
    options: { completionGraceMs: 20, completionPollMs: 5 },
  });

  await reconciler.reconcileRun(run.id);

  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.status, "failed");
  const error = String(updates[0]?.error);
  assert.match(error, /completion missing after terminal runtime state \(job failed\)/);
  assert.match(error, /lost completion callback/);
  assert.match(error, /push rejected/);
});

test("reconciler fails with a pod-death diagnostic when the runner never attempted completion", async () => {
  const run = makeRun();
  const updates: Array<Record<string, unknown>> = [];
  const reconciler = makeReconciler({
    completions: [null],
    fact: "failed",
    run,
    updates,
    events: [
      {
        runId: run.id,
        eventId: "evt-1",
        eventType: "run.started",
        timestamp: "2026-06-01T00:00:00.000Z",
        sequence: 1,
        payload: {},
      },
    ],
    options: { completionGraceMs: 20, completionPollMs: 5 },
  });

  await reconciler.reconcileRun(run.id);

  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.status, "failed");
  const error = String(updates[0]?.error);
  assert.match(error, /completion missing after terminal runtime state \(job failed\)/);
  assert.match(error, /OOMKill, eviction, node loss, or hard crash/);
});

test("reconciler still classifies a genuinely missing completion, and the message is non-retryable-friendly", async () => {
  // The improved message must remain matchable by run-manager's ERROR_PATTERNS.
  const { classifyError } = await import("../src/run-manager.js");
  const run = makeRun();
  const updates: Array<Record<string, unknown>> = [];
  const reconciler = makeReconciler({
    completions: [null],
    fact: "missing",
    run,
    updates,
    options: { completionGraceMs: 10, completionPollMs: 5 },
  });

  await reconciler.reconcileRun(run.id);

  const error = String(updates[0]?.error);
  assert.equal(classifyError(error).category, "runner_completion_missing");
});
