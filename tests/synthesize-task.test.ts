import test from "node:test";
import assert from "node:assert/strict";
import { synthesizeTask } from "../src/orchestrator/synthesize-task.js";
import type { ChatMessage } from "../src/llm/caller.js";

test("synthesizeTask returns markdown spec from conversation + proposal", async () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "auth is slow" },
    { role: "assistant", content: "let me look... it's the JWT verification on each request" },
    { role: "user", content: "ok how do we fix it" },
    { role: "assistant", content: "we can cache the JWT verification result" },
  ];
  const proposal = { repoSlug: "owner/repo", summary: "Cache JWT verification result" };

  const stubLLM = (async () => ({
    content: "## Goal\nCache JWT verification\n\n## Files\n- src/auth.ts",
    model: "test",
    messages: [],
    turnsUsed: 1,
    totalInputTokens: 200,
    totalOutputTokens: 100,
    perModelUsage: [{ model: "test", input: 200, output: 100 }],
  })) as never;

  const result = await synthesizeTask({
    llmConfig: {} as never,
    model: "test-model",
    messages,
    proposal,
    _callLLMOverride: stubLLM,
  });

  assert.match(result.task, /## Goal/);
  assert.match(result.task, /Cache JWT/);
  assert.equal(result.tokenUsage[0]?.model, "test");
  assert.equal(result.tokenUsage[0]?.input, 200);
  assert.equal(result.fallback, false);
});

test("synthesizeTask falls back to proposal summary on LLM failure", async () => {
  const messages: ChatMessage[] = [{ role: "user", content: "do x" }];
  const proposal = { repoSlug: "owner/repo", summary: "Do X" };

  const failingLLM = (async () => {
    throw new Error("LLM unavailable");
  }) as never;

  const result = await synthesizeTask({
    llmConfig: {} as never,
    model: "test-model",
    messages,
    proposal,
    _callLLMOverride: failingLLM,
  });

  assert.match(result.task, /Do X/);
  assert.equal(result.tokenUsage.length, 0);
  assert.equal(result.fallback, true);
});

test("synthesizeTask falls back when LLM returns empty content", async () => {
  const messages: ChatMessage[] = [{ role: "user", content: "do x" }];
  const proposal = { repoSlug: "owner/repo", summary: "Do X" };

  const emptyLLM = (async () => ({
    content: "",
    model: "test",
    messages: [],
    turnsUsed: 1,
    totalInputTokens: 50,
    totalOutputTokens: 0,
    perModelUsage: [{ model: "test", input: 50, output: 0 }],
  })) as never;

  const result = await synthesizeTask({
    llmConfig: {} as never,
    model: "test-model",
    messages,
    proposal,
    _callLLMOverride: emptyLLM,
  });

  assert.match(result.task, /Do X/);
  assert.equal(result.fallback, true);
});
