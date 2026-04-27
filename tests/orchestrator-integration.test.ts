/**
 * Integration tests for handleMessage — mocks fetch to simulate OpenRouter
 * and verifies the full tool-routing flow (execute_task, list_runs, get_config,
 * search_memory, search_code, plus error paths).
 */

import assert from "node:assert/strict";
import { describe, test, beforeEach, afterEach } from "node:test";
import { handleMessage } from "../src/orchestrator/orchestrator.js";
import { buildSystemContext } from "../src/orchestrator/system-context.js";
import type { HandleMessageDeps, HandleMessageRequest } from "../src/orchestrator/types.js";
import type { LLMCallerConfig } from "../src/llm/caller.js";
import type { AppConfig } from "../src/config.js";

// ── Helpers ──────────────────────────────────────────────

const llmConfig: LLMCallerConfig = {
  apiKey: "test-key",
  defaultModel: "test-model",
  defaultTimeoutMs: 10_000
};

const model = "test-model";

const systemContext = buildSystemContext({
  appName: "TestBot",
  repoAllowlist: ["test/repo", "acme/api"]
} as AppConfig);

function makeRequest(overrides: Partial<HandleMessageRequest> = {}): HandleMessageRequest {
  return {
    message: "fix the login bug",
    userId: "U123",
    channelId: "C123",
    threadTs: "1234567890.123456",
    ...overrides
  };
}

function makeDeps(overrides: Partial<HandleMessageDeps> = {}): HandleMessageDeps {
  return {
    repoAllowlist: ["test/repo", "acme/api"],
    enqueueRun: async (_repo, _task, _opts) => ({
      id: "run-abc-12345678",
      branchName: "gooseherd/fix-login",
      repoSlug: "test/repo"
    }),
    listRuns: async (_repoSlug) => JSON.stringify([
      { id: "run-1", repo: "test/repo", task: "fix header", status: "completed" }
    ]),
    getConfig: async (_key) => JSON.stringify({ repoAllowlist: ["test/repo"], pipelineFile: "pipeline.yml" }),
    ...overrides
  };
}

// OpenRouter-shaped response helpers
interface MockToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

function textResponse(text: string) {
  return {
    choices: [{ message: { role: "assistant", content: text } }],
    model: "test-model",
    usage: { prompt_tokens: 100, completion_tokens: 50 }
  };
}

function toolCallResponse(calls: MockToolCall[], content: string | null = null) {
  return {
    choices: [{
      message: {
        role: "assistant",
        content,
        tool_calls: calls.map((tc, i) => ({
          id: `tc_${String(i)}`,
          type: "function",
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments)
          }
        }))
      }
    }],
    model: "test-model",
    usage: { prompt_tokens: 100, completion_tokens: 50 }
  };
}

// Mock fetch: queues responses in order. Each fetch call pops the next one.
let fetchResponses: Array<Record<string, unknown>> = [];
let fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
const originalFetch = globalThis.fetch;

function mockFetch() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    fetchCalls.push({ url, body });
    const nextResponse = fetchResponses.shift();
    if (!nextResponse) {
      throw new Error("No more mock fetch responses queued");
    }
    return {
      ok: true,
      json: async () => nextResponse,
      text: async () => JSON.stringify(nextResponse)
    };
  };
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

// ── Tests ────────────────────────────────────────────────

