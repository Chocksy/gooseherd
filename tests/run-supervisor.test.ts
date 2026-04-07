import assert from "node:assert/strict";
import test from "node:test";
import { classifyFailureWithRetryability, type ClassifiedFailure } from "../src/supervisor/failure-classifier.js";
import { RunSupervisor } from "../src/supervisor/run-supervisor.js";
import type { AppConfig } from "../src/config.js";
import type { RunRecord } from "../src/types.js";
import type { NodeEvent } from "../src/pipeline/types.js";

// ── Failure Classifier Tests ──────────────────────────

test("classifyFailureWithRetryability: clone errors are retryable (full)", () => {
  const result = classifyFailureWithRetryability("failed to clone repository: timeout");
  assert.equal(result.category, "clone");
  assert.equal(result.retryable, true);
  assert.equal(result.retryStrategy, "full");
});

test("classifyFailureWithRetryability: timeout errors are NOT retryable", () => {
  const result = classifyFailureWithRetryability("exceeded 1200s — terminating");
  assert.equal(result.category, "timeout");
  assert.equal(result.retryable, false);
  assert.equal(result.retryStrategy, "none");
});

test("classifyFailureWithRetryability: no_changes errors are NOT retryable", () => {
  const result = classifyFailureWithRetryability("no meaningful changes detected");
  assert.equal(result.category, "no_changes");
  assert.equal(result.retryable, false);
  assert.equal(result.retryStrategy, "none");
});

test("classifyFailureWithRetryability: validation errors are NOT retryable", () => {
  const result = classifyFailureWithRetryability("Validation failed after 2 retry rounds");
  assert.equal(result.category, "validation");
  assert.equal(result.retryable, false);
  assert.equal(result.retryStrategy, "none");
});

test("classifyFailureWithRetryability: agent_crash is retryable (full)", () => {
  const result = classifyFailureWithRetryability("agent exited with code 137");
  assert.equal(result.category, "agent_crash");
  assert.equal(result.retryable, true);
  assert.equal(result.retryStrategy, "full");
});

test("classifyFailureWithRetryability: push errors are retryable (full)", () => {
  const result = classifyFailureWithRetryability("push was rejected by remote");
  assert.equal(result.category, "push");
  assert.equal(result.retryable, true);
  assert.equal(result.retryStrategy, "full");
});

test("classifyFailureWithRetryability: pr errors are retryable (full)", () => {
  const result = classifyFailureWithRetryability("create_pr failed: 502 Bad Gateway");
  assert.equal(result.category, "pr");
  assert.equal(result.retryable, true);
  assert.equal(result.retryStrategy, "full");
});

test("classifyFailureWithRetryability: unknown errors are NOT retryable", () => {
  const result = classifyFailureWithRetryability("something completely unexpected happened");
  assert.equal(result.category, "unknown");
  assert.equal(result.retryable, false);
  assert.equal(result.retryStrategy, "none");
});

// ── RunSupervisor Tests ──────────────────────────────

/** Minimal config for supervisor tests. */
function makeSupervisorConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    supervisorEnabled: true,
    supervisorRunTimeoutSeconds: 7200,
    supervisorNodeStaleSeconds: 1800,
    supervisorWatchdogIntervalSeconds: 30,
    supervisorMaxAutoRetries: 1,
    supervisorRetryCooldownSeconds: 60,
    supervisorMaxRetriesPerDay: 20,
    slackCommandName: "testbot",
    ...overrides
  } as AppConfig;
}

function makeTestRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: `test-run-${Date.now()}`,
    status: "running",
    phase: "agent",
    repoSlug: "test/repo",
    task: "test task",
    baseBranch: "main",
    branchName: "testbot/abc123",
    requestedBy: "U_TEST",
    channelId: "C12345",
    threadTs: "1234567890.123456",
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

/** Fake store with just the methods the supervisor uses. */
function fakeStore(runs: RunRecord[]) {
  const data = new Map(runs.map(r => [r.id, { ...r }]));
  return {
    getRun: async (id: string) => data.get(id),
    updateRun: async (id: string, updates: Partial<RunRecord>) => {
      const run = data.get(id);
      if (!run) throw new Error(`Run ${id} not found`);
      Object.assign(run, updates);
      return run;
    }
  };
}

