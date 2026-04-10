/**
 * Tests for the setup_sandbox pipeline node.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContextBag } from "../src/pipeline/context-bag.js";
import { setupSandboxNode } from "../src/pipeline/nodes/setup-sandbox.js";
import type { NodeConfig, NodeDeps } from "../src/pipeline/types.js";
import type { AppConfig } from "../src/config.js";
import type { RunRecord } from "../src/types.js";

// ── Helpers ──

function makeNodeConfig(): NodeConfig {
  return { id: "setup_sandbox", type: "deterministic", action: "setup_sandbox" };
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

function makeDeps(overrides: Partial<NodeDeps> = {}): NodeDeps {
  return {
    config: {
      sandboxEnabled: true,
      sandboxImage: "gooseherd/sandbox:default"
    } as AppConfig,
    run: makeRun(),
    logFile: "/dev/null",
    workRoot: "/tmp",
    onPhase: async () => {},
    ...overrides
  };
}

// ═══════════════════════════════════════════════════════
// setup_sandbox node
// ═══════════════════════════════════════════════════════

describe("setupSandboxNode", () => {
  test("returns runtime_disabled and skips requestSandbox for non-docker runtime", async () => {
    const ctx = new ContextBag();
    let requested = false;
    const deps = makeDeps({
      config: {
        sandboxRuntime: "local",
        sandboxEnabled: true,
        sandboxImage: "gooseherd/sandbox:default"
      } as AppConfig,
      requestSandbox: async () => { requested = true; }
    });

    const result = await setupSandboxNode(makeNodeConfig(), ctx, deps);
    assert.equal(result.outcome, "success");
    assert.equal(result.outputs?.sandboxImage, "none");
    assert.equal(result.outputs?.sandboxSource, "runtime_disabled");
    assert.equal(requested, false);
  });

  test("returns success with disabled source when sandbox is off", async () => {
    const ctx = new ContextBag();
    const deps = makeDeps({
      config: { sandboxEnabled: false, sandboxImage: "gooseherd/sandbox:default" } as AppConfig
    });
    const result = await setupSandboxNode(makeNodeConfig(), ctx, deps);
    assert.equal(result.outcome, "success");
    assert.equal(result.outputs?.sandboxSource, "disabled");
  });

  test("returns success with default source when no requestSandbox callback", async () => {
    const ctx = new ContextBag();
    const deps = makeDeps();
    // No requestSandbox callback — sandbox handled externally
    const result = await setupSandboxNode(makeNodeConfig(), ctx, deps);
    assert.equal(result.outcome, "success");
    assert.equal(result.outputs?.sandboxSource, "default");
    assert.equal(result.outputs?.sandboxImage, "gooseherd/sandbox:default");
  });

  test("calls requestSandbox with default image when no repo config", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "setup-sandbox-"));
    try {
      const ctx = new ContextBag({ repoDir: tmpDir });
      let requestedImage = "";
      const deps = makeDeps({
        requestSandbox: async (image: string) => { requestedImage = image; }
      });

      const result = await setupSandboxNode(makeNodeConfig(), ctx, deps);
      assert.equal(result.outcome, "success");
      assert.equal(requestedImage, "gooseherd/sandbox:default");
      assert.equal(result.outputs?.sandboxSource, "default");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("calls requestSandbox with repo-configured image", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "setup-sandbox-"));
    try {
      await writeFile(
        path.join(tmpDir, ".gooseherd.yml"),
        "sandbox:\n  image: ruby:3.3-slim\n",
        "utf8"
      );
      const ctx = new ContextBag({ repoDir: tmpDir });
      let requestedImage = "";
      const deps = makeDeps({
        requestSandbox: async (image: string) => { requestedImage = image; }
      });

      const result = await setupSandboxNode(makeNodeConfig(), ctx, deps);
      assert.equal(result.outcome, "success");
      assert.equal(requestedImage, "ruby:3.3-slim");
      assert.equal(result.outputs?.sandboxImage, "ruby:3.3-slim");
      assert.equal(result.outputs?.sandboxSource, "repo_config");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("uses default image when repoDir is not in context", async () => {
    const ctx = new ContextBag(); // no repoDir
    let requestedImage = "";
    const deps = makeDeps({
      requestSandbox: async (image: string) => { requestedImage = image; }
    });

    const result = await setupSandboxNode(makeNodeConfig(), ctx, deps);
    assert.equal(result.outcome, "success");
    assert.equal(requestedImage, "gooseherd/sandbox:default");
  });

  test("outputs builtLocally as false for pre-built images", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "setup-sandbox-"));
    try {
      await writeFile(
        path.join(tmpDir, ".gooseherd.yml"),
        "sandbox:\n  image: node:20-slim\n",
        "utf8"
      );
      const ctx = new ContextBag({ repoDir: tmpDir });
      const deps = makeDeps({
        requestSandbox: async () => {}
      });

      const result = await setupSandboxNode(makeNodeConfig(), ctx, deps);
      assert.equal(result.outputs?.sandboxBuiltLocally, false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
