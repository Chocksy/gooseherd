/**
 * Eval judges unit tests — verifies each judge type with synthetic data.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { runJudge, runAllJudges, extractJsonObject, readCheckpoint, outcomeToVerdict, readDiff } from "../src/eval/judges.js";
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

  // ── expected_outcome judge ──

  test("expected_outcome passes when run error matches context_conflict", async () => {
    const ctx = makeCtx({
      run: makeRun({ status: "failed", error: "Agent reported context conflict: task assumes a feature that does not exist" }),
    });
    const verdict = await runJudge(
      { type: "expected_outcome", expect: ["no_changes", "context_conflict"] },
      ctx
    );
    assert.equal(verdict.pass, true);
    assert.equal(verdict.score, 100);
    assert.ok(verdict.reason.includes("context_conflict"));
  });

  test("expected_outcome passes when run error matches no_changes", async () => {
    const ctx = makeCtx({
      run: makeRun({ status: "failed", error: "Agent exited 0 but made no meaningful changes. Signals: none" }),
    });
    const verdict = await runJudge(
      { type: "expected_outcome", expect: ["no_changes", "context_conflict"] },
      ctx
    );
    assert.equal(verdict.pass, true);
    assert.equal(verdict.score, 100);
    assert.ok(verdict.reason.includes("no_changes"));
  });

  test("expected_outcome passes on completed run with empty diff when allow_empty_diff", async () => {
    const ctx = makeCtx({ run: makeRun({ status: "completed", error: undefined }), diff: "   \n  " });
    const verdict = await runJudge(
      { type: "expected_outcome", expect: ["no_changes", "context_conflict"], allow_empty_diff: true },
      ctx
    );
    assert.equal(verdict.pass, true);
    assert.ok(verdict.reason.includes("empty diff"));
  });

  test("expected_outcome fails when the agent invented work (non-empty diff, no matching error)", async () => {
    const ctx = makeCtx({
      run: makeRun({ status: "completed", error: undefined }),
      diff: "+<button class='dark-mode-toggle'>Toggle</button>",
    });
    const verdict = await runJudge(
      { type: "expected_outcome", expect: ["no_changes", "context_conflict"], allow_empty_diff: true },
      ctx
    );
    assert.equal(verdict.pass, false);
    assert.equal(verdict.score, 0);
  });

  test("expected_outcome does not pass on empty diff when allow_empty_diff is unset", async () => {
    const ctx = makeCtx({ run: makeRun({ status: "completed", error: undefined }), diff: "" });
    const verdict = await runJudge(
      { type: "expected_outcome", expect: ["no_changes", "context_conflict"] },
      ctx
    );
    assert.equal(verdict.pass, false);
  });

  test("expected_outcome fails a 'did nothing' token match when the diff is NOT empty", async () => {
    // The error string claims a context conflict, but a non-empty diff proves the
    // agent actually changed files — the outcome does not hold.
    const ctx = makeCtx({
      run: makeRun({ status: "failed", error: "Agent reported context conflict" }),
      diff: "+<div class='sneaky-refactor'></div>",
    });
    const verdict = await runJudge(
      { type: "expected_outcome", expect: ["no_changes", "context_conflict"] },
      ctx
    );
    assert.equal(verdict.pass, false);
    assert.equal(verdict.score, 0);
  });

  test("expected_outcome matches an unknown token only on exact status equality, not substring", async () => {
    // Exact status token matches.
    const exact = await runJudge(
      { type: "expected_outcome", expect: ["failed"] },
      makeCtx({ run: makeRun({ status: "failed", error: undefined }) })
    );
    assert.equal(exact.pass, true);

    // A substring of the status/error must NOT match (would previously false-pass).
    const substring = await runJudge(
      { type: "expected_outcome", expect: ["fail"] },
      makeCtx({ run: makeRun({ status: "failed", error: "something failed badly" }) })
    );
    assert.equal(substring.pass, false);
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

test("extractJsonObject: strips markdown fences and isolates the object", () => {
  assert.equal(
    extractJsonObject('```json\n{ "pass": true, "score": 72, "reason": "ok" }\n```'),
    '{ "pass": true, "score": 72, "reason": "ok" }'
  );
  assert.equal(extractJsonObject('{"pass":false}'), '{"pass":false}');
  assert.equal(extractJsonObject('noise before {"pass":true} noise after'), '{"pass":true}');
});

describe("extractJsonObject brace balancing", () => {
  test("does not truncate on a '}' inside a string value", () => {
    const raw = '{"pass":true,"score":80,"reason":"closes the block with a } brace"}';
    const extracted = extractJsonObject(raw);
    assert.equal(extracted, raw);
    const parsed = JSON.parse(extracted) as { reason: string };
    assert.equal(parsed.reason, "closes the block with a } brace");
  });

  test("stops at the first balanced object and ignores trailing prose", () => {
    const extracted = extractJsonObject('{"pass":false,"reason":"nope"} and then the model kept talking {oops');
    assert.equal(extracted, '{"pass":false,"reason":"nope"}');
    const parsed = JSON.parse(extracted) as { pass: boolean };
    assert.equal(parsed.pass, false);
  });

  test("handles nested objects and escaped quotes", () => {
    const raw = '{"pass":true,"meta":{"note":"has \\"quotes\\" and a } inside"}}';
    const extracted = extractJsonObject(raw);
    assert.equal(extracted, raw);
    const parsed = JSON.parse(extracted) as { meta: { note: string } };
    assert.equal(parsed.meta.note, 'has "quotes" and a } inside');
  });
});

describe("outcomeToVerdict mapping", () => {
  test("maps the outcomes of gates that actually ran", () => {
    assert.equal(outcomeToVerdict("success"), "pass");
    assert.equal(outcomeToVerdict("failure"), "hard_fail");
    assert.equal(outcomeToVerdict("soft_fail"), "soft_fail");
  });

  test("passes through outcomes with no explicit mapping unchanged", () => {
    // `skipped` is never mapped here (the reconstruction drops skipped outcomes), so
    // it — like any other unmapped outcome — falls through unchanged.
    assert.equal(outcomeToVerdict("skipped"), "skipped");
    assert.equal(outcomeToVerdict("weird"), "weird");
  });
});

describe("readCheckpoint gate-report reconstruction from events.jsonl", () => {
  async function makeWorkDir(): Promise<{ workRoot: string; runId: string; cleanup: () => Promise<void> }> {
    const workRoot = await mkdtemp(path.join(tmpdir(), "eval-judges-"));
    const runId = "run-1";
    await mkdir(path.join(workRoot, runId), { recursive: true });
    return { workRoot, runId, cleanup: () => rm(workRoot, { recursive: true, force: true }) };
  }

  async function writeEvents(workRoot: string, runId: string, lines: string[]): Promise<void> {
    await writeFile(path.join(workRoot, runId, "events.jsonl"), lines.join("\n") + "\n", "utf8");
  }

  async function writeCheckpoint(workRoot: string, runId: string, data: unknown): Promise<void> {
    const dir = path.join(workRoot, runId, "checkpoints");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "checkpoint.json"), JSON.stringify({ data }), "utf8");
  }

  test("reconstructs gate report from node_end events when checkpoint is absent", async () => {
    const { workRoot, runId, cleanup } = await makeWorkDir();
    try {
      await writeEvents(workRoot, runId, [
        JSON.stringify({ type: "node_start", nodeId: "scope_judge" }),
        JSON.stringify({ type: "node_end", nodeId: "scope_judge", outcome: "success" }),
        JSON.stringify({ type: "node_end", nodeId: "diff_gate", outcome: "failure" }),
        JSON.stringify({ type: "node_end", nodeId: "implement", outcome: "success" }), // not a gate node
      ]);
      const data = await readCheckpoint(workRoot, runId);
      const gateReport = data.gateReport as Array<{ gate: string; verdict: string }>;
      assert.deepEqual(gateReport, [
        { gate: "scope_judge", verdict: "pass" },
        { gate: "diff_gate", verdict: "hard_fail" },
      ]);
    } finally {
      await cleanup();
    }
  });

  test("keeps the LAST outcome per gate node (fix-loop re-runs a gate)", async () => {
    const { workRoot, runId, cleanup } = await makeWorkDir();
    try {
      await writeEvents(workRoot, runId, [
        JSON.stringify({ type: "node_end", nodeId: "scope_judge", outcome: "soft_fail" }),
        JSON.stringify({ type: "node_end", nodeId: "scope_judge", outcome: "success" }),
      ]);
      const data = await readCheckpoint(workRoot, runId);
      assert.deepEqual(data.gateReport, [{ gate: "scope_judge", verdict: "pass" }]);
    } finally {
      await cleanup();
    }
  });

  test("falls back to events when checkpoint has an EMPTY gateReport array", async () => {
    const { workRoot, runId, cleanup } = await makeWorkDir();
    try {
      await writeCheckpoint(workRoot, runId, { gateReport: [] });
      await writeEvents(workRoot, runId, [
        JSON.stringify({ type: "node_end", nodeId: "scope_judge", outcome: "success" }),
      ]);
      const data = await readCheckpoint(workRoot, runId);
      assert.deepEqual(data.gateReport, [{ gate: "scope_judge", verdict: "pass" }]);
    } finally {
      await cleanup();
    }
  });

  test("prefers a non-empty checkpoint gateReport over events reconstruction", async () => {
    const { workRoot, runId, cleanup } = await makeWorkDir();
    try {
      await writeCheckpoint(workRoot, runId, { gateReport: [{ gate: "scope_judge", verdict: "hard_fail" }] });
      await writeEvents(workRoot, runId, [
        JSON.stringify({ type: "node_end", nodeId: "scope_judge", outcome: "success" }),
      ]);
      const data = await readCheckpoint(workRoot, runId);
      assert.deepEqual(data.gateReport, [{ gate: "scope_judge", verdict: "hard_fail" }]);
    } finally {
      await cleanup();
    }
  });

  test("drops a 'skipped' node_end so the gate stays ABSENT (production appends no entry)", async () => {
    const { workRoot, runId, cleanup } = await makeWorkDir();
    try {
      await writeEvents(workRoot, runId, [
        JSON.stringify({ type: "node_end", nodeId: "scope_judge", outcome: "skipped" }),
        JSON.stringify({ type: "node_end", nodeId: "diff_gate", outcome: "success" }),
      ]);
      const data = await readCheckpoint(workRoot, runId);
      // scope_judge skipped → no entry; only the gate that actually ran appears.
      assert.deepEqual(data.gateReport, [{ gate: "diff_gate", verdict: "pass" }]);

      // A gate_verdict judge for the skipped gate must therefore report "not found".
      const verdict = await runJudge(
        { type: "gate_verdict", gate: "scope_judge", expect: "pass" },
        makeCtx({ checkpointData: data })
      );
      assert.equal(verdict.pass, false);
      assert.ok(verdict.reason.includes("not found"));
    } finally {
      await cleanup();
    }
  });
});

describe("readDiff base-ref fallback safety", () => {
  test("returns '' instead of a fabricated patch when the base ref cannot be resolved", async () => {
    // A repo with a single base commit and NO origin remote: `git diff origin/main...`
    // and `git fetch origin main` both fail, and the commit-count gate can't resolve
    // origin/main either. The old code ran `git show HEAD` and returned the base
    // commit's unrelated patch; the gated fallback must return "" instead.
    const workRoot = await mkdtemp(path.join(tmpdir(), "eval-readdiff-"));
    const runId = "run-diff";
    const repoDir = path.join(workRoot, runId, "repo");
    await mkdir(repoDir, { recursive: true });
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: repoDir, stdio: "ignore" });
    };
    try {
      git("init", "-q", "-b", "main");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      await writeFile(path.join(repoDir, "README.md"), "base content\n", "utf8");
      git("add", "-A");
      git("commit", "-q", "-m", "base commit");

      const diff = await readDiff(workRoot, runId, "main");
      assert.equal(diff, "");
    } finally {
      await rm(workRoot, { recursive: true, force: true });
    }
  });
});
