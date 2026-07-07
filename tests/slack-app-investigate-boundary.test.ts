/**
 * Boundary test: when the orchestrator calls deps.enqueueRun with mode="investigate",
 * the slack-app.ts wrapper must construct an InvestigateRunIntent and pass it to
 * RunManager.enqueueRun. Without this test, a regression that drops the intent spread
 * (or mistypes `kind`) would silently fall through to deriveRunIntentFromLegacy →
 * generic_task, route to the default pipeline, and reproduce the prod bug.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildHandleMessageDeps } from "../src/slack-app.js";
import type { AppConfig } from "../src/config.js";
import type { RunManager } from "../src/run-manager.js";
import type { NewRunInput, RunRecord } from "../src/types.js";
import { isRunIntent } from "../src/runs/run-intent.js";

function makeConfig(): AppConfig {
  return {
    repoAllowlist: ["owner/repo"],
    defaultBaseBranch: "master",
    sandboxRuntime: "local",
    appName: "TestHerd"
  } as unknown as AppConfig;
}

function makeMockRunManager(captures: { input?: NewRunInput }): RunManager {
  const enqueueRun = async (input: NewRunInput): Promise<RunRecord> => {
    captures.input = input;
    return {
      id: "run-test-1",
      runtime: input.runtime,
      status: "queued",
      repoSlug: input.repoSlug,
      task: input.task,
      baseBranch: input.baseBranch,
      branchName: "investigate/run-test-1",
      requestedBy: input.requestedBy,
      channelId: input.channelId,
      threadTs: input.threadTs,
      createdAt: new Date().toISOString()
    };
  };
  // Cast: the test only exercises enqueueRun + continueRun.
  return {
    enqueueRun,
    continueRun: async () => undefined,
    getRecentRuns: async () => []
  } as unknown as RunManager;
}

test("buildHandleMessageDeps.enqueueRun: mode='investigate' produces an InvestigateRunIntent", async () => {
  const captures: { input?: NewRunInput } = {};
  const deps = buildHandleMessageDeps(makeConfig(), makeMockRunManager(captures));

  await deps.enqueueRun("owner/repo", "Why didn't DWS go out for org 633609?", { mode: "investigate" });

  const input = captures.input;
  assert.ok(input, "RunManager.enqueueRun should have been called");
  assert.ok(input.intent, "Investigate run must include an intent");
  assert.equal(input.intent.kind, "investigate");
  assert.equal(input.intent.version, 1);
  // The wrapped intent must be a valid RunIntent — i.e. would NOT fall through to
  // deriveRunIntentFromLegacy → generic_task.
  assert.equal(isRunIntent(input.intent), true, "intent must satisfy isRunIntent");
  if (input.intent.kind === "investigate") {
    assert.equal(input.intent.question, "Why didn't DWS go out for org 633609?");
    assert.equal(input.intent.requestedBy, "orchestrator");
  }
  // pipelineHint should NOT redundantly carry "investigation" — pipeline routing
  // is the intent's responsibility (see selectPipelineIdForIntent).
  assert.equal(input.pipelineHint, undefined, "pipelineHint must not duplicate intent routing");
});

test("buildHandleMessageDeps.enqueueRun: mode='code_change' produces no intent (fallback path)", async () => {
  const captures: { input?: NewRunInput } = {};
  const deps = buildHandleMessageDeps(makeConfig(), makeMockRunManager(captures));

  await deps.enqueueRun("owner/repo", "add a button", { mode: "code_change" });

  const input = captures.input;
  assert.ok(input, "RunManager.enqueueRun should have been called");
  assert.equal(input.intent, undefined, "code_change must NOT carry an investigate intent");
});

test("buildHandleMessageDeps.enqueueRun: investigate intent uses source: 'unknown' (non-Slack origin)", async () => {
  const captures: { input?: NewRunInput } = {};
  const deps = buildHandleMessageDeps(makeConfig(), makeMockRunManager(captures));

  await deps.enqueueRun("owner/repo", "why is X broken?", { mode: "investigate" });

  const intent = captures.input?.intent;
  assert.ok(intent && intent.kind === "investigate");
  // The fallback in buildHandleMessageDeps is a non-Slack origin (channelId="").
  // The real Slack-event override at the depsWithContext callsite uses source: "slack".
  assert.equal(intent.source, "unknown");
});
