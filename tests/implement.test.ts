import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  analyzeAgentOutput,
  classifyAutoReviewNoop,
  extractAutoReviewSummary,
  extractPiAgentCost,
  inspectAutoReviewOutput,
  implementNode,
  persistAutoReviewSummaryArtifact,
} from "../src/pipeline/nodes/implement.js";
import { ContextBag } from "../src/pipeline/context-bag.js";
import type { AppConfig } from "../src/config.js";
import type { RunRecord } from "../src/types.js";
import { runShellCapture } from "../src/pipeline/shell.js";

// ── Helper: create a real git repo with changes ──

test("extractPiAgentCost aggregates assistant usage by model", () => {
  const stdout = [
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        model: "openai/gpt-4.1-mini",
        usage: { input: 100, output: 200, cost: { total: 0.001 } }
      }
    }),
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        model: "anthropic/claude-sonnet-4-6",
        usage: { input: 200, output: 1000, cost: { total: 0.016 } }
      }
    }),
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        model: "openai/gpt-4.1-mini",
        usage: { input: 30, output: 2, cost: { total: 0.0001 } }
      }
    })
  ].join("\n");

  const cost = extractPiAgentCost(stdout);

  assert.deepEqual(cost?.byModel, [
    { model: "openai/gpt-4.1-mini", input: 130, output: 202, costUsd: 0.0011 },
    { model: "anthropic/claude-sonnet-4-6", input: 200, output: 1000, costUsd: 0.016 }
  ]);
  assert.equal(cost?.inputTokens, 330);
  assert.equal(cost?.outputTokens, 1202);
  assert.equal(cost?.totalCost, 0.0171);
});

async function makeGitRepo(prefix = "impl-test-"): Promise<{ dir: string; logFile: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  // Log file lives OUTSIDE the repo to avoid polluting git diff
  const logDir = await mkdtemp(path.join(os.tmpdir(), "impl-log-"));
  const logFile = path.join(logDir, "test.log");
  await writeFile(logFile, "", "utf8");
  await runShellCapture("git init && git config user.email 'test@test.com' && git config user.name 'Test'", { cwd: dir, logFile });
  // Create initial commit so HEAD exists
  await writeFile(path.join(dir, ".gitkeep"), "", "utf8");
  await runShellCapture("git add -A && git commit -m 'init'", { cwd: dir, logFile });
  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(logDir, { recursive: true, force: true });
  };
  return { dir, logFile, cleanup };
}

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
    agentCommandTemplate: "printf 'GOOSEHERD_REVIEW_SUMMARY: {\"selectedFindings\":[],\"ignoredFindings\":[],\"rationale\":\"No actionable findings in the current diff.\"}\\n'",
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

