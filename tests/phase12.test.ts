/**
 * Phase 12 tests — Dashboard Auth, Token Usage, Help Blocks, Pipeline Events, Clone Progress
 */

import assert from "node:assert/strict";
import { describe, test, mock } from "node:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

// ══════════════════════════════════════════════════════════
// Dashboard Auth
// ══════════════════════════════════════════════════════════

describe("dashboard auth", () => {
  // Import dynamically to avoid loading the whole dashboard server
  let checkAuth: typeof import("../src/dashboard/auth.js").checkAuth;

  test("load checkAuth", async () => {
    const mod = await import("../src/dashboard/auth.js");
    checkAuth = mod.checkAuth;
  });

  function makeMockReq(overrides: {
    method?: string;
    headers?: Record<string, string>;
  } = {}): IncomingMessage {
    return {
      method: overrides.method ?? "GET",
      headers: overrides.headers ?? {}
    } as unknown as IncomingMessage;
  }

  function makeMockRes(): ServerResponse & { _statusCode?: number; _headers: Record<string, string>; _ended: boolean } {
    const res = {
      _statusCode: undefined as number | undefined,
      _headers: {} as Record<string, string>,
      _ended: false,
      statusCode: 200,
      setHeader(name: string, value: string) {
        res._headers[name.toLowerCase()] = value;
      },
      end() {
        res._ended = true;
      }
    };
    // Proxy statusCode setter
    Object.defineProperty(res, "statusCode", {
      get() { return res._statusCode ?? 200; },
      set(v: number) { res._statusCode = v; }
    });
    return res as any;
  }

  test("no token configured → always passes", async () => {
    const req = makeMockReq();
    const res = makeMockRes();
    const opts = { setupComplete: true };
    assert.equal(await checkAuth(req, res, opts, "/"), true);
    assert.equal(await checkAuth(req, res, opts, "/api/runs"), true);
  });

  test("healthz always passes even with token", async () => {
    const req = makeMockReq();
    const res = makeMockRes();
    assert.equal(await checkAuth(req, res, { setupComplete: true, dashboardToken: "secret123" }, "/healthz"), true);
  });

  test("/login always passes even with token", async () => {
    const req = makeMockReq();
    const res = makeMockRes();
    assert.equal(await checkAuth(req, res, { setupComplete: true, dashboardToken: "secret123" }, "/login"), true);
  });

  test("API route without auth returns 401", async () => {
    const req = makeMockReq();
    const res = makeMockRes();
    const result = await checkAuth(req, res, { setupComplete: true, dashboardToken: "secret123" }, "/api/runs");
    assert.equal(result, false);
    assert.equal(res.statusCode, 401);
  });

  test("API route with valid Bearer token passes", async () => {
    const req = makeMockReq({
      headers: { authorization: "Bearer secret123" }
    });
    const res = makeMockRes();
    assert.equal(await checkAuth(req, res, { setupComplete: true, dashboardToken: "secret123" }, "/api/runs"), true);
  });

  test("API route with wrong Bearer token returns 401", async () => {
    const req = makeMockReq({
      headers: { authorization: "Bearer wrong" }
    });
    const res = makeMockRes();
    assert.equal(await checkAuth(req, res, { setupComplete: true, dashboardToken: "secret123" }, "/api/runs"), false);
    assert.equal(res.statusCode, 401);
  });

  test("HTML page without cookie redirects to /login", async () => {
    const req = makeMockReq();
    const res = makeMockRes();
    const result = await checkAuth(req, res, { setupComplete: true, dashboardToken: "secret123" }, "/");
    assert.equal(result, false);
    assert.equal(res.statusCode, 302);
    assert.equal(res._headers["location"], "/login");
  });

  test("HTML page with valid session cookie passes", async () => {
    const req = makeMockReq({
      headers: { cookie: "gooseherd-session=session-token" }
    });
    const res = makeMockRes();
    const sessionStore = {
      getSessionByToken: mock.fn(async (token: string) => token === "session-token"
        ? {
          id: "sess-1",
          principalType: "user",
          authMethod: "slack",
          userId: "user-1",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          lastSeenAt: new Date().toISOString(),
        }
        : undefined),
    } as any;
    assert.equal(await checkAuth(req, res, { setupComplete: true, dashboardToken: "secret123", sessionStore }, "/"), true);
  });

  test("HTML page with invalid session cookie redirects", async () => {
    const req = makeMockReq({
      headers: { cookie: "gooseherd-session=invalid" }
    });
    const res = makeMockRes();
    const sessionStore = { getSessionByToken: mock.fn(async () => undefined) } as any;
    assert.equal(await checkAuth(req, res, { setupComplete: true, dashboardToken: "secret123", sessionStore }, "/"), false);
    assert.equal(res.statusCode, 302);
  });

  test("API route with valid session cookie passes", async () => {
    const req = makeMockReq({
      headers: { cookie: "gooseherd-session=session-token" }
    });
    const res = makeMockRes();
    const sessionStore = {
      getSessionByToken: mock.fn(async () => ({
        id: "sess-1",
        principalType: "admin",
        authMethod: "admin_password",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        lastSeenAt: new Date().toISOString(),
      })),
    } as any;
    assert.equal(await checkAuth(req, res, { setupComplete: true, dashboardToken: "mytoken", sessionStore }, "/api/runs"), true);
  });
});

