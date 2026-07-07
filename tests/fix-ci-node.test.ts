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
    ciFixAgentBailEnabled: false,
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

  const log = await readFile(logFile, "utf8");
  assert.match(log, /\[ci:fix\] prompt file: .*ci-fix-round-1\.md/);
  assert.match(log, /\[ci:fix\] prompt context: failed_runs=unit-tests annotations=1 log_tail=yes changed_files=1/);
  assert.match(log, /\[ci:fix\] ci annotation 1: src\.ts:1 — Expected semicolon/);
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

test("fixCiNode commits after local_test passes on the first inner round", async (t) => {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-inner-pass-repo-"));
  const runDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-inner-pass-run-"));
  const logFile = path.join(runDir, "run.log");
  const promptCounter = path.join(runDir, "prompt-counter");
  await writeFile(logFile, "", "utf8");
  await initRepo(repoDir, logFile);
  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  });

  const ctx = new ContextBag({ repoDir, runDir, changedFiles: ["src.ts"] });

  const result = await fixCiNode({ id: "fix_ci", type: "agentic", action: "fix_ci" }, ctx, {
    config: makeConfig({
      agentCommandTemplate:
        `repo={{repo_dir}}; printf 'export const value = 2;\\n' > "$repo/src.ts"; ` +
        `printf 'x' >> '${promptCounter}'`,
      localTestCommand: "true",
    }),
    run: makeRun({ branchName: "" }),
    logFile,
    workRoot: runDir,
    onPhase: async () => undefined,
  });

  assert.equal(result.outcome, "success");
  const counter = await readFile(promptCounter, "utf8");
  assert.equal(counter.length, 1, "agent should run exactly once when test passes immediately");

  const log = await readFile(logFile, "utf8");
  assert.match(log, /\[ci:fix\] inner loop: local_test=configured max_rounds=5/);
  assert.match(log, /\[ci:fix:inner\] round 1\/5: running agent/);
  assert.match(log, /\[ci:fix:inner\] round 1\/5: running local_test/);
  assert.match(log, /\[ci:fix:inner\] round 1\/5: local_test passed/);
  assert.match(log, /\[ci:fix\] pushed fix commit/);
});

test("fixCiNode retries the agent when local_test fails, then commits after pass", async (t) => {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-inner-retry-repo-"));
  const runDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-inner-retry-run-"));
  const logFile = path.join(runDir, "run.log");
  const stateFile = path.join(runDir, "agent-round");
  const testFlag = path.join(runDir, "test-pass-flag");
  await writeFile(logFile, "", "utf8");
  await writeFile(stateFile, "0", "utf8");
  await initRepo(repoDir, logFile);
  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  });

  // Agent: 1st run touches the file; 2nd run also touches the file AND
  // creates the test-pass flag so the next test invocation succeeds.
  // Use a counter-based value (>= 10) so the working tree always differs
  // from the original `value = 1;` content seeded by initRepo.
  const agentScript = [
    `repo={{repo_dir}}`,
    `n=$(cat '${stateFile}')`,
    `n=$((n+1))`,
    `printf '%s' "$n" > '${stateFile}'`,
    `printf 'export const value = '"$((n+10))"';\\n' > "$repo/src.ts"`,
    `if [ "$n" -ge 2 ]; then touch '${testFlag}'; fi`,
  ].join("; ");

  const ctx = new ContextBag({ repoDir, runDir, changedFiles: ["src.ts"] });

  // Failing test command emits a recognisable marker on both streams so we
  // can verify the retry prompt actually carries the test output forward
  // (not just the harness header).
  const localTest = [
    `if [ -f '${testFlag}' ]; then exit 0; fi`,
    `echo 'STDOUT_MARKER: AssertionError at src.ts:42 (expected 2, got 1)'`,
    `echo 'STDERR_MARKER: 1 test failed' >&2`,
    `exit 1`,
  ].join("; ");

  const result = await fixCiNode({ id: "fix_ci", type: "agentic", action: "fix_ci" }, ctx, {
    config: makeConfig({
      agentCommandTemplate: agentScript,
      localTestCommand: localTest,
    }),
    run: makeRun({ branchName: "" }),
    logFile,
    workRoot: runDir,
    onPhase: async () => undefined,
  });

  assert.equal(result.outcome, "success");
  assert.equal((await readFile(stateFile, "utf8")).trim(), "2", "agent should run exactly twice");

  const log = await readFile(logFile, "utf8");
  assert.match(log, /\[ci:fix:inner\] round 1\/5: local_test failed/);
  assert.match(log, /\[ci:fix:inner\] round 2\/5: retry prompt at .*ci-fix-round-1-inner-retry-1\.md/);
  assert.match(log, /\[ci:fix:inner\] round 2\/5: local_test passed/);
  assert.match(log, /\[ci:fix\] pushed fix commit/);

  // The retry prompt should carry the test output forward, not just the harness header.
  const retryPromptPath = path.join(runDir, "ci-fix-round-1-inner-retry-1.md");
  const retryPrompt = await readFile(retryPromptPath, "utf8");
  assert.match(retryPrompt, /Local test suite is still failing/);
  assert.match(retryPrompt, /Inner test round: 2\/5/);
  assert.match(retryPrompt, /STDOUT_MARKER: AssertionError at src\.ts:42 \(expected 2, got 1\)/);
  assert.match(retryPrompt, /STDERR_MARKER: 1 test failed/);
});