describe("handleMessage integration", () => {
  beforeEach(() => {
    fetchResponses = [];
    fetchCalls = [];
    mockFetch();
  });

  afterEach(() => {
    restoreFetch();
  });

  test("LLM answers a question directly (no tools)", async () => {
    fetchResponses.push(textResponse("The browser verify node uses openai/gpt-4.1-mini."));

    const result = await handleMessage(llmConfig, model, systemContext, makeRequest({
      message: "what model does browser verify use?"
    }), makeDeps());

    assert.equal(result.response, "The browser verify node uses openai/gpt-4.1-mini.");
    assert.equal(result.runsQueued.length, 0);
    assert.equal(fetchCalls.length, 1);
  });

  test("LLM calls execute_task → run enqueued", async () => {
    // Turn 1: LLM calls execute_task tool
    fetchResponses.push(toolCallResponse([{
      name: "execute_task",
      arguments: { repo: "test/repo", task: "fix the login bug" }
    }]));
    // Turn 2: LLM produces final text after seeing tool result
    fetchResponses.push(textResponse("I've queued a run to fix the login bug in test/repo."));

    const result = await handleMessage(llmConfig, model, systemContext, makeRequest(), makeDeps());

    assert.equal(result.runsQueued.length, 1);
    assert.equal(result.runsQueued[0].repoSlug, "test/repo");
    assert.equal(result.runsQueued[0].branchName, "gooseherd/fix-login");
    assert.ok(result.response.includes("fix the login bug"));
    assert.equal(fetchCalls.length, 2);
  });

  test("execute_task with disallowed repo returns error", async () => {
    fetchResponses.push(toolCallResponse([{
      name: "execute_task",
      arguments: { repo: "evil/hacker", task: "steal secrets" }
    }]));
    fetchResponses.push(textResponse("Sorry, that repo isn't allowed."));

    const result = await handleMessage(llmConfig, model, systemContext, makeRequest(), makeDeps());

    assert.equal(result.runsQueued.length, 0);
    // The second fetch should have received the error as a tool result
    const secondBody = fetchCalls[1].body;
    const messages = secondBody["messages"] as Array<{ role: string; content: string }>;
    const toolResult = messages.find(m => m.role === "tool");
    assert.ok(toolResult);
    assert.ok(toolResult.content.includes("not in the allowlist"));
  });

  test("execute_task with continueFromThread reuses existing run", async () => {
    let capturedOpts: { continueFrom?: string } = {};
    const deps = makeDeps({
      enqueueRun: async (_repo, _task, opts) => {
        capturedOpts = opts;
        return { id: "run-continued", branchName: "gooseherd/fix-login", repoSlug: "test/repo" };
      }
    });

    fetchResponses.push(toolCallResponse([{
      name: "execute_task",
      arguments: { repo: "test/repo", task: "also fix the footer", continueFromThread: true }
    }]));
    fetchResponses.push(textResponse("Continuing on the same branch."));

    const result = await handleMessage(llmConfig, model, systemContext, makeRequest({
      existingRunId: "run-prev-123",
      existingRunRepo: "test/repo"
    }), deps);

    assert.equal(result.runsQueued.length, 1);
    assert.equal(capturedOpts.continueFrom, "run-prev-123");
  });

  test("execute_task with continueFromThread but no existing run creates fresh run", async () => {
    let capturedOpts: { continueFrom?: string } = {};
    const deps = makeDeps({
      enqueueRun: async (_repo, _task, opts) => {
        capturedOpts = opts;
        return { id: "run-fresh", branchName: "gooseherd/new-branch", repoSlug: "test/repo" };
      }
    });

    fetchResponses.push(toolCallResponse([{
      name: "execute_task",
      arguments: { repo: "test/repo", task: "fix something", continueFromThread: true }
    }]));
    fetchResponses.push(textResponse("Starting a fresh run."));

    const result = await handleMessage(llmConfig, model, systemContext, makeRequest(), deps);

    assert.equal(result.runsQueued.length, 1);
    assert.equal(capturedOpts.continueFrom, undefined);
  });

  test("execute_task with enableNodes and skipNodes", async () => {
    let capturedArgs: { enableNodes?: string[]; skipNodes?: string[] } = {};
    const deps = makeDeps({
      enqueueRun: async (_repo, _task, opts) => {
        capturedArgs = opts;
        return { id: "run-preview", branchName: "gooseherd/ui-fix", repoSlug: "test/repo" };
      }
    });

    fetchResponses.push(toolCallResponse([{
      name: "execute_task",
      arguments: {
        repo: "test/repo",
        task: "fix button styles",
        enableNodes: ["deploy_preview", "browser_verify"],
        skipNodes: ["diff_gate"]
      }
    }]));
    fetchResponses.push(textResponse("Queued run with preview enabled."));

    await handleMessage(llmConfig, model, systemContext, makeRequest(), deps);

    assert.deepEqual(capturedArgs.enableNodes, ["deploy_preview", "browser_verify"]);
    assert.deepEqual(capturedArgs.skipNodes, ["diff_gate"]);
  });

  test("execute_task missing repo returns error", async () => {
    fetchResponses.push(toolCallResponse([{
      name: "execute_task",
      arguments: { task: "fix something" }
    }]));
    fetchResponses.push(textResponse("I need a repo — which one?"));

    const result = await handleMessage(llmConfig, model, systemContext, makeRequest(), makeDeps());

    assert.equal(result.runsQueued.length, 0);
    const toolResult = (fetchCalls[1].body["messages"] as Array<{ role: string; content: string }>)
      .find(m => m.role === "tool");
    assert.ok(toolResult?.content.includes("required"));
  });

  test("LLM calls list_runs tool", async () => {
    let listRunsCalled = false;
    const deps = makeDeps({
      listRuns: async (repoSlug) => {
        listRunsCalled = true;
        assert.equal(repoSlug, "test/repo");
        return JSON.stringify([{ id: "run-1", status: "completed" }]);
      }
    });

    fetchResponses.push(toolCallResponse([{
      name: "list_runs",
      arguments: { repoSlug: "test/repo" }
    }]));
    fetchResponses.push(textResponse("Here are the recent runs for test/repo."));

    await handleMessage(llmConfig, model, systemContext, makeRequest(), deps);

    assert.ok(listRunsCalled);
  });

  test("LLM calls get_config tool", async () => {
    let getConfigCalled = false;
    const deps = makeDeps({
      getConfig: async (key) => {
        getConfigCalled = true;
        assert.equal(key, "repoAllowlist");
        return JSON.stringify(["test/repo", "acme/api"]);
      }
    });

    fetchResponses.push(toolCallResponse([{
      name: "get_config",
      arguments: { key: "repoAllowlist" }
    }]));
    fetchResponses.push(textResponse("The allowed repos are test/repo and acme/api."));

    await handleMessage(llmConfig, model, systemContext, makeRequest({
      message: "which repos are configured?"
    }), deps);

    assert.ok(getConfigCalled);
  });

  test("LLM calls search_memory tool", async () => {
    let memoryQuery = "";
    const deps = makeDeps({
      searchMemory: async (query) => {
        memoryQuery = query;
        return "Found: login module uses bcrypt for password hashing";
      }
    });

    fetchResponses.push(toolCallResponse([{
      name: "search_memory",
      arguments: { query: "login authentication" }
    }]));
    fetchResponses.push(textResponse("Based on organizational memory, the login uses bcrypt."));

    await handleMessage(llmConfig, model, systemContext, makeRequest({
      message: "how does login auth work?"
    }), deps);

    assert.equal(memoryQuery, "login authentication");
  });

  test("LLM calls search_code tool", async () => {
    let codeQuery = "";
    let codeRepo = "";
    const deps = makeDeps({
      searchCode: async (query, repoSlug) => {
        codeQuery = query;
        codeRepo = repoSlug;
        return "src/auth.ts: function validatePassword(...)";
      }
    });

    fetchResponses.push(toolCallResponse([{
      name: "search_code",
      arguments: { query: "validatePassword", repoSlug: "test/repo" }
    }]));
    fetchResponses.push(textResponse("Found validatePassword in src/auth.ts."));

    await handleMessage(llmConfig, model, systemContext, makeRequest({
      message: "find the password validation function"
    }), deps);

    assert.equal(codeQuery, "validatePassword");
    assert.equal(codeRepo, "test/repo");
  });

  test("unknown tool returns error text", async () => {
    fetchResponses.push(toolCallResponse([{
      name: "nonexistent_tool",
      arguments: { foo: "bar" }
    }]));
    fetchResponses.push(textResponse("I couldn't use that tool."));

    const result = await handleMessage(llmConfig, model, systemContext, makeRequest(), makeDeps());

    const toolResult = (fetchCalls[1].body["messages"] as Array<{ role: string; content: string }>)
      .find(m => m.role === "tool");
    assert.equal(toolResult?.content, "Unknown tool");
    assert.equal(result.runsQueued.length, 0);
  });

  test("prior messages are included in conversation", async () => {
    fetchResponses.push(textResponse("I remember the repo from earlier."));

    const result = await handleMessage(llmConfig, model, systemContext, makeRequest({
      priorMessages: [
        { role: "user", content: "describe epiccoders/pxls" },
        { role: "assistant", content: "It's a Ruby/JS Rails app." }
      ],
      existingRunRepo: "test/repo",
      existingRunId: "run-prev"
    }), makeDeps());

    const body = fetchCalls[0].body;
    const messages = body["messages"] as Array<{ role: string; content: string }>;
    // System + 2 prior messages + 1 new user message = 4 messages
    const nonSystem = messages.filter(m => m.role !== "system");
    assert.equal(nonSystem.length, 3);
    assert.equal(nonSystem[0].content, "describe epiccoders/pxls");
    assert.equal(nonSystem[1].content, "It's a Ruby/JS Rails app.");
    // New user message includes Active Thread Run
    assert.ok(nonSystem[2].content.includes("Active Thread Run"));
    assert.ok(nonSystem[2].content.includes("test/repo"));
    assert.ok(nonSystem[2].content.includes("run-prev"));
    // Result includes messages array
    assert.ok(Array.isArray(result.messages));
    assert.ok(result.messages.length > 0);
  });

  test("enqueueRun failure returns error text to LLM", async () => {
    const deps = makeDeps({
      enqueueRun: async () => { throw new Error("Queue is full"); }
    });

    fetchResponses.push(toolCallResponse([{
      name: "execute_task",
      arguments: { repo: "test/repo", task: "fix something" }
    }]));
    fetchResponses.push(textResponse("Sorry, the queue is full right now."));

    const result = await handleMessage(llmConfig, model, systemContext, makeRequest(), deps);

    assert.equal(result.runsQueued.length, 0);
    const toolResult = (fetchCalls[1].body["messages"] as Array<{ role: string; content: string }>)
      .find(m => m.role === "tool");
    assert.ok(toolResult?.content.includes("Queue is full"));
  });

  test("API error returns friendly error response", async () => {
    fetchResponses.length = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async () => {
      return { ok: false, status: 500, text: async () => "Internal Server Error" };
    };

    const result = await handleMessage(llmConfig, model, systemContext, makeRequest(), makeDeps());

    assert.ok(result.response.includes("Something went wrong"));
    assert.equal(result.runsQueued.length, 0);
  });

  test("AbortError returns timeout response (not raw aborted text)", async () => {
    fetchResponses.length = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async () => {
      throw new DOMException("This operation was aborted", "AbortError");
    };

    const result = await handleMessage(
      llmConfig,
      model,
      systemContext,
      makeRequest(),
      makeDeps(),
      { timeoutMs: 45_000 }
    );

    assert.ok(result.response.includes("LLM timeout"));
    assert.ok(result.response.includes("45000ms"));
    assert.ok(!result.response.toLowerCase().includes("aborted"));
  });

  test("empty allowlist allows any repo", async () => {
    const deps = makeDeps({ repoAllowlist: [] });

    fetchResponses.push(toolCallResponse([{
      name: "execute_task",
      arguments: { repo: "any/repo", task: "fix it" }
    }]));
    fetchResponses.push(textResponse("Done."));

    const result = await handleMessage(llmConfig, model, systemContext, makeRequest(), deps);

    assert.equal(result.runsQueued.length, 1);
    assert.equal(result.runsQueued[0].repoSlug, "test/repo");
  });

  test("system context is sent as system message", async () => {
    fetchResponses.push(textResponse("Hello!"));

    await handleMessage(llmConfig, model, systemContext, makeRequest(), makeDeps());

    const body = fetchCalls[0].body;
    const messages = body["messages"] as Array<{ role: string; content: string }>;
    const systemMsg = messages.find(m => m.role === "system");
    assert.ok(systemMsg);
    assert.ok(systemMsg.content.includes("TestBot"));
    assert.ok(systemMsg.content.includes("execute_task"));
  });

  test("tools array is sent with the request", async () => {
    fetchResponses.push(textResponse("Hi!"));

    await handleMessage(llmConfig, model, systemContext, makeRequest(), makeDeps());

    const body = fetchCalls[0].body;
    const tools = body["tools"] as Array<{ function: { name: string } }>;
    const toolNames = tools.map(t => t.function.name);
    assert.ok(toolNames.includes("execute_task"));
    assert.ok(toolNames.includes("list_runs"));
    assert.ok(toolNames.includes("get_config"));
    // search_memory and search_code should NOT be present (no deps for them)
    assert.ok(!toolNames.includes("search_memory"));
    assert.ok(!toolNames.includes("search_code"));
  });

  test("search_memory tool registered when dep provided", async () => {
    fetchResponses.push(textResponse("Hi!"));

    const deps = makeDeps({ searchMemory: async () => "results" });
    await handleMessage(llmConfig, model, systemContext, makeRequest(), deps);

    const tools = fetchCalls[0].body["tools"] as Array<{ function: { name: string } }>;
    const toolNames = tools.map(t => t.function.name);
    assert.ok(toolNames.includes("search_memory"));
  });

  test("search_code tool registered when dep provided", async () => {
    fetchResponses.push(textResponse("Hi!"));

    const deps = makeDeps({ searchCode: async () => "results" });
    await handleMessage(llmConfig, model, systemContext, makeRequest(), deps);

    const tools = fetchCalls[0].body["tools"] as Array<{ function: { name: string } }>;
    const toolNames = tools.map(t => t.function.name);
    assert.ok(toolNames.includes("search_code"));
  });

  test("LLM calls describe_repo tool", async () => {
    let describedRepo = "";
    const deps = makeDeps({
      describeRepo: async (repoSlug) => {
        describedRepo = repoSlug;
        return "Languages:\n- Ruby: 65.2%\n- JavaScript: 20.1%\n\nRoot files:\nGemfile\npackage.json\napp/";
      }
    });

    fetchResponses.push(toolCallResponse([{
      name: "describe_repo",
      arguments: { repoSlug: "test/repo" }
    }]));
    fetchResponses.push(textResponse("This is a Ruby on Rails app with some JavaScript."));

    const result = await handleMessage(llmConfig, model, systemContext, makeRequest({
      message: "what kind of code type are we using in test/repo?"
    }), deps);

    assert.equal(describedRepo, "test/repo");
    assert.ok(result.response.includes("Ruby"));
  });

  test("read-only repository questions are not enqueued even if LLM calls execute_task", async () => {
    fetchResponses.push(toolCallResponse([{
      name: "execute_task",
      arguments: { repo: "test/repo", task: "what is this repository about?" }
    }]));
    fetchResponses.push(textResponse("I'll answer that directly instead of starting a code-change run."));

    let enqueueCalled = false;
    const deps = makeDeps({
      enqueueRun: async () => {
        enqueueCalled = true;
        throw new Error("should not enqueue");
      }
    });

    const result = await handleMessage(llmConfig, model, systemContext, makeRequest({
      message: "test/repo what is this repository about?"
    }), deps);

    assert.equal(enqueueCalled, false);
    assert.equal(result.runsQueued.length, 0);

    const toolResult = (fetchCalls[1].body["messages"] as Array<{ role: string; content: string }>)
      .find(m => m.role === "tool");
    assert.ok(toolResult?.content.includes("read-only question"));
    assert.ok(toolResult?.content.includes("describe_repo"));
  });

  test("describe_repo tool registered when dep provided", async () => {
    fetchResponses.push(textResponse("Hi!"));

    const deps = makeDeps({ describeRepo: async () => "info" });
    await handleMessage(llmConfig, model, systemContext, makeRequest(), deps);

    const tools = fetchCalls[0].body["tools"] as Array<{ function: { name: string } }>;
    const toolNames = tools.map(t => t.function.name);
    assert.ok(toolNames.includes("describe_repo"));
  });

  test("describe_repo tool NOT registered without dep", async () => {
    fetchResponses.push(textResponse("Hi!"));

    await handleMessage(llmConfig, model, systemContext, makeRequest(), makeDeps());

    const tools = fetchCalls[0].body["tools"] as Array<{ function: { name: string } }>;
    const toolNames = tools.map(t => t.function.name);
    assert.ok(!toolNames.includes("describe_repo"));
  });

  test("handleMessage allows complex investigations beyond 8 LLM turns", async () => {
    // Simulate an LLM doing a deep investigation: 10 search/read tool calls,
    // then a final answer. Previously hardcoded maxTurns: 8 would cut this off
    // and return "Sorry, I ran out of time...". After removing the cap, the
    // orchestrator should ride the LLM caller's higher default (25 turns).
    for (let i = 0; i < 10; i++) {
      fetchResponses.push(toolCallResponse([{
        name: "search_code",
        arguments: { query: `pattern-${String(i)}`, repoSlug: "test/repo" }
      }]));
    }
    fetchResponses.push(textResponse("Investigation complete after 10 searches."));

    const deps = makeDeps({
      searchCode: async () => "match: src/foo.ts:42"
    });

    const result = await handleMessage(llmConfig, model, systemContext, makeRequest({
      message: "investigate why the daily summary email failed"
    }), deps);

    assert.equal(result.response, "Investigation complete after 10 searches.");
    assert.equal(fetchCalls.length, 11);
    assert.ok(!result.response.startsWith("Sorry, I ran out of time"));
  });

  test("handleMessage forwards options.maxInputTokens to the LLM caller", async () => {
    // Token budget propagation: each mocked turn reports prompt_tokens=100 in usage.
    // With maxInputTokens=150, the LLM caller must bail after the 2nd turn
    // (cumulative 200 > 150) instead of running all 3 tool calls + final text.
    for (let i = 0; i < 3; i++) {
      fetchResponses.push(toolCallResponse([{
        name: "search_code",
        arguments: { query: `q${String(i)}`, repoSlug: "test/repo" }
      }]));
    }
    fetchResponses.push(textResponse("Done"));

    const deps = makeDeps({ searchCode: async () => "match" });

    const result = await handleMessage(
      llmConfig,
      model,
      systemContext,
      makeRequest(),
      deps,
      { maxInputTokens: 150 }
    );

    // Budget should kick in before all queued responses are consumed.
    assert.ok(fetchCalls.length < 4, `expected <4 fetches, got ${String(fetchCalls.length)}`);
    // Exhaustion path returns the conversational fallback.
    assert.ok(
      result.response.startsWith("Sorry, I ran out of time"),
      `expected exhaustion fallback, got: ${result.response}`
    );
  });

  test("exhaustion fallback returns conversational message instead of JSON", async () => {
    // Simulate: LLM makes a tool call, then wall-clock timeout hits
    // callLLMWithTools returns its JSON fallback
    fetchResponses.length = 0;
    let callCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (_url: string, init: { body: string }) => {
      callCount++;
      fetchCalls.push({ url: _url, body: JSON.parse(init.body) as Record<string, unknown> });
      if (callCount === 1) {
        // First call: LLM responds with text only — but content is the JSON fallback
        // Simulate this by returning a text response that looks like the exhaustion fallback
        return {
          ok: true,
          json: async () => textResponse('Loop exhausted: wall-clock timeout after 1 turns'),
          text: async () => ""
        };
      }
      return { ok: true, json: async () => textResponse(""), text: async () => "" };
    };

    const result = await handleMessage(llmConfig, model, systemContext, makeRequest(), makeDeps());

    assert.ok(result.response.includes("ran out of time") || result.response.includes("try again"));
    assert.ok(!result.response.includes('"passed"'));
  });
});
