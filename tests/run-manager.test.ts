import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunManager, classifyError } from "../src/run-manager.js";
import { RunStore } from "../src/store.js";
import type { AppConfig } from "../src/config.js";
import type { PipelineEngine } from "../src/pipeline/pipeline-engine.js";
import type { RunRecord, ExecutionResult } from "../src/types.js";

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
    pipelineFile: "pipelines/default.yml",
    observerEnabled: false,
    observerAlertChannelId: "",
    observerMaxRunsPerDay: 10,
    observerMaxRunsPerRepoPerDay: 5,
    observerCooldownMinutes: 5,
    observerRulesFile: "",
    observerRepoMap: new Map(),
    observerSentryPollIntervalSeconds: 300,
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

function makeMockPipelineEngine(result?: Partial<ExecutionResult>): PipelineEngine {
  return {
    execute: async (_run: RunRecord, phaseCallback: (phase: string) => Promise<void>) => {
      await phaseCallback("cloning");
      await phaseCallback("agent");
      await phaseCallback("committing");
      await phaseCallback("pushing");
      return {
        branchName: "testherd/test-branch",
        logsPath: "/tmp/test-work/test-run/run.log",
        commitSha: "abc1234def5678",
        changedFiles: ["src/index.ts", "src/config.ts"],
        prUrl: "https://github.com/org/repo/pull/42",
        ...result
      } as ExecutionResult;
    }
  } as unknown as PipelineEngine;
}

function makeMockPipelineEngineFailing(errorMessage: string): PipelineEngine {
  return {
    execute: async (_run: RunRecord, phaseCallback: (phase: string) => Promise<void>) => {
      await phaseCallback("cloning");
      await phaseCallback("agent");
      throw new Error(errorMessage);
    }
  } as unknown as PipelineEngine;
}

// ── Test helpers ────────────────────────────────────────

async function setupTestStore(): Promise<{ store: RunStore; tmpDir: string }> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "gooseherd-test-"));
  const store = new RunStore(tmpDir);
  await store.init();
  return { store, tmpDir };
}

async function cleanupTestStore(tmpDir: string): Promise<void> {
  // Small delay to let async queue operations finish writing
  await new Promise((resolve) => setTimeout(resolve, 100));
  try {
    await rm(tmpDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors — OS will clean up temp dirs
  }
}

// ── enqueueRun ─────────────────────────────────────────

test("enqueueRun creates a run record and returns it", async () => {
  const { store, tmpDir } = await setupTestStore();
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
    threadTs: "1234567890.000000"
  });

  assert.ok(run.id, "Run should have an ID");
  assert.equal(run.status, "queued");
  assert.equal(run.repoSlug, "org/repo");
  assert.equal(run.task, "fix the bug");
  assert.ok(run.branchName.startsWith("testherd/"));

  await cleanupTestStore(tmpDir);
});

// ── retryRun ───────────────────────────────────────────

test("retryRun creates a new run from a completed run", async () => {
  const { store, tmpDir } = await setupTestStore();
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
    threadTs: "1234567890.000000"
  });

  // Mark as completed so retryRun allows retry (status guard)
  await store.updateRun(original.id, { status: "completed" });

  const retried = await manager.retryRun(original.id, "U5678");
  assert.ok(retried, "Retry should return a new run");
  assert.notEqual(retried!.id, original.id, "Retried run should have a different ID");
  assert.equal(retried!.repoSlug, "org/repo");
  assert.equal(retried!.task, "original task");
  assert.equal(retried!.requestedBy, "U5678");
  // retryRun does NOT set parentRunId
  assert.equal(retried!.parentRunId, undefined);

  await cleanupTestStore(tmpDir);
});

test("retryRun returns undefined for queued/running run", async () => {
  const { store, tmpDir } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const mockPipeline = makeMockPipelineEngine();
  const config = makeConfig();

  const manager = new RunManager(config, store, mockPipeline, mockClient as any);

  const run = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "still running",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000"
  });

  // Run is in "queued" status — retry should be blocked
  const result = await manager.retryRun(run.id, "U5678");
  assert.equal(result, undefined, "Should not retry a queued run");

  await cleanupTestStore(tmpDir);
});