const PI_JSONL_NOOP_SUMMARY = [
  "{\"type\":\"session\",\"version\":3}",
  "{\"type\":\"agent_start\"}",
  "{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_end\",\"content\":\"GOOSEHERD_REVIEW_SUMMARY: {\\\"selectedFindings\\\":[],\\\"ignoredFindings\\\":[\\\"stale comment\\\"],\\\"rationale\\\":\\\"No actionable findings in the current diff.\\\"}\"}}",
  "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"GOOSEHERD_REVIEW_SUMMARY: {\\\"selectedFindings\\\":[],\\\"ignoredFindings\\\":[\\\"stale comment\\\"],\\\"rationale\\\":\\\"No actionable findings in the current diff.\\\"}\"}]}}",
  "{\"type\":\"agent_end\",\"messages\":[]}",
].join("\n");

const PI_JSONL_NOOP_SUMMARY_DELTA = [
  "{\"type\":\"session\",\"version\":3}",
  "{\"type\":\"agent_start\"}",
  "{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"contentIndex\":0,\"delta\":\"summary\",\"partial\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"GOOSEHERD_REVIEW_SUMMARY: {\\\"selectedFindings\\\":[],\\\"ignoredFindings\\\":[\\\"stale comment\\\"],\\\"rationale\\\":\\\"No actionable findings in the current diff.\\\"}\"}]}}}",
  "{\"type\":\"agent_end\",\"messages\":[]}",
].join("\n");

const PI_JSONL_EMBEDDED_NOOP_SUMMARY_DELTA = [
  "{\"type\":\"session\",\"version\":3}",
  "{\"type\":\"agent_start\"}",
  "{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"contentIndex\":0,\"delta\":\"summary\",\"partial\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"I reviewed the changes in the PR and found no remaining actionable issues.\\nGOOSEHERD_REVIEW_SUMMARY: {\\\"selectedFindings\\\":[],\\\"ignoredFindings\\\":[\\\"stale comment\\\"],\\\"rationale\\\":\\\"No actionable findings in the current diff.\\\"}\"}]}}}",
  "{\"type\":\"agent_end\",\"messages\":[]}",
].join("\n");

const PI_JSONL_MULTILINE_NOOP_SUMMARY_DELTA = [
  "{\"type\":\"session\",\"version\":3}",
  "{\"type\":\"agent_start\"}",
  "{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"contentIndex\":0,\"delta\":\"summary\",\"partial\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"I reviewed the changes in the PR and found no remaining actionable issues.\\nGOOSEHERD_REVIEW_SUMMARY:\\n{\\n  \\\"selectedFindings\\\": [],\\n  \\\"ignoredFindings\\\": [\\\"stale comment\\\"],\\n  \\\"rationale\\\": \\\"No actionable findings in the current diff.\\\"\\n}\"}]}}}",
  "{\"type\":\"agent_end\",\"messages\":[]}",
].join("\n");

const PI_JSONL_PARTIAL_SENTINEL_THEN_COMPLETE_SUMMARY = [
  "{\"type\":\"session\",\"version\":3}",
  "{\"type\":\"agent_start\"}",
  "{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"contentIndex\":0,\"delta\":\"prefix\",\"partial\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Review complete.\\nGOOSEHERD_REVIEW_SUMMARY:\"}]}}}",
  "{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"contentIndex\":0,\"delta\":\"json\",\"partial\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Review complete.\\nGOOSEHERD_REVIEW_SUMMARY:{\\\"selectedFindings\\\":[],\\\"ignoredFindings\\\":[\\\"stale comment\\\"],\\\"rationale\\\":\\\"No actionable findings in the current diff.\\\"}\"}]}}}",
  "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Review complete.\\nGOOSEHERD_REVIEW_SUMMARY:{\\\"selectedFindings\\\":[],\\\"ignoredFindings\\\":[\\\"stale comment\\\"],\\\"rationale\\\":\\\"No actionable findings in the current diff.\\\"}\"}]}}",
  "{\"type\":\"agent_end\",\"messages\":[]}",
].join("\n");

const INVALID_SUMMARY_OUTPUT = [
  "Review complete.",
  "GOOSEHERD_REVIEW_SUMMARY:",
  "{",
  "  not-json",
  "}",
].join("\n");

const PI_JSONL_CONTEXT_CONFLICT = [
  "{\"type\":\"session\",\"version\":3}",
  "{\"type\":\"agent_start\"}",
  "{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_end\",\"content\":\"GOOSEHERD_CONTEXT_CONFLICT: Jira describes a different scope than the current branch diff\"}}",
  "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"GOOSEHERD_CONTEXT_CONFLICT: Jira describes a different scope than the current branch diff\"}]}}",
  "{\"type\":\"agent_end\",\"messages\":[]}",
].join("\n");

// ── analyzeAgentOutput: verdict logic ──

test("analyzeAgentOutput: no changes → verdict empty", async (t) => {
  const { dir, logFile, cleanup } = await makeGitRepo();
  t.after(cleanup);

  const result = await analyzeAgentOutput(dir, "", "", logFile);
  assert.equal(result.verdict, "empty");
  assert.equal(result.filesChanged.length, 0);
  assert.equal(result.diffStats.filesCount, 0);
  assert.ok(result.signals.some(s => s.includes("no file changes")));
});

test("analyzeAgentOutput: AGENTS.md only → verdict empty", async (t) => {
  const { dir, logFile, cleanup } = await makeGitRepo();
  t.after(cleanup);

  await writeFile(path.join(dir, "AGENTS.md"), "# AGENTS.md\n", "utf8");

  const result = await analyzeAgentOutput(dir, "", "", logFile);
  assert.equal(result.verdict, "empty");
  assert.deepEqual(result.filesChanged, []);
  assert.equal(result.diffStats.filesCount, 0);
});

test("analyzeAgentOutput: context conflict sentinel → verdict context_conflict", async (t) => {
  const { dir, logFile, cleanup } = await makeGitRepo();
  t.after(cleanup);

  const result = await analyzeAgentOutput(
    dir,
    "GOOSEHERD_CONTEXT_CONFLICT: Jira describes a different scope than the current branch diff",
    "",
    logFile
  );

  assert.equal(result.verdict, "context_conflict");
  assert.equal(result.contextConflictReason, "Jira describes a different scope than the current branch diff");
  assert.deepEqual(result.filesChanged, []);
  assert.equal(result.diffStats.filesCount, 0);
});

test("persistAutoReviewSummaryArtifact: writes parsed summary for auto-review runs", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-review-summary-"));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const artifact = await persistAutoReviewSummaryArtifact(
    "work-item:auto-review",
    dir,
    [
      "Finished review.",
      'GOOSEHERD_REVIEW_SUMMARY: {"selectedFindings":["race in queued message completion","missing bot_type filter"],"ignoredFindings":["stale naming comment"],"rationale":"I fixed the issues that still reproduced in the current diff and ignored the stale naming suggestion."}',
    ].join("\n"),
    ["queued_message_call_job.rb", "queued_message_service.rb"]
  );

  assert.ok(artifact, "Expected auto-review summary artifact to be created");
  assert.equal(artifact?.path, "auto-review-summary.json");
  assert.deepEqual(artifact?.summary.selectedFindings, [
    "race in queued message completion",
    "missing bot_type filter",
  ]);
  assert.deepEqual(artifact?.summary.ignoredFindings, ["stale naming comment"]);
  assert.match(artifact?.summary.rationale ?? "", /fixed the issues/i);

  const saved = JSON.parse(await readFile(path.join(dir, "auto-review-summary.json"), "utf8")) as {
    selectedFindings: string[];
    ignoredFindings: string[];
    rationale: string;
  };
  assert.deepEqual(saved, artifact?.summary);
});

test("persistAutoReviewSummaryArtifact: writes summary for auto-review intent", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-review-intent-summary-"));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const artifact = await persistAutoReviewSummaryArtifact(
    makeRun({
      requestedBy: "manual:dashboard",
      intent: {
        version: 1,
        kind: "feature_delivery.self_review",
        source: "work_item",
        workItemId: "11111111-1111-1111-1111-111111111111",
        repo: "owner/repo",
        prNumber: 7,
        prUrl: "https://github.com/owner/repo/pull/7",
        sourceSubstate: "pr_adopted",
      },
    }),
    dir,
    'GOOSEHERD_REVIEW_SUMMARY: {"selectedFindings":[],"ignoredFindings":[],"rationale":"No remaining findings."}',
  );

  assert.ok(artifact, "Expected auto-review summary artifact to be created from intent");
});

