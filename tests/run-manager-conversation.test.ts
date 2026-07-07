import test from "node:test";
import assert from "node:assert/strict";
import { RunManager } from "../src/run-manager.js";
import { RunStore } from "../src/store.js";
import type { AppConfig } from "../src/config.js";
import type { RuntimeRegistry } from "../src/runtime/backend.js";
import type { RunRecord, ExecutionResult } from "../src/types.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";

function makeConfig(): AppConfig {
  return {
    appName: "TestHerd",
    appSlug: "testherd",
    slackBotToken: "xoxb-test",
    slackAppToken: "xapp-test",
    slackSigningSecret: "test-secret",
    slackCommandName: "testherd",
    slackAllowedChannels: [],
    repoAllowlist: [],
    runnerConcurrency: 1,
    workRoot: "/tmp/test-work",
    dataDir: "/tmp/test-data",
    dryRun: false,
    branchPrefix: "testherd",
    defaultBaseBranch: "main",
    gitAuthorName: "Test",
    gitAuthorEmail: "test@test.com",
    agentCommandTemplate: "echo test",
    validationCommand: "",
    lintFixCommand: "",
    maxValidationRounds: 0,
    agentTimeoutSeconds: 60,
    slackProgressHeartbeatSeconds: 30,
    dashboardEnabled: false,
    dashboardHost: "localhost",
    dashboardPort: 3000,
    maxTaskChars: 2000,
    workspaceCleanupEnabled: false,
    workspaceMaxAgeHours: 24,
    workspaceCleanupIntervalMinutes: 60,
    cemsEnabled: false,
    pipelineFile: "pipelines/pipeline.yml",
    observerEnabled: false,
    observerAlertChannelId: "",
    observerMaxRunsPerDay: 10,
    observerMaxRunsPerRepoPerDay: 5,
    observerCooldownMinutes: 5,
    observerRulesFile: "",
    observerRepoMap: new Map(),
    observerSentryPollIntervalSeconds: 300,
    sandboxRuntime: "local",
    sandboxRuntimeExplicit: false,
    sandboxEnabled: false,
  } as AppConfig;
}

function makeMockSlackClient() {
  return {
    chat: {
      postMessage: async () => ({ ts: "1234567890.123456" }),
      update: async () => undefined,
      postEphemeral: async () => undefined,
    },
  };
}

function makeMockPipelineEngine(): RuntimeRegistry {
  const execute = async (_run: RunRecord): Promise<ExecutionResult> => {
    return {
      branchName: "test-branch",
      logsPath: "/tmp/test.log",
      commitSha: "abc123",
      changedFiles: [],
      prUrl: "https://example.com/pr",
      prNumber: 1,
    } as ExecutionResult;
  };
  return {
    local: { runtime: "local", execute },
    docker: { runtime: "docker", execute },
    kubernetes: undefined,
  };
}

async function setup(): Promise<{ store: RunStore; manager: RunManager; testDb: TestDb }> {
  const testDb = await createTestDb();
  const store = new RunStore(testDb.db);
  await store.init();
  const config = makeConfig();
  const manager = new RunManager(config, store, makeMockPipelineEngine(), makeMockSlackClient() as never);
  return { store, manager, testDb };
}

test("getOrCreateConversationRun creates a new run when no thread run exists", async () => {
  const { store, manager, testDb } = await setup();
  try {
    const run = await manager.getOrCreateConversationRun({
      channelId: "C1",
      threadTs: "1700000000.0",
      requestedBy: "U1",
      firstMessage: "hi",
    });
    assert.equal(run.status, "conversation");
    assert.equal(run.intent?.kind, "conversation");
    const reloaded = await store.getRun(run.id);
    assert.ok(reloaded);
  } finally {
    await testDb.cleanup();
  }
});

test("getOrCreateConversationRun reuses an active conversation run", async () => {
  const { manager, testDb } = await setup();
  try {
    const first = await manager.getOrCreateConversationRun({
      channelId: "C2",
      threadTs: "1700000001.0",
      requestedBy: "U2",
      firstMessage: "first",
    });
    const second = await manager.getOrCreateConversationRun({
      channelId: "C2",
      threadTs: "1700000001.0",
      requestedBy: "U2",
      firstMessage: "second",
    });
    assert.equal(second.id, first.id);
    assert.equal(second.task, "first");
  } finally {
    await testDb.cleanup();
  }
});