// ══════════════════════════════════════════════════════════
// Token Usage Aggregation
// ══════════════════════════════════════════════════════════

describe("token usage aggregation", () => {
  test("aggregateTokenUsage returns null when no token entries", async () => {
    const { aggregateTokenUsage } = await import("../src/pipeline/pipeline-engine.js");
    const { ContextBag } = await import("../src/pipeline/context-bag.js");

    const ctx = new ContextBag({ repoDir: "/tmp" });
    assert.equal(aggregateTokenUsage(ctx), null);
  });

  test("aggregateTokenUsage sums all _tokenUsage_* entries", async () => {
    const { aggregateTokenUsage } = await import("../src/pipeline/pipeline-engine.js");
    const { ContextBag } = await import("../src/pipeline/context-bag.js");

    const ctx = new ContextBag({});
    ctx.set("_tokenUsage_plan_task", { input: 100, output: 50 });
    ctx.set("_tokenUsage_scope_judge", { input: 200, output: 80 });
    ctx.set("unrelated_key", "hello");

    const result = aggregateTokenUsage(ctx);
    assert.notEqual(result, null);
    assert.equal(result!.qualityGateInputTokens, 300);
    assert.equal(result!.qualityGateOutputTokens, 130);
  });

  test("aggregateTokenUsage ignores entries with zero tokens", async () => {
    const { aggregateTokenUsage } = await import("../src/pipeline/pipeline-engine.js");
    const { ContextBag } = await import("../src/pipeline/context-bag.js");

    const ctx = new ContextBag({});
    ctx.set("_tokenUsage_empty", { input: 0, output: 0 });

    assert.equal(aggregateTokenUsage(ctx), null);
  });

  test("TokenUsage serializes to RunRecord correctly", async () => {
    const usage = {
      qualityGateInputTokens: 500,
      qualityGateOutputTokens: 200,
      agentInputTokens: 1000,
      agentOutputTokens: 800
    };

    // Ensure it round-trips through JSON
    const serialized = JSON.parse(JSON.stringify({ tokenUsage: usage }));
    assert.equal(serialized.tokenUsage.qualityGateInputTokens, 500);
    assert.equal(serialized.tokenUsage.qualityGateOutputTokens, 200);
    assert.equal(serialized.tokenUsage.agentInputTokens, 1000);
    assert.equal(serialized.tokenUsage.agentOutputTokens, 800);
  });
});

// ══════════════════════════════════════════════════════════
// Help Blocks
// ══════════════════════════════════════════════════════════

describe("buildHelpBlocks", () => {
  test("returns valid Slack blocks", async () => {
    const { buildHelpBlocks } = await import("../src/slack-app.js");
    const config = {
      appName: "TestBot",
      slackCommandName: "testbot"
    } as any;

    const blocks = buildHelpBlocks(config);

    assert.ok(Array.isArray(blocks));
    assert.ok(blocks.length > 0);

    // First block should be a header
    assert.equal(blocks[0].type, "header");

    // Should contain section blocks with command references
    const sections = blocks.filter(b => b.type === "section");
    assert.ok(sections.length >= 3, "Expected at least 3 section blocks");

    // Should reference the command name
    const allText = JSON.stringify(blocks);
    assert.ok(allText.includes("testbot"), "Should reference slackCommandName");
    assert.ok(allText.includes("TestBot"), "Should reference appName");
  });

  test("includes follow-up instructions", async () => {
    const { buildHelpBlocks } = await import("../src/slack-app.js");
    const config = { appName: "Goose", slackCommandName: "goose" } as any;

    const blocks = buildHelpBlocks(config);
    const allText = JSON.stringify(blocks);

    assert.ok(allText.includes("follow-up") || allText.includes("Follow-up"), "Should mention follow-up mode");
    assert.ok(allText.includes("retry"), "Should mention retry");
  });
});

// ══════════════════════════════════════════════════════════
// Pipeline Event Logger
// ══════════════════════════════════════════════════════════

