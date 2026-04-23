import assert from "node:assert/strict";
import test from "node:test";
import { RunManager, classifyError } from "../src/run-manager.js";
import { RunStore } from "../src/store.js";
import type { AppConfig } from "../src/config.js";
import type { RuntimeRegistry } from "../src/runtime/backend.js";
import type { RunRecord, ExecutionResult } from "../src/types.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";

// ── Mock factories ─────────────────────────────────────

function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
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
    ...overrides
  } as AppConfig;
}

interface MockSlackClient {
  chat: {
    postMessage: (args: Record<string, unknown>) => Promise<{ ts: string }>;
    update: (args: Record<string, unknown>) => Promise<void>;
    postEphemeral: (args: Record<string, unknown>) => Promise<void>;
  };
  _calls: Array<{ method: string; args: Record<string, unknown> }>;
}

function makeMockSlackClient(): MockSlackClient {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  return {
    chat: {
      postMessage: async (args) => {
        calls.push({ method: "chat.postMessage", args });
        return { ts: "1234567890.123456" };
      },
      update: async (args) => {
        calls.push({ method: "chat.update", args });
      },
      postEphemeral: async (args) => {
        calls.push({ method: "chat.postEphemeral", args });
      }
    },
    _calls: calls
  };
}

function makeMockPipelineEngine(result?: Partial<ExecutionResult>): RuntimeRegistry {
  const execute = async (_run: RunRecord, { onPhase }: { onPhase: (phase: string) => Promise<void> }) => {
    await onPhase("cloning");
    await onPhase("agent");
    await onPhase("committing");
    await onPhase("pushing");
    return {
      branchName: "testherd/test-branch",
      logsPath: "/tmp/test-work/test-run/run.log",
      commitSha: "abc1234def5678",
      changedFiles: ["src/index.ts", "src/config.ts"],
      prUrl: "https://github.com/org/repo/pull/42",
      prNumber: 42,
      ...result
    } as ExecutionResult;
  };

  return {
    local: { runtime: "local", execute },
    docker: { runtime: "docker", execute },
    kubernetes: undefined
  };
}

function makeMockPipelineEngineFailing(errorMessage: string): RuntimeRegistry {
  const execute = async (_run: RunRecord, { onPhase }: { onPhase: (phase: string) => Promise<void> }) => {
    await onPhase("cloning");
    await onPhase("agent");
    throw new Error(errorMessage);
  };

  return {
    local: { runtime: "local", execute },
    docker: { runtime: "docker", execute },
    kubernetes: undefined
  };
}

// ── Test helpers ────────────────────────────────────────

async function setupTestStore(): Promise<{ store: RunStore; testDb: TestDb }> {
  const testDb = await createTestDb();
  const store = new RunStore(testDb.db);
  await store.init();
  return { store, testDb };
}

/** Poll until a run reaches a terminal status (completed/failed) or throw on timeout. */
async function waitForRunDone(store: RunStore, runId: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await store.getRun(runId);
    if (run && (run.status === "completed" || run.status === "failed" || run.status === "cancelled")) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`waitForRunDone: run ${runId} did not reach terminal status within ${timeoutMs}ms`);
}

async function waitForRunStatus(
  store: RunStore,
  runId: string,
  expectedStatus: RunRecord["status"],
  timeoutMs = 15000,
): Promise<RunRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await store.getRun(runId);
    if (run?.status === expectedStatus) {
      return run;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`waitForRunStatus: run ${runId} did not reach status ${expectedStatus} within ${timeoutMs}ms`);
}

async function waitForManagerIdle(manager: RunManager): Promise<void> {
  await ((manager as unknown) as { queue: { onIdle: () => Promise<void> } }).queue.onIdle();
}

// ── enqueueRun ─────────────────────────────────────────

test("enqueueRun creates a run record and returns it", async () => {
  const { store, testDb } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const mockPipeline = makeMockPipelineEngine();
  const config = makeConfig();

  const manager = new RunManager(config, store, mockPipeline, mockClient as any);

  const run = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "fix the bug",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000",
    runtime: config.sandboxRuntime
  });

  assert.ok(run.id, "Run should have an ID");
  assert.equal(run.status, "queued");
  assert.equal(run.repoSlug, "org/repo");
  assert.equal(run.task, "fix the bug");
  assert.ok(run.branchName.startsWith("testherd/"));

  await waitForRunDone(store, run.id);
  await testDb.cleanup();
});

