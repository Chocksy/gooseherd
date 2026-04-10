import assert from "node:assert/strict";
import test from "node:test";
import { RunManager } from "../src/run-manager.js";
import type { AppConfig } from "../src/config.js";
import type { RuntimeRegistry } from "../src/runtime/backend.js";

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

test("enqueueRun rejects kubernetes sandbox runtime before accepting a run", async () => {
  let createRunCalled = false;
  const manager = new RunManager(
    makeConfig({ sandboxRuntime: "kubernetes", sandboxEnabled: false }),
    {
      createRun: async () => {
        createRunCalled = true;
        throw new Error("should not create run");
      }
    } as any,
    {
      local: { runtime: "local", execute: async () => { throw new Error("not used"); } },
      docker: { runtime: "docker", execute: async () => { throw new Error("not used"); } },
      kubernetes: undefined
    } as RuntimeRegistry,
    undefined
  );

  await assert.rejects(
    () => manager.enqueueRun({
      repoSlug: "org/repo",
      task: "fix the bug",
      baseBranch: "main",
      requestedBy: "U1234",
      channelId: "C1234",
      threadTs: "1234567890.000000"
    }),
    /SANDBOX_RUNTIME=kubernetes is not supported yet/
  );
  assert.equal(createRunCalled, false);
});

test("enqueueRun accepts explicit local runtime when config default is kubernetes", async () => {
  let capturedRuntime: string | undefined;
  const manager = new RunManager(
    makeConfig({ sandboxRuntime: "kubernetes", sandboxEnabled: false }),
    {
      createRun: async (input: { runtime: string }) => {
        capturedRuntime = input.runtime;
        return {
          id: "run-123",
          runtime: input.runtime,
          status: "queued",
          repoSlug: "org/repo",
          task: "fix the bug",
          baseBranch: "main",
          branchName: "testherd/run-123",
          requestedBy: "U1234",
          channelId: "C1234",
          threadTs: "1234567890.000000",
          createdAt: new Date().toISOString()
        };
      },
      getRun: async () => undefined
    } as any,
    {
      local: { runtime: "local", execute: async () => { throw new Error("not used"); } },
      docker: { runtime: "docker", execute: async () => { throw new Error("not used"); } },
      kubernetes: undefined
    } as RuntimeRegistry,
    undefined
  );

  const run = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "fix the bug",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000",
    runtime: "local"
  });

  assert.equal(capturedRuntime, "local");
  assert.equal(run.runtime, "local");
});
