import test from "node:test";
import assert from "node:assert/strict";
import { handleMessage } from "../src/orchestrator/orchestrator.js";
import type { HandleMessageDeps, HandleMessageRequest } from "../src/orchestrator/types.js";

test("HandleMessageResult exposes per-model token usage from the LLM call", async () => {
  const fakeLLM = async () => ({
    content: "answer",
    model: "gpt-4.1-mini",
    messages: [
      { role: "user" as const, content: "q" },
      { role: "assistant" as const, content: "answer" },
    ],
    turnsUsed: 1,
    totalInputTokens: 100,
    totalOutputTokens: 50,
    perModelUsage: [{ model: "gpt-4.1-mini", input: 100, output: 50 }],
  });

  const deps: HandleMessageDeps = {
    enqueueRun: async () => ({ id: "x", branchName: "b", repoSlug: "o/r" }),
    listRuns: async () => "[]",
    getConfig: async () => "{}",
    repoAllowlist: ["o/r"],
  };
  const request: HandleMessageRequest = {
    message: "test",
    userId: "U1",
    channelId: "C1",
    threadTs: "T1",
  };

  const result = await handleMessage(
    {} as never,
    "test-model",
    "system",
    request,
    deps,
    { _callLLMOverride: fakeLLM as never },
  );

  assert.equal(Array.isArray(result.tokenUsage), true);
  assert.equal(result.tokenUsage[0]?.model, "gpt-4.1-mini");
  assert.equal(result.tokenUsage[0]?.input, 100);
  assert.equal(result.tokenUsage[0]?.output, 50);
});

test("HandleMessageResult.tokenUsage is empty array on LLM failure", async () => {
  const failingLLM = async () => {
    throw new Error("LLM unavailable");
  };

  const deps: HandleMessageDeps = {
    enqueueRun: async () => ({ id: "x", branchName: "b", repoSlug: "o/r" }),
    listRuns: async () => "[]",
    getConfig: async () => "{}",
    repoAllowlist: ["o/r"],
  };
  const request: HandleMessageRequest = {
    message: "test",
    userId: "U1",
    channelId: "C1",
    threadTs: "T1",
  };

  const result = await handleMessage(
    {} as never,
    "test-model",
    "system",
    request,
    deps,
    { _callLLMOverride: failingLLM as never },
  );

  assert.deepEqual(result.tokenUsage, []);
  assert.match(result.response, /Something went wrong/);
});