test("run manager prefetches work item context before backend dispatch and persists it", async () => {
  const { store, testDb } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const config = makeConfig();
  const callOrder: string[] = [];
  const workItemId = "11111111-1111-1111-1111-111111111111";
  const prefetchContext: NonNullable<RunRecord["prefetchContext"]> = {
    meta: {
      fetchedAt: "2026-04-17T00:00:00.000Z",
      sources: ["jira"],
    },
    workItem: {
      id: workItemId,
      title: "Work item",
      workflow: "feature_delivery",
    },
    jira: {
      issue: {
        key: "HUB-1",
        description: "issue description",
      },
      comments: [],
    },
  };

  const runtimeRegistry: RuntimeRegistry = {
    local: {
      runtime: "local",
      execute: async (run, { onPhase }) => {
        callOrder.push("execute");
        assert.deepEqual(run.prefetchContext, prefetchContext);
        const stored = await store.getRun(run.id);
        assert.deepEqual(stored?.prefetchContext, prefetchContext);
        await onPhase("cloning");
        return {
          branchName: "testherd/test-branch",
          logsPath: "/tmp/test-work/test-run/run.log",
          commitSha: "abc1234def5678",
          changedFiles: ["src/index.ts"],
          prUrl: "https://github.com/org/repo/pull/42",
        } satisfies ExecutionResult;
      },
    },
    docker: undefined,
    kubernetes: undefined,
  };

  const prefetcher = {
    prefetch: async (run: RunRecord) => {
      callOrder.push("prefetch");
      assert.equal(run.workItemId, workItemId);
      return prefetchContext;
    },
  };

  const manager = new RunManager(config, store, runtimeRegistry, mockClient as any, undefined, undefined, undefined, prefetcher);

  const run = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "prefetch before dispatch",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000",
    runtime: config.sandboxRuntime,
    workItemId,
  });

  await waitForRunDone(store, run.id);

  assert.deepEqual(callOrder, ["prefetch", "execute"]);

  await testDb.cleanup();
});

test("run manager fails closed when prefetch throws for a linked work item", async () => {
  const { store, testDb } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const config = makeConfig();
  let backendCalled = false;
  const workItemId = "22222222-2222-2222-2222-222222222222";

  const runtimeRegistry: RuntimeRegistry = {
    local: {
      runtime: "local",
      execute: async () => {
        backendCalled = true;
        throw new Error("backend should not have been called");
      },
    },
    docker: undefined,
    kubernetes: undefined,
  };

  const prefetcher = {
    prefetch: async (run: RunRecord) => {
      assert.equal(run.workItemId, workItemId);
      throw new Error("prefetch boom");
    },
  };

  const manager = new RunManager(config, store, runtimeRegistry, mockClient as any, undefined, undefined, undefined, prefetcher);

  const run = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "prefetch failure",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000",
    runtime: config.sandboxRuntime,
    workItemId,
  });

  const failed = await waitForRunStatus(store, run.id, "failed");
  assert.equal(failed.error, "prefetch boom");
  assert.equal(backendCalled, false);

  await testDb.cleanup();
});

test("run manager can cancel a run while prefetch is still pending", async () => {
  const { store, testDb } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const config = makeConfig();
  let backendCalled = false;
  let resolvePrefetch: ((value: RunRecord["prefetchContext"]) => void) | undefined;

  const runtimeRegistry: RuntimeRegistry = {
    local: {
      runtime: "local",
      execute: async () => {
        backendCalled = true;
        throw new Error("backend should not have been called");
      },
    },
    docker: undefined,
    kubernetes: undefined,
  };

  const prefetcher = {
    prefetch: async () =>
      await new Promise<RunRecord["prefetchContext"]>((resolve) => {
        resolvePrefetch = resolve;
      }),
  };

  const manager = new RunManager(config, store, runtimeRegistry, mockClient as any, undefined, undefined, undefined, prefetcher);

  const run = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "cancel during prefetch",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000",
    runtime: config.sandboxRuntime,
    workItemId: "33333333-3333-3333-3333-333333333333",
  });

  await waitForRunStatus(store, run.id, "running");
  const cancelled = await manager.cancelRun(run.id);
  assert.equal(cancelled, true);

  const terminal = await waitForRunStatus(store, run.id, "cancelled");
  assert.equal(terminal.error, "Run cancelled");
  assert.equal(backendCalled, false);

  resolvePrefetch?.(undefined);
  await waitForManagerIdle(manager);
  await testDb.cleanup();
});

test("run manager can cancel a kubernetes run while prefetch is still pending", async () => {
  const { store, testDb } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const config = makeConfig();
  let backendCalled = false;
  let resolvePrefetch: ((value: RunRecord["prefetchContext"]) => void) | undefined;

  const runtimeRegistry: RuntimeRegistry = {
    local: undefined,
    docker: undefined,
    kubernetes: {
      runtime: "kubernetes",
      execute: async () => {
        backendCalled = true;
        throw new Error("backend should not have been called");
      },
    },
  };

  const prefetcher = {
    prefetch: async () =>
      await new Promise<RunRecord["prefetchContext"]>((resolve) => {
        resolvePrefetch = resolve;
      }),
  };

  const manager = new RunManager(config, store, runtimeRegistry, mockClient as any, undefined, undefined, undefined, prefetcher);

  const run = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "cancel kubernetes during prefetch",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000",
    runtime: "kubernetes",
    workItemId: "33333333-3333-3333-3333-333333333334",
  });

  await waitForRunStatus(store, run.id, "running");
  const cancelled = await manager.cancelRun(run.id);
  assert.equal(cancelled, true);

  const cancelling = await waitForRunStatus(store, run.id, "cancel_requested");
  assert.equal(cancelling.phase, "cancel_requested");

  const terminal = await waitForRunStatus(store, run.id, "cancelled");
  assert.equal(terminal.error, "Run cancelled");
  assert.equal(backendCalled, false);

  resolvePrefetch?.(undefined);
  await waitForManagerIdle(manager);
  await testDb.cleanup();
});