/** Fake pipeline engine with onNodeEvent support. */
function fakePipelineEngine() {
  const listeners: Array<(event: NodeEvent) => void> = [];
  return {
    onNodeEvent: (cb: (event: NodeEvent) => void) => { listeners.push(cb); },
    fireTestEvent: (event: NodeEvent) => { for (const cb of listeners) cb(event); },
    _listeners: listeners
  };
}

/** Fake RunManager that records retryRun calls. */
function fakeRunManager() {
  const terminalCbs: Array<(runId: string, status: string) => void> = [];
  const retries: Array<{ runId: string; requestedBy: string }> = [];

  return {
    onRunTerminal: (cb: (runId: string, status: string) => void) => { terminalCbs.push(cb); },
    retryRun: async (runId: string, requestedBy: string) => {
      retries.push({ runId, requestedBy });
      const newId = `retry-of-${runId}`;
      return makeTestRun({ id: newId, status: "queued" });
    },
    fireTerminal: (runId: string, status: string) => {
      for (const cb of terminalCbs) cb(runId, status);
    },
    _retries: retries
  };
}

/** Fake Slack client that records postMessage calls. */
function fakeSlackClient() {
  const messages: Array<{ channel: string; text: string }> = [];
  return {
    chat: {
      postMessage: async (args: { channel: string; text: string }) => {
        messages.push({ channel: args.channel, text: args.text });
        return { ok: true };
      }
    },
    _messages: messages
  };
}

test("RunSupervisor: node events update watched run state", async () => {
  const run = makeTestRun();
  const store = fakeStore([run]);
  const engine = fakePipelineEngine();
  const rm = fakeRunManager();
  const slack = fakeSlackClient();
  const config = makeSupervisorConfig();

  const supervisor = new RunSupervisor(
    config, rm as any, engine as any, store as any, slack as any
  );
  supervisor.start();

  // Fire a node start event
  engine.fireTestEvent({
    runId: run.id, nodeId: "clone", action: "clone", type: "start"
  });

  // Give the async store.getRun() time to resolve
  await new Promise(r => setTimeout(r, 50));

  const watched = supervisor.getWatchedRun(run.id);
  assert.ok(watched, "Run should be tracked after node start event");
  assert.equal(watched?.currentNodeId, "clone");
  assert.equal(watched?.currentNodeAction, "clone");

  // Fire a node end event
  engine.fireTestEvent({
    runId: run.id, nodeId: "clone", action: "clone", type: "end",
    outcome: "success", durationMs: 5000
  });

  // lastNodeEventAt should have been updated
  const watched2 = supervisor.getWatchedRun(run.id);
  assert.ok(watched2, "Run should still be tracked");
  assert.ok(watched2!.lastNodeEventAt >= watched!.lastNodeEventAt);

  supervisor.stop();
});

test("RunSupervisor: auto-retries clone failure", async () => {
  const run = makeTestRun({ error: "failed to clone repository: connection timed out" });
  const store = fakeStore([run]);
  const engine = fakePipelineEngine();
  const rm = fakeRunManager();
  const slack = fakeSlackClient();
  const config = makeSupervisorConfig();

  const supervisor = new RunSupervisor(
    config, rm as any, engine as any, store as any, slack as any
  );
  supervisor.start();

  // Simulate terminal failure
  rm.fireTerminal(run.id, "failed");

  // Wait for async handling
  await new Promise(r => setTimeout(r, 100));

  assert.equal(rm._retries.length, 1, "Should have retried once");
  assert.equal(rm._retries[0]?.runId, run.id);
  assert.equal(rm._retries[0]?.requestedBy, "supervisor");

  // Should have posted a Slack message about auto-retry
  const retryMsg = slack._messages.find(m => m.text.includes("Auto-retrying"));
  assert.ok(retryMsg, "Should post auto-retry message to Slack");

  supervisor.stop();
});

