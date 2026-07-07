import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { investigateNode } from "../src/pipeline/nodes/investigate.js";
import { ContextBag } from "../src/pipeline/context-bag.js";
import type { AppConfig } from "../src/config.js";
import type { NodeConfig, NodeDeps } from "../src/pipeline/types.js";
import type { RunRecord } from "../src/types.js";

async function makeWorkspace(): Promise<{ repoDir: string; logFile: string; cleanup: () => Promise<void> }> {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "investigate-test-"));
  const logDir = await mkdtemp(path.join(os.tmpdir(), "investigate-log-"));
  const logFile = path.join(logDir, "run.log");
  await writeFile(logFile, "", "utf8");
  const cleanup = async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(logDir, { recursive: true, force: true });
  };
  return { repoDir, logFile, cleanup };
}

function makeConfig(agentCommandTemplate: string): AppConfig {
  return {
    appName: "TestHerd",
    agentCommandTemplate,
    mcpExtensions: [],
    piAgentExtensions: [],
    sandboxEnabled: false
  } as unknown as AppConfig;
}

function makeRun(overrides?: Partial<RunRecord>): RunRecord {
  return {
    id: "investigate-run-001",
    runtime: "local",
    status: "running",
    repoSlug: "owner/repo",
    task: "Why didn't DWS go out for org 633609?",
    baseBranch: "master",
    branchName: "investigate/run-001",
    requestedBy: "U123",
    channelId: "C123",
    threadTs: "1234567890.000100",
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

function makeDeps(config: AppConfig, run: RunRecord, logFile: string, repoDir: string): NodeDeps {
  return {
    config,
    run,
    logFile,
    workRoot: repoDir,
    onPhase: async () => undefined
  } as NodeDeps;
}

test("investigateNode captures .gooseherd/answer.md content into ContextBag.answer", async () => {
  const { repoDir, logFile, cleanup } = await makeWorkspace();
  try {
    // The fake agent: writes a markdown answer file and exits 0.
    const fakeAgent = "mkdir -p .gooseherd && printf '%s' '# Answer\n\nDWS skipped for org 633609 because Sidekiq queue X drained late.\n' > .gooseherd/answer.md";
    const config = makeConfig(fakeAgent);
    const run = makeRun();
    const ctx = new ContextBag();
    ctx.set("repoDir", repoDir);

    const result = await investigateNode({} as NodeConfig, ctx, makeDeps(config, run, logFile, repoDir));

    assert.equal(result.outcome, "success");
    const answer = ctx.get<string>("answer");
    assert.ok(answer && answer.includes("DWS skipped for org 633609"), `expected answer to contain the fake content, got: ${String(answer)}`);
  } finally {
    await cleanup();
  }
});

test("investigateNode returns soft_fail when .gooseherd/answer.md is missing", async () => {
  const { repoDir, logFile, cleanup } = await makeWorkspace();
  try {
    // Agent runs successfully but writes no answer file.
    const fakeAgent = "true";
    const config = makeConfig(fakeAgent);
    const run = makeRun();
    const ctx = new ContextBag();
    ctx.set("repoDir", repoDir);

    const result = await investigateNode({} as NodeConfig, ctx, makeDeps(config, run, logFile, repoDir));

    assert.equal(result.outcome, "soft_fail");
    assert.match(result.error ?? "", /answer\.md/i);
  } finally {
    await cleanup();
  }
});

test("investigateNode returns soft_fail when answer file is empty", async () => {
  const { repoDir, logFile, cleanup } = await makeWorkspace();
  try {
    const fakeAgent = "mkdir -p .gooseherd && : > .gooseherd/answer.md";
    const config = makeConfig(fakeAgent);
    const run = makeRun();
    const ctx = new ContextBag();
    ctx.set("repoDir", repoDir);

    const result = await investigateNode({} as NodeConfig, ctx, makeDeps(config, run, logFile, repoDir));

    assert.equal(result.outcome, "soft_fail");
  } finally {
    await cleanup();
  }
});

test("investigateNode fails when repoDir is missing from ContextBag", async () => {
  const { repoDir, logFile, cleanup } = await makeWorkspace();
  try {
    const config = makeConfig("true");
    const run = makeRun();
    const ctx = new ContextBag();
    // intentionally NOT set repoDir
    void repoDir;

    const result = await investigateNode({} as NodeConfig, ctx, makeDeps(config, run, logFile, "/nonexistent"));

    assert.equal(result.outcome, "failure");
    assert.match(result.error ?? "", /repoDir/);
  } finally {
    await cleanup();
  }
});

test("investigateNode reads the prompt file written before invoking the agent", async () => {
  const { repoDir, logFile, cleanup } = await makeWorkspace();
  try {
    // The fake agent copies the prompt file into the answer file so the test
    // can prove the prompt was written and contains the run.task.
    const fakeAgent = "mkdir -p .gooseherd && cp .gooseherd/investigate-prompt.md .gooseherd/answer.md";
    const config = makeConfig(fakeAgent);
    const run = makeRun({ task: "Why is feature X broken on prod?" });
    const ctx = new ContextBag();
    ctx.set("repoDir", repoDir);

    const result = await investigateNode({} as NodeConfig, ctx, makeDeps(config, run, logFile, repoDir));

    assert.equal(result.outcome, "success");
    const answer = ctx.get<string>("answer");
    assert.ok(answer && answer.includes("Why is feature X broken on prod?"), "answer should echo the run.task via the prompt file");
  } finally {
    await cleanup();
  }
});