test("run manager reloads latest run state before prefetch and backend dispatch", async () => {
  const { store, testDb } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const config = makeConfig();
  const workItemId = "44444444-4444-4444-4444-444444444444";
  const prefetchContext: NonNullable<RunRecord["prefetchContext"]> = {
    meta: {
      fetchedAt: "2026-04-17T00:00:00.000Z",
      sources: ["jira"],
    },
    workItem: {
      id: workItemId,
      title: "Late-linked work item",
      workflow: "feature_delivery",
    },
    jira: {
      issue: {
        key: "HUB-444",
        description: "late-linked issue description",
      },
      comments: [],
    },
  };
  const originalUpdateRun = store.updateRun.bind(store);
  let linkedAfterStart = false;

  (store as typeof store & {
    updateRun: typeof store.updateRun;
  }).updateRun = async (runId, patch) => {
    const updated = await originalUpdateRun(runId, patch);
    if (patch.status === "running" && !linkedAfterStart) {
      linkedAfterStart = true;
      await originalUpdateRun(runId, { workItemId });
    }
    return updated;
  };

  const runtimeRegistry: RuntimeRegistry = {
    local: {
      runtime: "local",
      execute: async (run) => {
        assert.equal(run.workItemId, workItemId);
        assert.deepEqual(run.prefetchContext, prefetchContext);
        return {
          branchName: "testherd/test-branch",
          logsPath: "/tmp/test-work/test-run/run.log",
          commitSha: "abc1234def5678",
          changedFiles: ["src/index.ts"],
        } satisfies ExecutionResult;
      },
    },
    docker: undefined,
    kubernetes: undefined,
  };

  let prefetchedWorkItemId: string | undefined;
  const prefetcher = {
    prefetch: async (run: RunRecord) => {
      prefetchedWorkItemId = run.workItemId;
      return prefetchContext;
    },
  };

  const manager = new RunManager(config, store, runtimeRegistry, mockClient as any, undefined, undefined, undefined, prefetcher);

  const run = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "reload before prefetch",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000",
    runtime: config.sandboxRuntime,
  });

  await waitForRunDone(store, run.id);

  assert.equal(prefetchedWorkItemId, workItemId);

  await testDb.cleanup();
});

test("run manager refreshes run state again after resolving the pipeline before dispatch", async () => {
  const { store, testDb } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const config = makeConfig();
  const workItemId = "55555555-5555-5555-5555-555555555555";
  const prefetchContext: NonNullable<RunRecord["prefetchContext"]> = {
    meta: {
      fetchedAt: "2026-04-17T00:00:00.000Z",
      sources: ["jira"],
    },
    workItem: {
      id: workItemId,
      title: "Post-resolve linked work item",
      workflow: "feature_delivery",
    },
    jira: {
      issue: {
        key: "HUB-555",
        description: "post-resolve issue description",
      },
      comments: [],
    },
  };
  let linkedDuringResolve = false;

  const runtimeRegistry: RuntimeRegistry = {
    local: {
      runtime: "local",
      execute: async (run) => {
        assert.equal(run.workItemId, workItemId);
        assert.deepEqual(run.prefetchContext, prefetchContext);
        return {
          branchName: "testherd/test-branch",
          logsPath: "/tmp/test-work/test-run/run.log",
          commitSha: "abc1234def5678",
          changedFiles: ["src/index.ts"],
        } satisfies ExecutionResult;
      },
    },
    docker: undefined,
    kubernetes: undefined,
  };

  let prefetchedWorkItemId: string | undefined;
  const prefetcher = {
    prefetch: async (run: RunRecord) => {
      prefetchedWorkItemId = run.workItemId;
      return prefetchContext;
    },
  };

  const manager = new RunManager(config, store, runtimeRegistry, mockClient as any, undefined, undefined, undefined, prefetcher);
  (manager as unknown as {
    resolvePipeline: (hint: string | undefined, runId: string) => Promise<string>;
  }).resolvePipeline = async (_hint, runId) => {
    if (!linkedDuringResolve) {
      linkedDuringResolve = true;
      await store.updateRun(runId, { workItemId });
    }
    return config.pipelineFile;
  };

  const run = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "refresh after resolvePipeline",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000",
    runtime: config.sandboxRuntime,
  });

  await waitForRunDone(store, run.id);

  assert.equal(prefetchedWorkItemId, workItemId);

  await testDb.cleanup();
});