test("fixCiNode returns failure without pushing when local_test never passes", async (t) => {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-inner-exhaust-repo-"));
  const runDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-inner-exhaust-run-"));
  const logFile = path.join(runDir, "run.log");
  const stateFile = path.join(runDir, "agent-round");
  await writeFile(logFile, "", "utf8");
  await writeFile(stateFile, "0", "utf8");
  await initRepo(repoDir, logFile);
  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  });

  // Agent always touches the working tree with a fresh value (>= 10 so it
  // never collides with the seeded `value = 1;` from initRepo).
  const agentScript = [
    `repo={{repo_dir}}`,
    `n=$(cat '${stateFile}')`,
    `n=$((n+1))`,
    `printf '%s' "$n" > '${stateFile}'`,
    `printf 'export const value = '"$((n+10))"';\\n' > "$repo/src.ts"`,
  ].join("; ");

  const headBefore = (await runShellCapture("git rev-parse HEAD", { cwd: repoDir, logFile })).stdout.trim();

  const ctx = new ContextBag({ repoDir, runDir, changedFiles: ["src.ts"] });

  const result = await fixCiNode({ id: "fix_ci", type: "agentic", action: "fix_ci" }, ctx, {
    config: makeConfig({
      agentCommandTemplate: agentScript,
      localTestCommand: "false", // always fails
    }),
    run: makeRun({ branchName: "" }),
    logFile,
    workRoot: runDir,
    onPhase: async () => undefined,
  });

  assert.equal(result.outcome, "failure");
  assert.match(result.error ?? "", /Local test still failing after 5 inner round\(s\); not pushing/);
  assert.equal((await readFile(stateFile, "utf8")).trim(), "5", "agent should run exactly INNER_TEST_MAX_ROUNDS times");

  // No commit was made.
  const headAfter = (await runShellCapture("git rev-parse HEAD", { cwd: repoDir, logFile })).stdout.trim();
  assert.equal(headAfter, headBefore, "fix_ci must not commit when tests never pass");

  const log = await readFile(logFile, "utf8");
  assert.match(log, /\[ci:fix:inner\] exhausted — Local test still failing after 5 inner round\(s\)/);
  assert.doesNotMatch(log, /\[ci:fix\] pushed fix commit/);
});

test("fixCiNode skips the inner test gate when LOCAL_TEST_COMMAND is empty", async (t) => {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-inner-skip-repo-"));
  const runDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-inner-skip-run-"));
  const logFile = path.join(runDir, "run.log");
  await writeFile(logFile, "", "utf8");
  await initRepo(repoDir, logFile);
  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  });

  const ctx = new ContextBag({ repoDir, runDir, changedFiles: ["src.ts"] });

  const result = await fixCiNode({ id: "fix_ci", type: "agentic", action: "fix_ci" }, ctx, {
    config: makeConfig({
      agentCommandTemplate: `repo={{repo_dir}}; printf 'export const value = 2;\\n' > "$repo/src.ts"`,
      localTestCommand: "",
    }),
    run: makeRun({ branchName: "" }),
    logFile,
    workRoot: runDir,
    onPhase: async () => undefined,
  });

  assert.equal(result.outcome, "success");

  const log = await readFile(logFile, "utf8");
  assert.match(log, /\[ci:fix\] inner loop: local_test=not configured max_rounds=1/);
  assert.match(log, /no local_test configured — proceeding to commit/);
  assert.match(log, /\[ci:fix\] pushed fix commit/);
});