test("RunSupervisor: does NOT retry validation failure", async () => {
  const run = makeTestRun({ error: "Validation failed after 2 retry rounds" });
  const store = fakeStore([run]);
  const engine = fakePipelineEngine();
  const rm = fakeRunManager();
  const slack = fakeSlackClient();
  const config = makeSupervisorConfig();

  const supervisor = new RunSupervisor(
    config, rm as any, engine as any, store as any, slack as any
  );
  supervisor.start();

  rm.fireTerminal(run.id, "failed");
  await new Promise(r => setTimeout(r, 100));

  assert.equal(rm._retries.length, 0, "Should NOT retry validation failures");

  const permanentMsg = slack._messages.find(m => m.text.includes("Permanent failure"));
  assert.ok(permanentMsg, "Should post permanent failure message");

  supervisor.stop();
});

test("RunSupervisor: respects retry cap", async () => {
  const run = makeTestRun({ error: "failed to clone repository: timeout" });
  const store = fakeStore([run]);
  const engine = fakePipelineEngine();
  const rm = fakeRunManager();
  const slack = fakeSlackClient();
  const config = makeSupervisorConfig({ supervisorMaxAutoRetries: 1 });

  const supervisor = new RunSupervisor(
    config, rm as any, engine as any, store as any, slack as any
  );
  supervisor.start();

  // First failure → should retry
  rm.fireTerminal(run.id, "failed");
  await new Promise(r => setTimeout(r, 100));
  assert.equal(rm._retries.length, 1, "First failure should trigger retry");

  // The retried run also fails
  const retriedRunId = `retry-of-${run.id}`;
  const retriedRun = makeTestRun({
    id: retriedRunId,
    error: "failed to clone repository: still broken"
  });
  // Add the retried run to the store
  (store as any).getRun = async (id: string) => {
    if (id === retriedRunId) return retriedRun;
    return (store as any).getRun.call(store, id);
  };
  const storeGetOrig = store.getRun.bind(store);
  store.getRun = async (id: string) => {
    if (id === retriedRunId) return retriedRun;
    return storeGetOrig(id);
  };

  rm.fireTerminal(retriedRunId, "failed");
  await new Promise(r => setTimeout(r, 100));

  // Should NOT retry a second time (cap is 1)
  assert.equal(rm._retries.length, 1, "Should not retry beyond cap");

  const givingUpMsg = slack._messages.find(m => m.text.includes("Giving up"));
  assert.ok(givingUpMsg, "Should post giving-up message");

  supervisor.stop();
});

test("RunSupervisor: daily cap enforcement", async () => {
  const store = fakeStore([]);
  const engine = fakePipelineEngine();
  const rm = fakeRunManager();
  const slack = fakeSlackClient();
  const config = makeSupervisorConfig({
    supervisorMaxAutoRetries: 100, // high per-run cap
    supervisorMaxRetriesPerDay: 2, // low daily cap
    supervisorRetryCooldownSeconds: 0 // no cooldown
  });

  const supervisor = new RunSupervisor(
    config, rm as any, engine as any, store as any, slack as any
  );
  supervisor.start();

  // Create 3 runs, each failing with clone error
  for (let i = 0; i < 3; i++) {
    const run = makeTestRun({
      id: `daily-cap-run-${String(i)}`,
      error: "failed to clone repository: timeout"
    });
    store.getRun = async (id: string) => {
      if (id === run.id) return run;
      return undefined;
    };
    rm.fireTerminal(run.id, "failed");
    await new Promise(r => setTimeout(r, 100));
  }

  // Only 2 should have been retried
  assert.equal(rm._retries.length, 2, "Should respect daily cap");

  const budgetMsg = slack._messages.find(m => m.text.includes("budget exhausted"));
  assert.ok(budgetMsg, "Should post budget exhausted message");

  supervisor.stop();
});