test("run manager invalidates stale prefetched context when the linked work item changes", async () => {
  const { store, testDb } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const config = makeConfig();
  const initialWorkItemId = "66666666-6666-6666-6666-666666666666";
  const relinkedWorkItemId = "77777777-7777-7777-7777-777777777777";
  const initialPrefetchContext: NonNullable<RunRecord["prefetchContext"]> = {
    meta: {
      fetchedAt: "2026-04-17T00:00:00.000Z",
      sources: ["jira"],
    },
    workItem: {
      id: initialWorkItemId,
      title: "Original work item",
      workflow: "feature_delivery",
    },
    jira: {
      issue: {
        key: "HUB-666",
        description: "original issue description",
      },
      comments: [],
    },
  };
  const relinkedPrefetchContext: NonNullable<RunRecord["prefetchContext"]> = {
    meta: {
      fetchedAt: "2026-04-17T00:00:01.000Z",
      sources: ["jira"],
    },
    workItem: {
      id: relinkedWorkItemId,
      title: "Relinked work item",
      workflow: "feature_delivery",
    },
    jira: {
      issue: {
        key: "HUB-777",
        description: "relinked issue description",
      },
      comments: [],
    },
  };
  let relinkedDuringResolve = false;

  const runtimeRegistry: RuntimeRegistry = {
    local: {
      runtime: "local",
      execute: async (run) => {
        assert.equal(run.workItemId, relinkedWorkItemId);
        assert.deepEqual(run.prefetchContext, relinkedPrefetchContext);
        return {
          branchName: "testherd/test-branch",
          logsPath: "/tmp/test-work/test-run/run.log",
          commitSha: "abc1234def5678",
          changedFiles: ["src/index.ts"],
        } satisfies ExecutionResult;
      },
    },
    docker: undefined,
    kubernetes: undefined,
  };

  const prefetcher = {
    prefetch: async (run: RunRecord) => {
      if (run.workItemId === initialWorkItemId) {
        return initialPrefetchContext;
      }
      if (run.workItemId === relinkedWorkItemId) {
        return relinkedPrefetchContext;
      }
      throw new Error(`unexpected work item id: ${run.workItemId}`);
    },
  };

  const manager = new RunManager(config, store, runtimeRegistry, mockClient as any, undefined, undefined, undefined, prefetcher);
  (manager as unknown as {
    resolvePipeline: (hint: string | undefined, runId: string) => Promise<string>;
  }).resolvePipeline = async (_hint, runId) => {
    if (!relinkedDuringResolve) {
      relinkedDuringResolve = true;
      await store.updateRun(runId, { workItemId: relinkedWorkItemId });
    }
    return config.pipelineFile;
  };

  const run = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "invalidate stale prefetched context",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000",
    runtime: config.sandboxRuntime,
    workItemId: initialWorkItemId,
  });

  await waitForRunDone(store, run.id);

  await testDb.cleanup();
});

test("run manager clears persisted prefetch context when the linked work item is removed before dispatch", async () => {
  const { store, testDb } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const config = makeConfig();
  const workItemId = "88888888-8888-8888-8888-888888888888";
  const prefetchContext: NonNullable<RunRecord["prefetchContext"]> = {
    meta: {
      fetchedAt: "2026-04-17T00:00:00.000Z",
      sources: ["jira"],
    },
    workItem: {
      id: workItemId,
      title: "Transient work item",
      workflow: "feature_delivery",
    },
    jira: {
      issue: {
        key: "HUB-888",
        description: "transient issue description",
      },
      comments: [],
    },
  };
  let prefetchCalls = 0;
  let unlinkedDuringResolve = false;

  const runtimeRegistry: RuntimeRegistry = {
    local: {
      runtime: "local",
      execute: async (run) => {
        assert.equal(run.workItemId, undefined);
        assert.equal(run.prefetchContext, undefined);
        assert.equal(run.autoReviewSourceSubstate, undefined);
        return {
          branchName: "testherd/test-branch",
          logsPath: "/tmp/test-work/test-run/run.log",
          commitSha: "abc1234def5678",
          changedFiles: ["src/index.ts"],
        } satisfies ExecutionResult;
      },
    },
    docker: undefined,
    kubernetes: undefined,
  };

  const prefetcher = {
    prefetch: async (run: RunRecord) => {
      prefetchCalls += 1;
      assert.equal(run.workItemId, workItemId);
      return prefetchContext;
    },
  };

  const manager = new RunManager(config, store, runtimeRegistry, mockClient as any, undefined, undefined, undefined, prefetcher);
  (manager as unknown as {
    resolvePipeline: (hint: string | undefined, runId: string) => Promise<string>;
  }).resolvePipeline = async (_hint, runId) => {
    if (!unlinkedDuringResolve) {
      unlinkedDuringResolve = true;
      await store.updateRun(runId, { workItemId: undefined });
    }
    return config.pipelineFile;
  };

  const run = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "clear stale prefetched context after unlink",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000",
    runtime: config.sandboxRuntime,
    workItemId,
    autoReviewSourceSubstate: "pr_adopted",
  });

  await waitForRunDone(store, run.id);

  assert.equal(prefetchCalls, 1);
  const stored = await store.getRun(run.id);
  assert.equal(stored?.workItemId, undefined);
  assert.equal(stored?.prefetchContext, undefined);
  assert.equal(stored?.autoReviewSourceSubstate, undefined);

  await testDb.cleanup();
});

// ── retryRun ───────────────────────────────────────────

test("retryRun creates a new run from a completed run", async () => {
  const { store, testDb } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const mockPipeline = makeMockPipelineEngine();
  const config = makeConfig();

  const manager = new RunManager(config, store, mockPipeline, mockClient as any);

  const original = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "original task",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000",
    runtime: config.sandboxRuntime
  });

  // Wait for background processRun to complete first
  await waitForRunDone(store, original.id);

  const retried = await manager.retryRun(original.id, "U5678");
  assert.ok(retried, "Retry should return a new run");
  assert.notEqual(retried!.id, original.id, "Retried run should have a different ID");
  assert.equal(retried!.repoSlug, "org/repo");
  assert.equal(retried!.task, "original task");
  assert.equal(retried!.requestedBy, "U5678");
  // retryRun does NOT set parentRunId
  assert.equal(retried!.parentRunId, undefined);

  await waitForRunDone(store, retried!.id);
  await testDb.cleanup();
});