test("fixCiNode runs the local_test gate when the agent commits internally and fails", async (t) => {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-internal-commit-fail-repo-"));
  const runDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-internal-commit-fail-run-"));
  const logFile = path.join(runDir, "run.log");
  const stateFile = path.join(runDir, "agent-round");
  await writeFile(logFile, "", "utf8");
  await writeFile(stateFile, "0", "utf8");
  await initRepo(repoDir, logFile);
  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  });

  // Agent commits internally on every round; working tree ends clean each time.
  // The seeded repo has `value = 1;` so values >= 10 always produce a real diff.
  const agentScript = [
    `repo={{repo_dir}}`,
    `n=$(cat '${stateFile}')`,
    `n=$((n+1))`,
    `printf '%s' "$n" > '${stateFile}'`,
    `printf 'export const value = '"$((n+10))"';\\n' > "$repo/src.ts"`,
    `git -C "$repo" add src.ts`,
    `git -C "$repo" commit --quiet -m "agent fix round $n"`,
  ].join("; ");

  const headBefore = (await runShellCapture("git rev-parse HEAD", { cwd: repoDir, logFile })).stdout.trim();

  const ctx = new ContextBag({ repoDir, runDir, changedFiles: ["src.ts"] });

  const result = await fixCiNode({ id: "fix_ci", type: "agentic", action: "fix_ci" }, ctx, {
    config: makeConfig({
      agentCommandTemplate: agentScript,
      localTestCommand: "false",
    }),
    run: makeRun({ branchName: "" }),
    logFile,
    workRoot: runDir,
    onPhase: async () => undefined,
  });

  assert.equal(result.outcome, "failure");
  assert.match(result.error ?? "", /Local test still failing after 5 inner round\(s\); not pushing/);
  assert.equal(
    (await readFile(stateFile, "utf8")).trim(),
    "5",
    "test gate must run for agent-internal commits, exhausting all 5 rounds",
  );

  // The agent's commits stay on the local branch (no rollback contract here),
  // but fix_ci must NOT have pushed — verify by checking the log for the push line.
  const log = await readFile(logFile, "utf8");
  assert.match(log, /\[ci:fix:inner\] round 1\/5: running local_test/);
  assert.match(log, /\[ci:fix:inner\] round 1\/5: local_test failed/);
  assert.match(log, /\[ci:fix:inner\] exhausted/);
  assert.doesNotMatch(log, /\[ci:fix\] pushed fix commit/);
  assert.doesNotMatch(log, /history-only/);

  // Sanity: the agent did move HEAD locally.
  const headAfter = (await runShellCapture("git rev-parse HEAD", { cwd: repoDir, logFile })).stdout.trim();
  assert.notEqual(headAfter, headBefore);
});

test("fixCiNode bails out and pushes when local_test exits with an infra-error code", async (t) => {
  // Regression: if the test command itself can't run (exit 127 — command not
  // found is the canonical case), retrying the agent is futile. fix_ci must
  // log a warning, bail out of the inner loop, and proceed to commit+push so
  // wait_ci / CI can be the source of truth.
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-infra-bail-repo-"));
  const runDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-infra-bail-run-"));
  const logFile = path.join(runDir, "run.log");
  const stateFile = path.join(runDir, "agent-round");
  await writeFile(logFile, "", "utf8");
  await writeFile(stateFile, "0", "utf8");
  await initRepo(repoDir, logFile);
  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  });

  const agentScript = [
    `repo={{repo_dir}}`,
    `n=$(cat '${stateFile}')`,
    `n=$((n+1))`,
    `printf '%s' "$n" > '${stateFile}'`,
    `printf 'export const value = '"$((n+10))"';\\n' > "$repo/src.ts"`,
  ].join("; ");

  const ctx = new ContextBag({ repoDir, runDir, changedFiles: ["src.ts"] });

  const result = await fixCiNode({ id: "fix_ci", type: "agentic", action: "fix_ci" }, ctx, {
    config: makeConfig({
      agentCommandTemplate: agentScript,
      // exit 127: classic "command not found" — infrastructure, not a code bug.
      localTestCommand: "exit 127",
    }),
    run: makeRun({ branchName: "" }),
    logFile,
    workRoot: runDir,
    onPhase: async () => undefined,
  });

  assert.equal(result.outcome, "success");
  assert.equal(
    (await readFile(stateFile, "utf8")).trim(),
    "1",
    "agent must run only once: infra error short-circuits the retry loop",
  );

  const log = await readFile(logFile, "utf8");
  assert.match(
    log,
    /\[ci:fix:inner\] round 1\/5: local_test exited with code 127 — treating as infrastructure error; bailing out of inner loop and deferring to CI/,
  );
  assert.match(log, /\[ci:fix\] pushed fix commit/);
  // Must NOT have produced a retry prompt.
  assert.doesNotMatch(log, /retry prompt at/);
});

