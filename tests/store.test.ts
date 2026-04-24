import assert from "node:assert/strict";
import test from "node:test";
import { modelPrices, runs, teams, users } from "../src/db/schema.js";
import { mapPhaseToRunStatus, RunStore } from "../src/store.js";
import { WorkItemStore } from "../src/work-items/store.js";
import { createTestDb } from "./helpers/test-db.js";

async function createStore(): Promise<{ store: RunStore; db: Awaited<ReturnType<typeof createTestDb>>["db"]; cleanup: () => Promise<void> }> {
  const testDb = await createTestDb();
  const store = new RunStore(testDb.db);
  await store.init();
  return { store, db: testDb.db, cleanup: testDb.cleanup };
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
    internalArtifacts: ["AGENTS.md"],
    statusMessageTs: "1234.55"
  });

  assert.equal(updated.phase, "agent");
  assert.equal(updated.commitSha, "abc123");
  assert.deepEqual(updated.changedFiles, ["a.ts", "b.ts"]);
  assert.deepEqual(updated.internalArtifacts, ["AGENTS.md"]);
  assert.equal(updated.statusMessageTs, "1234.55");

  const formatted = store.formatRunStatus(updated);
  assert.match(formatted, /Commit: abc123/);
  assert.match(formatted, /Changed files: 2/);
});

test("RunStore persists prefetchContext and autoReviewSourceSubstate", async (t) => {
  const { store, cleanup } = await createStore();
  t.after(cleanup);

  const created = await store.createRun(
    {
      repoSlug: "owner/repo",
      task: "prefetch test",
      baseBranch: "main",
      requestedBy: "U123",
      channelId: "C123",
      threadTs: "123.456",
      runtime: "local",
      workItemId: "11111111-1111-1111-1111-111111111111",
      autoReviewSourceSubstate: "pr_adopted",
      prefetchContext: {
        meta: {
          fetchedAt: new Date().toISOString(),
          sources: ["github_pr", "jira"],
        },
        workItem: {
          id: "11111111-1111-1111-1111-111111111111",
          title: "Prefetch test",
          workflow: "feature_delivery",
          state: "collecting_context",
          jiraIssueKey: "HBL-1",
          githubPrUrl: "https://github.com/owner/repo/pull/1",
          githubPrNumber: 1,
        },
        github: {
          pr: {
            number: 1,
            url: "https://github.com/owner/repo/pull/1",
            title: "Prefetch test PR",
            body: "Body",
            state: "open",
            headSha: "abc123",
          },
          discussionComments: [],
          reviews: [],
          reviewComments: [],
          ci: {
            headSha: "abc123",
            conclusion: "no_ci",
          },
        },
        jira: {
          issue: {
            key: "HBL-1",
            description: "Jira description",
          },
          comments: [],
        },
      },
    },
    "gooseherd"
  );

  const loaded = await store.getRun(created.id);

  assert.equal(loaded?.autoReviewSourceSubstate, "pr_adopted");
  assert.equal(loaded?.prefetchContext?.workItem.id, "11111111-1111-1111-1111-111111111111");
  assert.equal(loaded?.prefetchContext?.github?.pr.title, "Prefetch test PR");
  assert.equal(loaded?.prefetchContext?.jira?.issue.key, "HBL-1");
});

test("RunStore accumulates token usage by model", async (t) => {
  const { store, cleanup } = await createStore();
  t.after(cleanup);

  const run = await store.createRun(
    {
      repoSlug: "owner/repo",
      task: "token usage test",
      baseBranch: "main",
      requestedBy: "U123",
      channelId: "C123",
      threadTs: "123.456",
      runtime: "local"
    },
    "gooseherd"
  );

  await store.addTokenUsage(run.id, { model: "openai/gpt-4.1-mini", input: 100, output: 200 });
  await store.addTokenUsage(run.id, { model: "anthropic/claude-sonnet-4-6", input: 200, output: 1000 });
  const updated = await store.addTokenUsage(run.id, { model: "openai/gpt-4.1-mini", input: 30, output: 2 });

  assert.deepEqual(updated.tokenUsage?.byModel, [
    { model: "openai/gpt-4.1-mini", input: 130, output: 202, costUsd: 0.0004 },
    { model: "anthropic/claude-sonnet-4-6", input: 200, output: 1000, costUsd: 0.0156 }
  ]);
  assert.equal(updated.tokenUsage?.qualityGateInputTokens, 330);
  assert.equal(updated.tokenUsage?.qualityGateOutputTokens, 1202);
  assert.equal(updated.tokenUsage?.costUsd, 0.016);
});