test("persistAutoReviewSummaryArtifact: falls back to context conflict rationale", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-review-conflict-"));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const artifact = await persistAutoReviewSummaryArtifact(
    "work-item:auto-review",
    dir,
    "GOOSEHERD_CONTEXT_CONFLICT: Jira describes a different scope than the current branch diff",
    []
  );

  assert.ok(artifact, "Expected conflict runs to still emit a summary artifact");
  assert.deepEqual(artifact?.summary.selectedFindings, []);
  assert.deepEqual(artifact?.summary.ignoredFindings, []);
  assert.equal(
    artifact?.summary.rationale,
    "Context conflict: Jira describes a different scope than the current branch diff"
  );
});

test("persistAutoReviewSummaryArtifact: stores heuristic grounding metrics", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-review-grounding-"));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const artifact = await persistAutoReviewSummaryArtifact(
    "work-item:auto-review",
    dir,
    'GOOSEHERD_REVIEW_SUMMARY: {"selectedFindings":["queued message race","missing bot_type filter"],"ignoredFindings":["rename unrelated helper"],"rationale":"The queue-specific findings still matched the changed files."}',
    ["app/jobs/queued_message_call_job.rb", "app/services/queued_message_service.rb"]
  );

  assert.ok(artifact?.summary.groundingMetrics, "Expected grounding metrics to be present");
  assert.equal(artifact?.summary.groundingMetrics?.selectedFindingCount, 2);
  assert.equal(artifact?.summary.groundingMetrics?.selectedFindingOverlapCount, 1);
  assert.equal(artifact?.summary.groundingMetrics?.selectedFindingOverlapRatio, 0.5);
});

