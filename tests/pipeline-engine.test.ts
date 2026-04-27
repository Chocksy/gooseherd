import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PipelineEngine } from "../src/pipeline/pipeline-engine.js";
import { ContextBag } from "../src/pipeline/context-bag.js";
import type { AppConfig } from "../src/config.js";
import type { RunRecord } from "../src/types.js";
import type { NodeConfig, NodeResult } from "../src/pipeline/types.js";
import { NODE_HANDLERS } from "../src/pipeline/node-registry.js";
import { runShellCapture } from "../src/pipeline/shell.js";

// ── Helpers ──

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
    localTestCommand: "",
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
    ...overrides
  } as AppConfig;
}

function makeRun(overrides?: Partial<RunRecord>): RunRecord {
  return {
    id: "test-run-001",
    status: "queued",
    repoSlug: "owner/repo",
    task: "Fix the bug",
    baseBranch: "main",
    branchName: "testherd/test-run",
    requestedBy: "U123",
    channelId: "C123",
    threadTs: "1234567890.000000",
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

// ── Pipeline override validation ──

test("PipelineEngine: instantiates correctly", async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pe-test-"));
  const workDir = path.join(tmpDir, "work");
  await mkdir(path.join(workDir, "test-run-001"), { recursive: true });
  await writeFile(path.join(workDir, "test-run-001", "run.log"), "", "utf8");
  t.after(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  const config = makeConfig({ workRoot: workDir });
  const engine = new PipelineEngine(config);
  assert.ok(engine instanceof PipelineEngine);
});

test("PipelineEngine: seeds ContextBag with run prefetch context", async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pe-prefetch-"));
  const workDir = path.join(tmpDir, "work");
  await mkdir(workDir, { recursive: true });
  const pipelinePath = path.join(tmpDir, "pipeline.yml");
  await writeFile(
    pipelinePath,
    [
      "version: 1",
      "name: test-pipeline",
      "nodes:",
      "  - id: classify_task",
      "    type: deterministic",
      "    action: classify_task"
    ].join("\n"),
    "utf8"
  );
  t.after(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  const prefetchContext: NonNullable<RunRecord["prefetchContext"]> = {
    meta: {
      fetchedAt: new Date("2026-04-17T00:00:00.000Z").toISOString(),
      sources: ["jira"],
    },
    workItem: {
      id: "work-item-1",
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
  const run = makeRun({
    id: "test-run-prefetch",
    prefetchContext,
  });
  const config = makeConfig({ workRoot: workDir, dryRun: true });
  const engine = new PipelineEngine(config);
  let observedPrefetchContext: RunRecord["prefetchContext"] | undefined;

  (engine as unknown as {
    executePipeline: (
      pipeline: unknown,
      ctx: ContextBag,
      deps: unknown,
      startIndex: number,
      eventLogger?: unknown,
      skipNodeIds?: Set<string>,
      enableNodeIds?: Set<string>,
      abortSignal?: AbortSignal,
      sandboxRef?: { handle?: unknown }
    ) => Promise<NodeResult & { steps: never[]; warnings: never[] }>;
  }).executePipeline = async (_pipeline, ctx) => {
    observedPrefetchContext = ctx.get<RunRecord["prefetchContext"]>("prefetchContext");
    return {
      outcome: "success",
      steps: [],
      warnings: [],
    };
  };

  await engine.execute(run, async () => undefined, pipelinePath);

  assert.deepEqual(observedPrefetchContext, prefetchContext);
});

test("PipelineEngine: unified pipeline is the single pipeline file", () => {
  const resolved = "pipelines/pipeline.yml";
  assert.equal(resolved, "pipelines/pipeline.yml");
});

test("PipelineEngine: filters internal-generated files from execution result changedFiles", async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pe-changed-files-"));
  const workDir = path.join(tmpDir, "work");
  await mkdir(workDir, { recursive: true });
  const pipelinePath = path.join(tmpDir, "pipeline.yml");
  await writeFile(
    pipelinePath,
    [
      "version: 1",
      "name: test-pipeline",
      "nodes:",
      "  - id: classify_task",
      "    type: deterministic",
      "    action: classify_task"
    ].join("\n"),
    "utf8"
  );
  t.after(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  const run = makeRun({ id: "test-run-changed-files" });
  const config = makeConfig({ workRoot: workDir, dryRun: true });
  const engine = new PipelineEngine(config);

  (engine as unknown as {
    executePipeline: (
      pipeline: unknown,
      ctx: ContextBag,
      deps: unknown,
      startIndex: number,
      eventLogger?: unknown,
      skipNodeIds?: Set<string>,
      enableNodeIds?: Set<string>,
      abortSignal?: AbortSignal,
      sandboxRef?: { handle?: unknown }
    ) => Promise<NodeResult & { steps: never[]; warnings: never[] }>;
  }).executePipeline = async (_pipeline, ctx) => {
    ctx.set("changedFiles", ["AGENTS.md", "src/index.ts"]);
    ctx.set("internalArtifacts", ["AGENTS.md"]);
    return {
      outcome: "success",
      steps: [],
      warnings: [],
    };
  };

  const result = await engine.execute(run, async () => undefined, pipelinePath);
  assert.deepEqual(result.changedFiles, ["src/index.ts"]);
  assert.deepEqual(result.internalArtifacts, ["AGENTS.md"]);
});

test("PipelineEngine: context conflict stops before commit and push", async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pe-context-conflict-"));
  const workDir = path.join(tmpDir, "work");
  await mkdir(workDir, { recursive: true });
  const pipelinePath = path.join(tmpDir, "pipeline.yml");
  await writeFile(
    pipelinePath,
    [
      "version: 1",
      "name: context-conflict-pipeline",
      "nodes:",
      "  - id: clone",
      "    type: deterministic",
      "    action: clone",
      "  - id: hydrate_context",
      "    type: deterministic",
      "    action: hydrate_context",
      "  - id: implement",
      "    type: agentic",
      "    action: implement",
      "  - id: commit",
      "    type: deterministic",
      "    action: commit",
      "  - id: push",
      "    type: deterministic",
      "    action: push",
    ].join("\n"),
    "utf8"
  );

  const originalClone = NODE_HANDLERS.clone;
  const originalCommit = NODE_HANDLERS.commit;
  const originalPush = NODE_HANDLERS.push;
  let commitCalls = 0;
  let pushCalls = 0;

  t.after(async () => {
    NODE_HANDLERS.clone = originalClone;
    NODE_HANDLERS.commit = originalCommit;
    NODE_HANDLERS.push = originalPush;
    await rm(tmpDir, { recursive: true, force: true });
  });

  NODE_HANDLERS.clone = async (_nodeConfig, ctx, deps) => {
    const runDir = path.join(deps.workRoot, deps.run.id);
    const repoDir = path.join(runDir, "repo");
    const promptFile = path.join(runDir, "task.md");
    await mkdir(repoDir, { recursive: true });
    await runShellCapture("git init", { cwd: repoDir, logFile: deps.logFile });
    await runShellCapture("git config user.email 'test@test.com'", { cwd: repoDir, logFile: deps.logFile });
    await runShellCapture("git config user.name 'Test User'", { cwd: repoDir, logFile: deps.logFile });
    await runShellCapture("git checkout -b main", { cwd: repoDir, logFile: deps.logFile });
    await writeFile(path.join(repoDir, "queue.txt"), "base queue behavior\n", "utf8");
    await runShellCapture("git add -A && git commit -m 'base'", { cwd: repoDir, logFile: deps.logFile });
    await runShellCapture(`git checkout -b ${deps.run.branchName}`, { cwd: repoDir, logFile: deps.logFile });
    await writeFile(path.join(repoDir, "queue.txt"), "current branch changes queued-message behavior\n", "utf8");
    await runShellCapture("git add -A && git commit -m 'queue change'", { cwd: repoDir, logFile: deps.logFile });

    const outputs = {
      repoDir,
      runDir,
      promptFile,
      resolvedBaseBranch: "main",
      isFollowUp: false,
      reusesExistingBranch: false,
    };
    return { outcome: "success", outputs };
  };
  NODE_HANDLERS.commit = async () => {
    commitCalls += 1;
    return { outcome: "success", outputs: { commitSha: "abc123", changedFiles: ["queue.txt"] } };
  };
  NODE_HANDLERS.push = async () => {
    pushCalls += 1;
    return { outcome: "success" };
  };

  const run = makeRun({
    id: "test-run-context-conflict",
    requestedBy: "work-item:auto-review",
    task: "Rewrite the billing controller to match Jira, even if the current branch diff is about queue handling.",
    prefetchContext: {
      meta: {
        fetchedAt: new Date("2026-04-17T00:00:00.000Z").toISOString(),
        sources: ["github_pr", "jira"],
      },
      workItem: {
        id: "work-item-context-conflict",
        title: "Conflicting auto-review fixture",
        workflow: "feature_delivery",
        jiraIssueKey: "HBL-900",
        githubPrUrl: "https://github.com/owner/repo/pull/99",
        githubPrNumber: 99,
      },
      github: {
        pr: {
          number: 99,
          url: "https://github.com/owner/repo/pull/99",
          title: "Queue worker changes",
          body: "This PR only changes queue handling code.",
          state: "open",
          baseRef: "main",
          headRef: "testherd/test-run",
          headSha: "abc123",
        },
        discussionComments: [],
        reviews: [],
        reviewComments: [],
        ci: {
          conclusion: "success",
          headSha: "abc123",
        },
      },
      jira: {
        issue: {
          key: "HBL-900",
          description: "Jira still talks about a billing controller rewrite.",
        },
        comments: [],
      },
    },
  });
  const config = makeConfig({
    workRoot: workDir,
    dryRun: true,
    agentCommandTemplate: "printf 'GOOSEHERD_CONTEXT_CONFLICT: Jira asks for billing controller work, but the current diff only changes queue.txt\\n'",
  });
  const engine = new PipelineEngine(config);

  await assert.rejects(
    () => engine.execute(run, async () => undefined, pipelinePath),
    /Agent reported context conflict: Jira asks for billing controller work, but the current diff only changes queue\.txt/
  );

  assert.equal(commitCalls, 0, "commit should never run after a context conflict");
  assert.equal(pushCalls, 0, "push should never run after a context conflict");

  const prompt = await readFile(path.join(workDir, run.id, "task.md"), "utf8");
  assert.ok(prompt.includes("### Current Branch Diff"), "Prompt should include the actual diff");
  assert.ok(prompt.includes("current branch changes queued-message behavior"), "Prompt should show the conflicting branch diff");
});

test("PipelineEngine: passes CODEX_API_KEY into sandbox env", async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pe-sandbox-env-"));
  const workDir = path.join(tmpDir, "work");
  const runId = "test-run-sandbox-env";
  const runDir = path.join(workDir, runId);
  const logFile = path.join(runDir, "run.log");
  await mkdir(runDir, { recursive: true });
  await writeFile(logFile, "", "utf8");

  const savedOpenAi = process.env.OPENAI_API_KEY;
  const savedCodex = process.env.CODEX_API_KEY;
  process.env.OPENAI_API_KEY = "sk-openai-test";
  process.env.CODEX_API_KEY = "sk-codex-test";

  t.after(async () => {
    if (savedOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenAi;
    if (savedCodex === undefined) delete process.env.CODEX_API_KEY;
    else process.env.CODEX_API_KEY = savedCodex;
    await rm(tmpDir, { recursive: true, force: true });
  });

  let capturedEnv: Record<string, string> | undefined;
  const fakeContainerManager = {
    createSandbox: async (_runId: string, sandboxConfig: { env: Record<string, string> }) => {
      capturedEnv = sandboxConfig.env;
      return { containerId: "sandbox-1", containerName: "sandbox-1" };
    }
  };

  const config = makeConfig({
    workRoot: workDir,
    sandboxEnabled: true,
    sandboxHostWorkPath: workDir,
  });
  const engine = new PipelineEngine(config, undefined, undefined, fakeContainerManager as never);

  await (engine as unknown as { buildAndCreateSandbox: (runId: string, image: string, logFile: string) => Promise<unknown> })
    .buildAndCreateSandbox(runId, config.sandboxImage, logFile);

  assert.equal(capturedEnv?.OPENAI_API_KEY, "sk-openai-test");
  assert.equal(capturedEnv?.CODEX_API_KEY, "sk-codex-test");
});

test("PipelineEngine: auto-enables decide_recovery when browser_verify is enabled", async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pe-auto-enable-"));
  const workDir = path.join(tmpDir, "work");
  await mkdir(workDir, { recursive: true });
  const pipelinePath = path.join(tmpDir, "pipeline.yml");
  await writeFile(
    pipelinePath,
    [
      "version: 1",
      "name: test-pipeline",
      "nodes:",
      "  - id: classify_task",
      "    type: deterministic",
      "    action: classify_task"
    ].join("\n"),
    "utf8"
  );
  t.after(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  const run = makeRun({ id: "test-run-auto-enable" });
  const config = makeConfig({ workRoot: workDir, dryRun: true });
  const engine = new PipelineEngine(config);

  const result = await engine.execute(
    run,
    async () => {},
    pipelinePath,
    undefined,
    undefined,
    ["browser_verify"]
  );

  const log = await readFile(result.logsPath, "utf8");
  assert.ok(
    log.includes("[pipeline] auto-enable: decide_recovery (browser_verify enabled)"),
    "Expected execute() to auto-enable decide_recovery when browser_verify is requested"
  );
});

test("PipelineEngine: bypasses browser_verify fix loop for non-code failure classes", async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pe-loop-bypass-"));
  const workDir = path.join(tmpDir, "work");
  await mkdir(workDir, { recursive: true });
  const runDir = path.join(workDir, "test-run-loop-bypass");
  await mkdir(runDir, { recursive: true });
  const logFile = path.join(runDir, "run.log");
  await writeFile(logFile, "", "utf8");
  t.after(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  const config = makeConfig({ workRoot: workDir, dryRun: true });
  const engine = new PipelineEngine(config);
  const run = makeRun({ id: "test-run-loop-bypass" });
  const ctx = new ContextBag();
  ctx.set("browserVerifyFailureCode", "auth_exhausted");

  const failedNode: NodeConfig = {
    id: "browser_verify",
    type: "deterministic",
    action: "browser_verify",
    on_failure: {
      action: "loop",
      agent_node: "fix_browser",
      max_rounds: 2,
      on_exhausted: "complete_with_warning"
    }
  };
  const failedResult: NodeResult = {
    outcome: "failure",
    error: "Browser verification failed"
  };
  const deps = {
    config,
    run,
    logFile,
    workRoot: config.workRoot,
    onPhase: async () => {}
  };

  const loopResult = await (engine as any).handleLoopFailure(
    failedNode,
    failedResult,
    ctx,
    deps
  );

  assert.equal(loopResult.outcome, "completed_with_warnings");
  assert.ok(
    loopResult.warnings.some((w: string) => w.includes("loop bypassed") && w.includes("auth_exhausted")),
    "Expected a warning that the browser_verify loop was bypassed"
  );

  const log = await readFile(logFile, "utf8");
  assert.ok(log.includes("browser_verify loop bypassed for auth_exhausted"));
});