test("RunStore records a model price placeholder for unknown models", async (t) => {
  const { store, db, cleanup } = await createStore();
  t.after(cleanup);

  const run = await store.createRun(
    {
      repoSlug: "owner/repo",
      task: "unknown model test",
      baseBranch: "main",
      requestedBy: "U123",
      channelId: "C123",
      threadTs: "123.456",
      runtime: "local"
    },
    "gooseherd"
  );

  const updated = await store.addTokenUsage(run.id, { model: "new/provider-model", input: 100, output: 50 });
  const prices = await db.select().from(modelPrices);

  assert.equal(updated.tokenUsage?.costUsd, undefined);
  assert.equal(updated.tokenUsage?.costIncomplete, true);
  assert.deepEqual(updated.tokenUsage?.missingPriceModels, ["new/provider-model"]);
  assert.deepEqual(updated.tokenUsage?.byModel, [
    { model: "new/provider-model", input: 100, output: 50 }
  ]);
  assert.equal(prices.length, 1);
  assert.equal(prices[0]?.model, "new/provider-model");
  assert.equal(prices[0]?.inputPerM, null);
  assert.equal(prices[0]?.outputPerM, null);
  assert.equal(prices[0]?.source, "observed");
  assert.equal(prices[0]?.firstSeenRunId, run.id);
});

test("RunStore persists explicit run intent and derives legacy intent on reads", async (t) => {
  const { store, db, cleanup } = await createStore();
  t.after(cleanup);

  const intent = {
    version: 1,
    kind: "generic_task",
    source: "dashboard",
    requestedBy: "manual:dashboard",
    pipelineHint: "custom-pipeline",
  } as const;

  const created = await store.createRun(
    {
      repoSlug: "owner/repo",
      task: "intent test",
      baseBranch: "main",
      requestedBy: "manual:dashboard",
      channelId: "dashboard",
      threadTs: "123.456",
      runtime: "local",
      intent,
    },
    "gooseherd",
  );

  assert.deepEqual(created.intent, intent);
  assert.equal(created.intentKind, "generic_task");

  await db.insert(runs).values({
    id: "22222222-2222-2222-2222-222222222222",
    runtime: "local",
    status: "queued",
    phase: "queued",
    repoSlug: "owner/repo",
    task: "legacy run",
    baseBranch: "main",
    branchName: "gooseherd/legacy",
    requestedBy: "work-item:auto-review",
    channelId: "C123",
    threadTs: "123.456",
    prUrl: "https://github.com/owner/repo/pull/7",
    prNumber: 7,
    workItemId: "11111111-1111-1111-1111-111111111111",
    autoReviewSourceSubstate: "applying_review_feedback",
  });

  const legacy = await store.getRun("22222222-2222-2222-2222-222222222222");
  assert.equal(legacy?.intent?.kind, "feature_delivery.apply_review_feedback");
  assert.equal(legacy?.intentKind, "feature_delivery.apply_review_feedback");
});

test("RunStore derives intent kind from the validated or derived intent", async (t) => {
  const { store, db, cleanup } = await createStore();
  t.after(cleanup);

  await db.insert(runs).values({
    id: "33333333-3333-3333-3333-333333333333",
    runtime: "local",
    status: "queued",
    phase: "queued",
    repoSlug: "owner/repo",
    task: "mismatched intent",
    baseBranch: "main",
    branchName: "gooseherd/mismatched",
    requestedBy: "work-item:auto-review",
    channelId: "C123",
    threadTs: "123.456",
    prUrl: "https://github.com/owner/repo/pull/9",
    prNumber: 9,
    workItemId: "11111111-1111-1111-1111-111111111111",
    autoReviewSourceSubstate: "applying_review_feedback",
    intentKind: "feature_delivery.repair_ci",
  });

  const loaded = await store.getRun("33333333-3333-3333-3333-333333333333");

  assert.equal(loaded?.intent?.kind, "feature_delivery.apply_review_feedback");
  assert.equal(loaded?.intentKind, "feature_delivery.apply_review_feedback");
});

test("RunStore normalizes invalid explicit intent before persisting", async (t) => {
  const { store, cleanup } = await createStore();
  t.after(cleanup);

  const created = await store.createRun(
    {
      repoSlug: "owner/repo",
      task: "invalid intent",
      baseBranch: "main",
      requestedBy: "manual:dashboard",
      channelId: "dashboard",
      threadTs: "123.456",
      runtime: "local",
      intent: { version: 1, kind: "generic_task" } as never,
    },
    "gooseherd",
  );

  assert.equal(created.intent?.kind, "generic_task");
  assert.equal(created.intent?.source, "dashboard");
  assert.equal(created.intentKind, "generic_task");
});

