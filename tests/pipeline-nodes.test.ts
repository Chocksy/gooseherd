/**
 * Tests for plan-task, local-test, and notify pipeline nodes.
 */

import assert from "node:assert/strict";
import { describe, test, mock } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContextBag } from "../src/pipeline/context-bag.js";
import { localTestNode } from "../src/pipeline/nodes/local-test.js";
import { notifyNode } from "../src/pipeline/nodes/notify.js";
import type { NodeConfig, NodeDeps } from "../src/pipeline/types.js";
import type { AppConfig } from "../src/config.js";
import type { RunRecord } from "../src/types.js";

// ── Helpers ──

function makeNodeConfig(id = "test_node"): NodeConfig {
  return { id, type: "deterministic", action: id };
}

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: `test-${Date.now()}`,
    status: "running",
    phase: "agent",
    repoSlug: "org/repo",
    task: "Test task",
    baseBranch: "main",
    branchName: "gooseherd/test",
    requestedBy: "U_TEST",
    channelId: "C_TEST",
    threadTs: "0000.0000",
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

function makeDeps(overrides: Partial<NodeDeps> & { configOverrides?: Partial<AppConfig> } = {}): NodeDeps {
  const { configOverrides, ...depsOverrides } = overrides;
  return {
    config: {
      localTestCommand: "",
      agentTimeoutSeconds: 60,
      openrouterApiKey: undefined,
      ...configOverrides
    } as AppConfig,
    run: makeRun(),
    logFile: "/dev/null",
    workRoot: "/tmp",
    onPhase: async () => {},
    ...depsOverrides
  };
}

// ═══════════════════════════════════════════════════════
// Local Test Node
// ═══════════════════════════════════════════════════════

