import assert from "node:assert/strict";
import test from "node:test";
import { deployPreviewNode } from "../src/pipeline/nodes/deploy-preview.js";
import { ContextBag } from "../src/pipeline/context-bag.js";
import type { NodeConfig, NodeDeps } from "../src/pipeline/types.js";
import type { AppConfig } from "../src/config.js";
import type { RunRecord } from "../src/types.js";

const NOOP = async () => {};

function makeDeps(overrides?: Partial<NodeDeps>): NodeDeps {
  return {
    config: {} as AppConfig,
    run: {
      id: "test-run-123",
      repoSlug: "owner/repo",
      branchName: "huble-test-branch",
      task: "test task"
    } as RunRecord,
    logFile: "/dev/null",
    workRoot: "/tmp/test-work",
    onPhase: NOOP,
    ...overrides
  };
}

function makeNodeConfig(config: Record<string, unknown>): NodeConfig {
  return {
    id: "deploy_preview",
    type: "deterministic",
    action: "deploy_preview",
    config
  };
}

// ── Missing strategy ──

test("deploy_preview: soft_fail when strategy is missing", async () => {
  const ctx = new ContextBag();
  const result = await deployPreviewNode(
    makeNodeConfig({}),
    ctx,
    makeDeps()
  );

  assert.equal(result.outcome, "soft_fail");
  assert.ok(result.error?.includes("'strategy' is required"));
});

// ── url_pattern strategy ──

test("deploy_preview: url_pattern constructs URL with prNumber", async () => {
  const ctx = new ContextBag();
  ctx.set("prNumber", 42);

  const result = await deployPreviewNode(
    makeNodeConfig({
      strategy: "url_pattern",
      url_pattern: "https://{{prNumber}}.stg.epicpxls.com",
      readiness_timeout_seconds: 0
    }),
    ctx,
    makeDeps()
  );

  assert.equal(result.outcome, "success");
  assert.equal(ctx.get("reviewAppUrl"), "https://42.stg.epicpxls.com");
});

test("deploy_preview: url_pattern constructs URL with branchName", async () => {
  const ctx = new ContextBag();
  ctx.set("branchName", "feature-xyz");

  const result = await deployPreviewNode(
    makeNodeConfig({
      strategy: "url_pattern",
      url_pattern: "https://{{branchName}}.preview.example.com",
      readiness_timeout_seconds: 0
    }),
    ctx,
    makeDeps()
  );

  assert.equal(result.outcome, "success");
  assert.equal(ctx.get("reviewAppUrl"), "https://feature-xyz.preview.example.com");
});

test("deploy_preview: url_pattern soft_fail when pattern is missing", async () => {
  const ctx = new ContextBag();
  const result = await deployPreviewNode(
    makeNodeConfig({ strategy: "url_pattern", readiness_timeout_seconds: 0 }),
    ctx,
    makeDeps()
  );

  assert.equal(result.outcome, "soft_fail");
  assert.ok(result.error?.includes("url_pattern"));
});

// ── Validation ──

test("deploy_preview: soft_fail on non-http(s) URL", async () => {
  const ctx = new ContextBag();
  const result = await deployPreviewNode(
    makeNodeConfig({
      strategy: "url_pattern",
      url_pattern: "ftp://bad-scheme.com",
      readiness_timeout_seconds: 0
    }),
    ctx,
    makeDeps()
  );

  assert.equal(result.outcome, "soft_fail");
  assert.ok(result.error?.includes("Invalid preview URL scheme"));
});

test("deploy_preview: unknown strategy returns soft_fail", async () => {
  const ctx = new ContextBag();
  const result = await deployPreviewNode(
    makeNodeConfig({ strategy: "magic_deploy" }),
    ctx,
    makeDeps()
  );

  assert.equal(result.outcome, "soft_fail");
  assert.ok(result.error?.includes("unknown strategy"));
});

// ── Readiness polling ──

test("deploy_preview: soft_fail when URL never becomes ready", async () => {
  const ctx = new ContextBag();
  const result = await deployPreviewNode(
    makeNodeConfig({
      strategy: "url_pattern",
      url_pattern: "http://192.0.2.1:1/",
      readiness_timeout_seconds: 2,
      readiness_poll_interval_seconds: 1
    }),
    ctx,
    makeDeps()
  );

  assert.equal(result.outcome, "soft_fail");
  assert.ok(result.error?.includes("never became ready"));
});

// ── github_deployment_api strategy ──

test("deploy_preview: github_deployment_api soft_fail without pattern", async () => {
  const ctx = new ContextBag();
  const result = await deployPreviewNode(
    makeNodeConfig({ strategy: "github_deployment_api", readiness_timeout_seconds: 0 }),
    ctx,
    makeDeps()
  );

  assert.equal(result.outcome, "soft_fail");
  assert.ok(result.error?.includes("github_deployment_api"));
});

// ── url_pattern: empty variable validation ──

test("deploy_preview: url_pattern soft_fail when prNumber is empty", async () => {
  const ctx = new ContextBag();
  // No prNumber set → template produces "https://.stg.epicpxls.com"
  const result = await deployPreviewNode(
    makeNodeConfig({
      strategy: "url_pattern",
      url_pattern: "https://{{prNumber}}.stg.epicpxls.com",
      readiness_timeout_seconds: 0
    }),
    ctx,
    makeDeps()
  );

  assert.equal(result.outcome, "soft_fail");
  assert.ok(result.error?.includes("could not determine"));
});

test("deploy_preview: url_pattern soft_fail when template has unresolved vars", async () => {
  const ctx = new ContextBag();
  const result = await deployPreviewNode(
    makeNodeConfig({
      strategy: "url_pattern",
      url_pattern: "https://{{unknownVar}}.example.com",
      readiness_timeout_seconds: 0
    }),
    ctx,
    makeDeps()
  );

  assert.equal(result.outcome, "soft_fail");
  assert.ok(result.error?.includes("could not determine"));
});

// ── poll interval floor ──

test("deploy_preview: readiness_poll_interval_seconds has 1s minimum floor", async () => {
  const ctx = new ContextBag();
  ctx.set("prNumber", 1);

  // interval=0 should be clamped to 1s, not spin-loop. The URL is unreachable
  // so this tests that the interval floor prevents a tight loop and the timeout fires.
  const start = Date.now();
  const result = await deployPreviewNode(
    makeNodeConfig({
      strategy: "url_pattern",
      url_pattern: "http://192.0.2.1:1/",
      readiness_timeout_seconds: 2,
      readiness_poll_interval_seconds: 0
    }),
    ctx,
    makeDeps()
  );
  const elapsed = Date.now() - start;

  assert.equal(result.outcome, "soft_fail");
  // With a 1s floor on interval and 2s timeout, should take ~2s not 0ms
  assert.ok(elapsed >= 1500, `Expected >=1500ms, got ${String(elapsed)}ms`);
});

// ── command strategy ──

test("deploy_preview: command strategy soft_fail without command", async () => {
  const ctx = new ContextBag();
  const result = await deployPreviewNode(
    makeNodeConfig({ strategy: "command", readiness_timeout_seconds: 0 }),
    ctx,
    makeDeps()
  );

  assert.equal(result.outcome, "soft_fail");
  assert.ok(result.error?.includes("command"));
});
