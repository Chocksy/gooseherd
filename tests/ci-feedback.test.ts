import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateConclusions,
  excludeCheckRuns,
  filterCheckRuns,
  mapAnnotations,
  truncateLog,
  buildCIFixPrompt,
  shouldAbortFixLoop
} from "../src/pipeline/ci/ci-monitor.js";
import type { CICheckRun, CICheckAnnotation } from "../src/github.js";

// ── aggregateConclusions ──

test("aggregateConclusions: all success → success", () => {
  const runs: CICheckRun[] = [
    { id: 1, name: "test", status: "completed", conclusion: "success" },
    { id: 2, name: "lint", status: "completed", conclusion: "success" }
  ];
  assert.equal(aggregateConclusions(runs), "success");
});

test("aggregateConclusions: one failure → failure", () => {
  const runs: CICheckRun[] = [
    { id: 1, name: "test", status: "completed", conclusion: "success" },
    { id: 2, name: "lint", status: "completed", conclusion: "failure" }
  ];
  assert.equal(aggregateConclusions(runs), "failure");
});

test("aggregateConclusions: timed_out → failure", () => {
  const runs: CICheckRun[] = [
    { id: 1, name: "test", status: "completed", conclusion: "timed_out" }
  ];
  assert.equal(aggregateConclusions(runs), "failure");
});

test("aggregateConclusions: action_required → failure", () => {
  const runs: CICheckRun[] = [
    { id: 1, name: "test", status: "completed", conclusion: "action_required" }
  ];
  assert.equal(aggregateConclusions(runs), "failure");
});

test("aggregateConclusions: empty → no_ci", () => {
  assert.equal(aggregateConclusions([]), "no_ci");
});

test("aggregateConclusions: in_progress → pending", () => {
  const runs: CICheckRun[] = [
    { id: 1, name: "test", status: "in_progress", conclusion: null },
    { id: 2, name: "lint", status: "completed", conclusion: "success" }
  ];
  assert.equal(aggregateConclusions(runs), "pending");
});

test("aggregateConclusions: all cancelled → cancelled", () => {
  const runs: CICheckRun[] = [
    { id: 1, name: "test", status: "completed", conclusion: "cancelled" },
    { id: 2, name: "lint", status: "completed", conclusion: "cancelled" }
  ];
  assert.equal(aggregateConclusions(runs), "cancelled");
});

test("aggregateConclusions: mixed success + cancelled → success", () => {
  const runs: CICheckRun[] = [
    { id: 1, name: "test", status: "completed", conclusion: "success" },
    { id: 2, name: "deploy", status: "completed", conclusion: "cancelled" }
  ];
  assert.equal(aggregateConclusions(runs), "success");
});

test("aggregateConclusions: neutral + skipped → success", () => {
  const runs: CICheckRun[] = [
    { id: 1, name: "test", status: "completed", conclusion: "neutral" },
    { id: 2, name: "lint", status: "completed", conclusion: "skipped" }
  ];
  assert.equal(aggregateConclusions(runs), "success");
});

test("aggregateConclusions: completed with null conclusion → failure (fail-secure)", () => {
  const runs: CICheckRun[] = [
    { id: 1, name: "test", status: "completed", conclusion: null },
    { id: 2, name: "lint", status: "completed", conclusion: "success" }
  ];
  assert.equal(aggregateConclusions(runs), "failure");
});

// ── filterCheckRuns ──

test("filterCheckRuns: empty filter → all runs", () => {
  const runs: CICheckRun[] = [
    { id: 1, name: "test", status: "completed", conclusion: "success" },
    { id: 2, name: "lint", status: "completed", conclusion: "success" }
  ];
  assert.equal(filterCheckRuns(runs, []).length, 2);
});

test("filterCheckRuns: filters by name (case-insensitive)", () => {
  const runs: CICheckRun[] = [
    { id: 1, name: "RSpec Tests", status: "completed", conclusion: "success" },
    { id: 2, name: "Rubocop Lint", status: "completed", conclusion: "success" },
    { id: 3, name: "Deploy Preview", status: "completed", conclusion: "success" }
  ];
  const filtered = filterCheckRuns(runs, ["rspec", "rubocop"]);
  assert.equal(filtered.length, 2);
  assert.ok(filtered.some(r => r.name === "RSpec Tests"));
  assert.ok(filtered.some(r => r.name === "Rubocop Lint"));
});

