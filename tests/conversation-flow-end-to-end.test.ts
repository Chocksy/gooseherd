/**
 * End-to-end test of the full conversation→build flow that the slack-app
 * exercises. Real LLM, real DB, mock pipeline backend.
 *
 * Replays the exact failing scenario from production:
 *   T1 user: "where do users cancel their plan in epiccoders/pxls?"
 *   T1 bot:  <answer with file references>
 *   T2 user: "this is good. can we change the cancel button text?"
 *   T2 bot:  "I'd update X. Want me to open a PR?"
 *   T3 user: "yeah do it!"
 *   T3 bot:  *should promote the conversation run to a build*
 *
 * Skipped without OPENROUTER_API_KEY.
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { handleMessage } from "../src/orchestrator/orchestrator.js";
import { buildSystemContext } from "../src/orchestrator/system-context.js";
import { synthesizeTask } from "../src/orchestrator/synthesize-task.js";
import { RunManager } from "../src/run-manager.js";
import { RunStore } from "../src/store.js";
import type { AppConfig } from "../src/config.js";
import type { LLMCallerConfig } from "../src/llm/caller.js";
import type { HandleMessageDeps } from "../src/orchestrator/types.js";
import type { RuntimeRegistry } from "../src/runtime/backend.js";
import type { RunRecord, ExecutionResult } from "../src/types.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";

const API_KEY = process.env["OPENROUTER_API_KEY"];
const MODEL = process.env["ORCHESTRATOR_MODEL"] ?? "google/gemini-2.5-flash";

const llmConfig: LLMCallerConfig = {
  apiKey: API_KEY ?? "",
  defaultModel: MODEL,
  defaultTimeoutMs: 60_000,
};

function makeConfig(): AppConfig {
  return {
    appName: "TestHerd",
    appSlug: "testherd",
    slackCommandName: "testherd",
    slackBotToken: "xoxb-test",
    slackAppToken: "xapp-test",
    slackSigningSecret: "test-secret",
    slackAllowedChannels: [],
    repoAllowlist: ["epiccoders/pxls"],
    runnerConcurrency: 1,
    workRoot: "/tmp/test-work",
    dataDir: "/tmp/test-data",
    dryRun: false,
    branchPrefix: "testherd",
    defaultBaseBranch: "main",
    gitAuthorName: "Test",
    gitAuthorEmail: "test@test.com",
    agentCommandTemplate: "echo test",
    validationCommand: "",
    lintFixCommand: "",
    maxValidationRounds: 0,
    agentTimeoutSeconds: 60,
    slackProgressHeartbeatSeconds: 30,
    dashboardEnabled: false,
    dashboardHost: "localhost",
    dashboardPort: 3000,
    maxTaskChars: 2000,
    workspaceCleanupEnabled: false,
    workspaceMaxAgeHours: 24,
    workspaceCleanupIntervalMinutes: 60,
    cemsEnabled: false,
    pipelineFile: "pipelines/pipeline.yml",
    observerEnabled: false,
    observerAlertChannelId: "",
    observerMaxRunsPerDay: 10,
    observerMaxRunsPerRepoPerDay: 5,
    observerCooldownMinutes: 5,
    observerRulesFile: "",
    observerRepoMap: new Map(),
    observerSentryPollIntervalSeconds: 300,
    sandboxRuntime: "local",
    sandboxRuntimeExplicit: false,
    sandboxEnabled: false,
    orchestratorModel: MODEL,
  } as unknown as AppConfig;
}

function makeMockSlack() {
  return {
    chat: {
      postMessage: async () => ({ ts: "1.0" }),
      update: async () => undefined,
      postEphemeral: async () => undefined,
    },
  };
}

function makeMockBackend(): RuntimeRegistry {
  const execute = async (_run: RunRecord): Promise<ExecutionResult> => ({
    branchName: "test/branch",
    logsPath: "/tmp/test.log",
    commitSha: "abc",
    changedFiles: [],
    prUrl: "https://example.com/pr/1",
    prNumber: 1,
  } as ExecutionResult);
  return {
    local: { runtime: "local", execute },
    docker: { runtime: "docker", execute },
    kubernetes: undefined,
  };
}

describe("conversation flow end-to-end", { skip: !API_KEY ? "OPENROUTER_API_KEY not set" : false }, () => {
  let testDb: TestDb;
  let store: RunStore;
  let runManager: RunManager;
  let config: AppConfig;
  let systemContext: string;

  before(async () => {
    testDb = await createTestDb();
    store = new RunStore(testDb.db);
    await store.init();
    config = makeConfig();
    systemContext = buildSystemContext(config);
    runManager = new RunManager(config, store, makeMockBackend(), makeMockSlack() as never);
  });

  after(async () => {
    await testDb.cleanup();
  });

  test("user agreement after a proposal promotes the conversation run to a build", async () => {
    const channelId = "C-PROD-REPRO";
    const threadTs = "1700000000.0001";
    const userId = "U_TEST";

    // Step 1: First mention — orchestrator answers a research question.
    const conversationRun = await runManager.getOrCreateConversationRun({
      channelId,
      threadTs,
      requestedBy: userId,
      firstMessage: "where do users cancel their plan in epiccoders/pxls?",
    });
    assert.equal(conversationRun.status, "conversation");

    // Step 2: Synthetic prior conversation (matches what ConversationStore would
    // return after a real exchange). We skip the actual research turn to keep
    // the test fast — what matters is the assistant's pending proposal.
    const priorMessages = [
      {
        role: "user" as const,
        content: "## Current Message (from <@U_TEST>)\nwhere do users cancel their plan in epiccoders/pxls?",
      },
      {
        role: "assistant" as const,
        content: "Users can cancel their plan from the account settings/edit profile page. In the codebase, it's at app/views/users/edit.html.slim — a 'Cancel subscription' button using the cancel_subscription_user_path route.",
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

    // Step 3: User says "yeah do it!" — this is what failed in production.
    let promoteCalled = false;
    let synthesizedTask: string | undefined;
    let promotedRunId: string | undefined;

    const deps: HandleMessageDeps = {
      enqueueRun: async (repo, task, opts) => {
        // For mode='code_change' (default), the slack-app's depsWithContext
        // synthesizes the task and PROMOTES the conversation run.
        if (opts.mode === "investigate") {
          throw new Error("Test setup error — expected code_change, got investigate");
        }

        const synthesis = await synthesizeTask({
          llmConfig,
          model: config.orchestratorModel,
          messages: priorMessages,
          proposal: { repoSlug: repo, summary: task },
        });

        const promoted = await runManager.promoteConversationToBuild(conversationRun.id, {
          repoSlug: repo,
          synthesizedTask: synthesis.task,
          intent: {
            version: 1,
            kind: "generic_task",
            source: "slack",
            requestedBy: userId,
          },
        });
        promoteCalled = true;
        synthesizedTask = synthesis.task;
        promotedRunId = promoted.id;
        return { id: promoted.id, branchName: promoted.branchName, repoSlug: promoted.repoSlug };
      },
      listRuns: async () => "[]",
      getConfig: async () => "{}",
      repoAllowlist: ["epiccoders/pxls"],
    };

    const result = await handleMessage(llmConfig, MODEL, systemContext, {
      message: "yeah do it!",
      userId,
      channelId,
      threadTs,
      priorMessages,
      existingRunRepo: "epiccoders/pxls",
      existingRunId: conversationRun.id,
    }, deps);

    // The orchestrator MUST call execute_task → which routes through enqueueRun → promote.
    assert.equal(
      promoteCalled,
      true,
      `Orchestrator did not call execute_task on natural confirmation. ` +
      `Response was: ${JSON.stringify(result.response)}, runsQueued=${result.runsQueued.length}`,
    );
    assert.equal(promotedRunId, conversationRun.id, "Should promote the SAME conversation run, not create a new one");
    assert.ok(synthesizedTask && synthesizedTask.length > 0, "Synthesized task should be non-empty");

    // The persisted run should no longer be in "conversation" — it's been
    // promoted (and possibly already completed by the mock backend).
    const reloaded = await store.getRun(conversationRun.id);
    assert.notEqual(reloaded?.status, "conversation", "Run should have left conversation status");
    assert.equal(reloaded?.repoSlug, "epiccoders/pxls");
    assert.equal(reloaded?.intent?.kind, "generic_task");

    // findRunByThread should return the same row.
    const byThread = await store.findRunByThread(channelId, threadTs);
    assert.equal(byThread?.id, conversationRun.id);
    assert.notEqual(byThread?.status, "conversation");
  });
});