test("retryRun returns undefined for non-existent run", async () => {
  const { store, tmpDir } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const mockPipeline = makeMockPipelineEngine();
  const config = makeConfig();

  const manager = new RunManager(config, store, mockPipeline, mockClient as any);

  const result = await manager.retryRun("nonexistent-id", "U1234");
  assert.equal(result, undefined);

  await cleanupTestStore(tmpDir);
});

// ── continueRun ────────────────────────────────────────

test("continueRun creates a chained run with parentRunId", async () => {
  const { store, tmpDir } = await setupTestStore();
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
    threadTs: "1234567890.000000"
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

  await cleanupTestStore(tmpDir);
});

test("continueRun returns undefined for non-existent parent", async () => {
  const { store, tmpDir } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const mockPipeline = makeMockPipelineEngine();
  const config = makeConfig();

  const manager = new RunManager(config, store, mockPipeline, mockClient as any);

  const result = await manager.continueRun("nonexistent", "new instructions", "U1234");
  assert.equal(result, undefined);

  await cleanupTestStore(tmpDir);
});

// ── processRun (via enqueueRun) ────────────────────────

test("processRun posts status card and summary on success", async () => {
  const { store, tmpDir } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const mockPipeline = makeMockPipelineEngine();
  const config = makeConfig();

  const manager = new RunManager(config, store, mockPipeline, mockClient as any);

  await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "add feature",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000"
  });

  // Wait for the async queue to process
  await new Promise((resolve) => setTimeout(resolve, 200));

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

  await cleanupTestStore(tmpDir);
});

test("processRun posts failure summary on error", async () => {
  const { store, tmpDir } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const mockPipeline = makeMockPipelineEngineFailing("Agent timed out");
  const config = makeConfig();

  const manager = new RunManager(config, store, mockPipeline, mockClient as any);

  await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "fix the bug",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000"
  });

  // Wait for the async queue to process
  await new Promise((resolve) => setTimeout(resolve, 200));

  const postMessages = mockClient._calls.filter((c) => c.method === "chat.postMessage");
  const summary = postMessages[postMessages.length - 1];
  assert.ok(summary, "Should have a summary message on failure");
  const summaryText = summary.args.text as string;
  assert.ok(summaryText.includes("Run failed"), "Summary should say 'Run failed'");
  assert.ok(summaryText.includes("Agent timed out"), "Summary should include error");
  assert.ok(summaryText.includes("retry"), "Summary should suggest retry");

  await cleanupTestStore(tmpDir);
});

// ── username override ──────────────────────────────────

test("postOrUpdateRunCard includes username on postMessage", async () => {
  const { store, tmpDir } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const mockPipeline = makeMockPipelineEngine();
  const config = makeConfig({ slackCommandName: "mybot" });

  const manager = new RunManager(config, store, mockPipeline, mockClient as any);

  await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "test username",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000"
  });

  // Wait for processing
  await new Promise((resolve) => setTimeout(resolve, 200));

  // First postMessage should be the status card
  const firstPost = mockClient._calls.find((c) => c.method === "chat.postMessage");
  assert.ok(firstPost, "Should have at least one postMessage");
  assert.equal(firstPost.args.username, "mybot", "postMessage should include username");

  // chat.update calls should NOT have username (Slack API doesn't support it on updates)
  const updates = mockClient._calls.filter((c) => c.method === "chat.update");
  for (const update of updates) {
    assert.equal(update.args.username, undefined, "chat.update should not include username");
  }

  await cleanupTestStore(tmpDir);
});

// ── formatRunStatus ────────────────────────────────────

test("formatRunStatus returns message when no run found", async () => {
  const { store, tmpDir } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const mockPipeline = makeMockPipelineEngine();
  const config = makeConfig();

  const manager = new RunManager(config, store, mockPipeline, mockClient as any);

  const status = await manager.formatRunStatus(undefined, "C1234");
  assert.ok(status.includes("No run found"), "Should say no run found");

  await cleanupTestStore(tmpDir);
});

