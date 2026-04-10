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
  await testDb.cleanup();
});
