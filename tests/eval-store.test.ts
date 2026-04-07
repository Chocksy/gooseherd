/**
 * Eval Store tests — DB CRUD for eval results.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { EvalStore } from "../src/eval/eval-store.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import type { EvalResult } from "../src/eval/types.js";

function makeResult(overrides?: Partial<EvalResult>): EvalResult {
  return {
    scenarioName: "homepage-title",
    runId: randomUUID(),
    configLabel: "sonnet-test",
    pipeline: "ui-change",
    model: "anthropic/claude-sonnet-4-6",
    overallPass: true,
    overallScore: 95,
    judgeResults: [
      { judge: "status", pass: true, score: 100, reason: "completed" },
      { judge: "diff_contains", pass: true, score: 90, reason: "Pattern found" },
    ],
    durationMs: 240_000,
    costUsd: 0.18,
    tags: ["ui", "simple"],
    ...overrides,
  };
}

async function makeStore(): Promise<{ store: EvalStore; testDb: TestDb }> {
  const testDb = await createTestDb();
  const store = new EvalStore(testDb.db);
  return { store, testDb };
}

describe("EvalStore", { concurrency: 1 }, () => {

  test("recordResult() stores a result", async (t) => {
    const { store, testDb } = await makeStore();
    t.after(async () => { await testDb.cleanup(); });

    await store.recordResult(makeResult());
    const results = await store.getRecentResults();
    assert.equal(results.length, 1);
    assert.equal(results[0]!.scenarioName, "homepage-title");
    assert.equal(results[0]!.overallPass, true);
    assert.equal(results[0]!.overallScore, 95);
  });

  test("getScenarioHistory() returns results for a scenario", async (t) => {
    const { store, testDb } = await makeStore();
    t.after(async () => { await testDb.cleanup(); });

    await store.recordResult(makeResult({ scenarioName: "homepage-title", overallScore: 90 }));
    await store.recordResult(makeResult({ scenarioName: "homepage-title", overallScore: 95 }));
    await store.recordResult(makeResult({ scenarioName: "add-footer-link", overallScore: 80 }));

    const history = await store.getScenarioHistory("homepage-title");
    assert.equal(history.length, 2);
  });

  test("getRecentResults() returns newest first", async (t) => {
    const { store, testDb } = await makeStore();
    t.after(async () => { await testDb.cleanup(); });

    await store.recordResult(makeResult({ scenarioName: "first" }));
    await store.recordResult(makeResult({ scenarioName: "second" }));

    const results = await store.getRecentResults(10);
    assert.equal(results.length, 2);
    assert.equal(results[0]!.scenarioName, "second");
    assert.equal(results[1]!.scenarioName, "first");
  });

  test("getRecentResults() respects limit", async (t) => {
    const { store, testDb } = await makeStore();
    t.after(async () => { await testDb.cleanup(); });

    await store.recordResult(makeResult({ scenarioName: "a" }));
    await store.recordResult(makeResult({ scenarioName: "b" }));
    await store.recordResult(makeResult({ scenarioName: "c" }));

    const results = await store.getRecentResults(2);
    assert.equal(results.length, 2);
  });

  test("getComparison() groups by model/configLabel", async (t) => {
    const { store, testDb } = await makeStore();
    t.after(async () => { await testDb.cleanup(); });

    await store.recordResult(makeResult({ configLabel: "sonnet", model: "claude-sonnet", overallPass: true, overallScore: 90 }));
    await store.recordResult(makeResult({ configLabel: "sonnet", model: "claude-sonnet", overallPass: true, overallScore: 80 }));
    await store.recordResult(makeResult({ configLabel: "gpt", model: "gpt-4.1", overallPass: false, overallScore: 50 }));

    const comparison = await store.getComparison("homepage-title");
    assert.equal(comparison.length, 2);

    const sonnet = comparison.find((c) => c.configLabel === "sonnet");
    assert.ok(sonnet);
    assert.equal(sonnet.totalRuns, 2);
    assert.equal(sonnet.passRate, 100);
    assert.equal(sonnet.avgScore, 85);

    const gpt = comparison.find((c) => c.configLabel === "gpt");
    assert.ok(gpt);
    assert.equal(gpt.totalRuns, 1);
    assert.equal(gpt.passRate, 0);
  });

  test("stores and retrieves judge results correctly", async (t) => {
    const { store, testDb } = await makeStore();
    t.after(async () => { await testDb.cleanup(); });

    const judges = [
      { judge: "status", pass: true, score: 100, reason: "completed" },
      { judge: "diff_contains", pass: false, score: 50, reason: "missing pattern" },
    ];

    await store.recordResult(makeResult({ judgeResults: judges, overallPass: false, overallScore: 75 }));
    const results = await store.getRecentResults();
    assert.equal(results[0]!.judgeResults.length, 2);
    assert.equal(results[0]!.judgeResults[0]!.judge, "status");
    assert.equal(results[0]!.judgeResults[1]!.pass, false);
  });

  test("stores and retrieves tags", async (t) => {
    const { store, testDb } = await makeStore();
    t.after(async () => { await testDb.cleanup(); });

    await store.recordResult(makeResult({ tags: ["ui", "simple", "rails"] }));
    const results = await store.getRecentResults();
    assert.deepEqual(results[0]!.tags, ["ui", "simple", "rails"]);
  });

  test("handles null optional fields", async (t) => {
    const { store, testDb } = await makeStore();
    t.after(async () => { await testDb.cleanup(); });

    await store.recordResult(makeResult({
      configLabel: undefined,
      pipeline: undefined,
      model: undefined,
      tags: undefined,
    }));
    const results = await store.getRecentResults();
    assert.equal(results[0]!.configLabel, undefined);
    assert.equal(results[0]!.pipeline, undefined);
    assert.equal(results[0]!.model, undefined);
    assert.equal(results[0]!.tags, undefined);
  });
});