test("fixCiNode treats a timeout-killed local_test as infra error, not a real failure", async (t) => {
  // Regression: when local_test hangs and the harness kills it via SIGTERM,
  // runShellCapture must surface 143 (128+SIGTERM), not 1 — otherwise the
  // inner loop misclassifies a hung test as a real failure and burns rounds.
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-timeout-bail-repo-"));
  const runDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-timeout-bail-run-"));
  const logFile = path.join(runDir, "run.log");
  const stateFile = path.join(runDir, "agent-round");
  await writeFile(logFile, "", "utf8");
  await writeFile(stateFile, "0", "utf8");
  await initRepo(repoDir, logFile);
  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  });

  const agentScript = [
    `repo={{repo_dir}}`,
    `n=$(cat '${stateFile}')`,
    `n=$((n+1))`,
    `printf '%s' "$n" > '${stateFile}'`,
    `printf 'export const value = '"$((n+10))"';\\n' > "$repo/src.ts"`,
  ].join("; ");

  const ctx = new ContextBag({ repoDir, runDir, changedFiles: ["src.ts"] });

  const result = await fixCiNode({ id: "fix_ci", type: "agentic", action: "fix_ci" }, ctx, {
    config: makeConfig({
      agentCommandTemplate: agentScript,
      // Hangs forever; harness will SIGTERM it after 1s.
      localTestCommand: "sleep 60",
      agentTimeoutSeconds: 1,
    }),
    run: makeRun({ branchName: "" }),
    logFile,
    workRoot: runDir,
    onPhase: async () => undefined,
  });

  assert.equal(result.outcome, "success", "timeout must trigger infra-bail and proceed to push, not retry");
  assert.equal(
    (await readFile(stateFile, "utf8")).trim(),
    "1",
    "agent must run only once: timeout-as-infra short-circuits the loop",
  );

  const log = await readFile(logFile, "utf8");
  assert.match(log, /local_test exited with code 143 — treating as infrastructure error/);
  assert.match(log, /\[ci:fix\] pushed fix commit/);
  assert.doesNotMatch(log, /retry prompt at/);
});

test("fixCiNode treats exit code 2 as a real test failure and retries", async (t) => {
  // pytest reports exit 2 for some failure modes (collection errors etc.).
  // We've decided to whitelist 2 alongside 1 as "real test failure"; verify
  // that path goes through the retry loop and not the infra-bail.
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-exit2-repo-"));
  const runDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-exit2-run-"));
  const logFile = path.join(runDir, "run.log");
  const stateFile = path.join(runDir, "agent-round");
  const passFlag = path.join(runDir, "pass-flag");
  await writeFile(logFile, "", "utf8");
  await writeFile(stateFile, "0", "utf8");
  await initRepo(repoDir, logFile);
  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  });

  const agentScript = [
    `repo={{repo_dir}}`,
    `n=$(cat '${stateFile}')`,
    `n=$((n+1))`,
    `printf '%s' "$n" > '${stateFile}'`,
    `printf 'export const value = '"$((n+10))"';\\n' > "$repo/src.ts"`,
    `if [ "$n" -ge 2 ]; then touch '${passFlag}'; fi`,
  ].join("; ");

  // Round 1: exit 2 (real failure, retry). Round 2: pass.
  const localTest = `if [ -f '${passFlag}' ]; then exit 0; fi; echo 'collection error'; exit 2`;

  const ctx = new ContextBag({ repoDir, runDir, changedFiles: ["src.ts"] });

  const result = await fixCiNode({ id: "fix_ci", type: "agentic", action: "fix_ci" }, ctx, {
    config: makeConfig({
      agentCommandTemplate: agentScript,
      localTestCommand: localTest,
    }),
    run: makeRun({ branchName: "" }),
    logFile,
    workRoot: runDir,
    onPhase: async () => undefined,
  });

  assert.equal(result.outcome, "success");
  assert.equal((await readFile(stateFile, "utf8")).trim(), "2", "exit 2 should still trigger a retry");

  const log = await readFile(logFile, "utf8");
  assert.match(log, /\[ci:fix:inner\] round 1\/5: local_test failed \(exit 2\)/);
  assert.match(log, /\[ci:fix:inner\] round 2\/5: local_test passed/);
  assert.doesNotMatch(log, /infrastructure error/);
});