test("retryRun returns undefined for queued/running run", async () => {
  const { store, testDb } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const mockPipeline = makeMockPipelineEngine();
  const config = makeConfig();

  const manager = new RunManager(config, store, mockPipeline, mockClient as any);

  // Create run directly via store to avoid triggering background processRun
  const run = await store.createRun({
    repoSlug: "org/repo",
    task: "still running",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000",
    runtime: "local"
  }, "testherd");

  // Run is in "queued" status — retry should be blocked
  const result = await manager.retryRun(run.id, "U5678");
  assert.equal(result, undefined, "Should not retry a queued run");

  await testDb.cleanup();
});

test("retryRun returns undefined for non-existent run", async () => {
  const { store, testDb } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const mockPipeline = makeMockPipelineEngine();
  const config = makeConfig();

  const manager = new RunManager(config, store, mockPipeline, mockClient as any);

  const result = await manager.retryRun("00000000-0000-0000-0000-000000000000", "U1234");
  assert.equal(result, undefined);

  await testDb.cleanup();
});

// ── continueRun ────────────────────────────────────────

test("continueRun creates a chained run with parentRunId", async () => {
  const { store, testDb } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const mockPipeline = makeMockPipelineEngine();
  const config = makeConfig();

  const manager = new RunManager(config, store, mockPipeline, mockClient as any);

  const parent = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "initial task",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000",
    runtime: config.sandboxRuntime
  });

  const continued = await manager.continueRun(parent.id, "fix the tests too", "U1234");
  assert.ok(continued, "Continue should return a new run");
  assert.notEqual(continued!.id, parent.id);
  assert.equal(continued!.parentRunId, parent.id);
  assert.equal(continued!.feedbackNote, "fix the tests too");
  assert.equal(continued!.task, "fix the tests too");
  assert.equal(continued!.repoSlug, "org/repo");
  // Should reuse parent's branch
  assert.equal(continued!.branchName, parent.branchName);

  await waitForRunDone(store, parent.id);
  await waitForRunDone(store, continued!.id);
  await testDb.cleanup();
});

test("continueRun returns undefined for non-existent parent", async () => {
  const { store, testDb } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const mockPipeline = makeMockPipelineEngine();
  const config = makeConfig();

  const manager = new RunManager(config, store, mockPipeline, mockClient as any);

  const result = await manager.continueRun("00000000-0000-0000-0000-000000000000", "new instructions", "U1234");
  assert.equal(result, undefined);

  await testDb.cleanup();
});

test("run manager notifies status listeners for awaiting_ci and completed transitions", async () => {
  const { store, testDb } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const config = makeConfig();
  const seenStatuses: string[] = [];
  const mockPipeline: RuntimeRegistry = {
    local: {
      runtime: "local",
      execute: async (_run, { onPhase }) => {
        await onPhase("cloning");
        await onPhase("agent");
        await onPhase("awaiting_ci");
        return {
          branchName: "testherd/test-branch",
          logsPath: "/tmp/test-work/test-run/run.log",
          commitSha: "abc1234def5678",
          changedFiles: ["src/index.ts"],
          prUrl: "https://github.com/org/repo/pull/42",
        } satisfies ExecutionResult;
      },
    },
    docker: undefined,
    kubernetes: undefined,
  };

  const manager = new RunManager(config, store, mockPipeline, mockClient as any);
  manager.onRunStatusChange((runId, status) => {
    if (runId) {
      seenStatuses.push(status);
    }
  });

  const run = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "wait for ci",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000",
    runtime: config.sandboxRuntime,
  });

  await waitForRunDone(store, run.id);

  assert.ok(seenStatuses.includes("awaiting_ci"));
  assert.equal(seenStatuses.at(-1), "completed");

  await testDb.cleanup();
});

// ── processRun (via enqueueRun) ────────────────────────

test("processRun posts status card and summary on success", async () => {
  const { store, testDb } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const mockPipeline = makeMockPipelineEngine();
  const config = makeConfig();

  const manager = new RunManager(config, store, mockPipeline, mockClient as any);

  const run = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "add feature",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000",
    runtime: config.sandboxRuntime
  });

  await waitForRunDone(store, run.id);
  await waitForManagerIdle(manager);

  // Should have posted messages: initial card + heartbeat updates + final card + summary
  const postMessages = mockClient._calls.filter((c) => c.method === "chat.postMessage");
  assert.ok(postMessages.length >= 2, `Should have >= 2 postMessages, got ${postMessages.length}`);

  // Last postMessage should be the summary
  const summary = postMessages[postMessages.length - 1];
  assert.ok(summary, "Should have a summary message");
  const summaryText = summary.args.text as string;
  assert.ok(summaryText.includes("Run complete"), "Summary should say 'Run complete'");
  assert.ok(summaryText.includes("org/repo"), "Summary should mention repo");
  assert.ok(summaryText.includes("src/index.ts"), "Summary should list changed files");
  assert.ok(summaryText.includes("github.com/org/repo/pull/42"), "Summary should include PR link");
  assert.ok(summaryText.includes("Reply in this thread"), "Summary should invite follow-up");

  // Summary should have username override
  assert.equal(summary.args.username, "testherd");

  await testDb.cleanup();
});