test("extractAutoReviewSummary: parses pi-agent JSONL assistant text", () => {
  const summary = extractAutoReviewSummary(PI_JSONL_NOOP_SUMMARY);

  assert.deepEqual(summary, {
    selectedFindings: [],
    ignoredFindings: ["stale comment"],
    rationale: "No actionable findings in the current diff.",
  });
});

test("inspectAutoReviewOutput: reports pi-agent JSONL extraction method", () => {
  const diagnostics = inspectAutoReviewOutput(PI_JSONL_NOOP_SUMMARY);

  assert.equal(diagnostics.summaryFound, true);
  assert.equal(diagnostics.summaryExtractionMethod, "pi_jsonl_message_update");
  assert.equal(diagnostics.contextConflictFound, false);
  assert.match(diagnostics.preview ?? "", /GOOSEHERD_REVIEW_SUMMARY/);
});

test("inspectAutoReviewOutput: detects summary in pi-agent text_delta partial output", () => {
  const diagnostics = inspectAutoReviewOutput(PI_JSONL_NOOP_SUMMARY_DELTA);

  assert.equal(diagnostics.summaryFound, true);
  assert.equal(diagnostics.summaryExtractionMethod, "pi_jsonl_message_update");
  assert.equal(diagnostics.contextConflictFound, false);
  assert.match(diagnostics.preview ?? "", /GOOSEHERD_REVIEW_SUMMARY/);
});

test("inspectAutoReviewOutput: detects summary embedded later in a pi-agent text block", () => {
  const diagnostics = inspectAutoReviewOutput(PI_JSONL_EMBEDDED_NOOP_SUMMARY_DELTA);

  assert.equal(diagnostics.summaryFound, true);
  assert.equal(diagnostics.summaryExtractionMethod, "pi_jsonl_message_update");
  assert.equal(diagnostics.contextConflictFound, false);
  assert.match(diagnostics.preview ?? "", /GOOSEHERD_REVIEW_SUMMARY/);
});

test("inspectAutoReviewOutput: keeps multiline JSON summary preview", () => {
  const diagnostics = inspectAutoReviewOutput(PI_JSONL_MULTILINE_NOOP_SUMMARY_DELTA);

  assert.equal(diagnostics.summaryFound, true);
  assert.equal(diagnostics.summaryExtractionMethod, "pi_jsonl_message_update");
  assert.match(diagnostics.preview ?? "", /selectedFindings/);
  assert.match(diagnostics.preview ?? "", /ignoredFindings/);
});

test("inspectAutoReviewOutput: falls back to the tail of agent output when summary is missing", () => {
  const diagnostics = inspectAutoReviewOutput([
    "L01",
    "L02",
    "L03",
    "L04",
    "L05",
    "L06",
    "L07",
    "L08",
    "L09",
    "L10",
    "L11",
    "L12",
  ].join("\n"));

  assert.equal(diagnostics.summaryFound, false);
  assert.equal(diagnostics.summaryExtractionMethod, "none");
  assert.equal(diagnostics.contextConflictFound, false);
  assert.doesNotMatch(diagnostics.preview ?? "", /\bL01\b/);
  assert.match(diagnostics.preview ?? "", /\bL03\b/);
  assert.match(diagnostics.preview ?? "", /\bL12\b/);
});

test("classifyAutoReviewNoop: allows success when summary reports no actionable findings", () => {
  const result = classifyAutoReviewNoop(
    "work-item:auto-review",
    "GOOSEHERD_REVIEW_SUMMARY: {\"selectedFindings\":[],\"ignoredFindings\":[\"stale comment\"],\"rationale\":\"No actionable findings in the current diff.\"}"
  );

  assert.deepEqual(result, { allowed: true });
});

