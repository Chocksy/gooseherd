/**
 * Tests for the conversation-related additions to RunStore:
 * findRunByThread, createConversationRun, setPendingBuildProposal,
 * promoteConversationRun.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { RunStore } from "../src/store.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";

let db: TestDb;
let store: RunStore;

test.beforeEach(async () => {
  db = await createTestDb();
  store = new RunStore(db.db);
});

test.afterEach(async () => {
  await db.cleanup();
});

test("findRunByThread returns undefined when no run exists for the thread", async () => {
  const result = await store.findRunByThread("C1", "1700000000.0");
  assert.equal(result, undefined);
});

test("findRunByThread returns the most recent run for a thread", async () => {
  const first = await store.createRun(
    {
      repoSlug: "owner/repo",
      task: "first",
      baseBranch: "main",
      requestedBy: "U1",
      channelId: "C1",
      threadTs: "1700000000.0",
      runtime: "local",
    },
    "test",
  );

  await new Promise((r) => setTimeout(r, 10));

  const second = await store.createRun(
    {
      repoSlug: "owner/repo",
      task: "second",
      baseBranch: "main",
      requestedBy: "U1",
      channelId: "C1",
      threadTs: "1700000000.0",
      runtime: "local",
    },
    "test",
  );

  const result = await store.findRunByThread("C1", "1700000000.0");
  assert.ok(result);
  assert.equal(result.id, second.id);
  assert.equal(result.task, "second");
  const firstAgain = await store.getRun(first.id);
  assert.ok(firstAgain);
});

test("createConversationRun creates a row with status=conversation and intent kind=conversation", async () => {
  const run = await store.createConversationRun({
    channelId: "C2",
    threadTs: "1700000001.0",
    requestedBy: "U2",
    firstMessage: "why is auth slow in chocksy/cems?",
    defaultBaseBranch: "main",
    branchPrefix: "test",
  });

  assert.equal(run.status, "conversation");
  assert.equal(run.repoSlug, "");
  assert.equal(run.branchName.startsWith("test/"), true);
  assert.equal(run.task, "why is auth slow in chocksy/cems?");
  assert.equal(run.baseBranch, "main");
  assert.equal(run.intent?.kind, "conversation");
  assert.equal(run.intentKind, "conversation");
  assert.equal(run.channelId, "C2");
  assert.equal(run.threadTs, "1700000001.0");
});

test("createConversationRun chains via parentRunId when prior thread run is terminal", async () => {
  const first = await store.createConversationRun({
    channelId: "C3",
    threadTs: "1700000002.0",
    requestedBy: "U3",
    firstMessage: "first",
    defaultBaseBranch: "main",
    branchPrefix: "test",
  });
  await store.updateRun(first.id, { status: "completed", phase: "completed" });

  const second = await store.createConversationRun({
    channelId: "C3",
    threadTs: "1700000002.0",
    requestedBy: "U3",
    firstMessage: "follow-up",
    defaultBaseBranch: "main",
    branchPrefix: "test",
    parentRunId: first.id,
  });

  assert.equal(second.parentRunId, first.id);
  assert.equal(second.rootRunId, first.id);
  assert.equal(second.chainIndex, 1);
});

test("promoteConversationRun flips status, replaces intent, fills repoSlug and task", async () => {
  const run = await store.createConversationRun({
    channelId: "C6",
    threadTs: "1700000005.0",
    requestedBy: "U6",
    firstMessage: "explain auth",
    defaultBaseBranch: "main",
    branchPrefix: "test",
  });

  const promoted = await store.promoteConversationRun(run.id, {
    repoSlug: "owner/repo",
    task: "Implement JWT cache as discussed",
    intent: {
      version: 1,
      kind: "generic_task",
      source: "slack",
      requestedBy: "U6",
    },
  });

  assert.equal(promoted.status, "queued");
  assert.equal(promoted.phase, "queued");
  assert.equal(promoted.repoSlug, "owner/repo");
  assert.equal(promoted.task, "Implement JWT cache as discussed");
  assert.equal(promoted.intent?.kind, "generic_task");
  assert.equal(promoted.intentKind, "generic_task");
});

test("promoteConversationRun throws if run is not in conversation status", async () => {
  const run = await store.createRun(
    {
      repoSlug: "owner/repo",
      task: "x",
      baseBranch: "main",
      requestedBy: "U7",
      channelId: "C7",
      threadTs: "1700000006.0",
      runtime: "local",
    },
    "test",
  );

  await assert.rejects(
    () =>
      store.promoteConversationRun(run.id, {
        repoSlug: "owner/repo",
        task: "y",
        intent: {
          version: 1,
          kind: "generic_task",
          source: "slack",
          requestedBy: "U7",
        },
      }),
    /not in conversation status/i,
  );
});