test("fixCiNode still gates agent-created clean HEAD commits on local_test", async (t) => {
  // Regression for the bug where `clean working tree + new HEAD` was treated
  // as "history-only" and bypassed the local_test gate. An agent that does
  // its own `git commit` produces real code changes that must still be
  // verified before pushing.
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-clean-head-gated-repo-"));
  const runDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-clean-head-gated-run-"));
  const logFile = path.join(runDir, "run.log");
  const stateFile = path.join(runDir, "agent-round");
  await writeFile(logFile, "", "utf8");
  await writeFile(stateFile, "0", "utf8");
  await initRepo(repoDir, logFile);
  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  });

  // Agent: write src.ts with a fresh value, git add, git commit. Working tree
  // ends clean each round, HEAD moves each round. Use a counter so successive
  // rounds (when the test still fails) don't trip "nothing to commit".
  const agentScript = [
    `repo={{repo_dir}}`,
    `n=$(cat '${stateFile}')`,
    `n=$((n+1))`,
    `printf '%s' "$n" > '${stateFile}'`,
    `printf 'export const value = '"$((n+10))"';\\n' > "$repo/src.ts"`,
    `git -C "$repo" add src.ts`,
    `git -C "$repo" commit --quiet -m "agent fix round $n"`,
  ].join("; ");

  const headBefore = (await runShellCapture("git rev-parse HEAD", { cwd: repoDir, logFile })).stdout.trim();

  const ctx = new ContextBag({ repoDir, runDir, changedFiles: ["src.ts"] });

  const result = await fixCiNode({ id: "fix_ci", type: "agentic", action: "fix_ci" }, ctx, {
    config: makeConfig({
      agentCommandTemplate: agentScript,
      localTestCommand: "false",
    }),
    run: makeRun({ branchName: "" }),
    logFile,
    workRoot: runDir,
    onPhase: async () => undefined,
  });

  assert.equal(result.outcome, "failure");
  assert.match(result.error ?? "", /Local test still failing/);

  const log = await readFile(logFile, "utf8");
  assert.match(log, /\[ci:fix:inner\] round 1\/5: running local_test/);
  assert.match(log, /\[ci:fix:inner\] round 1\/5: local_test failed/);
  assert.doesNotMatch(log, /\[ci:fix\] pushed fix commit/);
  assert.doesNotMatch(log, /history-only/);

  // Sanity: HEAD did move locally (agent committed); fix_ci just refused to push.
  const headAfter = (await runShellCapture("git rev-parse HEAD", { cwd: repoDir, logFile })).stdout.trim();
  assert.notEqual(headAfter, headBefore);
});

test("fixCiNode threads both stdout and stderr from local_test into the retry prompt", async (t) => {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-merge-streams-repo-"));
  const runDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-merge-streams-run-"));
  const logFile = path.join(runDir, "run.log");
  const stateFile = path.join(runDir, "agent-round");
  const testFlag = path.join(runDir, "test-pass-flag");
  await writeFile(logFile, "", "utf8");
  await writeFile(stateFile, "0", "utf8");
  await initRepo(repoDir, logFile);
  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  });

  // Agent always changes the file; on the 2nd round it also flips the flag
  // so the test starts passing — but only after we've captured one retry prompt.
  const agentScript = [
    `repo={{repo_dir}}`,
    `n=$(cat '${stateFile}')`,
    `n=$((n+1))`,
    `printf '%s' "$n" > '${stateFile}'`,
    `printf 'export const value = '"$((n+10))"';\\n' > "$repo/src.ts"`,
    `if [ "$n" -ge 2 ]; then touch '${testFlag}'; fi`,
  ].join("; ");

  // Test runner emits a summary on stdout AND a warning on stderr, then exits
  // with a failure unless the flag exists. parseErrors falls back to the raw
  // last 6000 chars when nothing structured is detected, so both lines should
  // surface in the retry prompt.
  const localTest = [
    `echo 'SUMMARY: 1 failure: src.ts:42 expected 2 got 1'`,
    `echo 'WARNING: deprecated API used' >&2`,
    `test -f '${testFlag}'`,
  ].join("; ");

  const ctx = new ContextBag({ repoDir, runDir, changedFiles: ["src.ts"] });

  const result = await fixCiNode({ id: "fix_ci", type: "agentic", action: "fix_ci" }, ctx, {
    config: makeConfig({
      agentCommandTemplate: agentScript,
      localTestCommand: localTest,
    }),
    run: makeRun({ branchName: "" }),
    logFile,
    workRoot: runDir,
    onPhase: async () => undefined,
  });

  assert.equal(result.outcome, "success");

  const retryPrompt = await readFile(path.join(runDir, "ci-fix-round-1-inner-retry-1.md"), "utf8");
  assert.match(retryPrompt, /SUMMARY: 1 failure: src\.ts:42 expected 2 got 1/);
  assert.match(retryPrompt, /WARNING: deprecated API used/);
});