test("RunSupervisor: does not retry completed runs", async () => {
  const run = makeTestRun({ status: "completed" });
  const store = fakeStore([run]);
  const engine = fakePipelineEngine();
  const rm = fakeRunManager();
  const slack = fakeSlackClient();
  const config = makeSupervisorConfig();

  const supervisor = new RunSupervisor(
    config, rm as any, engine as any, store as any, slack as any
  );
  supervisor.start();

  rm.fireTerminal(run.id, "completed");
  await new Promise(r => setTimeout(r, 100));

  assert.equal(rm._retries.length, 0, "Should not retry completed runs");
  assert.equal(slack._messages.length, 0, "Should not post any messages for completed runs");

  supervisor.stop();
});

test("RunSupervisor: watchdog detects run timeout", async () => {
  const run = makeTestRun();
  const store = fakeStore([run]);
  const engine = fakePipelineEngine();
  const rm = fakeRunManager();
  const slack = fakeSlackClient();
  // Very short timeout for testing
  const config = makeSupervisorConfig({
    supervisorRunTimeoutSeconds: 1,
    supervisorWatchdogIntervalSeconds: 60 // we'll call sweep manually
  });

  const supervisor = new RunSupervisor(
    config, rm as any, engine as any, store as any, slack as any
  );
  supervisor.start();

  // Seed a watched run with an old startedAt
  engine.fireTestEvent({
    runId: run.id, nodeId: "implement", action: "implement", type: "start"
  });
  await new Promise(r => setTimeout(r, 50));

  // Force the run to look old
  const watched = supervisor.getWatchedRun(run.id);
  assert.ok(watched);
  watched!.startedAt = Date.now() - 2000; // 2 seconds ago (threshold is 1s)

  // Manually trigger watchdog sweep
  (supervisor as any).watchdogSweep();

  // Give async operations time
  await new Promise(r => setTimeout(r, 100));

  // Run should have been force-failed in the store
  const updatedRun = await store.getRun(run.id);
  assert.equal(updatedRun?.status, "failed");
  assert.ok(updatedRun?.error?.includes("timed out"));

  const timeoutMsg = slack._messages.find(m => m.text.includes("timed out"));
  assert.ok(timeoutMsg, "Should post timeout message");

  supervisor.stop();
});

test("RunSupervisor: watchdog alerts on stale node", async () => {
  const run = makeTestRun();
  const store = fakeStore([run]);
  const engine = fakePipelineEngine();
  const rm = fakeRunManager();
  const slack = fakeSlackClient();
  const config = makeSupervisorConfig({
    supervisorRunTimeoutSeconds: 9999, // high timeout
    supervisorNodeStaleSeconds: 1, // 1 second stale threshold
    supervisorWatchdogIntervalSeconds: 60
  });

  const supervisor = new RunSupervisor(
    config, rm as any, engine as any, store as any, slack as any
  );
  supervisor.start();

  engine.fireTestEvent({
    runId: run.id, nodeId: "implement", action: "implement", type: "start"
  });
  await new Promise(r => setTimeout(r, 50));

  // Make the last event old
  const watched = supervisor.getWatchedRun(run.id);
  assert.ok(watched);
  watched!.lastNodeEventAt = Date.now() - 2000; // 2 seconds ago

  (supervisor as any).watchdogSweep();
  await new Promise(r => setTimeout(r, 100));

  // Should alert but NOT kill the run
  const staleMsg = slack._messages.find(m => m.text.includes("has been running for"));
  assert.ok(staleMsg, "Should post stale node alert");

  // Run should still be tracked (not removed)
  assert.ok(supervisor.getWatchedRun(run.id), "Run should still be watched");

  supervisor.stop();
});

test("RunSupervisor: stop() clears state", () => {
  const config = makeSupervisorConfig();
  const engine = fakePipelineEngine();
  const rm = fakeRunManager();
  const slack = fakeSlackClient();
  const store = fakeStore([]);

  const supervisor = new RunSupervisor(
    config, rm as any, engine as any, store as any, slack as any
  );
  supervisor.start();
  supervisor.stop();

  // Should not throw and timers should be cleared
  assert.equal(supervisor.getWatchedRun("nonexistent"), undefined);
});