describe("EventLogger", () => {
  let tmpDir: string;

  test("setup temp dir", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "events-test-"));
  });

  test("writes JSONL events to file", async () => {
    const { EventLogger } = await import("../src/pipeline/event-logger.js");

    const logger = new EventLogger(tmpDir);
    await logger.emit("node_start", { nodeId: "clone" });
    await logger.emit("node_end", { nodeId: "clone", outcome: "success", durationMs: 1500 });
    await logger.emit("phase_change", { phase: "agent" });

    const content = await readFile(logger.getFilePath(), "utf8");
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 3);

    const first = JSON.parse(lines[0]);
    assert.equal(first.type, "node_start");
    assert.equal(first.nodeId, "clone");
    assert.ok(first.timestamp);

    const second = JSON.parse(lines[1]);
    assert.equal(second.type, "node_end");
    assert.equal(second.outcome, "success");
    assert.equal(second.durationMs, 1500);

    const third = JSON.parse(lines[2]);
    assert.equal(third.type, "phase_change");
    assert.equal(third.phase, "agent");
  });

  test("getFilePath returns events.jsonl path", async () => {
    const { EventLogger } = await import("../src/pipeline/event-logger.js");
    const logger = new EventLogger("/tmp/test-run");
    assert.equal(logger.getFilePath(), "/tmp/test-run/events.jsonl");
  });

  test("cleanup", async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ══════════════════════════════════════════════════════════
// Clone Progress Parsing
// ══════════════════════════════════════════════════════════

describe("clone progress parsing", () => {
  test("git clone progress regex matches expected patterns", () => {
    const re = /(Receiving|Resolving|Counting) objects:\s+(\d+)%/;

    const cases = [
      { input: "Receiving objects:  45% (123/274)", expect: ["Receiving", "45"] },
      { input: "Resolving deltas: 100% (50/50)", expect: null },
      { input: "Resolving objects: 78% (50/64)", expect: ["Resolving", "78"] },
      { input: "Counting objects:  12% (3/25)", expect: ["Counting", "12"] },
      { input: "Compressing objects: 50%", expect: null },
      { input: "random text", expect: null },
    ];

    for (const { input, expect: expected } of cases) {
      const match = re.exec(input);
      if (expected === null) {
        assert.equal(match, null, `Should not match: ${input}`);
      } else {
        assert.ok(match, `Should match: ${input}`);
        assert.equal(match![1], expected[0]);
        assert.equal(match![2], expected[1]);
      }
    }
  });

  test("onDetail throttling prevents rapid calls", async () => {
    const calls: string[] = [];
    let lastDetailTime = 0;

    // Simulate the throttled onDetail logic from run-manager
    const onDetail = async (detail: string) => {
      const now = Date.now();
      if (now - lastDetailTime < 5000) return;
      lastDetailTime = now;
      calls.push(detail);
    };

    await onDetail("first");
    await onDetail("second");  // should be throttled
    await onDetail("third");   // should be throttled

    assert.equal(calls.length, 1);
    assert.equal(calls[0], "first");
  });
});

// ══════════════════════════════════════════════════════════
// Context Bag keys() method
// ══════════════════════════════════════════════════════════

describe("ContextBag.keys()", () => {
  test("returns all keys in the bag", async () => {
    const { ContextBag } = await import("../src/pipeline/context-bag.js");

    const ctx = new ContextBag({ a: 1, b: 2 });
    ctx.set("c", 3);

    const keys = [...ctx.keys()];
    assert.deepEqual(keys.sort(), ["a", "b", "c"]);
  });
});

// ══════════════════════════════════════════════════════════
// NodeDeps onDetail field
// ══════════════════════════════════════════════════════════

describe("NodeDeps onDetail", () => {
  test("onDetail is optional in NodeDeps", async () => {
    // Just verify the type compiles — the field is optional
    const deps: import("../src/pipeline/types.js").NodeDeps = {
      config: {} as any,
      run: {} as any,
      logFile: "/dev/null",
      workRoot: "/tmp",
      onPhase: async () => {}
      // onDetail intentionally omitted
    };
    assert.equal(deps.onDetail, undefined);
  });
});

// ══════════════════════════════════════════════════════════
// PipelineEvent type
// ══════════════════════════════════════════════════════════

describe("PipelineEvent type", () => {
  test("PipelineEvent supports all event types", async () => {
    const event: import("../src/pipeline/types.js").PipelineEvent = {
      type: "node_start",
      timestamp: new Date().toISOString(),
      nodeId: "clone"
    };
    assert.equal(event.type, "node_start");

    const phaseEvent: import("../src/pipeline/types.js").PipelineEvent = {
      type: "phase_change",
      timestamp: new Date().toISOString(),
      phase: "agent"
    };
    assert.equal(phaseEvent.type, "phase_change");

    const errorEvent: import("../src/pipeline/types.js").PipelineEvent = {
      type: "error",
      timestamp: new Date().toISOString(),
      error: "something went wrong"
    };
    assert.equal(errorEvent.type, "error");
  });
});