test("fixCiNode detects that agent did nothing new even after a prior round committed", async (t) => {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-noop-after-commit-repo-"));
  const runDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-noop-after-commit-run-"));
  const logFile = path.join(runDir, "run.log");
  const stateFile = path.join(runDir, "agent-round");
  await writeFile(logFile, "", "utf8");
  await writeFile(stateFile, "0", "utf8");
  await initRepo(repoDir, logFile);
  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  });

  // Round 1: agent makes a real commit (test will fail).
  // Round 2+: agent does nothing — fix_ci must surface a "no further changes" failure
  // rather than treating the round-1 commit as round-2 progress.
  const agentScript = [
    `repo={{repo_dir}}`,
    `n=$(cat '${stateFile}')`,
    `n=$((n+1))`,
    `printf '%s' "$n" > '${stateFile}'`,
    `[ "$n" -eq 1 ] && printf 'export const value = 11;\\n' > "$repo/src.ts" && git -C "$repo" add src.ts && git -C "$repo" commit --quiet -m "agent fix round 1"`,
    `true`,
  ].join("; ");

  const ctx = new ContextBag({ repoDir, runDir, changedFiles: ["src.ts"] });

  const result = await fixCiNode({ id: "fix_ci", type: "agentic", action: "fix_ci" }, ctx, {
    config: makeConfig({
      agentCommandTemplate: agentScript,
      localTestCommand: "false",
    }),
    run: makeRun({ branchName: "" }),
    logFile,
    workRoot: runDir,
    onPhase: async () => undefined,
  });

  assert.equal(result.outcome, "failure");
  assert.match(
    result.error ?? "",
    /CI fix agent made no further changes after local test failed in round 1/,
  );
  assert.equal((await readFile(stateFile, "utf8")).trim(), "2", "agent should have run twice (round 1 + round 2 noop)");

  const log = await readFile(logFile, "utf8");
  assert.match(log, /\[ci:fix:inner\] round 2\/5: CI fix agent made no further changes/);
  assert.doesNotMatch(log, /\[ci:fix\] pushed fix commit/);
});

test("fixCiNode detects that agent did nothing new even when prior round left uncommitted changes", async (t) => {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-noop-after-dirty-round-repo-"));
  const runDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-noop-after-dirty-round-run-"));
  const logFile = path.join(runDir, "run.log");
  const stateFile = path.join(runDir, "agent-round");
  await writeFile(logFile, "", "utf8");
  await writeFile(stateFile, "0", "utf8");
  await initRepo(repoDir, logFile);
  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  });

  // Round 1: leave a real uncommitted edit behind (test will fail).
  // Round 2+: agent does nothing in the repo. The existing dirty tree must not
  // count as fresh progress for later rounds.
  const agentScript = [
    `repo={{repo_dir}}`,
    `n=$(cat '${stateFile}')`,
    `n=$((n+1))`,
    `printf '%s' "$n" > '${stateFile}'`,
    `[ "$n" -eq 1 ] && printf 'export const value = 11;\\n' > "$repo/src.ts"`,
    `true`,
  ].join("; ");

  const ctx = new ContextBag({ repoDir, runDir, changedFiles: ["src.ts"] });

  const result = await fixCiNode({ id: "fix_ci", type: "agentic", action: "fix_ci" }, ctx, {
    config: makeConfig({
      agentCommandTemplate: agentScript,
      localTestCommand: "false",
    }),
    run: makeRun({ branchName: "" }),
    logFile,
    workRoot: runDir,
    onPhase: async () => undefined,
  });

  assert.equal(result.outcome, "failure");
  assert.match(
    result.error ?? "",
    /CI fix agent made no further changes after local test failed in round 1/,
  );
  assert.equal((await readFile(stateFile, "utf8")).trim(), "2", "agent should have run twice (round 1 dirty change + round 2 noop)");

  const log = await readFile(logFile, "utf8");
  assert.match(log, /\[ci:fix:inner\] round 2\/5: CI fix agent made no further changes/);
  assert.doesNotMatch(log, /\[ci:fix:inner\] exhausted/);
  assert.doesNotMatch(log, /\[ci:fix\] pushed fix commit/);
});

test("fixCiNode honors the agent bail sentinel from round 2 when the feature is enabled", async (t) => {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-agent-bail-on-repo-"));
  const runDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-agent-bail-on-run-"));
  const logFile = path.join(runDir, "run.log");
  const stateFile = path.join(runDir, "agent-round");
  await writeFile(logFile, "", "utf8");
  await writeFile(stateFile, "0", "utf8");
  await initRepo(repoDir, logFile);
  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  });

  // Round 1: agent makes a real edit (test will fail with exit 1).
  // Round 2: agent edits again AND drops the bail sentinel — harness should
  // honor it, skip the test, and proceed to commit+push.
  const agentScript = [
    `repo={{repo_dir}}`,
    `n=$(cat '${stateFile}')`,
    `n=$((n+1))`,
    `printf '%s' "$n" > '${stateFile}'`,
    `printf 'export const value = '"$((n+10))"';\\n' > "$repo/src.ts"`,
    `if [ "$n" -ge 2 ]; then mkdir -p "$repo/.gooseherd" && printf 'flaky test, environment differs from CI\\n' > "$repo/.gooseherd/bail-test-loop"; fi`,
  ].join("; ");

  const ctx = new ContextBag({ repoDir, runDir, changedFiles: ["src.ts"] });

  const result = await fixCiNode({ id: "fix_ci", type: "agentic", action: "fix_ci" }, ctx, {
    config: makeConfig({
      agentCommandTemplate: agentScript,
      localTestCommand: "exit 1",
      ciFixAgentBailEnabled: true,
    }),
    run: makeRun({ branchName: "" }),
    logFile,
    workRoot: runDir,
    onPhase: async () => undefined,
  });

  assert.equal(result.outcome, "success");
  assert.equal((await readFile(stateFile, "utf8")).trim(), "2", "agent should run twice: round 1 fails, round 2 bails");

  const log = await readFile(logFile, "utf8");
  assert.match(log, /\[ci:fix:inner\] round 2\/5: agent requested bail — flaky test, environment differs from CI/);
  assert.match(log, /\[ci:fix:inner\] round 2\/5: bail honored — skipping local_test gate, proceeding to commit/);
  assert.match(log, /\[ci:fix\] pushed fix commit/);

  // Round 2 must NOT have invoked local_test.
  const round2RunningTest = log.match(/round 2\/5: running local_test/g);
  assert.equal(round2RunningTest, null, "local_test must not run on round 2 when bail is honored");

  // Sentinel must be drained — must not show up in the commit.
  const trackedFiles = await runShellCapture("git ls-tree --name-only -r HEAD", { cwd: repoDir, logFile });
  assert.doesNotMatch(trackedFiles.stdout, /\.gooseherd\/bail-test-loop/);
  // And the retry prompt should mention the bail option since the feature is on.
  const retryPrompt = await readFile(path.join(runDir, "ci-fix-round-1-inner-retry-1.md"), "utf8");
  assert.match(retryPrompt, /If you believe the failure is environmental/);
  assert.match(retryPrompt, /\.gooseherd\/bail-test-loop/);
});

