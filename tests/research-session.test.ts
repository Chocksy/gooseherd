/**
 * Research Session tests — champion tracking, iteration loop, seed configs.
 * Uses a mock EvalRunner to avoid needing a real pipeline/database.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  ResearchSession,
  type IterationResult,
} from "../src/eval/research-session.js";
import type { EvalScenario, EvalResult } from "../src/eval/types.js";
import type { EvalRunner } from "../src/eval/eval-runner.js";

// ── Helpers ──

function makeScenario(name: string): EvalScenario {
  return {
    name,
    description: `Test scenario: ${name}`,
    repo: "test/repo",
    baseBranch: "main",
    task: "Do the thing",
    judges: [{ type: "status", expect: "completed" }],
    tags: ["test"],
  };
}

function makeResult(scenario: string, pass: boolean, score: number, cost = 0.10): EvalResult {
  return {
    scenarioName: scenario,
    runId: `run-${scenario}-${String(Math.random()).slice(2, 8)}`,
    overallPass: pass,
    overallScore: score,
    judgeResults: [{ judge: "status", pass, score, reason: pass ? "ok" : "fail" }],
    durationMs: 120_000,
    costUsd: cost,
    tags: ["test"],
  };
}

/** Creates a mock EvalRunner that returns predetermined results per configLabel. */
function createMockRunner(
  resultMap: Record<string, EvalResult[]>
): EvalRunner {
  return {
    runAll: async (scenarios: EvalScenario[], configLabel?: string) => {
      const key = configLabel ?? "default";
      return resultMap[key] ?? scenarios.map((s) => makeResult(s.name, false, 0));
    },
    runScenario: async () => makeResult("mock", false, 0),
  } as unknown as EvalRunner;
}

// ── Tests ──

