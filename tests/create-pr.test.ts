import assert from "node:assert/strict";
import test from "node:test";
import { buildPrBody, createPrNode } from "../src/pipeline/nodes/create-pr.js";
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

test("buildPrBody: includes What changed section with agent analysis", () => {
  const analysis: AgentAnalysis = {
    verdict: "clean",
    filesChanged: ["src/settings.ts", "src/theme.css", "tests/settings.test.ts"],
    diffSummary: " 3 files changed, 50 insertions(+), 20 deletions(-)",
    diffStats: { added: 50, removed: 20, filesCount: 3 },
    signals: []
  };
  const body = buildPrBody(BASE_RUN, "main", "Gooseherd", false, undefined, analysis);
  assert.ok(body.includes("## What changed"));
  assert.ok(body.includes("**3** files changed"));
  assert.ok(body.includes("+50"));
  assert.ok(body.includes("-20"));
  assert.ok(body.includes("`src/settings.ts`"));
  assert.ok(body.includes("`src/theme.css`"));
  assert.ok(body.includes("`tests/settings.test.ts`"));
});

test("buildPrBody: details table has proper Field/Value headers", () => {
  const body = buildPrBody(BASE_RUN, "main", "Gooseherd", false);
  assert.ok(body.includes("| Field | Value |"));
  assert.ok(body.includes("|-------|-------|"));
});

test("buildPrBody: formats numbered requirements as a list", () => {
  const run = {
    ...BASE_RUN,
    task: "Add a stats section. Requirements: 1. Create a partial. 2. Add SCSS. 3. Make responsive."
  };
  const body = buildPrBody(run, "main", "Gooseherd", false);
  // Each item should appear on its own line
  const lines = body.split("\n");
  assert.ok(lines.some(l => l.trim() === "1. Create a partial"), "Item 1 should be on its own line");
  assert.ok(lines.some(l => l.trim() === "2. Add SCSS"), "Item 2 should be on its own line");
  assert.ok(lines.some(l => l.trim() === "3. Make responsive"), "Item 3 should be on its own line");
});

test("buildPrBody: formats requirements starting with 1.", () => {
  const run = {
    ...BASE_RUN,
    task: "1. Add tests. 2. Fix lint. 3. Update docs."
  };
  const body = buildPrBody(run, "main", "Gooseherd", false);
  const lines = body.split("\n");
  assert.ok(lines.some(l => l.trim() === "1. Add tests"), "Item 1 should be on its own line");
  assert.ok(lines.some(l => l.trim() === "2. Fix lint"), "Item 2 should be on its own line");
});

test("buildPrBody: does not format single numbers in prose", () => {
  const run = {
    ...BASE_RUN,
    task: "Fix error 500. Retry the connection."
  };
  const body = buildPrBody(run, "main", "Gooseherd", false);
  assert.ok(body.includes("Fix error 500. Retry the connection."), "Should keep prose unchanged");
});

test("buildPrBody: filters out timeout signals (various forms)", () => {
  const analysis: AgentAnalysis = {
    verdict: "clean",
    filesChanged: ["src/index.ts"],
    diffSummary: "1 file changed",
    diffStats: { added: 10, removed: 0, filesCount: 1 },
    signals: ['error signal: "timeout"', 'error: timeout occurred', 'warning signal: "deprecated"']
  };
  const body = buildPrBody(BASE_RUN, "main", "Gooseherd", false, undefined, analysis);
  assert.ok(body.includes("deprecated"), "Should keep meaningful signals");
  assert.ok(!body.includes("timeout"), "Should filter all timeout signals");
});

test("buildPrBody: collapses individual files when more than 30", () => {
  const files = Array.from({ length: 35 }, (_, i) => `src/file${String(i)}.ts`);
  const analysis: AgentAnalysis = {
    verdict: "clean",
    filesChanged: files,
    diffSummary: "big diff",
    diffStats: { added: 100, removed: 50, filesCount: 35 },
    signals: []
  };
  const body = buildPrBody(BASE_RUN, "main", "Gooseherd", false, undefined, analysis);
  assert.ok(body.includes("**35** files changed"));
  assert.ok(body.includes("<details>"), "Should collapse files into details tag");
  assert.ok(body.includes("`src/file0.ts`"), "Files should still be listed inside collapse");
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
  assert.ok(body.includes("**Signals detected:**"));
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
  assert.ok(!body.includes("**Signals detected:**"), "Should not have Signals section when empty");
});

test("buildPrBody: no What changed section when agentAnalysis is undefined", () => {
  const body = buildPrBody(BASE_RUN, "main", "Gooseherd", false);
  assert.ok(!body.includes("files changed"), "Should not have file stats without analysis");
});

// ── Quality gate report ──

test("buildPrBody: includes verification section with gate warnings", () => {
  const gateReport = [
    { gate: "diff_gate", verdict: "pass", reasons: [] },
    { gate: "forbidden_files", verdict: "soft_fail", reasons: [".env file detected"] }
  ];
  const body = buildPrBody(BASE_RUN, "main", "Gooseherd", false, gateReport);
  assert.ok(body.includes("## Verification"));
  assert.ok(body.includes("Forbidden Files"));
  assert.ok(body.includes(".env file detected"));
});

