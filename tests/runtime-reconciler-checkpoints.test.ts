import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeReconciler } from "../src/runtime/reconciler.js";
import type { RunRecord } from "../src/types.js";
import type { RunCheckpointRecord } from "../src/runs/run-checkpoints.js";
import type { EmitRunCheckpointInput } from "../src/runs/run-checkpoint-store.js";

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    runtime: "kubernetes",
    status: "running",
    phase: "awaiting_ci",
    repoSlug: "org/repo",
    task: "reconcile",
    baseBranch: "main",
    branchName: "goose/reconcile",
    requestedBy: "work-item:auto-review",
    channelId: "C1",
    threadTs: "1",
    createdAt: new Date().toISOString(),
    workItemId: "11111111-1111-1111-1111-111111111111",
    prUrl: "https://github.com/org/repo/pull/1",
    prNumber: 1,
    intent: {
      version: 1,
      kind: "feature_delivery.self_review",
      source: "work_item",
      workItemId: "11111111-1111-1111-1111-111111111111",
      repo: "org/repo",
      prUrl: "https://github.com/org/repo/pull/1",
      prNumber: 1,
      sourceSubstate: "pr_adopted",
    },
    ...overrides,
  };
}

function toRecord(input: EmitRunCheckpointInput): RunCheckpointRecord {
  const now = new Date().toISOString();
  return {
    runId: input.runId,
    checkpointKey: input.checkpointKey,
    checkpointType: input.checkpointType,
    payload: input.payload ?? {},
    emittedAt: input.emittedAt ?? now,
    createdAt: now,
    updatedAt: now,
  };
}

test("reconciler drains stored runner checkpoint events before finalizing recovered runs", async () => {
  const emitted: EmitRunCheckpointInput[] = [];
  const processed: string[] = [];
  const run = makeRun();
  const reconciler = new RuntimeReconciler(
    {
      getLatestCompletion: async () => ({
        id: 1,
        runId: run.id,
        idempotencyKey: "complete-1",
        payload: {
          idempotencyKey: "complete-1",
          status: "success",
          artifactState: "complete",
          commitSha: "abc123",
          changedFiles: ["a.ts"],
        },
        createdAt: new Date().toISOString(),
      }),
      listEventsAfterSequence: async () => [{
        runId: run.id,
        eventId: "evt-1",
        eventType: "run.checkpoint",
        timestamp: "2026-04-24T00:00:00.000Z",
        sequence: 1,
        payload: {
          checkpointKey: "external_ci_wait_started",
          checkpointType: "run.waiting_external_ci",
          emittedAt: "not-a-date",
          payload: { source: "test" },
        },
      }],
    },
    { getTerminalFact: async () => "succeeded" },
    {
      getRun: async () => run,
      updateRun: async () => run,
    } as never,
    {
      emit: async (input: EmitRunCheckpointInput) => {
        emitted.push(input);
        return { inserted: true, checkpoint: toRecord(input) };
      },
      hasCheckpoint: async () => emitted.some((item) => item.checkpointKey === "external_ci_wait_started"),
    } as never,
    {
      process: async (checkpoint: RunCheckpointRecord) => {
        processed.push(checkpoint.checkpointKey);
      },
    } as never,
  );

  await reconciler.reconcileRun(run.id);

  assert.deepEqual(emitted.map((item) => item.checkpointKey), ["external_ci_wait_started"]);
  assert.equal(emitted[0]?.emittedAt, "2026-04-24T00:00:00.000Z");
  assert.deepEqual(processed, ["external_ci_wait_started"]);
});

test("reconciler emits terminal progress fallback when recovered completion has no external CI checkpoint", async () => {
  const emitted: EmitRunCheckpointInput[] = [];
  const run = makeRun({ phase: "agent" });
  const reconciler = new RuntimeReconciler(
    {
      getLatestCompletion: async () => ({
        id: 1,
        runId: run.id,
        idempotencyKey: "complete-1",
        payload: {
          idempotencyKey: "complete-1",
          status: "success",
          artifactState: "complete",
          commitSha: "abc123",
          changedFiles: [],
        },
        createdAt: new Date().toISOString(),
      }),
      listEventsAfterSequence: async () => [],
    },
    { getTerminalFact: async () => "succeeded" },
    {
      getRun: async () => run,
      updateRun: async () => run,
    } as never,
    {
      emit: async (input: EmitRunCheckpointInput) => {
        emitted.push(input);
        return { inserted: true, checkpoint: toRecord(input) };
      },
      hasCheckpoint: async () => false,
    } as never,
    {
      process: async () => {},
    } as never,
  );

  await reconciler.reconcileRun(run.id);

  assert.deepEqual(emitted.map((item) => item.checkpointKey), ["terminal_progress_without_external_wait"]);
  assert.equal(emitted[0]?.checkpointType, "run.completed_without_external_wait");
});