test("classifyAutoReviewNoop: allows pi-agent JSONL no-op summary", () => {
  const result = classifyAutoReviewNoop(
    "work-item:auto-review",
    PI_JSONL_NOOP_SUMMARY
  );

  assert.deepEqual(result, { allowed: true });
});

test("classifyAutoReviewNoop: allows pi-agent JSONL text_delta no-op summary", () => {
  const result = classifyAutoReviewNoop(
    "work-item:auto-review",
    PI_JSONL_NOOP_SUMMARY_DELTA
  );

  assert.deepEqual(result, { allowed: true });
});

test("classifyAutoReviewNoop: allows pi-agent JSONL summary embedded after prose", () => {
  const result = classifyAutoReviewNoop(
    "work-item:auto-review",
    PI_JSONL_EMBEDDED_NOOP_SUMMARY_DELTA
  );

  assert.deepEqual(result, { allowed: true });
});

test("classifyAutoReviewNoop: allows multiline JSON summary after sentinel", () => {
  const result = classifyAutoReviewNoop(
    "work-item:auto-review",
    PI_JSONL_MULTILINE_NOOP_SUMMARY_DELTA
  );

  assert.deepEqual(result, { allowed: true });
});

test("classifyAutoReviewNoop: ignores partial sentinel-only text_delta events when a later full summary exists", () => {
  const result = classifyAutoReviewNoop(
    "work-item:auto-review",
    PI_JSONL_PARTIAL_SENTINEL_THEN_COMPLETE_SUMMARY
  );

  assert.deepEqual(result, { allowed: true });
});

test("classifyAutoReviewNoop: distinguishes unparsable summary payloads", () => {
  const result = classifyAutoReviewNoop(
    "work-item:auto-review",
    INVALID_SUMMARY_OUTPUT
  );

  assert.deepEqual(result, {
    allowed: false,
    reason: "Agent emitted GOOSEHERD_REVIEW_SUMMARY but the JSON payload could not be parsed.",
  });
});

test("classifyAutoReviewNoop: rejects empty diff when summary is missing", () => {
  const result = classifyAutoReviewNoop(
    "work-item:auto-review",
    "Finished review with no changes."
  );

  assert.deepEqual(result, {
    allowed: false,
    reason: "Agent made no changes and did not emit GOOSEHERD_REVIEW_SUMMARY.",
  });
});

test("classifyAutoReviewNoop: rejects empty diff when actionable findings remain", () => {
  const result = classifyAutoReviewNoop(
    "work-item:auto-review",
    "GOOSEHERD_REVIEW_SUMMARY: {\"selectedFindings\":[\"missing nil guard\"],\"ignoredFindings\":[],\"rationale\":\"The issue still reproduces.\"}"
  );

  assert.deepEqual(result, {
    allowed: false,
    reason: "Agent reported actionable findings but made no code changes.",
  });
});

test("implementNode: auto-review no-op exposes summary artifact as internal artifact", async (t) => {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "implement-node-repo-"));
  const runDir = await mkdtemp(path.join(os.tmpdir(), "implement-node-run-"));
  const logDir = await mkdtemp(path.join(os.tmpdir(), "implement-node-log-"));
  const logFile = path.join(logDir, "run.log");
  const promptFile = path.join(runDir, "task.md");
  await writeFile(logFile, "", "utf8");
  await writeFile(promptFile, "review prompt", "utf8");
  await runShellCapture("git init && git config user.email 'test@test.com' && git config user.name 'Test'", { cwd: repoDir, logFile });
  await writeFile(path.join(repoDir, ".gitkeep"), "", "utf8");
  await runShellCapture("git add -A && git commit -m 'init'", { cwd: repoDir, logFile });
  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
    await rm(logDir, { recursive: true, force: true });
  });

  const ctx = new ContextBag();
  ctx.set("repoDir", repoDir);
  ctx.set("promptFile", promptFile);
  ctx.set("runDir", runDir);

  const result = await implementNode({ id: "implement", type: "agentic", action: "implement" }, ctx, {
    config: makeConfig(),
    run: makeRun(),
    logFile,
    workRoot: runDir,
    onPhase: async () => undefined,
  });

  assert.equal(result.outcome, "success");
  assert.equal(result.outputs?.autoReviewNoop, true);
  assert.deepEqual(result.outputs?.internalArtifacts, [
    "agent-stdout.log",
    "agent-stderr.log",
    "auto-review-summary.json",
  ]);
});