describe("localTestNode", () => {
  test("skips when localTestCommand is empty", async () => {
    const ctx = new ContextBag({ repoDir: "/tmp" });
    const deps = makeDeps({ configOverrides: { localTestCommand: "" } });
    const result = await localTestNode(makeNodeConfig("local_test"), ctx, deps);
    assert.equal(result.outcome, "skipped");
  });

  test("skips when localTestCommand is whitespace", async () => {
    const ctx = new ContextBag({ repoDir: "/tmp" });
    const deps = makeDeps({ configOverrides: { localTestCommand: "   " } });
    const result = await localTestNode(makeNodeConfig("local_test"), ctx, deps);
    assert.equal(result.outcome, "skipped");
  });

  test("returns success when test command exits 0", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "lt-pass-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const ctx = new ContextBag({ repoDir: tmpDir });
    const deps = makeDeps({
      configOverrides: { localTestCommand: "true" },
      logFile
    });

    const result = await localTestNode(makeNodeConfig("local_test"), ctx, deps);
    assert.equal(result.outcome, "success");

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns failure with rawOutput when test command exits non-zero", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "lt-fail-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const ctx = new ContextBag({ repoDir: tmpDir });
    const deps = makeDeps({
      configOverrides: { localTestCommand: "echo 'test output' && exit 1" },
      logFile
    });

    const result = await localTestNode(makeNodeConfig("local_test"), ctx, deps);
    assert.equal(result.outcome, "failure");
    assert.ok(result.error?.includes("exit code 1"));
    assert.ok(result.rawOutput !== undefined);

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("throws when repoDir is missing from context", async () => {
    const ctx = new ContextBag();
    const deps = makeDeps({ configOverrides: { localTestCommand: "true" } });

    await assert.rejects(
      () => localTestNode(makeNodeConfig("local_test"), ctx, deps),
      { message: /required key 'repoDir' is missing/ }
    );
  });
});

// ═══════════════════════════════════════════════════════
// Plan Task Node (import separately — depends on LLM module)
// ═══════════════════════════════════════════════════════

describe("planTaskNode", () => {
  // Dynamic import to avoid issues if LLM module has side effects
  let planTaskNode: typeof import("../src/pipeline/nodes/plan-task.js")["planTaskNode"];

  test("skips when no openrouterApiKey is set", async () => {
    // Import the module
    const mod = await import("../src/pipeline/nodes/plan-task.js");
    planTaskNode = mod.planTaskNode;

    const ctx = new ContextBag({ repoSummary: "some context" });
    const deps = makeDeps({ configOverrides: { openrouterApiKey: undefined } });

    const result = await planTaskNode(makeNodeConfig("plan_task"), ctx, deps);
    assert.equal(result.outcome, "skipped");
  });

  test("skips when openrouterApiKey is empty string", async () => {
    const mod = await import("../src/pipeline/nodes/plan-task.js");
    planTaskNode = mod.planTaskNode;

    const ctx = new ContextBag({ repoSummary: "some context" });
    // Config with explicitly undefined API key (empty string gets trimmed to undefined in config loader)
    const deps = makeDeps({ configOverrides: { openrouterApiKey: undefined } });

    const result = await planTaskNode(makeNodeConfig("plan_task"), ctx, deps);
    assert.equal(result.outcome, "skipped");
  });
});

// ═══════════════════════════════════════════════════════
// Notify Node
// ═══════════════════════════════════════════════════════

function makeNotifyConfig(config?: Record<string, unknown>): NodeConfig {
  return { id: "notify", type: "deterministic", action: "notify", config };
}

describe("notifyNode", () => {
  test("skips when no webhook_url configured", async () => {
    const ctx = new ContextBag();
    const deps = makeDeps({ configOverrides: { appName: "TestApp" } });
    const result = await notifyNode(makeNotifyConfig(), ctx, deps);
    assert.equal(result.outcome, "skipped");
  });

  test("skips when webhook_url is empty string", async () => {
    const ctx = new ContextBag();
    const deps = makeDeps({ configOverrides: { appName: "TestApp" } });
    const result = await notifyNode(makeNotifyConfig({ webhook_url: "" }), ctx, deps);
    assert.equal(result.outcome, "skipped");
  });

  test("skips when webhook_url has invalid scheme", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "notify-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const ctx = new ContextBag();
    const deps = makeDeps({ configOverrides: { appName: "TestApp" }, logFile });
    const result = await notifyNode(
      makeNotifyConfig({ webhook_url: "ftp://bad.example.com" }),
      ctx,
      deps
    );
    assert.equal(result.outcome, "skipped");

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns success on 200 response", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "notify-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const mockFetch = mock.method(globalThis, "fetch", async () => {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const ctx = new ContextBag({ prUrl: "https://github.com/org/repo/pull/1" });
    const deps = makeDeps({ configOverrides: { appName: "TestApp" }, logFile });
    const result = await notifyNode(
      makeNotifyConfig({ webhook_url: "https://hook.example.com/test" }),
      ctx,
      deps
    );

    assert.equal(result.outcome, "success");
    assert.equal(mockFetch.mock.calls.length, 1);

    const callArgs = mockFetch.mock.calls[0]!.arguments;
    assert.equal(callArgs[0], "https://hook.example.com/test");
    const body = JSON.parse((callArgs[1] as RequestInit).body as string) as Record<string, unknown>;
    assert.equal(body["event"], "pipeline_completed");
    assert.equal(body["pr_url"], "https://github.com/org/repo/pull/1");

    mockFetch.mock.restore();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns soft_fail on non-2xx response", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "notify-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const mockFetch = mock.method(globalThis, "fetch", async () => {
      return new Response("Internal Server Error", { status: 500 });
    });

    const ctx = new ContextBag();
    const deps = makeDeps({ configOverrides: { appName: "TestApp" }, logFile });
    const result = await notifyNode(
      makeNotifyConfig({ webhook_url: "https://hook.example.com/test" }),
      ctx,
      deps
    );

    assert.equal(result.outcome, "soft_fail");
    assert.ok(result.error?.includes("500"));

    mockFetch.mock.restore();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns soft_fail on network error", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "notify-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const mockFetch = mock.method(globalThis, "fetch", async () => {
      throw new Error("Connection refused");
    });

    const ctx = new ContextBag();
    const deps = makeDeps({ configOverrides: { appName: "TestApp" }, logFile });
    const result = await notifyNode(
      makeNotifyConfig({ webhook_url: "https://hook.example.com/test" }),
      ctx,
      deps
    );

    assert.equal(result.outcome, "soft_fail");
    assert.ok(result.error?.includes("Connection refused"));

    mockFetch.mock.restore();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("includes custom headers in webhook request", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "notify-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const mockFetch = mock.method(globalThis, "fetch", async () => {
      return new Response("OK", { status: 200 });
    });

    const ctx = new ContextBag();
    const deps = makeDeps({ configOverrides: { appName: "TestApp" }, logFile });
    await notifyNode(
      makeNotifyConfig({
        webhook_url: "https://hook.example.com/test",
        webhook_headers: { Authorization: "Bearer secret123" }
      }),
      ctx,
      deps
    );

    const callArgs = mockFetch.mock.calls[0]!.arguments;
    const headers = (callArgs[1] as RequestInit).headers as Record<string, string>;
    assert.equal(headers["Authorization"], "Bearer secret123");
    assert.equal(headers["Content-Type"], "application/json");

    mockFetch.mock.restore();
    await rm(tmpDir, { recursive: true, force: true });
  });
});