test("excludeCheckRuns: ignores matching runs by name (case-insensitive contains)", () => {
  const runs: CICheckRun[] = [
    { id: 1, name: "build-and-test", status: "completed", conclusion: "success" },
    { id: 2, name: "PR Checker", status: "completed", conclusion: "failure" },
    { id: 3, name: "commitlint", status: "completed", conclusion: "success" }
  ];
  const filtered = excludeCheckRuns(runs, ["pr checker"]);
  assert.deepEqual(filtered.map(r => r.name), ["build-and-test", "commitlint"]);
});

// ── mapAnnotations ──

test("mapAnnotations: converts GitHub format to CIAnnotation", () => {
  const ghAnnotations: CICheckAnnotation[] = [
    { path: "src/app.ts", start_line: 42, message: "Expected number, got string", annotation_level: "failure" }
  ];
  const mapped = mapAnnotations(ghAnnotations);
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0]!.file, "src/app.ts");
  assert.equal(mapped[0]!.line, 42);
  assert.equal(mapped[0]!.message, "Expected number, got string");
  assert.equal(mapped[0]!.level, "failure");
});

// ── truncateLog ──

test("truncateLog: short log unchanged", () => {
  assert.equal(truncateLog("short log"), "short log");
});

test("truncateLog: long log truncated to last N chars", () => {
  const longLog = "x".repeat(5000);
  const result = truncateLog(longLog, 3000);
  assert.ok(result.length <= 3020); // 3000 + truncation prefix
  assert.ok(result.startsWith("...(truncated)"));
  assert.ok(result.endsWith("x"));
});

// ── buildCIFixPrompt ──

test("buildCIFixPrompt: includes annotations", () => {
  const prompt = buildCIFixPrompt(
    [{ file: "src/app.ts", line: 42, message: "type error", level: "failure" }],
    "",
    ["src/app.ts"]
  );
  assert.ok(prompt.includes("src/app.ts:42"));
  assert.ok(prompt.includes("type error"));
  assert.ok(prompt.includes("Check Run Annotations"));
});

test("buildCIFixPrompt: includes log tail", () => {
  const prompt = buildCIFixPrompt([], "FAILED: 3 tests failed", ["src/app.ts"]);
  assert.ok(prompt.includes("FAILED: 3 tests failed"));
  assert.ok(prompt.includes("Failed Job Log"));
});

test("buildCIFixPrompt: includes changed files", () => {
  const prompt = buildCIFixPrompt([], "", ["src/app.ts", "src/lib.ts"]);
  assert.ok(prompt.includes("src/app.ts"));
  assert.ok(prompt.includes("src/lib.ts"));
  assert.ok(prompt.includes("Your Changed Files"));
});

test("buildCIFixPrompt: filters internal-generated files from changed files", () => {
  const prompt = buildCIFixPrompt([], "", ["AGENTS.md", "src/app.ts"]);
  assert.ok(prompt.includes("src/app.ts"));
  assert.ok(!prompt.includes("AGENTS.md"));
});

test("buildCIFixPrompt: includes fix instructions", () => {
  const prompt = buildCIFixPrompt([], "", []);
  assert.ok(prompt.includes("Fix only the CI failures"));
  assert.ok(prompt.includes("Do not refactor unrelated code"));
  assert.match(prompt, /existing PR branch/i);
  assert.match(prompt, /do not create .* new branch/i);
  assert.match(prompt, /do not create .* new PR/i);
});

test("buildCIFixPrompt: includes current run id when provided", () => {
  const prompt = buildCIFixPrompt([], "", [], [], "445ad8a6-33c3-45c6-badf-429ec98c4a51");
  assert.match(prompt, /Current Gooseherd run id: `445ad8a6-33c3-45c6-badf-429ec98c4a51`/);
});

// ── shouldAbortFixLoop ──

test("shouldAbortFixLoop: more failures → abort", () => {
  assert.ok(shouldAbortFixLoop(2, 5));
});

test("shouldAbortFixLoop: fewer failures → continue", () => {
  assert.ok(!shouldAbortFixLoop(5, 2));
});

test("shouldAbortFixLoop: same failures → continue", () => {
  assert.ok(!shouldAbortFixLoop(3, 3));
});

test("shouldAbortFixLoop: first attempt (prevCount=0) → never abort", () => {
  assert.ok(!shouldAbortFixLoop(0, 5));
});