test("fixCiNode honors round-2 bail after a prior agent-created clean commit", async (t) => {
  // Regression: round-1 agent commits internally (clean tree, HEAD moved),
  // round-2 agent only drops the bail sentinel — no further code change.
  // The "no further changes" detector would otherwise short-circuit before
  // bail is honored. This is the exact scenario the bail feature exists for.
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-bail-after-commit-repo-"));
  const runDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-bail-after-commit-run-"));
  const logFile = path.join(runDir, "run.log");
  const stateFile = path.join(runDir, "agent-round");
  await writeFile(logFile, "", "utf8");
  await writeFile(stateFile, "0", "utf8");
  await initRepo(repoDir, logFile);
  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  });

  // Round 1: edit src.ts + git add + git commit. Round 2: only drop sentinel.
  const agentScript = [
    `repo={{repo_dir}}`,
    `n=$(cat '${stateFile}')`,
    `n=$((n+1))`,
    `printf '%s' "$n" > '${stateFile}'`,
    // Round 1: commit a real change.
    `if [ "$n" -eq 1 ]; then ` +
      `printf 'export const value = 11;\\n' > "$repo/src.ts" && ` +
      `git -C "$repo" add src.ts && ` +
      `git -C "$repo" commit --quiet -m "agent fix round 1"; ` +
      `fi`,
    // Round 2: only drop the bail sentinel — no code change.
    `if [ "$n" -eq 2 ]; then ` +
      `mkdir -p "$repo/.gooseherd" && printf 'env mismatch — defer to CI\\n' > "$repo/.gooseherd/bail-test-loop"; ` +
      `fi`,
  ].join("; ");

  const headBefore = (await runShellCapture("git rev-parse HEAD", { cwd: repoDir, logFile })).stdout.trim();

  const ctx = new ContextBag({ repoDir, runDir, changedFiles: ["src.ts"] });

  const result = await fixCiNode({ id: "fix_ci", type: "agentic", action: "fix_ci" }, ctx, {
    config: makeConfig({
      agentCommandTemplate: agentScript,
      localTestCommand: "exit 1",
      ciFixAgentBailEnabled: true,
    }),
    run: makeRun({ branchName: "" }),
    logFile,
    workRoot: runDir,
    onPhase: async () => undefined,
  });

  assert.equal(result.outcome, "success");
  assert.equal((await readFile(stateFile, "utf8")).trim(), "2", "agent should run twice: round 1 commits, round 2 bails");

  const log = await readFile(logFile, "utf8");
  assert.match(log, /\[ci:fix:inner\] round 2\/5: agent requested bail — env mismatch — defer to CI/);
  assert.match(log, /\[ci:fix:inner\] round 2\/5: bail honored — skipping local_test gate/);
  assert.doesNotMatch(log, /round 2\/5: running local_test/);
  assert.doesNotMatch(log, /round 2\/5: CI fix agent made no further changes/);

  // Sentinel must not have ended up in any tracked content.
  const tracked = await runShellCapture("git ls-tree --name-only -r HEAD", { cwd: repoDir, logFile });
  assert.doesNotMatch(tracked.stdout, /\.gooseherd\/bail-test-loop/);

  // Final HEAD points at round-1's commit (which is what gets pushed).
  const headAfter = (await runShellCapture("git rev-parse HEAD", { cwd: repoDir, logFile })).stdout.trim();
  assert.notEqual(headAfter, headBefore);
  assert.equal(result.outputs?.commitSha, headAfter);
});