test("implementNode: persists raw stdout and stderr artifacts for debug", async (t) => {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "implement-node-streams-repo-"));
  const runDir = await mkdtemp(path.join(os.tmpdir(), "implement-node-streams-run-"));
  const logDir = await mkdtemp(path.join(os.tmpdir(), "implement-node-streams-log-"));
  const logFile = path.join(logDir, "run.log");
  const promptFile = path.join(runDir, "task.md");
  await writeFile(logFile, "", "utf8");
  await writeFile(promptFile, "review prompt", "utf8");
  await runShellCapture("git init && git config user.email 'test@test.com' && git config user.name 'Test'", { cwd: repoDir, logFile });
  await writeFile(path.join(repoDir, ".gitkeep"), "", "utf8");
  await runShellCapture("git add -A && git commit -m 'init'", { cwd: repoDir, logFile });
  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
    await rm(logDir, { recursive: true, force: true });
  });

  const ctx = new ContextBag();
  ctx.set("repoDir", repoDir);
  ctx.set("promptFile", promptFile);
  ctx.set("runDir", runDir);

  const result = await implementNode({ id: "implement", type: "agentic", action: "implement" }, ctx, {
    config: makeConfig({
      agentCommandTemplate: `printf 'stdout marker\nGOOSEHERD_REVIEW_SUMMARY: {"selectedFindings":[],"ignoredFindings":[],"rationale":"No actionable findings in the current diff."}\n'; printf 'stderr marker\n' >&2`,
    }),
    run: makeRun(),
    logFile,
    workRoot: runDir,
    onPhase: async () => undefined,
  });

  assert.equal(result.outcome, "success");
  assert.ok(result.outputs?.internalArtifacts?.includes("agent-stdout.log"));
  assert.ok(result.outputs?.internalArtifacts?.includes("agent-stderr.log"));
  assert.ok(result.outputs?.internalArtifacts?.includes("auto-review-summary.json"));
  assert.match(await readFile(path.join(runDir, "agent-stdout.log"), "utf8"), /stdout marker/);
  assert.match(await readFile(path.join(runDir, "agent-stderr.log"), "utf8"), /stderr marker/);
});

test("implementNode: auto-review failure logs debug diagnostics when mode is failures", async (t) => {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "implement-node-debug-repo-"));
  const runDir = await mkdtemp(path.join(os.tmpdir(), "implement-node-debug-run-"));
  const logDir = await mkdtemp(path.join(os.tmpdir(), "implement-node-debug-log-"));
  const logFile = path.join(logDir, "run.log");
  const promptFile = path.join(runDir, "task.md");
  await writeFile(logFile, "", "utf8");
  await writeFile(promptFile, "review prompt", "utf8");
  await runShellCapture("git init && git config user.email 'test@test.com' && git config user.name 'Test'", { cwd: repoDir, logFile });
  await writeFile(path.join(repoDir, ".gitkeep"), "", "utf8");
  await runShellCapture("git add -A && git commit -m 'init'", { cwd: repoDir, logFile });
  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
    await rm(logDir, { recursive: true, force: true });
  });

  const ctx = new ContextBag();
  ctx.set("repoDir", repoDir);
  ctx.set("promptFile", promptFile);
  ctx.set("runDir", runDir);

  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  t.after(() => {
    console.warn = originalWarn;
  });

  const result = await implementNode({ id: "implement", type: "agentic", action: "implement" }, ctx, {
    config: makeConfig({
      agentCommandTemplate: "printf 'L01\\nL02\\nL03\\nL04\\nL05\\nL06\\nL07\\nL08\\nL09\\nL10\\nL11\\nL12\\n'",
      autoReviewDebugLogMode: "failures",
    }),
    run: makeRun(),
    logFile,
    workRoot: runDir,
    onPhase: async () => undefined,
  });

  assert.equal(result.outcome, "failure");
  assert.ok(
    warnings.some((args) =>
      args.some((arg) => typeof arg === "string" && arg.includes("Auto-review debug diagnostics"))
    ),
    "Expected auto-review debug warning to be emitted"
  );
  const details = warnings
    .flat()
    .find((arg): arg is Record<string, unknown> =>
      Boolean(arg) && typeof arg === "object" && "summaryFound" in (arg as Record<string, unknown>)
    );
  assert.ok(details, "Expected structured debug details");
  assert.equal(details?.summaryFound, false);
  assert.equal(details?.summaryExtractionMethod, "none");
  assert.equal(details?.analysisVerdict, "empty");
  assert.doesNotMatch(String(details?.preview ?? ""), /\bL01\b/);
  assert.match(String(details?.preview ?? ""), /\bL03\b/);
  assert.match(String(details?.preview ?? ""), /\bL12\b/);
});