test("formatRunStatus returns not found for bad ID", async () => {
  const { store, tmpDir } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const mockPipeline = makeMockPipelineEngine();
  const config = makeConfig();

  const manager = new RunManager(config, store, mockPipeline, mockClient as any);

  const status = await manager.formatRunStatus("nonexistent", "C1234");
  assert.ok(status.includes("not found"), "Should say run not found");

  await cleanupTestStore(tmpDir);
});

// ── getLatestRunForThread ──────────────────────────────

test("getLatestRunForThread returns the most recent run", async () => {
  const { store, tmpDir } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const mockPipeline = makeMockPipelineEngine();
  const config = makeConfig();

  const manager = new RunManager(config, store, mockPipeline, mockClient as any);

  await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "first",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000"
  });

  const second = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "second",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000"
  });

  const latest = await manager.getLatestRunForThread("C1234", "1234567890.000000");
  assert.ok(latest, "Should find a run");
  assert.equal(latest!.id, second.id, "Should return the most recent run");

  await cleanupTestStore(tmpDir);
});

// ── getRunChain ────────────────────────────────────────

test("getRunChain returns all runs in a thread sorted by creation", async () => {
  const { store, tmpDir } = await setupTestStore();
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
    threadTs: "1234567890.000000"
  });

  const second = await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "second",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000"
  });

  const chain = await manager.getRunChain("C1234", "1234567890.000000");
  assert.equal(chain.length, 2);
  assert.equal(chain[0].id, first.id);
  assert.equal(chain[1].id, second.id);

  // Different thread should return empty
  const other = await manager.getRunChain("C1234", "9999999999.000000");
  assert.equal(other.length, 0);

  await cleanupTestStore(tmpDir);
});

// ── summary message content ────────────────────────────

test("summary includes task preview when task is long", async () => {
  const { store, tmpDir } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const longTask = "a".repeat(200);
  const mockPipeline = makeMockPipelineEngine();
  const config = makeConfig();

  const manager = new RunManager(config, store, mockPipeline, mockClient as any);

  await manager.enqueueRun({
    repoSlug: "org/repo",
    task: longTask,
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000"
  });

  await new Promise((resolve) => setTimeout(resolve, 200));

  const postMessages = mockClient._calls.filter((c) => c.method === "chat.postMessage");
  const summary = postMessages[postMessages.length - 1];
  const summaryText = summary.args.text as string;
  assert.ok(summaryText.includes("..."), "Long task should be truncated with ellipsis");

  await cleanupTestStore(tmpDir);
});

test("summary limits displayed files to 10", async () => {
  const { store, tmpDir } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const manyFiles = Array.from({ length: 15 }, (_, i) => `src/file${String(i)}.ts`);
  const mockPipeline = makeMockPipelineEngine({ changedFiles: manyFiles });
  const config = makeConfig();

  const manager = new RunManager(config, store, mockPipeline, mockClient as any);

  await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "many file changes",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000"
  });

  await new Promise((resolve) => setTimeout(resolve, 200));

  const postMessages = mockClient._calls.filter((c) => c.method === "chat.postMessage");
  const summary = postMessages[postMessages.length - 1];
  const summaryText = summary.args.text as string;
  assert.ok(summaryText.includes("+5 more"), "Should show overflow count for files > 10");

  await cleanupTestStore(tmpDir);
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
  const { store, tmpDir } = await setupTestStore();
  const mockClient = makeMockSlackClient();
  const mockPipeline = makeMockPipelineEngineFailing("failed to clone org/repo: fatal: repository not found");
  const config = makeConfig();

  const manager = new RunManager(config, store, mockPipeline, mockClient as any);

  await manager.enqueueRun({
    repoSlug: "org/repo",
    task: "fix the bug",
    baseBranch: "main",
    requestedBy: "U1234",
    channelId: "C1234",
    threadTs: "1234567890.000000"
  });

  await new Promise((resolve) => setTimeout(resolve, 200));

  const postMessages = mockClient._calls.filter((c) => c.method === "chat.postMessage");
  const summary = postMessages[postMessages.length - 1];
  const summaryText = summary.args.text as string;
  assert.ok(summaryText.includes("Failed to clone repository"), "Should show friendly error name");
  assert.ok(summaryText.includes("GITHUB_TOKEN"), "Should show suggestion");

  await cleanupTestStore(tmpDir);
});
