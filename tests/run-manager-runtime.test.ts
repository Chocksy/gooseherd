import assert from "node:assert/strict";
import test from "node:test";
import { RunManager } from "../src/run-manager.js";
import type { AppConfig } from "../src/config.js";
import type { RunExecutionBackend } from "../src/runtime/backend.js";
import type { PipelineStore } from "../src/pipeline/pipeline-store.js";
import { RunStore } from "../src/store.js";
import type { ExecutionResult, NewRunInput, RunRecord } from "../src/types.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";

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

async function waitForRunDone(store: RunStore, runId: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await store.getRun(runId);
    if (run && (run.status === "completed" || run.status === "failed")) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`waitForRunDone: run ${runId} did not reach terminal status within ${timeoutMs}ms`);
}

async function waitForManagerIdle(manager: RunManager): Promise<void> {
  await ((manager as unknown) as { queue: { onIdle: () => Promise<void> } }).queue.onIdle();
}

async function setupTestStore(): Promise<{ store: RunStore; testDb: TestDb }> {
  const testDb = await createTestDb();
  const store = new RunStore(testDb.db);
  await store.init();
  return { store, testDb };
}

function makeBackend(
  runtime: "local",
  calls: string[]
): RunExecutionBackend<"local">;
function makeBackend(
  runtime: "docker",
  calls: string[]
): RunExecutionBackend<"docker">;
function makeBackend(
  runtime: "kubernetes",
  calls: string[]
): RunExecutionBackend<"kubernetes">;
function makeBackend(
  runtime: RunRecord["runtime"],
  calls: string[]
): RunExecutionBackend {
  return {
    runtime,
    execute: async (run, ctx) => {
      calls.push(run.id);
      await ctx.onPhase("cloning");
      await ctx.onPhase("agent");
      await ctx.onPhase("pushing");
      return {
        branchName: run.branchName,
        logsPath: `/tmp/${run.id}.log`,
        commitSha: "abc123",
        changedFiles: []
      } as ExecutionResult;
    }
  };
}

test("enqueueRun uses config sandboxRuntime for new runs", async () => {
  const { store, testDb } = await setupTestStore();
  const config = makeConfig({ sandboxRuntime: "docker" } as Partial<AppConfig>);
  const localBackendCalls: string[] = [];
  const dockerBackendCalls: string[] = [];
  const runtimeRegistry = {
    local: makeBackend("local", localBackendCalls),
    docker: makeBackend("docker", dockerBackendCalls),
    kubernetes: undefined
  };
  const manager = new RunManager(config, store, runtimeRegistry, undefined);
  const baseInput: Omit<NewRunInput, "runtime"> = {
    repoSlug: "org/repo",
    task: "runtime test",
    baseBranch: "main",
    requestedBy: "U1",
    channelId: "C1",
    threadTs: "1"
  };

  const run = await manager.enqueueRun(baseInput);
  assert.equal(run.runtime, "docker");
  await waitForRunDone(store, run.id);
  await waitForManagerIdle(manager);
  await testDb.cleanup();
});

test("processRun dispatches to runtime-matched backend", async () => {
  const { store, testDb } = await setupTestStore();
  const config = makeConfig({ sandboxRuntime: "docker" } as Partial<AppConfig>);
  const localBackendCalls: string[] = [];
  const dockerBackendCalls: string[] = [];
  const runtimeRegistry = {
    local: makeBackend("local", localBackendCalls),
    docker: makeBackend("docker", dockerBackendCalls),
    kubernetes: undefined
  };
  const manager = new RunManager(config, store, runtimeRegistry, undefined);
  const baseInput: Omit<NewRunInput, "runtime"> = {
    repoSlug: "org/repo",
    task: "runtime test",
    baseBranch: "main",
    requestedBy: "U1",
    channelId: "C1",
    threadTs: "1"
  };

  const run = await manager.enqueueRun({ ...baseInput, runtime: "local" });
  await waitForRunDone(store, run.id);
  assert.equal(localBackendCalls.length, 1);
  assert.equal(dockerBackendCalls.length, 0);
  await waitForManagerIdle(manager);
  await testDb.cleanup();
});

