/**
 * Tests for the summarize_changes node and instruction building.
 */

import assert from "node:assert/strict";
import { describe, test, mock } from "node:test";
import { buildInstruction } from "../src/pipeline/quality-gates/stagehand-verify.js";

// ── buildInstruction (used by stagehand-verify agent) ──

describe("buildInstruction with changeSummary", () => {
  test("includes changeSummary when provided", () => {
    const msg = buildInstruction(
      "Change heading to Curated collections",
      ["app/views/home.html.erb"],
      undefined,
      "Modified the h2 element in the homepage partial to read 'Curated collections' instead of 'Featured categories'."
    );
    assert.ok(msg.includes("Change summary"));
    assert.ok(msg.includes("Modified the h2 element"));
    assert.ok(msg.includes("Curated collections"));
  });

  test("omits changeSummary section when not provided", () => {
    const msg = buildInstruction(
      "Change heading",
      ["file.erb"]
    );
    assert.ok(!msg.includes("Change summary"));
  });

  test("includes both changeSummary and credentials", () => {
    const msg = buildInstruction(
      "Task",
      [],
      { email: "test@test.com", password: "pass" },
      "Changed the user profile page heading."
    );
    assert.ok(msg.includes("Change summary"));
    assert.ok(msg.includes("Changed the user profile page heading"));
    assert.ok(msg.includes("%email%"));
    // changeSummary should appear before credentials
    const summaryPos = msg.indexOf("Change summary");
    const credPos = msg.indexOf("Authentication credentials");
    assert.ok(summaryPos < credPos, "changeSummary should come before credentials");
  });
});

// ── summarizeChangesNode (mocked LLM) ──

describe("summarizeChangesNode", () => {
  test("returns summary from LLM", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = mock.fn(async () => {
      return new Response(JSON.stringify({
        choices: [{ message: { content: "Changed the homepage heading from Featured to Curated collections in the Slim template." } }],
        model: "test-model",
        usage: { prompt_tokens: 500, completion_tokens: 30 }
      }), { status: 200 });
    }) as typeof fetch;

    try {
      const { summarizeChangesNode } = await import("../src/pipeline/nodes/summarize-changes.js");

      // Create a minimal mock context and deps
      const ctxStore = new Map<string, unknown>();
      ctxStore.set("repoDir", "/tmp/fake-repo");
      ctxStore.set("changedFiles", ["app/views/items/index.html.slim"]);

      const ctx = {
        get: <T>(key: string) => ctxStore.get(key) as T | undefined,
        getRequired: <T>(key: string) => { const v = ctxStore.get(key); if (v === undefined) throw new Error(`Missing ${key}`); return v as T; },
        set: (key: string, value: unknown) => { ctxStore.set(key, value); },
        mergeOutputs: (outputs: Record<string, unknown>) => { for (const [k, v] of Object.entries(outputs)) ctxStore.set(k, v); },
        entries: () => ctxStore.entries()
      };

      assert.ok(typeof summarizeChangesNode === "function");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("skips when no API key", async () => {
    const { summarizeChangesNode } = await import("../src/pipeline/nodes/summarize-changes.js");

    const ctxStore = new Map<string, unknown>();
    const ctx = {
      get: <T>(key: string) => ctxStore.get(key) as T | undefined,
      getRequired: <T>(key: string) => { const v = ctxStore.get(key); if (v === undefined) throw new Error(`Missing ${key}`); return v as T; },
      set: (key: string, value: unknown) => { ctxStore.set(key, value); },
      mergeOutputs: () => {},
      entries: () => ctxStore.entries()
    };

    const result = await summarizeChangesNode(
      { id: "test", type: "deterministic", action: "summarize_changes" },
      ctx as any,
      {
        config: { openrouterApiKey: "" } as any,
        run: { id: "test", task: "test task" } as any,
        logFile: "/dev/null",
        workRoot: "/tmp",
        onPhase: async () => {}
      }
    );

    assert.equal(result.outcome, "skipped");
  });
});
