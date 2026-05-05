/**
 * Live integration tests for the orchestrator — calls real OpenRouter API.
 *
 * Skipped unless OPENROUTER_API_KEY is set in environment.
 * Run directly: OPENROUTER_API_KEY=sk-or-... node --test --import tsx tests/orchestrator-live.test.ts
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { handleMessage } from "../src/orchestrator/orchestrator.js";
import { buildSystemContext } from "../src/orchestrator/system-context.js";
import type { HandleMessageDeps, HandleMessageRequest } from "../src/orchestrator/types.js";
import type { LLMCallerConfig } from "../src/llm/caller.js";
import type { AppConfig } from "../src/config.js";

const API_KEY = process.env["OPENROUTER_API_KEY"];
const MODEL = process.env["ORCHESTRATOR_MODEL"] ?? "google/gemini-2.5-flash";

const llmConfig: LLMCallerConfig = {
  apiKey: API_KEY ?? "",
  defaultModel: MODEL,
  defaultTimeoutMs: 20_000
};

const systemContext = buildSystemContext({
  appName: "TestBot",
  repoAllowlist: ["epiccoders/pxls", "acme/api"]
} as AppConfig);

function makeRequest(overrides: Partial<HandleMessageRequest> = {}): HandleMessageRequest {
  return {
    message: "hello",
    userId: "U_TEST",
    channelId: "C_TEST",
    threadTs: "1234567890.000000",
    ...overrides
  };
}

let enqueueRunCalls: Array<{ repo: string; task: string; opts: Record<string, unknown> }> = [];
let listRunsCalled = false;
let getConfigCalled = false;
let describeRepoCalled = false;

function makeDeps(overrides: Partial<HandleMessageDeps> = {}): HandleMessageDeps {
  enqueueRunCalls = [];
  listRunsCalled = false;
  getConfigCalled = false;
  describeRepoCalled = false;

  return {
    repoAllowlist: ["epiccoders/pxls", "acme/api"],
    enqueueRun: async (repo, task, opts) => {
      enqueueRunCalls.push({ repo, task, opts });
      return { id: "live-run-001", branchName: "gooseherd/live-test", repoSlug: repo };
    },
    listRuns: async () => {
      listRunsCalled = true;
      return JSON.stringify([
        { id: "abc12345", status: "completed", repo: "epiccoders/pxls", task: "fix header color" },
        { id: "def67890", status: "running", repo: "acme/api", task: "add pagination" }
      ]);
    },
    getConfig: async () => {
      getConfigCalled = true;
      return JSON.stringify({
        browserVerifyModel: "openai/gpt-4.1-mini",
        orchestratorModel: MODEL,
        pipelineFile: "pipelines/pipeline.yml"
      });
    },
    describeRepo: async (repoSlug) => {
      describeRepoCalled = true;
      return `Languages:\n- Ruby: 65.2%\n- JavaScript: 20.1%\n\nRoot files:\nGemfile\npackage.json\nREADME.md\n\nREADME: ${repoSlug} is a web application built with Ruby on Rails.`;
    },
    ...overrides
  };
}

describe("orchestrator live", { skip: !API_KEY ? "OPENROUTER_API_KEY not set" : false }, () => {

  test("answers a simple question directly (no tool use)", async () => {
    const result = await handleMessage(llmConfig, MODEL, systemContext, makeRequest({
      message: "what pipelines are available?"
    }), makeDeps());

    assert.ok(result.response.length > 10, "Should produce a meaningful response");
    assert.ok(
      result.response.toLowerCase().includes("default") ||
      result.response.toLowerCase().includes("pipeline"),
      "Should mention pipelines"
    );
    assert.equal(result.runsQueued.length, 0, "Should not queue any runs");
  });

  test("handles a code-change request — either asks first or fires execute_task (model judgment)", async () => {
    const result = await handleMessage(llmConfig, MODEL, systemContext, makeRequest({
      message: "fix the login timeout bug in epiccoders/pxls"
    }), makeDeps());

    assert.ok(result.response.length > 0, "Should produce a response");
    // The model may legitimately decide a clear request needs no further discussion,
    // or it may ask for confirmation per system prompt rule 12. Both are acceptable —
    // the regression we care about is "yeah do it!" after a proposal triggering the
    // build, which is covered by the next test.
    assert.ok(
      enqueueRunCalls.length === 0 || enqueueRunCalls.length === 1,
      "Should either ask first or queue exactly one run",
    );
    if (enqueueRunCalls.length === 1) {
      assert.equal(enqueueRunCalls[0].repo, "epiccoders/pxls");
    }
  });

  test("FIRES the build after user agrees to a prior proposal", async () => {
    // This is the regression case: orchestrator proposed a change in a prior
    // turn, user replies with natural agreement ("yeah do it!"), and the
    // orchestrator should call execute_task on the same thread.
    const priorMessages = [
      {
        role: "user" as const,
        content: "## Current Message (from <@U_TEST>)\ncan you tell me where users cancel their plan in epiccoders/pxls?",
      },
      {
        role: "assistant" as const,
        content: "Users can cancel their plan from the account settings/edit profile page. In the codebase, this is at app/views/users/edit.html.slim — it shows a 'Cancel subscription' button using the cancel_subscription_user_path route.",
      },
      {
        role: "user" as const,
        content: "## Current Message (from <@U_TEST>)\nOK this is good. can we change the text of the cancel button to be: 'I am out of here!'",
      },
      {
        role: "assistant" as const,
        content: "I can definitely do that! I will update app/views/users/edit.html.slim to change the button text from 'Cancel subscription' to 'I am out of here!'. Would you like me to go ahead and create a PR for this change?",
      },
    ];

    const result = await handleMessage(llmConfig, MODEL, systemContext, makeRequest({
      message: "yeah do it!",
      priorMessages,
      existingRunRepo: "epiccoders/pxls",
    }), makeDeps());

    assert.ok(result.response.length > 0, "Should produce a response");
    assert.equal(enqueueRunCalls.length, 1, `Should call execute_task for the agreed build, but enqueueRunCalls=${JSON.stringify(enqueueRunCalls)} and response was: ${result.response}`);
    assert.equal(enqueueRunCalls[0].repo, "epiccoders/pxls");
    assert.equal(enqueueRunCalls[0].opts.mode ?? "code_change", "code_change");
  });

  test("FIRES the build after a casual 'ok go!' confirmation", async () => {
    const priorMessages = [
      {
        role: "user" as const,
        content: "## Current Message (from <@U_TEST>)\nrename the readme heading in epiccoders/pxls to 'Pixels'",
      },
      {
        role: "assistant" as const,
        content: "I can rename the heading in README.md from its current value to 'Pixels'. Want me to open a PR for that?",
      },
    ];

    const result = await handleMessage(llmConfig, MODEL, systemContext, makeRequest({
      message: "ok go!",
      priorMessages,
      existingRunRepo: "epiccoders/pxls",
    }), makeDeps());

    assert.equal(enqueueRunCalls.length, 1, `Should call execute_task on natural confirmation, but enqueueRunCalls=${JSON.stringify(enqueueRunCalls)} and response was: ${result.response}`);
    assert.equal(enqueueRunCalls[0].repo, "epiccoders/pxls");
  });

  test("asks for clarification when repo is missing", async () => {
    const result = await handleMessage(llmConfig, MODEL, systemContext, makeRequest({
      message: "fix the header color"
    }), makeDeps());

    assert.ok(result.response.length > 10, "Should produce a response");
    // LLM should either ask which repo or attempt execute_task
    // If it asks, no runs are queued; if it guesses, one run is queued
    // Either behavior is acceptable — the key is it doesn't crash
    assert.ok(
      result.runsQueued.length === 0 || result.runsQueued.length === 1,
      "Should either ask or queue"
    );
  });

  test("handles follow-up in thread context", async () => {
    const result = await handleMessage(llmConfig, MODEL, systemContext, makeRequest({
      message: "also fix the footer while you're at it",
      priorMessages: [
        { role: "user", content: "## Current Message (from <@U_TEST>)\nfix the login timeout bug in epiccoders/pxls" },
        { role: "assistant", content: "I've queued a run to fix the login timeout." }
      ],
      existingRunRepo: "epiccoders/pxls",
      existingRunId: "run-prev-001"
    }), makeDeps());

    assert.ok(result.response.length > 0, "Should produce a response");
    // LLM should understand context and queue a continuation run
    if (enqueueRunCalls.length > 0) {
      assert.equal(enqueueRunCalls[0].repo, "epiccoders/pxls", "Should use the repo from thread context");
    }
  });

  test("calls describe_repo for tech stack questions", async () => {
    const result = await handleMessage(llmConfig, MODEL, systemContext, makeRequest({
      message: "what kind of project is epiccoders/pxls? what languages does it use?"
    }), makeDeps());

    assert.ok(result.response.length > 10, "Should produce a response");
    assert.ok(describeRepoCalled, "Should call describe_repo tool");
    assert.ok(
      result.response.toLowerCase().includes("ruby") ||
      result.response.toLowerCase().includes("rails"),
      "Should mention Ruby/Rails from describe_repo"
    );
  });

  test("calls list_runs for status questions", async () => {
    const result = await handleMessage(llmConfig, MODEL, systemContext, makeRequest({
      message: "what are the recent runs? show me the latest"
    }), makeDeps());

    assert.ok(result.response.length > 10, "Should produce a response");
    assert.ok(listRunsCalled, "Should call list_runs tool");
  });

  test("calls get_config for configuration questions", async () => {
    const result = await handleMessage(llmConfig, MODEL, systemContext, makeRequest({
      message: "what model does the orchestrator use? show me the config"
    }), makeDeps());

    assert.ok(result.response.length > 10, "Should produce a response");
    assert.ok(getConfigCalled, "Should call get_config tool");
  });

  test("rejects disallowed repo", async () => {
    const result = await handleMessage(llmConfig, MODEL, systemContext, makeRequest({
      message: "fix the bug in evil/hacker-repo"
    }), makeDeps());

    assert.ok(result.response.length > 0, "Should produce a response");
    assert.equal(enqueueRunCalls.length, 0, "Should NOT queue a run for disallowed repo");
    assert.ok(
      result.response.toLowerCase().includes("not") ||
      result.response.toLowerCase().includes("allow") ||
      result.response.toLowerCase().includes("can't"),
      "Should indicate repo is not allowed"
    );
  });

  test("response is conversational, not JSON garbage", async () => {
    const result = await handleMessage(llmConfig, MODEL, systemContext, makeRequest({
      message: "hey, can you help me with something?"
    }), makeDeps());

    assert.ok(result.response.length > 0, "Should produce a response");
    assert.ok(!result.response.startsWith("{"), "Should not return raw JSON");
    assert.ok(!result.response.includes('"passed"'), "Should not contain browser-verify JSON");
  });
});
