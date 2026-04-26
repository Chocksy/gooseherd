import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fixCiNode } from "../src/pipeline/ci/fix-ci-node.js";
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
    agentCommandTemplate: "true",
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
    runtime: "local",
    status: "queued",
    repoSlug: "owner/repo",
    task: "Fix failing CI",
    baseBranch: "main",
    branchName: "feature/ci-fix",
    requestedBy: "work-item:ci-fix",
    channelId: "C123",
    threadTs: "1234567890.000000",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function initRepo(repoDir: string, logFile: string): Promise<void> {
  await runShellCapture("git init", { cwd: repoDir, logFile });
  await runShellCapture("git config user.email 'test@test.com'", { cwd: repoDir, logFile });
  await runShellCapture("git config user.name 'Test'", { cwd: repoDir, logFile });
  await writeFile(path.join(repoDir, "src.ts"), "export const value = 1;\n", "utf8");
  await runShellCapture("git add -A", { cwd: repoDir, logFile });
  await runShellCapture("git commit -m 'init'", { cwd: repoDir, logFile });
}

test("fixCiNode derives CI context from prefetchContext and treats missing ciLogTail as optional", async (t) => {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-repo-"));
  const runDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-run-"));
  const logFile = path.join(runDir, "run.log");
  const capturedPrompt = path.join(runDir, "captured-prompt.md");
  await writeFile(logFile, "", "utf8");
  await initRepo(repoDir, logFile);
  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  });

  const ctx = new ContextBag({
    repoDir,
    runDir,
    changedFiles: ["src.ts"],
  });

  const result = await fixCiNode({ id: "fix_ci", type: "agentic", action: "fix_ci" }, ctx, {
    config: makeConfig({
      agentCommandTemplate: `cat {{prompt_file}} > '${capturedPrompt}'`,
    }),
    run: makeRun({
      prefetchContext: {
        meta: { fetchedAt: new Date().toISOString(), sources: ["github_ci"] },
        workItem: { id: "wi-1", title: "Fix CI", workflow: "feature_delivery" },
        github: {
          pr: { number: 7, url: "https://github.com/owner/repo/pull/7", title: "Fix CI", body: "", state: "open" },
          discussionComments: [],
          reviews: [],
          reviewComments: [],
          ci: {
            conclusion: "failure",
            failedRuns: [{ id: 11, name: "unit-tests", status: "completed", conclusion: "failure" }],
            failedAnnotations: [{
              checkRunName: "unit-tests",
              path: "src.ts",
              line: 1,
              message: "Expected semicolon",
              level: "failure",
            }],
            failedLogTail: "bundle exec rspec\nExpected semicolon\n",
          },
        },
      },
    }),
    logFile,
    workRoot: runDir,
    onPhase: async () => undefined,
  });

  assert.equal(result.outcome, "failure");
  assert.equal(result.error, "CI fix agent made no changes");

  const prompt = await readFile(capturedPrompt, "utf8");
  assert.match(prompt, /Current Gooseherd run id: `test-run-001`/);
  assert.match(prompt, /unit-tests/);
  assert.match(prompt, /src\.ts:1/);
  assert.match(prompt, /Failed Job Log/);
  assert.match(prompt, /Expected semicolon/);
});

test("fixCiNode returns a clean failure when only internal-generated files are present", async (t) => {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-internal-repo-"));
  const runDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-internal-run-"));
  const logFile = path.join(runDir, "run.log");
  await writeFile(logFile, "", "utf8");
  await initRepo(repoDir, logFile);
  await writeFile(path.join(repoDir, "AGENTS.md"), "# internal\n", "utf8");
  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  });

  const ctx = new ContextBag({
    repoDir,
    runDir,
    changedFiles: ["src.ts"],
  });

  const result = await fixCiNode({ id: "fix_ci", type: "agentic", action: "fix_ci" }, ctx, {
    config: makeConfig(),
    run: makeRun(),
    logFile,
    workRoot: runDir,
    onPhase: async () => undefined,
  });

  assert.equal(result.outcome, "failure");
  assert.equal(result.error, "CI fix agent made no changes");
});

