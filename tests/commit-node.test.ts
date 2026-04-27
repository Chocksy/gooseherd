import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { commitNode } from "../src/pipeline/nodes/commit.js";
import { ContextBag } from "../src/pipeline/context-bag.js";
import type { AppConfig } from "../src/config.js";
import type { RunRecord } from "../src/types.js";
import { runShellCapture } from "../src/pipeline/shell.js";

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
    localTestCommand: "",
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
    observerWebhookPort: 9090,
    scopeJudgeEnabled: false,
    scopeJudgeModel: "claude-haiku-4-5-20251001",
    scopeJudgeMinPassScore: 60,
    observerSmartTriageEnabled: false,
    observerSmartTriageModel: "claude-haiku-4-5-20251001",
    observerSmartTriageTimeoutMs: 10000,
    browserVerifyEnabled: false,
    browserVerifyModel: "anthropic/claude-haiku-4-5",
    browserVerifyExecutionModel: undefined,
    browserVerifyMaxSteps: 15,
    browserVerifyExecTimeoutMs: 300_000,
    ciWaitEnabled: false,
    ciPollIntervalSeconds: 30,
    ciPatienceTimeoutSeconds: 300,
    ciMaxWaitSeconds: 1800,
    ciCheckFilter: [],
    ciMaxFixRounds: 2,
    defaultLlmModel: "openrouter/z-ai/glm-5",
    planTaskModel: "openrouter/z-ai/glm-5",
    orchestratorModel: "openai/gpt-4.1-mini",
    orchestratorTimeoutMs: 180_000,
    orchestratorWallClockTimeoutMs: 480_000,
    openrouterApiKey: undefined,
    anthropicApiKey: undefined,
    openaiApiKey: undefined,
    reviewAppUrlPattern: undefined,
    screenshotEnabled: false,
    dashboardToken: undefined,
    teamChannelMap: new Map(),
    observerSlackWatchedChannels: [],
    observerSlackBotAllowlist: [],
    observerGithubWatchedRepos: [],
    observerGithubWebhookSecret: undefined,
    observerSentryWebhookSecret: undefined,
    sentryAuthToken: undefined,
    sentryOrgSlug: undefined,
    githubToken: undefined,
    githubAppId: undefined,
    githubAppPrivateKey: undefined,
    githubAppInstallationId: undefined,
    githubDefaultOwner: undefined,
    cemsTeamId: undefined,
    mcpExtensions: [],
    piAgentExtensions: [],
    openrouterProviderPreferences: undefined,
    sandboxEnabled: false,
    sandboxImage: "gooseherd/sandbox:default",
    sandboxHostWorkPath: "",
    sandboxCpus: 2,
    sandboxMemoryMb: 4096,
    supervisorEnabled: true,
    supervisorRunTimeoutSeconds: 7200,
    supervisorNodeStaleSeconds: 1800,
    supervisorWatchdogIntervalSeconds: 30,
    supervisorMaxAutoRetries: 1,
    supervisorRetryCooldownSeconds: 60,
    supervisorMaxRetriesPerDay: 20,
    ...overrides,
  } as AppConfig;
}

function makeRun(overrides?: Partial<RunRecord>): RunRecord {
  return {
    id: "test-run-001",
    status: "queued",
    repoSlug: "owner/repo",
    task: "Review the current pull request",
    baseBranch: "main",
    branchName: "feature/branch",
    requestedBy: "work-item:auto-review",
    channelId: "C123",
    threadTs: "1234567890.000000",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

test("commitNode: skips commit for auto-review no-op runs", async (t) => {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "commit-node-"));
  const logDir = await mkdtemp(path.join(os.tmpdir(), "commit-node-log-"));
  const logFile = path.join(logDir, "run.log");
  await writeFile(logFile, "", "utf8");
  await runShellCapture("git init && git config user.email 'test@test.com' && git config user.name 'Test'", { cwd: repoDir, logFile });
  await writeFile(path.join(repoDir, ".gitkeep"), "", "utf8");
  await runShellCapture("git add -A && git commit -m 'init'", { cwd: repoDir, logFile });
  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(logDir, { recursive: true, force: true });
  });

  const ctx = new ContextBag();
  ctx.set("repoDir", repoDir);
  ctx.set("autoReviewNoop", true);

  const result = await commitNode({ id: "commit", type: "deterministic", action: "commit" }, ctx, {
    config: makeConfig(),
    run: makeRun(),
    logFile,
    workRoot: repoDir,
    onPhase: async () => undefined,
  });

  assert.deepEqual(result, {
    outcome: "success",
    outputs: { skippedCommit: true },
  });
});

test("commitNode: preserves existing internal artifacts when adding commit artifacts", async (t) => {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "commit-node-merge-"));
  const logDir = await mkdtemp(path.join(os.tmpdir(), "commit-node-merge-log-"));
  const logFile = path.join(logDir, "run.log");
  await writeFile(logFile, "", "utf8");
  await runShellCapture("git init && git config user.email 'test@test.com' && git config user.name 'Test'", { cwd: repoDir, logFile });
  await writeFile(path.join(repoDir, ".gitkeep"), "", "utf8");
  await runShellCapture("git add -A && git commit -m 'init'", { cwd: repoDir, logFile });
  await writeFile(path.join(repoDir, "AGENTS.md"), "# internal\n", "utf8");
  await writeFile(path.join(repoDir, "src.ts"), "export const value = 1;\n", "utf8");
  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(logDir, { recursive: true, force: true });
  });

  const ctx = new ContextBag();
  ctx.set("repoDir", repoDir);
  ctx.set("internalArtifacts", ["auto-review-summary.json"]);

  const result = await commitNode({ id: "commit", type: "deterministic", action: "commit" }, ctx, {
    config: makeConfig(),
    run: makeRun(),
    logFile,
    workRoot: repoDir,
    onPhase: async () => undefined,
  });

  assert.equal(result.outcome, "success");
  assert.deepEqual(result.outputs?.internalArtifacts, ["auto-review-summary.json", "AGENTS.md"]);
});