test("analyzeAgentOutput: normal changes → verdict clean", async (t) => {
  const { dir, logFile, cleanup } = await makeGitRepo();
  t.after(cleanup);

  // Make some changes
  await writeFile(path.join(dir, "src.ts"), "const x = 1;\nconst y = 2;\nconst z = 3;\n", "utf8");
  await writeFile(path.join(dir, "test.ts"), "assert(true);\n", "utf8");

  const result = await analyzeAgentOutput(dir, "all good", "", logFile);
  assert.equal(result.verdict, "clean");
  assert.equal(result.filesChanged.length, 2);
  assert.ok(result.diffStats.added > 0);
  assert.equal(result.diffStats.filesCount, 2);
});

test("analyzeAgentOutput: pi-agent JSONL context conflict → verdict context_conflict", async (t) => {
  const { dir, logFile, cleanup } = await makeGitRepo();
  t.after(cleanup);

  const result = await analyzeAgentOutput(
    dir,
    PI_JSONL_CONTEXT_CONFLICT,
    "",
    logFile
  );

  assert.equal(result.verdict, "context_conflict");
  assert.equal(result.contextConflictReason, "Jira describes a different scope than the current branch diff");
});

test("analyzeAgentOutput: mass deletion → verdict suspect", async (t) => {
  const { dir, logFile, cleanup } = await makeGitRepo();
  t.after(cleanup);

  // Create 6 files with lots of content, commit them, then delete most content
  for (let i = 1; i <= 6; i++) {
    const content = Array.from({ length: 25 }, (_, j) => `line ${String(j + 1)} of file ${String(i)}`).join("\n") + "\n";
    await writeFile(path.join(dir, `file${String(i)}.ts`), content, "utf8");
  }
  await runShellCapture("git add -A && git commit -m 'add files'", { cwd: dir, logFile });

  // Now delete most content (keep 1 line each → removed ~144, added ~6)
  for (let i = 1; i <= 6; i++) {
    await writeFile(path.join(dir, `file${String(i)}.ts`), "x\n", "utf8");
  }

  const result = await analyzeAgentOutput(dir, "", "", logFile);
  assert.equal(result.verdict, "suspect");
  assert.ok(result.signals.some(s => s.includes("mass deletion")));
});

test("analyzeAgentOutput: deletion under thresholds → clean (not suspect)", async (t) => {
  const { dir, logFile, cleanup } = await makeGitRepo();
  t.after(cleanup);

  // Only 3 files (under the >5 files threshold)
  for (let i = 1; i <= 3; i++) {
    const content = Array.from({ length: 50 }, (_, j) => `line ${String(j + 1)}`).join("\n") + "\n";
    await writeFile(path.join(dir, `file${String(i)}.ts`), content, "utf8");
  }
  await runShellCapture("git add -A && git commit -m 'add files'", { cwd: dir, logFile });

  for (let i = 1; i <= 3; i++) {
    await writeFile(path.join(dir, `file${String(i)}.ts`), "x\n", "utf8");
  }

  const result = await analyzeAgentOutput(dir, "", "", logFile);
  assert.equal(result.verdict, "clean", "Should be clean — only 3 files, under >5 threshold");
});

// ── analyzeAgentOutput: signal parsing ──

test("analyzeAgentOutput: detects fatal error signal", async (t) => {
  const { dir, logFile, cleanup } = await makeGitRepo();
  t.after(cleanup);

  await writeFile(path.join(dir, "new.ts"), "code\n", "utf8");
  const result = await analyzeAgentOutput(dir, "fatal error occurred", "", logFile);
  assert.ok(result.signals.some(s => s.includes('error signal') && s.includes('fatal')));
});