test("processRun posts failure summary on error", async () => {
  const { store, testDb } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const mockPipeline = makeMockPipelineEngineFailing("Agent timed out");
  const config = makeConfig();

  const manager = new RunManager(config, store, mockPipeline, mockClient as any);

  const run = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "fix the bug",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000",
    runtime: config.sandboxRuntime
  });

  await waitForRunDone(store, run.id);
  await waitForManagerIdle(manager);

  const postMessages = mockClient._calls.filter((c) => c.method === "chat.postMessage");
  const summary = postMessages.findLast((c) => {
    const text = c.args.text;
    return typeof text === "string" && text.includes("Run failed");
  });
  assert.ok(summary, "Should have a summary message on failure");
  const summaryText = summary.args.text as string;
  assert.ok(summaryText.includes("Run failed"), "Summary should say 'Run failed'");
  assert.ok(summaryText.includes("Agent timed out"), "Summary should include error");
  assert.ok(summaryText.includes("retry"), "Summary should suggest retry");

  await testDb.cleanup();
});

test("processRun with local channel skips Slack posts and still completes", async () => {
  const { store, testDb } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const mockPipeline = makeMockPipelineEngine();
  const config = makeConfig();

  const manager = new RunManager(config, store, mockPipeline, mockClient as any);

  const run = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "local trigger task",
    baseBranch: "main",
    requestedBy: "local-trigger",
    channelId: "local",
    threadTs: "local",
    runtime: config.sandboxRuntime
  });

  await waitForRunDone(store, run.id);

  const stored = await store.getRun(run.id);
  assert.equal(stored?.status, "completed");
  assert.equal(stored?.phase, "completed");
  assert.equal(stored?.prNumber, 42);
  assert.equal(mockClient._calls.length, 0, "No Slack API calls should be made for local runs");

  await testDb.cleanup();
});

test("cancelRun marks kubernetes runs as cancel_requested and finalizes them as cancelled", async () => {
  const { store, testDb } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  let executionStarted = false;

  const runtimeRegistry: RuntimeRegistry = {
    local: undefined,
    docker: undefined,
    kubernetes: {
      runtime: "kubernetes",
      execute: async (run, { onPhase }) => {
        await onPhase("agent");
        executionStarted = true;
        while (true) {
          const latest = await store.getRun(run.id);
          if (latest?.status === "cancel_requested") {
            throw new Error("Run cancelled");
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      },
    },
  };
  const config = makeConfig({ sandboxRuntime: "kubernetes" });
  const manager = new RunManager(config, store, runtimeRegistry, mockClient as any);

  const run = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "cancel the kubernetes run",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000",
    runtime: "kubernetes",
  });

  while (!executionStarted) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(await manager.cancelRun(run.id), true);
  const cancelling = await waitForRunStatus(store, run.id, "cancel_requested");
  assert.equal(cancelling.phase, "cancel_requested");

  const cancelled = await waitForRunStatus(store, run.id, "cancelled");
  assert.equal(cancelled.phase, "cancelled");
  assert.ok(cancelled.finishedAt);

  await testDb.cleanup();
});

test("cancelRun does not locally abort kubernetes runs after dispatch", async () => {
  const { store, testDb } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  let executionStarted = false;

  const runtimeRegistry: RuntimeRegistry = {
    local: undefined,
    docker: undefined,
    kubernetes: {
      runtime: "kubernetes",
      execute: async (run, { onPhase, abortSignal }) => {
        await onPhase("agent");
        executionStarted = true;

        await new Promise<void>((resolve, reject) => {
          const interval = setInterval(async () => {
            const latest = await store.getRun(run.id);
            if (latest?.status === "cancel_requested") {
              clearInterval(interval);
              resolve();
            }
          }, 10);
          abortSignal.addEventListener("abort", () => {
            clearInterval(interval);
            reject(new Error("local abort before remote cancellation"));
          }, { once: true });
        });

        throw new Error("remote cancellation observed");
      },
    },
  };
  const config = makeConfig({ sandboxRuntime: "kubernetes" });
  const manager = new RunManager(config, store, runtimeRegistry, mockClient as any);

  const run = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "cancel kubernetes after dispatch",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000",
    runtime: "kubernetes",
  });

  while (!executionStarted) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(await manager.cancelRun(run.id), true);

  const cancelling = await waitForRunStatus(store, run.id, "cancel_requested");
  assert.equal(cancelling.phase, "cancel_requested");

  const cancelled = await waitForRunStatus(store, run.id, "cancelled");
  assert.equal(cancelled.error, "remote cancellation observed");

  await testDb.cleanup();
});

