/**
 * Eval judges unit tests — verifies each judge type with synthetic data.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { runJudge, runAllJudges } from "../src/eval/judges.js";
import type { RunRecord } from "../src/types.js";
import type { JudgeContext } from "../src/eval/judges.js";

function makeRun(overrides?: Partial<RunRecord>): RunRecord {
  return {
    id: "test-run-id",
    status: "completed",
    repoSlug: "org/repo",
    task: "test task",
    baseBranch: "main",
    branchName: "gooseherd/test-1",
    requestedBy: "eval",
    channelId: "eval",
    threadTs: "eval-test-123",
    createdAt: new Date().toISOString(),
    changedFiles: ["app/views/home.html.erb", "app/assets/stylesheets/main.css"],
    prUrl: "https://github.com/org/repo/pull/42",
    ...overrides,
  };
}

function makeCtx(overrides?: Partial<JudgeContext>): JudgeContext {
  return {
    run: makeRun(),
    checkpointData: {},
    diff: "",
    workRoot: "/tmp/test-work",
    ...overrides,
  };
}

describe("Eval Judges", () => {

  // ── status judge ──

  test("status judge passes when status matches", async () => {
    const verdict = await runJudge({ type: "status", expect: "completed" }, makeCtx());
    assert.equal(verdict.pass, true);
    assert.equal(verdict.score, 100);
  });

  test("status judge fails when status mismatches", async () => {
    const ctx = makeCtx({ run: makeRun({ status: "failed" }) });
    const verdict = await runJudge({ type: "status", expect: "completed" }, ctx);
    assert.equal(verdict.pass, false);
    assert.equal(verdict.score, 0);
    assert.ok(verdict.reason.includes("failed"));
  });

  // ── files_changed judge ──

  test("files_changed judge passes when expected file is changed", async () => {
    const verdict = await runJudge(
      { type: "files_changed", expect_any: ["app/views/home.html.erb"] },
      makeCtx()
    );
    assert.equal(verdict.pass, true);
    assert.equal(verdict.score, 100);
  });

  test("files_changed judge fails when no expected files changed", async () => {
    const verdict = await runJudge(
      { type: "files_changed", expect_any: ["nonexistent.rb"] },
      makeCtx()
    );
    assert.equal(verdict.pass, false);
    assert.equal(verdict.score, 0);
  });

  test("files_changed judge handles empty changedFiles", async () => {
    const ctx = makeCtx({ run: makeRun({ changedFiles: undefined }) });
    const verdict = await runJudge(
      { type: "files_changed", expect_any: ["anything.rb"] },
      ctx
    );
    assert.equal(verdict.pass, false);
  });

  // ── diff_contains judge ──

  test("diff_contains passes when all patterns found", async () => {
    const ctx = makeCtx({ diff: '+<h1>Welcome to Epic Pixels</h1>\n-<h1>Epic Pixels</h1>' });
    const verdict = await runJudge(
      { type: "diff_contains", patterns: ["Welcome to Epic Pixels"] },
      ctx
    );
    assert.equal(verdict.pass, true);
    assert.equal(verdict.score, 100);
  });

  test("diff_contains fails when pattern missing", async () => {
    const ctx = makeCtx({ diff: '+<h1>Hello World</h1>' });
    const verdict = await runJudge(
      { type: "diff_contains", patterns: ["Welcome to Epic Pixels", "Hello World"] },
      ctx
    );
    assert.equal(verdict.pass, false);
    assert.equal(verdict.score, 50);
  });

  test("diff_contains scores proportionally", async () => {
    const ctx = makeCtx({ diff: 'pattern-a pattern-b' });
    const verdict = await runJudge(
      { type: "diff_contains", patterns: ["pattern-a", "pattern-b", "pattern-c"] },
      ctx
    );
    assert.equal(verdict.pass, false);
    assert.equal(verdict.score, 67); // 2/3
  });

  // ── pr_created judge ──

  test("pr_created passes when prUrl exists", async () => {
    const verdict = await runJudge({ type: "pr_created" }, makeCtx());
    assert.equal(verdict.pass, true);
  });

  test("pr_created fails when no prUrl", async () => {
    const ctx = makeCtx({ run: makeRun({ prUrl: undefined }) });
    const verdict = await runJudge({ type: "pr_created" }, ctx);
    assert.equal(verdict.pass, false);
  });

  // ── gate_verdict judge ──

  test("gate_verdict passes when gate verdict matches", async () => {
    const ctx = makeCtx({
      checkpointData: {
        gateReport: [
          { gate: "scope_judge", verdict: "pass" },
          { gate: "diff_gate", verdict: "fail" },
        ],
      },
    });
    const verdict = await runJudge(
      { type: "gate_verdict", gate: "scope_judge", expect: "pass" },
      ctx
    );
    assert.equal(verdict.pass, true);
  });

  test("gate_verdict fails when gate verdict mismatches", async () => {
    const ctx = makeCtx({
      checkpointData: {
        gateReport: [{ gate: "scope_judge", verdict: "fail" }],
      },
    });
    const verdict = await runJudge(
      { type: "gate_verdict", gate: "scope_judge", expect: "pass" },
      ctx
    );
    assert.equal(verdict.pass, false);
  });

  test("gate_verdict fails when gate not found", async () => {
    const ctx = makeCtx({ checkpointData: { gateReport: [] } });
    const verdict = await runJudge(
      { type: "gate_verdict", gate: "scope_judge", expect: "pass" },
      ctx
    );
    assert.equal(verdict.pass, false);
    assert.ok(verdict.reason.includes("not found"));
  });

  test("gate_verdict fails when no gateReport", async () => {
    const verdict = await runJudge(
      { type: "gate_verdict", gate: "scope_judge", expect: "pass" },
      makeCtx()
    );
    assert.equal(verdict.pass, false);
  });

  // ── browser_verdict judge ──

  test("browser_verdict passes when passed matches", async () => {
    const ctx = makeCtx({
      checkpointData: {
        browserVerifyResult: { passed: true, confidence: 95, reasoning: "Looks good" },
      },
    });
    const verdict = await runJudge(
      { type: "browser_verdict", expect: "pass" },
      ctx
    );
    assert.equal(verdict.pass, true);
  });

  test("browser_verdict fails when passed mismatches", async () => {
    const ctx = makeCtx({
      checkpointData: {
        browserVerifyResult: { passed: false, confidence: 30, reasoning: "Broken layout" },
      },
    });
    const verdict = await runJudge(
      { type: "browser_verdict", expect: "pass" },
      ctx
    );
    assert.equal(verdict.pass, false);
    assert.ok(verdict.reason.includes("Broken layout"));
  });

  test("browser_verdict fails when no result", async () => {
    const verdict = await runJudge(
      { type: "browser_verdict", expect: "pass" },
      makeCtx()
    );
    assert.equal(verdict.pass, false);
  });

  // ── runAllJudges ──

  test("runAllJudges runs all judges and returns verdicts", async () => {
    const ctx = makeCtx({ diff: "Welcome to Epic Pixels" });
    const verdicts = await runAllJudges(
      [
        { type: "status", expect: "completed" },
        { type: "diff_contains", patterns: ["Welcome to Epic Pixels"] },
        { type: "pr_created" },
      ],
      ctx
    );
    assert.equal(verdicts.length, 3);
    assert.equal(verdicts[0]!.pass, true);
    assert.equal(verdicts[1]!.pass, true);
    assert.equal(verdicts[2]!.pass, true);
  });

  test("runAllJudges handles mixed pass/fail", async () => {
    const ctx = makeCtx({ run: makeRun({ status: "failed", prUrl: undefined }) });
    const verdicts = await runAllJudges(
      [
        { type: "status", expect: "completed" },
        { type: "pr_created" },
      ],
      ctx
    );
    assert.equal(verdicts.length, 2);
    assert.equal(verdicts[0]!.pass, false);
    assert.equal(verdicts[1]!.pass, false);
  });
});