test("analyzeAgentOutput: detects panic signal", async (t) => {
  const { dir, logFile, cleanup } = await makeGitRepo();
  t.after(cleanup);

  await writeFile(path.join(dir, "new.ts"), "code\n", "utf8");
  const result = await analyzeAgentOutput(dir, "", "goroutine panic", logFile);
  assert.ok(result.signals.some(s => s.includes('error signal') && s.includes('panic')));
});

test("analyzeAgentOutput: detects warning signal", async (t) => {
  const { dir, logFile, cleanup } = await makeGitRepo();
  t.after(cleanup);

  await writeFile(path.join(dir, "new.ts"), "code\n", "utf8");
  const result = await analyzeAgentOutput(dir, "warning: deprecated API", "", logFile);
  assert.ok(result.signals.some(s => s.includes('warning signal')));
});

test("analyzeAgentOutput: no signals in clean output", async (t) => {
  const { dir, logFile, cleanup } = await makeGitRepo();
  t.after(cleanup);

  await writeFile(path.join(dir, "new.ts"), "code\n", "utf8");
  const result = await analyzeAgentOutput(dir, "All tests passed successfully", "", logFile);
  assert.equal(result.signals.length, 0, "Should have no signals for clean output");
});

test("analyzeAgentOutput: case insensitive signal detection", async (t) => {
  const { dir, logFile, cleanup } = await makeGitRepo();
  t.after(cleanup);

  await writeFile(path.join(dir, "new.ts"), "code\n", "utf8");
  const result = await analyzeAgentOutput(dir, "FATAL ERROR", "", logFile);
  assert.ok(result.signals.some(s => s.includes('error signal')));
});

test("analyzeAgentOutput: detects signals from stderr", async (t) => {
  const { dir, logFile, cleanup } = await makeGitRepo();
  t.after(cleanup);

  await writeFile(path.join(dir, "new.ts"), "code\n", "utf8");
  const result = await analyzeAgentOutput(dir, "", "unhandled exception in module", logFile);
  assert.ok(result.signals.some(s => s.includes('error signal') && s.includes('unhandled exception')));
});

// ── analyzeAgentOutput: diff stats ──

test("analyzeAgentOutput: correct line counts for additions", async (t) => {
  const { dir, logFile, cleanup } = await makeGitRepo();
  t.after(cleanup);

  await writeFile(path.join(dir, "new.ts"), "line1\nline2\nline3\n", "utf8");
  const result = await analyzeAgentOutput(dir, "", "", logFile);
  assert.equal(result.diffStats.added, 3);
  assert.equal(result.diffStats.removed, 0);
  assert.equal(result.diffStats.filesCount, 1);
});

test("analyzeAgentOutput: correct line counts for modifications", async (t) => {
  const { dir, logFile, cleanup } = await makeGitRepo();
  t.after(cleanup);

  // Create and commit a file, then modify it
  await writeFile(path.join(dir, "existing.ts"), "old line 1\nold line 2\n", "utf8");
  await runShellCapture("git add -A && git commit -m 'add file'", { cwd: dir, logFile });
  await writeFile(path.join(dir, "existing.ts"), "new line 1\nnew line 2\nnew line 3\n", "utf8");

  const result = await analyzeAgentOutput(dir, "", "", logFile);
  assert.ok(result.diffStats.added > 0, "Should have additions");
  assert.ok(result.diffStats.removed > 0, "Should have removals");
  assert.equal(result.diffStats.filesCount, 1);
  assert.deepEqual(result.filesChanged, ["existing.ts"]);
});

test("analyzeAgentOutput: diffSummary is populated", async (t) => {
  const { dir, logFile, cleanup } = await makeGitRepo();
  t.after(cleanup);

  await writeFile(path.join(dir, "new.ts"), "hello\n", "utf8");
  const result = await analyzeAgentOutput(dir, "", "", logFile);
  assert.ok(result.diffSummary.length > 0, "diffSummary should not be empty");
  assert.ok(result.diffSummary.includes("new.ts"), "diffSummary should mention the file");
});