test("fixCiNode ignores the bail sentinel on round 1 (sentinel still drained)", async (t) => {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-bail-round1-repo-"));
  const runDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-bail-round1-run-"));
  const logFile = path.join(runDir, "run.log");
  const stateFile = path.join(runDir, "agent-round");
  await writeFile(logFile, "", "utf8");
  await writeFile(stateFile, "0", "utf8");
  await initRepo(repoDir, logFile);
  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  });

  // Every round: write a fresh value; on round 1 also drop the bail sentinel
  // (which must be ignored since bail is allowed only from round >= 2).
  const agentScript = [
    `repo={{repo_dir}}`,
    `n=$(cat '${stateFile}')`,
    `n=$((n+1))`,
    `printf '%s' "$n" > '${stateFile}'`,
    `printf 'export const value = '"$((n+10))"';\\n' > "$repo/src.ts"`,
    `if [ "$n" -eq 1 ]; then mkdir -p "$repo/.gooseherd" && printf 'too eager\\n' > "$repo/.gooseherd/bail-test-loop"; fi`,
  ].join("; ");

  const ctx = new ContextBag({ repoDir, runDir, changedFiles: ["src.ts"] });

  const result = await fixCiNode({ id: "fix_ci", type: "agentic", action: "fix_ci" }, ctx, {
    config: makeConfig({
      agentCommandTemplate: agentScript,
      // Test always fails; without bail honoring this exhausts all 5 rounds.
      localTestCommand: "exit 1",
      ciFixAgentBailEnabled: true,
    }),
    run: makeRun({ branchName: "" }),
    logFile,
    workRoot: runDir,
    onPhase: async () => undefined,
  });

  assert.equal(result.outcome, "failure", "round-1 bail must be ignored, so the loop exhausts");
  assert.equal((await readFile(stateFile, "utf8")).trim(), "5", "all 5 rounds must run");

  const log = await readFile(logFile, "utf8");
  assert.match(
    log,
    /\[ci:fix:inner\] round 1\/5: agent placed bail sentinel on round 1 but bail is allowed only from round 2 — ignoring/,
  );
  assert.doesNotMatch(log, /bail honored/);
  assert.doesNotMatch(log, /\[ci:fix\] pushed fix commit/);
});

test("fixCiNode ignores the bail sentinel when the feature flag is off", async (t) => {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-bail-disabled-repo-"));
  const runDir = await mkdtemp(path.join(os.tmpdir(), "fix-ci-bail-disabled-run-"));
  const logFile = path.join(runDir, "run.log");
  const stateFile = path.join(runDir, "agent-round");
  await writeFile(logFile, "", "utf8");
  await writeFile(stateFile, "0", "utf8");
  await initRepo(repoDir, logFile);
  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  });

  // Drop the sentinel on every round, but expect it to be ignored entirely.
  const agentScript = [
    `repo={{repo_dir}}`,
    `n=$(cat '${stateFile}')`,
    `n=$((n+1))`,
    `printf '%s' "$n" > '${stateFile}'`,
    `printf 'export const value = '"$((n+10))"';\\n' > "$repo/src.ts"`,
    `mkdir -p "$repo/.gooseherd" && printf 'please bail\\n' > "$repo/.gooseherd/bail-test-loop"`,
  ].join("; ");

  const ctx = new ContextBag({ repoDir, runDir, changedFiles: ["src.ts"] });

  const result = await fixCiNode({ id: "fix_ci", type: "agentic", action: "fix_ci" }, ctx, {
    config: makeConfig({
      agentCommandTemplate: agentScript,
      localTestCommand: "exit 1",
      // Feature flag explicitly OFF (this is also the default).
      ciFixAgentBailEnabled: false,
    }),
    run: makeRun({ branchName: "" }),
    logFile,
    workRoot: runDir,
    onPhase: async () => undefined,
  });

  assert.equal(result.outcome, "failure");
  assert.equal((await readFile(stateFile, "utf8")).trim(), "5", "with bail disabled we still exhaust all 5 rounds");

  const log = await readFile(logFile, "utf8");
  assert.match(log, /agent placed bail sentinel but ciFixAgentBailEnabled is false — ignoring/);
  assert.doesNotMatch(log, /bail honored/);

  // And the retry prompt must NOT advertise the bail option when the flag is off.
  const retryPrompt = await readFile(path.join(runDir, "ci-fix-round-1-inner-retry-1.md"), "utf8");
  assert.doesNotMatch(retryPrompt, /If you believe the failure is environmental/);
  assert.doesNotMatch(retryPrompt, /bail-test-loop/);
});