test("processRun passes resolved pipelineFile to backend execution", async () => {
  const { store, testDb } = await setupTestStore();
  const config = makeConfig({ pipelineFile: "pipelines/default.yml" } as Partial<AppConfig>);
  let receivedPipelineFile: string | undefined;
  const runtimeRegistry = {
    local: {
      runtime: "local",
      execute: async (run, ctx) => {
        receivedPipelineFile = ctx.pipelineFile;
        await ctx.onPhase("cloning");
        await ctx.onPhase("agent");
        await ctx.onPhase("pushing");
        return {
          branchName: run.branchName,
          logsPath: `/tmp/${run.id}.log`,
          commitSha: "abc123",
          changedFiles: []
        } satisfies ExecutionResult;
      }
    },
    docker: undefined,
    kubernetes: undefined
  };
  const pipelineStore = {
    get: (hint: string) => hint === "runtime-test"
      ? { isBuiltIn: false, yaml: "version: 1\nnodes: []\n" }
      : undefined
  } as Pick<PipelineStore, "get"> as PipelineStore;
  const manager = new RunManager(config, store, runtimeRegistry, undefined, undefined, pipelineStore);

  const run = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "runtime test",
    baseBranch: "main",
    requestedBy: "U1",
    channelId: "C1",
    threadTs: "1",
    pipelineHint: "runtime-test"
  });

  await waitForRunDone(store, run.id);
  assert.match(receivedPipelineFile ?? "", new RegExp(`${run.id}/pipeline-runtime-test\\.yml$`));
  await waitForManagerIdle(manager);
  await testDb.cleanup();
});

test("processRun resolves work-item pipeline from intent instead of legacy pipelineHint", async () => {
  const { store, testDb } = await setupTestStore();
  const config = makeConfig({ pipelineFile: "pipelines/default.yml" } as Partial<AppConfig>);
  let receivedPipelineFile: string | undefined;
  const runtimeRegistry = {
    local: {
      runtime: "local",
      execute: async (run, ctx) => {
        receivedPipelineFile = ctx.pipelineFile;
        return {
          branchName: run.branchName,
          logsPath: `/tmp/${run.id}.log`,
          commitSha: "abc123",
          changedFiles: [],
        } satisfies ExecutionResult;
      },
    },
    docker: undefined,
    kubernetes: undefined,
  };
  const manager = new RunManager(config, store, runtimeRegistry, undefined);

  const run = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "repair CI",
    baseBranch: "main",
    requestedBy: "work-item:ci-fix",
    channelId: "C1",
    threadTs: "1",
    pipelineHint: "wrong-pipeline",
    workItemId: "11111111-1111-1111-1111-111111111111",
    prUrl: "https://github.com/org/repo/pull/3",
    prNumber: 3,
    intent: {
      version: 1,
      kind: "feature_delivery.repair_ci",
      source: "work_item",
      workItemId: "11111111-1111-1111-1111-111111111111",
      repo: "org/repo",
      prNumber: 3,
      prUrl: "https://github.com/org/repo/pull/3",
      sourceSubstate: "ci_failed",
    },
  });

  await waitForRunDone(store, run.id);
  assert.match(receivedPipelineFile ?? "", /pipelines\/ci-fix\.yml$/);
  await waitForManagerIdle(manager);
  await testDb.cleanup();
});