test("cancelRun cancels queued kubernetes runs before they start executing", async () => {
  const { store, testDb } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  let firstRunStarted = false;
  let releaseFirstRun: (() => void) | undefined;
  let kubernetesExecuted = false;
  const firstRunReleased = new Promise<void>((resolve) => {
    releaseFirstRun = resolve;
  });

  const runtimeRegistry: RuntimeRegistry = {
    local: {
      runtime: "local",
      execute: async (_run, { onPhase }) => {
        await onPhase("agent");
        firstRunStarted = true;
        await firstRunReleased;
        return {
          branchName: "testherd/local-branch",
          logsPath: "/tmp/test-work/local/run.log",
          commitSha: "abc12345",
          changedFiles: [],
        };
      },
    },
    docker: undefined,
    kubernetes: {
      runtime: "kubernetes",
      execute: async () => {
        kubernetesExecuted = true;
        throw new Error("queued kubernetes run should not execute after cancellation");
      },
    },
  };

  const manager = new RunManager(makeConfig({ runnerConcurrency: 1 }), store, runtimeRegistry, mockClient as any);

  const first = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "block the queue",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000",
    runtime: "local",
  });

  while (!firstRunStarted) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const queued = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "cancel before kubernetes starts",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000",
    runtime: "kubernetes",
  });

  assert.equal(await manager.cancelRun(queued.id), true);
  const cancelled = await waitForRunStatus(store, queued.id, "cancelled");
  assert.equal(cancelled.phase, "cancelled");

  releaseFirstRun?.();
  await waitForRunDone(store, first.id);
  assert.equal(kubernetesExecuted, false);

  await testDb.cleanup();
});

// ── username override ──────────────────────────────────

test("postOrUpdateRunCard includes username on postMessage", async () => {
  const { store, testDb } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const mockPipeline = makeMockPipelineEngine();
  const config = makeConfig({ slackCommandName: "mybot" });

  const manager = new RunManager(config, store, mockPipeline, mockClient as any);

  const run = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "test username",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000",
    runtime: config.sandboxRuntime
  });

  await waitForRunDone(store, run.id);

  // First postMessage should be the status card
  const firstPost = mockClient._calls.find((c) => c.method === "chat.postMessage");
  assert.ok(firstPost, "Should have at least one postMessage");
  assert.equal(firstPost.args.username, "mybot", "postMessage should include username");

  // chat.update calls should NOT have username (Slack API doesn't support it on updates)
  const updates = mockClient._calls.filter((c) => c.method === "chat.update");
  for (const update of updates) {
    assert.equal(update.args.username, undefined, "chat.update should not include username");
  }

  await testDb.cleanup();
});

// ── formatRunStatus ────────────────────────────────────

test("formatRunStatus returns message when no run found", async () => {
  const { store, testDb } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const mockPipeline = makeMockPipelineEngine();
  const config = makeConfig();

  const manager = new RunManager(config, store, mockPipeline, mockClient as any);

  const status = await manager.formatRunStatus(undefined, "C1234");
  assert.ok(status.includes("No run found"), "Should say no run found");

  await testDb.cleanup();
});

test("formatRunStatus returns not found for bad ID", async () => {
  const { store, testDb } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const mockPipeline = makeMockPipelineEngine();
  const config = makeConfig();

  const manager = new RunManager(config, store, mockPipeline, mockClient as any);

  const status = await manager.formatRunStatus("nonexistent", "C1234");
  assert.ok(status.includes("not found"), "Should say run not found");

  await testDb.cleanup();
});

// ── getLatestRunForThread ──────────────────────────────

test("getLatestRunForThread returns the most recent run", async () => {
  const { store, testDb } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const mockPipeline = makeMockPipelineEngine();
  const config = makeConfig();

  const manager = new RunManager(config, store, mockPipeline, mockClient as any);

  const first = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "first",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000",
    runtime: config.sandboxRuntime
  });

  const second = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "second",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000",
    runtime: config.sandboxRuntime
  });

  const latest = await manager.getLatestRunForThread("C1234", "1234567890.000000");
  assert.ok(latest, "Should find a run");
  assert.equal(latest!.id, second.id, "Should return the most recent run");

  await waitForRunDone(store, first.id);
  await waitForRunDone(store, second.id);
  await testDb.cleanup();
});

// ── getRunChain ────────────────────────────────────────

test("getRunChain returns all runs in a thread sorted by creation", async () => {
  const { store, testDb } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const mockPipeline = makeMockPipelineEngine();
  const config = makeConfig();

  const manager = new RunManager(config, store, mockPipeline, mockClient as any);

  const first = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "first",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000",
    runtime: config.sandboxRuntime
  });

  const second = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "second",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000",
    runtime: config.sandboxRuntime
  });

  const chain = await manager.getRunChain("C1234", "1234567890.000000");
  assert.equal(chain.length, 2);
  assert.equal(chain[0].id, first.id);
  assert.equal(chain[1].id, second.id);

  // Different thread should return empty
  const other = await manager.getRunChain("C1234", "9999999999.000000");
  assert.equal(other.length, 0);

  await waitForRunDone(store, first.id);
  await waitForRunDone(store, second.id);
  await testDb.cleanup();
});

// ── summary message content ────────────────────────────

test("summary includes task preview when task is long", async () => {
  const { store, testDb } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const longTask = "a".repeat(200);
  const mockPipeline = makeMockPipelineEngine();
  const config = makeConfig();

  const manager = new RunManager(config, store, mockPipeline, mockClient as any);

  const run = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: longTask,
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000",
    runtime: config.sandboxRuntime
  });

  await waitForRunDone(store, run.id);
  await waitForManagerIdle(manager);

  const postMessages = mockClient._calls.filter((c) => c.method === "chat.postMessage");
  const summary = postMessages[postMessages.length - 1];
  const summaryText = summary.args.text as string;
  assert.ok(summaryText.includes("..."), "Long task should be truncated with ellipsis");

  await testDb.cleanup();
});