test("buildPrBody: shows all gates including passes for a convincing report", () => {
  const gateReport = [
    { gate: "diff_gate", verdict: "pass", reasons: [] },
    { gate: "security_scan", verdict: "pass", reasons: [] }
  ];
  const body = buildPrBody(BASE_RUN, "main", "Gooseherd", false, gateReport);
  assert.ok(body.includes("## Verification"), "Shows all gates even when all pass");
  assert.ok(body.includes("Diff Gate"));
  assert.ok(body.includes("Security Scan"));
});

test("createPrNode reuses an existing PR branch for auto-review runs without a parent run", async () => {
  const calls: string[] = [];
  const ctxStore = new Map<string, unknown>([["resolvedBaseBranch", "main"]]);
  const deps = {
    config: {
      appSlug: "gooseherd",
      appName: "Gooseherd",
      dryRun: false,
    },
    run: {
      id: "run-abc12345",
      task: "Self-review existing PR",
      requestedBy: "work-item:auto-review",
      repoSlug: "hubstaff/gooseherd",
      baseBranch: "main",
      branchName: "feature/hbl-404",
      parentBranchName: "feature/hbl-404",
    },
    githubService: {
      findOrCreatePullRequest: async () => {
        calls.push("findOrCreatePullRequest");
        return { url: "https://github.com/hubstaff/gooseherd/pull/77", number: 77 };
      },
      createPullRequest: async () => {
        calls.push("createPullRequest");
        return { url: "https://github.com/hubstaff/gooseherd/pull/999", number: 999 };
      },
    },
  } as any;
  const ctx = {
    get: <T>(key: string): T | undefined => ctxStore.get(key) as T | undefined,
    set: (key: string, value: unknown) => { ctxStore.set(key, value); },
  } as any;

  const result = await createPrNode({}, ctx, deps);

  assert.equal(result.outcome, "success");
  assert.deepEqual(calls, ["findOrCreatePullRequest"]);
  assert.equal(ctxStore.get("prNumber"), 77);
});

// ── Visual Evidence ──

test("buildPrBody: includes screenshot when URL provided", () => {
  const body = buildPrBody(BASE_RUN, "main", "Gooseherd", false, undefined, undefined, undefined, undefined,
    "https://dashboard.example.com/api/runs/run-abc12345/artifacts/screenshot.png");
  assert.ok(body.includes("## Visual Evidence"));
  assert.ok(body.includes("![Screenshot]"));
  assert.ok(body.includes("dashboard.example.com"));
});

test("buildPrBody: no visual evidence section without URL", () => {
  const body = buildPrBody(BASE_RUN, "main", "Gooseherd", false);
  assert.ok(!body.includes("## Visual Evidence"));
});

test("buildPrBody: screenshot-only visual evidence", () => {
  const body = buildPrBody(BASE_RUN, "main", "Gooseherd", false, undefined, undefined, undefined, undefined,
    "https://example.com/screenshot.png");
  assert.ok(body.includes("## Visual Evidence"));
  assert.ok(body.includes("![Screenshot]"));
  assert.ok(body.includes("screenshot.png"));
});

test("buildPrBody: includes embedded video and clickable link when provided", () => {
  const body = buildPrBody(
    BASE_RUN,
    "main",
    "Gooseherd",
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    "https://example.com/screenshot.png",
    "https://github.com/org/repo/blob/abc123/.gooseherd/videos/run-abc12345.mp4",
    "https://github.com/org/repo/raw/abc123/.gooseherd/videos/run-abc12345.mp4"
  );
  assert.ok(body.includes("### Verification Video"));
  assert.ok(body.includes("<video"));
  assert.ok(body.includes("View verification video"));
  assert.ok(body.includes("/blob/abc123/"));
  assert.ok(body.includes("/raw/abc123/"));
});

// ── Commit and changed files from context ──

test("buildPrBody: includes commit SHA in details table", () => {
  const body = buildPrBody(BASE_RUN, "main", "Gooseherd", false, undefined, undefined, "abc123def456");
  assert.ok(body.includes("`abc123def456`"));
  assert.ok(body.includes("**Commit**"));
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
  assert.ok(body.includes("## What changed"));
  assert.ok(body.includes("## Verification"));

  // Verify order: Task → Follow-up → What changed → Verification → Details → Footer
  const taskIdx = body.indexOf("## Task");
  const followUpIdx = body.indexOf("## Follow-up");
  const changesIdx = body.indexOf("## What changed");
  const gatesIdx = body.indexOf("## Verification");
  const detailsIdx = body.indexOf("## Details");
  const footerIdx = body.indexOf("Automated by");
  assert.ok(taskIdx < followUpIdx);
  assert.ok(followUpIdx < changesIdx);
  assert.ok(changesIdx < gatesIdx);
  assert.ok(gatesIdx < detailsIdx);
  assert.ok(detailsIdx < footerIdx);
});