describe("ResearchSession", { concurrency: 1 }, () => {

  test("runs seed configs and tracks champion", async () => {
    const scenarios = [makeScenario("test-a"), makeScenario("test-b")];

    const mockRunner = createMockRunner({
      "config-1": [makeResult("test-a", true, 80), makeResult("test-b", true, 90)],
      "config-2": [makeResult("test-a", true, 95), makeResult("test-b", true, 100)],
    });

    const session = new ResearchSession(mockRunner);
    const history = await session.run({
      maxIterations: 2,
      scenarios,
      seedConfigs: [
        { label: "config-1", rationale: "baseline", configOverrides: { DEFAULT_LLM_MODEL: "model-a" } },
        { label: "config-2", rationale: "improved", configOverrides: { DEFAULT_LLM_MODEL: "model-b" } },
      ],
    });

    assert.equal(history.length, 2);

    // First iteration becomes champion by default
    assert.equal(history[0]!.isNewChampion, true);
    assert.equal(history[0]!.champion.label, "config-1");

    // Second iteration has higher scores → new champion
    assert.equal(history[1]!.isNewChampion, true);
    assert.equal(history[1]!.champion.label, "config-2");

    const champion = session.getChampion();
    assert.ok(champion);
    assert.equal(champion.label, "config-2");
    assert.equal(champion.passRate, 100);
    assert.equal(champion.avgScore, 98); // (95+100)/2 rounded
  });

  test("champion does not change if candidate is worse", async () => {
    const scenarios = [makeScenario("test-a")];

    const mockRunner = createMockRunner({
      "good": [makeResult("test-a", true, 90)],
      "bad": [makeResult("test-a", false, 30)],
    });

    const session = new ResearchSession(mockRunner);
    const history = await session.run({
      maxIterations: 2,
      scenarios,
      seedConfigs: [
        { label: "good", rationale: "good config", configOverrides: {} },
        { label: "bad", rationale: "bad config", configOverrides: {} },
      ],
    });

    assert.equal(history[0]!.isNewChampion, true);
    assert.equal(history[1]!.isNewChampion, false);
    assert.equal(session.getChampion()!.label, "good");
  });

  test("champion breaks ties by score then cost", async () => {
    const scenarios = [makeScenario("test-a")];

    const mockRunner = createMockRunner({
      "cheap": [makeResult("test-a", true, 80, 0.05)],
      "expensive": [makeResult("test-a", true, 80, 0.50)],
    });

    const session = new ResearchSession(mockRunner);
    await session.run({
      maxIterations: 2,
      scenarios,
      seedConfigs: [
        { label: "expensive", rationale: "first", configOverrides: {} },
        { label: "cheap", rationale: "same score cheaper", configOverrides: {} },
      ],
    });

    // Same pass rate and score, but cheaper → new champion
    assert.equal(session.getChampion()!.label, "cheap");
  });

  test("onIteration callback fires each iteration", async () => {
    const scenarios = [makeScenario("test-a")];
    const mockRunner = createMockRunner({
      "c1": [makeResult("test-a", true, 90)],
      "c2": [makeResult("test-a", true, 95)],
    });

    const callbacks: IterationResult[] = [];
    const session = new ResearchSession(mockRunner);
    await session.run({
      maxIterations: 2,
      scenarios,
      seedConfigs: [
        { label: "c1", rationale: "first", configOverrides: {} },
        { label: "c2", rationale: "second", configOverrides: {} },
      ],
      onIteration: (result) => callbacks.push(result),
    });

    assert.equal(callbacks.length, 2);
    assert.equal(callbacks[0]!.iteration, 1);
    assert.equal(callbacks[1]!.iteration, 2);
  });

  test("stops when no more seed configs and no LLM config", async () => {
    const scenarios = [makeScenario("test-a")];
    const mockRunner = createMockRunner({
      "only": [makeResult("test-a", true, 90)],
    });

    const session = new ResearchSession(mockRunner);
    const history = await session.run({
      maxIterations: 10, // wants 10 but only 1 seed
      scenarios,
      seedConfigs: [
        { label: "only", rationale: "the only one", configOverrides: {} },
      ],
      // No llmConfig → can't propose after seeds exhausted
    });

    assert.equal(history.length, 1);
  });

  test("respects AbortSignal", async () => {
    const scenarios = [makeScenario("test-a")];
    const mockRunner = createMockRunner({
      "c1": [makeResult("test-a", true, 90)],
      "c2": [makeResult("test-a", true, 95)],
      "c3": [makeResult("test-a", true, 99)],
    });

    const controller = new AbortController();
    const session = new ResearchSession(mockRunner);

    // Abort after first iteration
    const history = await session.run({
      maxIterations: 3,
      scenarios,
      seedConfigs: [
        { label: "c1", rationale: "first", configOverrides: {} },
        { label: "c2", rationale: "second", configOverrides: {} },
        { label: "c3", rationale: "third", configOverrides: {} },
      ],
      signal: controller.signal,
      onIteration: (result) => {
        if (result.iteration === 1) controller.abort();
      },
    });

    // Should have run iteration 1, then aborted before starting 2
    assert.equal(history.length, 1);
  });

  test("getHistory returns copy of history", async () => {
    const scenarios = [makeScenario("test-a")];
    const mockRunner = createMockRunner({
      "c1": [makeResult("test-a", true, 90)],
    });

    const session = new ResearchSession(mockRunner);
    await session.run({
      maxIterations: 1,
      scenarios,
      seedConfigs: [{ label: "c1", rationale: "test", configOverrides: {} }],
    });

    const h1 = session.getHistory();
    const h2 = session.getHistory();
    assert.deepEqual(h1, h2);
    assert.notEqual(h1, h2); // different array instances
  });

  test("run() returns copy of history, not internal reference", async () => {
    const scenarios = [makeScenario("test-a")];
    const mockRunner = createMockRunner({
      "c1": [makeResult("test-a", true, 90)],
    });

    const session = new ResearchSession(mockRunner);
    const history = await session.run({
      maxIterations: 1,
      scenarios,
      seedConfigs: [{ label: "c1", rationale: "test", configOverrides: {} }],
    });

    // Mutating returned array should not affect internal state
    history.push(history[0]!);
    assert.equal(session.getHistory().length, 1);
  });

  test("throws on NaN maxIterations", async () => {
    const scenarios = [makeScenario("test-a")];
    const mockRunner = createMockRunner({});
    const session = new ResearchSession(mockRunner);

    await assert.rejects(
      () => session.run({ maxIterations: NaN, scenarios }),
      /Invalid maxIterations/
    );
  });

  test("empty results do not crown a champion", async () => {
    const scenarios = [makeScenario("test-a")];

    // Runner returns empty results for "empty" config
    const mockRunner = createMockRunner({
      "empty": [],
      "real": [makeResult("test-a", true, 80)],
    });

    const session = new ResearchSession(mockRunner);
    const history = await session.run({
      maxIterations: 2,
      scenarios,
      seedConfigs: [
        { label: "empty", rationale: "no results", configOverrides: {} },
        { label: "real", rationale: "has results", configOverrides: {} },
      ],
    });

    assert.equal(history.length, 2);
    // First iteration: empty results → no champion crowned
    assert.equal(history[0]!.isNewChampion, false);
    // Second iteration: real results → becomes champion
    assert.equal(history[1]!.isNewChampion, true);
    assert.equal(session.getChampion()!.label, "real");
  });

  test("run() resets state between calls", async () => {
    const scenarios = [makeScenario("test-a")];
    const mockRunner = createMockRunner({
      "first": [makeResult("test-a", true, 90)],
      "second": [makeResult("test-a", true, 50)],
    });

    const session = new ResearchSession(mockRunner);

    // First run
    await session.run({
      maxIterations: 1,
      scenarios,
      seedConfigs: [{ label: "first", rationale: "run1", configOverrides: {} }],
    });
    assert.equal(session.getChampion()!.label, "first");

    // Second run — state should be reset, not accumulated
    const history2 = await session.run({
      maxIterations: 1,
      scenarios,
      seedConfigs: [{ label: "second", rationale: "run2", configOverrides: {} }],
    });
    assert.equal(history2.length, 1);
    assert.equal(session.getChampion()!.label, "second");
    assert.equal(session.getHistory().length, 1);
  });

  test("LLM proposal failure skips iteration instead of crashing", async () => {
    const scenarios = [makeScenario("test-a")];

    // Runner that works fine for seeds
    const mockRunner = createMockRunner({
      "seed": [makeResult("test-a", true, 90)],
    });

    // Patch getExperiment to throw on iteration 2 (simulating LLM failure)
    const session = new ResearchSession(mockRunner);
    const origGetExperiment = (session as any).getExperiment.bind(session);
    let callCount = 0;
    (session as any).getExperiment = async (iteration: number, config: any) => {
      callCount++;
      if (callCount === 2) throw new Error("LLM network timeout");
      // iteration 3 has no seed and no llmConfig → returns undefined → stops
      return origGetExperiment(iteration, config);
    };

    const history = await session.run({
      maxIterations: 3,
      scenarios,
      seedConfigs: [{ label: "seed", rationale: "baseline", configOverrides: {} }],
      // No llmConfig — iteration 3 will return undefined after the skipped iteration 2
    });

    // Iteration 1 ran (seed), iteration 2 was skipped (error), iteration 3 stopped (no experiment)
    assert.equal(history.length, 1);
    assert.equal(history[0]!.experiment.label, "seed");
  });

  test("experiment merges configOverrides with scenario overrides", async () => {
    const scenarios: EvalScenario[] = [{
      name: "override-test",
      description: "test override merging",
      repo: "test/repo",
      baseBranch: "main",
      task: "Do it",
      judges: [{ type: "status", expect: "completed" }],
      configOverrides: { EXISTING_VAR: "keep-me", DEFAULT_LLM_MODEL: "original" },
    }];

    let capturedScenarios: EvalScenario[] = [];
    const mockRunner = {
      runAll: async (augmented: EvalScenario[], _label?: string) => {
        capturedScenarios = augmented;
        return [makeResult("override-test", true, 90)];
      },
      runScenario: async () => makeResult("mock", false, 0),
    } as unknown as EvalRunner;

    const session = new ResearchSession(mockRunner);
    await session.run({
      maxIterations: 1,
      scenarios,
      seedConfigs: [{
        label: "merged",
        rationale: "test",
        configOverrides: { DEFAULT_LLM_MODEL: "override-model", NEW_VAR: "new" },
      }],
    });

    assert.equal(capturedScenarios.length, 1);
    const merged = capturedScenarios[0]!.configOverrides!;
    assert.equal(merged.EXISTING_VAR, "keep-me");
    assert.equal(merged.DEFAULT_LLM_MODEL, "override-model"); // experiment wins
    assert.equal(merged.NEW_VAR, "new");
  });
});
