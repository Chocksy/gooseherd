import assert from "node:assert/strict";
import test from "node:test";
import { buildPrBody } from "../src/pipeline/nodes/create-pr.js";
import type { AgentAnalysis } from "../src/pipeline/nodes/implement.js";

const BASE_RUN = {
  id: "run-abc12345",
  task: "Add dark mode to the settings page",
  requestedBy: "U_alice"
};

// ── Basic PR body ──

test("buildPrBody: basic PR has task, base branch, run ID", () => {
  const body = buildPrBody(BASE_RUN, "main", "Gooseherd", false);
  assert.ok(body.includes("## Task"));
  assert.ok(body.includes("Add dark mode"));
  assert.ok(body.includes("`main`"));
  assert.ok(body.includes("U_alice"));
  assert.ok(body.includes("`run-abc1`"));
});

test("buildPrBody: footer includes app name and link", () => {
  const body = buildPrBody(BASE_RUN, "main", "Gooseherd", false);
  assert.ok(body.includes("Automated by [Gooseherd](https://goose-herd.com)"));
});

// ── Follow-up context ──

test("buildPrBody: follow-up includes parent context and feedback", () => {
  const run = {
    ...BASE_RUN,
    parentRunId: "parent-xyz99999",
    feedbackNote: "Please also add tests",
    chainIndex: 2
  };
  const body = buildPrBody(run, "main", "Gooseherd", true);
  assert.ok(body.includes("## Follow-up"));
  assert.ok(body.includes("Please also add tests"));
  assert.ok(body.includes("`parent-x`"));
  assert.ok(body.includes("**Chain depth:** 2"));
});

test("buildPrBody: follow-up without feedback defaults to retry", () => {
  const run = { ...BASE_RUN, parentRunId: "parent-xyz99999" };
  const body = buildPrBody(run, "main", "Gooseherd", true);
  assert.ok(body.includes("> retry"));
});

// ── Agent analysis section ──

test("buildPrBody: includes Changes section with agent analysis", () => {
  const analysis: AgentAnalysis = {
    verdict: "clean",
    filesChanged: ["src/settings.ts", "src/theme.css", "tests/settings.test.ts"],
    diffSummary: " 3 files changed, 50 insertions(+), 20 deletions(-)",
    diffStats: { added: 50, removed: 20, filesCount: 3 },
    signals: []
  };
  const body = buildPrBody(BASE_RUN, "main", "Gooseherd", false, undefined, analysis);
  assert.ok(body.includes("## Changes"));
  assert.ok(body.includes("**Files changed:** 3"));
  assert.ok(body.includes("+50 / -20"));
  assert.ok(body.includes("`src/settings.ts`"));
  assert.ok(body.includes("`src/theme.css`"));
  assert.ok(body.includes("`tests/settings.test.ts`"));
});

test("buildPrBody: hides individual files when more than 20", () => {
  const files = Array.from({ length: 25 }, (_, i) => `src/file${String(i)}.ts`);
  const analysis: AgentAnalysis = {
    verdict: "clean",
    filesChanged: files,
    diffSummary: "big diff",
    diffStats: { added: 100, removed: 50, filesCount: 25 },
    signals: []
  };
  const body = buildPrBody(BASE_RUN, "main", "Gooseherd", false, undefined, analysis);
  assert.ok(body.includes("**Files changed:** 25"));
  assert.ok(!body.includes("`src/file0.ts`"), "Should NOT list individual files when > 20");
});

test("buildPrBody: includes signals when present", () => {
  const analysis: AgentAnalysis = {
    verdict: "clean",
    filesChanged: ["src/index.ts"],
    diffSummary: "1 file changed",
    diffStats: { added: 10, removed: 0, filesCount: 1 },
    signals: ['warning signal: "deprecated"']
  };
  const body = buildPrBody(BASE_RUN, "main", "Gooseherd", false, undefined, analysis);
  assert.ok(body.includes("**Signals:**"));
  assert.ok(body.includes("deprecated"));
});

test("buildPrBody: no Signals section when signals array is empty", () => {
  const analysis: AgentAnalysis = {
    verdict: "clean",
    filesChanged: ["src/index.ts"],
    diffSummary: "1 file changed",
    diffStats: { added: 10, removed: 0, filesCount: 1 },
    signals: []
  };
  const body = buildPrBody(BASE_RUN, "main", "Gooseherd", false, undefined, analysis);
  assert.ok(!body.includes("**Signals:**"), "Should not have Signals section when empty");
});

test("buildPrBody: no Changes section when agentAnalysis is undefined", () => {
  const body = buildPrBody(BASE_RUN, "main", "Gooseherd", false);
  assert.ok(!body.includes("## Changes"), "Should not have Changes section without analysis");
});

// ── Quality gate report ──

test("buildPrBody: includes quality gate warnings", () => {
  const gateReport = [
    { gate: "diff_gate", verdict: "pass", reasons: [] },
    { gate: "forbidden_files", verdict: "soft_fail", reasons: [".env file detected"] }
  ];
  const body = buildPrBody(BASE_RUN, "main", "Gooseherd", false, gateReport);
  assert.ok(body.includes("## Quality Gates"));
  assert.ok(body.includes("forbidden_files"));
  assert.ok(body.includes(".env file detected"));
});

test("buildPrBody: no Quality Gates section when all gates pass with empty reasons", () => {
  const gateReport = [
    { gate: "diff_gate", verdict: "pass", reasons: [] },
    { gate: "security_scan", verdict: "pass", reasons: [] }
  ];
  const body = buildPrBody(BASE_RUN, "main", "Gooseherd", false, gateReport);
  assert.ok(!body.includes("## Quality Gates"), "All pass + empty reasons → no section");
});

// ── Combined: analysis + gates + follow-up ──

test("buildPrBody: all sections combined in correct order", () => {
  const run = {
    ...BASE_RUN,
    parentRunId: "parent-xyz",
    feedbackNote: "Fix the tests"
  };
  const analysis: AgentAnalysis = {
    verdict: "clean",
    filesChanged: ["src/fix.ts"],
    diffSummary: "1 file",
    diffStats: { added: 5, removed: 2, filesCount: 1 },
    signals: []
  };
  const gateReport = [
    { gate: "diff_gate", verdict: "soft_fail", reasons: ["Large diff"] }
  ];
  const body = buildPrBody(run, "main", "Gooseherd", true, gateReport, analysis);

  // Verify all sections exist
  assert.ok(body.includes("## Task"));
  assert.ok(body.includes("## Follow-up"));
  assert.ok(body.includes("## Changes"));
  assert.ok(body.includes("## Quality Gates"));

  // Verify order: Task → Details → Follow-up → Changes → Quality Gates → Footer
  const taskIdx = body.indexOf("## Task");
  const followUpIdx = body.indexOf("## Follow-up");
  const changesIdx = body.indexOf("## Changes");
  const gatesIdx = body.indexOf("## Quality Gates");
  const footerIdx = body.indexOf("Automated by");
  assert.ok(taskIdx < followUpIdx);
  assert.ok(followUpIdx < changesIdx);
  assert.ok(changesIdx < gatesIdx);
  assert.ok(gatesIdx < footerIdx);
});