test("RunStore can clear persisted work-item launch context fields", async (t) => {
  const { store, cleanup } = await createStore();
  t.after(cleanup);

  const created = await store.createRun(
    {
      repoSlug: "owner/repo",
      task: "clear prefetch context",
      baseBranch: "main",
      requestedBy: "U123",
      channelId: "C123",
      threadTs: "123.456",
      runtime: "local",
      workItemId: "11111111-1111-1111-1111-111111111111",
      autoReviewSourceSubstate: "pr_adopted",
      prefetchContext: {
        meta: {
          fetchedAt: new Date().toISOString(),
          sources: ["jira"],
        },
        workItem: {
          id: "11111111-1111-1111-1111-111111111111",
          title: "Prefetch test",
          workflow: "feature_delivery",
        },
      },
    },
    "gooseherd"
  );

  const cleared = await store.updateRun(created.id, {
    workItemId: undefined,
    prefetchContext: undefined,
    autoReviewSourceSubstate: undefined,
  });

  assert.equal(cleared.workItemId, undefined);
  assert.equal(cleared.prefetchContext, undefined);
  assert.equal(cleared.autoReviewSourceSubstate, undefined);

  const loaded = await store.getRun(created.id);
  assert.equal(loaded?.workItemId, undefined);
  assert.equal(loaded?.prefetchContext, undefined);
  assert.equal(loaded?.autoReviewSourceSubstate, undefined);
});

test("RunStore falls back to linked work item PR metadata when run fields are empty", async (t) => {
  const testDb = await createTestDb();
  t.after(testDb.cleanup);

  const store = new RunStore(testDb.db);
  await store.init();
  const workItems = new WorkItemStore(testDb.db);

  const ownerTeamId = "99999999-9999-4999-8999-999999999999";
  const ownerUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  await testDb.db.insert(users).values({
    id: ownerUserId,
    slackUserId: "U_STORE_TEST",
    displayName: "Store Test User",
  });
  await testDb.db.insert(teams).values({
    id: ownerTeamId,
    name: "store-test-team",
    slackChannelId: "C_STORE_TEST",
  });

  const workItem = await workItems.createWorkItem({
    workflow: "feature_delivery",
    state: "auto_review",
    title: "Store fallback test",
    summary: "Ensure runs inherit linked PR metadata on reads.",
    ownerTeamId,
    homeChannelId: "C_STORE_TEST",
    homeThreadTs: "1740000000.800",
    repo: "owner/repo",
    githubPrNumber: 77,
    githubPrUrl: "https://github.com/owner/repo/pull/77",
    createdByUserId: ownerUserId,
  });

  const run = await store.createRun(
    {
      repoSlug: "owner/repo",
      task: "run missing PR metadata",
      baseBranch: "main",
      requestedBy: "work-item:auto-review",
      channelId: "C_STORE_TEST",
      threadTs: "1740000000.800",
      runtime: "kubernetes",
      workItemId: workItem.id,
    },
    "gooseherd"
  );

  const loaded = await store.getRun(run.id);
  assert.equal(loaded?.prUrl, "https://github.com/owner/repo/pull/77");
  assert.equal(loaded?.prNumber, 77);

  const linkedRuns = await store.listRunsForWorkItem(workItem.id);
  assert.equal(linkedRuns[0]?.prUrl, "https://github.com/owner/repo/pull/77");
  assert.equal(linkedRuns[0]?.prNumber, 77);

  const listedRuns = await store.listRuns(10);
  const listed = listedRuns.find((candidate) => candidate.id === run.id);
  assert.equal(listed?.prUrl, "https://github.com/owner/repo/pull/77");
  assert.equal(listed?.prNumber, 77);
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
  assert.equal(mapPhaseToRunStatus("awaiting_ci"), "running");
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

test("recoverInProgressRuns leaves kubernetes runs untouched for reconciliation", async (t) => {
  const { store, cleanup } = await createStore();
  t.after(cleanup);

  const run = await store.createRun(
    {
      repoSlug: "owner/repo",
      task: "reconcile me via kubernetes facts",
      baseBranch: "main",
      requestedBy: "U1",
      channelId: "C1",
      threadTs: "1",
      runtime: "kubernetes"
    },
    "gooseherd"
  );

  await store.updateRun(run.id, {
    status: "running",
    phase: "agent",
    startedAt: new Date().toISOString()
  });

  const recovered = await store.recoverInProgressRuns("Recovered after process restart. Auto-requeued.");
  const unchanged = await store.getRun(run.id);

  assert.equal(recovered.length, 0);
  assert.equal(unchanged?.status, "running");
  assert.equal(unchanged?.phase, "agent");
});