test("getOrCreateConversationRun chains a new run after a terminal run", async () => {
  const { store, manager, testDb } = await setup();
  try {
    const first = await manager.getOrCreateConversationRun({
      channelId: "C3",
      threadTs: "1700000002.0",
      requestedBy: "U3",
      firstMessage: "first",
    });
    await store.updateRun(first.id, { status: "completed", phase: "completed" });

    const second = await manager.getOrCreateConversationRun({
      channelId: "C3",
      threadTs: "1700000002.0",
      requestedBy: "U3",
      firstMessage: "follow-up",
    });
    assert.notEqual(second.id, first.id);
    assert.equal(second.parentRunId, first.id);
    assert.equal(second.chainIndex, 1);
  } finally {
    await testDb.cleanup();
  }
});

test("recordConversationTurn accumulates token usage across calls", async () => {
  const { store, manager, testDb } = await setup();
  try {
    const run = await manager.getOrCreateConversationRun({
      channelId: "C4",
      threadTs: "1700000003.0",
      requestedBy: "U4",
      firstMessage: "hi",
    });
    await manager.recordConversationTurn(run.id, [
      { model: "gpt-4.1-mini", input: 100, output: 50 },
    ]);
    await manager.recordConversationTurn(run.id, [
      { model: "gpt-4.1-mini", input: 200, output: 100 },
    ]);
    const updated = await store.getRun(run.id);
    const entry = updated?.tokenUsage?.byModel?.find((m) => m.model === "gpt-4.1-mini");
    assert.equal(entry?.input, 300);
    assert.equal(entry?.output, 150);
  } finally {
    await testDb.cleanup();
  }
});

test("promoteConversationToBuild updates run and triggers requeue", async () => {
  const { store, manager, testDb } = await setup();
  try {
    const requeued: string[] = [];
    const original = manager.requeueExistingRun.bind(manager);
    manager.requeueExistingRun = (id: string) => {
      requeued.push(id);
    };

    const run = await manager.getOrCreateConversationRun({
      channelId: "C5",
      threadTs: "1700000004.0",
      requestedBy: "U5",
      firstMessage: "explain",
    });

    await manager.promoteConversationToBuild(run.id, {
      repoSlug: "owner/repo",
      synthesizedTask: "Implement caching",
      intent: {
        version: 1,
        kind: "generic_task",
        source: "slack",
        requestedBy: "U5",
      },
    });

    const updated = await store.getRun(run.id);
    assert.equal(updated?.status, "queued");
    assert.equal(updated?.repoSlug, "owner/repo");
    assert.equal(updated?.task, "Implement caching");
    assert.deepEqual(requeued, [run.id]);

    manager.requeueExistingRun = original;
  } finally {
    await testDb.cleanup();
  }
});

test("findActiveConversationRunForThread returns the run only while in conversation status", async () => {
  const { store, manager, testDb } = await setup();
  try {
    const run = await manager.getOrCreateConversationRun({
      channelId: "C-FINDACTIVE",
      threadTs: "1700000010.0",
      requestedBy: "U1",
      firstMessage: "hi",
    });

    const found = await manager.findActiveConversationRunForThread("C-FINDACTIVE", "1700000010.0");
    assert.equal(found?.id, run.id);

    // After promotion, should no longer find an active conversation run for the thread.
    await store.promoteConversationRun(run.id, {
      repoSlug: "owner/repo",
      task: "synthesized",
      intent: { version: 1, kind: "generic_task", source: "slack", requestedBy: "U1" },
    });
    const afterPromote = await manager.findActiveConversationRunForThread("C-FINDACTIVE", "1700000010.0");
    assert.equal(afterPromote, undefined);
  } finally {
    await testDb.cleanup();
  }
});

test("findActiveConversationRunForThread returns undefined when no run exists", async () => {
  const { manager, testDb } = await setup();
  try {
    const found = await manager.findActiveConversationRunForThread("C-NOTHING", "1700000099.0");
    assert.equal(found, undefined);
  } finally {
    await testDb.cleanup();
  }
});