test("summary limits displayed files to 10", async () => {
  const { store, testDb } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const manyFiles = Array.from({ length: 15 }, (_, i) => `src/file${String(i)}.ts`);
  const mockPipeline = makeMockPipelineEngine({ changedFiles: manyFiles });
  const config = makeConfig();

  const manager = new RunManager(config, store, mockPipeline, mockClient as any);

  const run = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "many file changes",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000",
    runtime: config.sandboxRuntime
  });

  await waitForRunDone(store, run.id);
  await waitForManagerIdle(manager);

  const postMessages = mockClient._calls.filter((c) => c.method === "chat.postMessage");
  const summary = postMessages[postMessages.length - 1];
  const summaryText = summary.args.text as string;
  assert.ok(summaryText.includes("+5 more"), "Should show overflow count for files > 10");

  await testDb.cleanup();
});

// ── classifyError ─────────────────────────────────────

test("classifyError matches clone failures", () => {
  const result = classifyError("fatal: repository 'https://github.com/org/repo' not found");
  assert.equal(result.category, "clone");
  assert.ok(result.friendly.includes("clone"));

  const result2 = classifyError("failed to clone org/repo");
  assert.equal(result2.category, "clone");

  const result3 = classifyError("Failed to fetch parent branch 'fix/typo' from origin.");
  assert.equal(result3.category, "clone");

  const result4 = classifyError("Failed to checkout parent branch 'fix/typo'.");
  assert.equal(result4.category, "clone");
});

test("classifyError matches timeout errors", () => {
  const result = classifyError("exceeded 300s limit — terminating agent process");
  assert.equal(result.category, "timeout");
  assert.ok(result.suggestion.includes("AGENT_TIMEOUT_SECONDS"));

  const result2 = classifyError("Agent [timeout] after 600 seconds");
  assert.equal(result2.category, "timeout");

  const result3 = classifyError("Agent timed out after 600s");
  assert.equal(result3.category, "timeout");

  const result4 = classifyError("[timeout: command exceeded limit, killed]");
  assert.equal(result4.category, "timeout");
});

test("classifyError matches no-changes errors", () => {
  const result = classifyError("no meaningful changes detected after agent run");
  assert.equal(result.category, "no_changes");

  const result2 = classifyError("mass deletion detected — aborting");
  assert.equal(result2.category, "no_changes");
});

test("classifyError matches validation failures", () => {
  const result = classifyError("validation failed after 3 retry rounds");
  assert.equal(result.category, "validation");
  assert.ok(result.suggestion.includes("linter"));
});

test("classifyError matches agent crash", () => {
  const result = classifyError("agent exited with code 1");
  assert.equal(result.category, "agent_crash");

  const result2 = classifyError("command failed with exit code 137");
  assert.equal(result2.category, "agent_crash");
});

test("classifyError matches push rejections", () => {
  const result = classifyError("failed to push refs to 'https://github.com/org/repo.git'");
  assert.equal(result.category, "push");

  const result2 = classifyError("remote: rejected — branch is protected");
  assert.equal(result2.category, "push");
});

test("classifyError matches PR creation failures", () => {
  const result = classifyError("pull request creation failed: 422 Unprocessable Entity");
  assert.equal(result.category, "pr");

  const result2 = classifyError("create_pr node failed");
  assert.equal(result2.category, "pr");
});

test("classifyError returns unknown for unrecognized errors", () => {
  const result = classifyError("something completely unexpected happened");
  assert.equal(result.category, "unknown");
  assert.equal(result.friendly, "Run failed");
  assert.ok(result.suggestion.includes("logs"));
});

test("classifyError returns first matching pattern when multiple could match", () => {
  // "failed to clone" matches clone pattern, even if it contains other keywords
  const result = classifyError("failed to clone — command failed with exit code 128");
  assert.equal(result.category, "clone", "Should match first pattern (clone) not later ones (agent_crash)");
});

// ── failure summary with classified error ─────────────

test("failure summary shows classified error with suggestion for known patterns", async () => {
  const { store, testDb } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const mockPipeline = makeMockPipelineEngineFailing("failed to clone org/repo: fatal: repository not found");
  const config = makeConfig();

  const manager = new RunManager(config, store, mockPipeline, mockClient as any);

  const run = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "fix the bug",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000",
    runtime: config.sandboxRuntime
  });

  await waitForRunDone(store, run.id);
  await waitForManagerIdle(manager);

  const postMessages = mockClient._calls.filter((c) => c.method === "chat.postMessage");
  const summary =
    postMessages.findLast((call) => typeof call.args.text === "string" && String(call.args.text).includes("*Run failed*")) ??
    postMessages[postMessages.length - 1];
  const summaryText = summary.args.text as string;
  assert.ok(summaryText.includes("Failed to clone repository"), "Should show friendly error name");
  assert.ok(summaryText.includes("GitHub credentials"), "Should show suggestion");

  await testDb.cleanup();
});