test("fixCiNode prefers current CI failure names from context over stale prefetch data", async (t) => {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-retry-repo-"));
  const runDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-retry-run-"));
  const logFile = path.join(runDir, "run.log");
  const capturedPrompt = path.join(runDir, "captured-prompt.md");
  await writeFile(logFile, "", "utf8");
  await initRepo(repoDir, logFile);
  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  });

  const ctx = new ContextBag({
    repoDir,
    runDir,
    changedFiles: ["src.ts"],
    ciFailedRunNames: ["lint"],
  });

  const result = await fixCiNode({ id: "fix_ci", type: "agentic", action: "fix_ci" }, ctx, {
    config: makeConfig({
      agentCommandTemplate: `cat {{prompt_file}} > '${capturedPrompt}'`,
    }),
    run: makeRun({
      prefetchContext: {
        meta: { fetchedAt: new Date().toISOString(), sources: ["github_ci"] },
        workItem: { id: "wi-1", title: "Fix CI", workflow: "feature_delivery" },
        github: {
          pr: { number: 7, url: "https://github.com/owner/repo/pull/7", title: "Fix CI", body: "", state: "open" },
          discussionComments: [],
          reviews: [],
          reviewComments: [],
          ci: {
            conclusion: "failure",
            failedRuns: [{ id: 11, name: "unit-tests", status: "completed", conclusion: "failure" }],
            failedAnnotations: [],
          },
        },
      },
    }),
    logFile,
    workRoot: runDir,
    onPhase: async () => undefined,
  });

  assert.equal(result.outcome, "failure");
  assert.equal(result.error, "CI fix agent made no changes");

  const prompt = await readFile(capturedPrompt, "utf8");
  assert.match(prompt, /\blint\b/);
  assert.ok(!prompt.includes("unit-tests"));
});

test("fixCiNode uses run id in commit message", async (t) => {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-commit-repo-"));
  const runDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-commit-run-"));
  const logFile = path.join(runDir, "run.log");
  const capturedPrompt = path.join(runDir, "captured-prompt.md");
  await writeFile(logFile, "", "utf8");
  await initRepo(repoDir, logFile);
  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  });

  const ctx = new ContextBag({
    repoDir,
    runDir,
    changedFiles: ["src.ts"],
  });

  const result = await fixCiNode({ id: "fix_ci", type: "agentic", action: "fix_ci" }, ctx, {
    config: makeConfig({
      agentCommandTemplate: `repo={{repo_dir}}; cat {{prompt_file}} > '${capturedPrompt}'; printf 'export const value = 2;\\n' > "$repo/src.ts"`,
    }),
    run: makeRun({
      id: "445ad8a6-33c3-45c6-badf-429ec98c4a51",
      branchName: "",
    }),
    logFile,
    workRoot: runDir,
    onPhase: async () => undefined,
  });

  assert.equal(result.outcome, "success");

  const prompt = await readFile(capturedPrompt, "utf8");
  assert.match(prompt, /Current Gooseherd run id: `445ad8a6-33c3-45c6-badf-429ec98c4a51`/);

  const subject = await runShellCapture("git log -1 --pretty=%s", { cwd: repoDir, logFile });
  assert.equal(subject.stdout.trim(), "fix: Fix CI for run 445ad8a6-33c3-45c6-badf-429ec98c4a51");
});

test("fixCiNode treats agent-created history-only commits as success", async (t) => {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-history-repo-"));
  const runDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-history-run-"));
  const logFile = path.join(runDir, "run.log");
  const capturedPrompt = path.join(runDir, "captured-prompt.md");
  await writeFile(logFile, "", "utf8");
  await initRepo(repoDir, logFile);
  const beforeHead = await runShellCapture("git rev-parse HEAD", { cwd: repoDir, logFile });
  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  });

  const ctx = new ContextBag({
    repoDir,
    runDir,
    changedFiles: ["src.ts"],
  });

  const result = await fixCiNode({ id: "fix_ci", type: "agentic", action: "fix_ci" }, ctx, {
    config: makeConfig({
      agentCommandTemplate: `repo={{repo_dir}}; cat {{prompt_file}} > '${capturedPrompt}'; git -C "$repo" commit --amend -m 'fix: Normalize openrouter agent profile models'`,
    }),
    run: makeRun({
      branchName: "",
    }),
    logFile,
    workRoot: runDir,
    onPhase: async () => undefined,
  });

  const afterHead = await runShellCapture("git rev-parse HEAD", { cwd: repoDir, logFile });

  assert.equal(result.outcome, "success");
  assert.notEqual(afterHead.stdout.trim(), beforeHead.stdout.trim());
  assert.equal(result.outputs?.commitSha, afterHead.stdout.trim());
  assert.deepEqual(result.outputs?.changedFiles, []);

  const prompt = await readFile(capturedPrompt, "utf8");
  assert.match(prompt, /Current Gooseherd run id: `test-run-001`/);

  const status = await runShellCapture("git status --porcelain", { cwd: repoDir, logFile });
  assert.equal(status.stdout.trim(), "");
});