test("processRun dispatches feature-delivery review pipelines from intent kind", async () => {
  const cases = [
    {
      task: "self review",
      requestedBy: "work-item:auto-review",
      expectedPipelineFile: /pipelines\/feature-delivery-self-review\.yml$/,
      intent: {
        version: 1,
        kind: "feature_delivery.self_review",
        source: "work_item",
        workItemId: "11111111-1111-1111-1111-111111111111",
        repo: "org/repo",
        prNumber: 3,
        prUrl: "https://github.com/org/repo/pull/3",
        sourceSubstate: "pr_adopted",
      },
    },
    {
      task: "apply review feedback",
      requestedBy: "work-item:auto-review",
      expectedPipelineFile: /pipelines\/feature-delivery-review-feedback\.yml$/,
      intent: {
        version: 1,
        kind: "feature_delivery.apply_review_feedback",
        source: "work_item",
        workItemId: "22222222-2222-2222-2222-222222222222",
        repo: "org/repo",
        prNumber: 4,
        prUrl: "https://github.com/org/repo/pull/4",
        sourceSubstate: "applying_review_feedback",
      },
    },
  ] as const;

  for (const testCase of cases) {
    const { store, testDb } = await setupTestStore();
    const config = makeConfig({ pipelineFile: "pipelines/default.yml" } as Partial<AppConfig>);
    let receivedPipelineFile: string | undefined;
    const runtimeRegistry = {
      local: {
        runtime: "local",
        execute: async (run, ctx) => {
          receivedPipelineFile = ctx.pipelineFile;
          return {
            branchName: run.branchName,
            logsPath: `/tmp/${run.id}.log`,
            commitSha: "abc123",
            changedFiles: [],
          } satisfies ExecutionResult;
        },
      },
      docker: undefined,
      kubernetes: undefined,
    };
    const manager = new RunManager(config, store, runtimeRegistry, undefined);

    const run = await manager.enqueueRun({
      repoSlug: "org/repo",
      task: testCase.task,
      baseBranch: "main",
      requestedBy: testCase.requestedBy,
      channelId: "C1",
      threadTs: "1",
      pipelineHint: "pipeline",
      workItemId: testCase.intent.workItemId,
      prUrl: testCase.intent.prUrl,
      prNumber: testCase.intent.prNumber,
      intent: testCase.intent,
    });

    await waitForRunDone(store, run.id);
    assert.match(receivedPipelineFile ?? "", testCase.expectedPipelineFile);
    await waitForManagerIdle(manager);
    await testDb.cleanup();
  }
});

test("processRun keeps generic pipeline dispatch on legacy pipelineHint", async () => {
  const { store, testDb } = await setupTestStore();
  const config = makeConfig({ pipelineFile: "pipelines/default.yml" } as Partial<AppConfig>);
  let receivedPipelineFile: string | undefined;
  const runtimeRegistry = {
    local: {
      runtime: "local",
      execute: async (run, ctx) => {
        receivedPipelineFile = ctx.pipelineFile;
        return {
          branchName: run.branchName,
          logsPath: `/tmp/${run.id}.log`,
          commitSha: "abc123",
          changedFiles: [],
        } satisfies ExecutionResult;
      },
    },
    docker: undefined,
    kubernetes: undefined,
  };
  const manager = new RunManager(config, store, runtimeRegistry, undefined);

  const run = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "generic task",
    baseBranch: "main",
    requestedBy: "manual:dashboard",
    channelId: "C1",
    threadTs: "1",
    pipelineHint: "pipeline",
    intent: {
      version: 1,
      kind: "generic_task",
      source: "dashboard",
      requestedBy: "manual:dashboard",
      pipelineHint: "pipeline",
    },
  });

  await waitForRunDone(store, run.id);
  assert.match(receivedPipelineFile ?? "", /pipelines\/pipeline\.yml$/);
  await waitForManagerIdle(manager);
  await testDb.cleanup();
});

test("requeueExistingRun dispatches using persisted runtime instead of config default", async () => {
  const { store, testDb } = await setupTestStore();
  const config = makeConfig({ sandboxRuntime: "docker" } as Partial<AppConfig>);
  const localBackendCalls: string[] = [];
  const dockerBackendCalls: string[] = [];
  const runtimeRegistry = {
    local: makeBackend("local", localBackendCalls),
    docker: makeBackend("docker", dockerBackendCalls),
    kubernetes: undefined
  };
  const manager = new RunManager(config, store, runtimeRegistry, undefined);

  const run = await store.createRun({
    repoSlug: "org/repo",
    task: "runtime test",
    baseBranch: "main",
    requestedBy: "U1",
    channelId: "C1",
    threadTs: "1",
    runtime: "local"
  }, config.branchPrefix);

  manager.requeueExistingRun(run.id);
  await waitForRunDone(store, run.id);
  assert.equal(localBackendCalls.length, 1);
  assert.equal(dockerBackendCalls.length, 0);
  await waitForManagerIdle(manager);
  await testDb.cleanup();
});
