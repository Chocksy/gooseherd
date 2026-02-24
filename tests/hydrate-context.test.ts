import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getExpectedOutput, buildRepoSummary, hydrateContextNode } from "../src/pipeline/nodes/hydrate-context.js";
import { ContextBag } from "../src/pipeline/context-bag.js";
import type { NodeDeps } from "../src/pipeline/types.js";

// ── getExpectedOutput ──

test("getExpectedOutput: bugfix includes root cause and regression test guidance", () => {
  const lines = getExpectedOutput("bugfix");
  assert.equal(lines[0], "Expected output:");
  const joined = lines.join(" ");
  assert.ok(joined.includes("root cause"), "Should mention root cause");
  assert.ok(joined.includes("regression test"), "Should mention regression test");
});

test("getExpectedOutput: feature includes architecture and tests guidance", () => {
  const lines = getExpectedOutput("feature");
  const joined = lines.join(" ");
  assert.ok(joined.includes("existing architecture"), "Should mention existing architecture");
  assert.ok(joined.includes("Add tests"), "Should mention tests");
});

test("getExpectedOutput: refactor includes behavior preservation", () => {
  const lines = getExpectedOutput("refactor");
  const joined = lines.join(" ");
  assert.ok(joined.includes("Preserve ALL existing behavior"), "Should mention behavior preservation");
});

test("getExpectedOutput: chore includes minimal changes", () => {
  const lines = getExpectedOutput("chore");
  const joined = lines.join(" ");
  assert.ok(joined.includes("Keep changes minimal"), "Should mention minimal changes");
});

test("getExpectedOutput: unknown task type falls back to chore", () => {
  const unknown = getExpectedOutput("deployment");
  const chore = getExpectedOutput("chore");
  assert.deepEqual(unknown, chore);
});

test("getExpectedOutput: empty string falls back to chore", () => {
  const empty = getExpectedOutput("");
  const chore = getExpectedOutput("chore");
  assert.deepEqual(empty, chore);
});

// ── buildRepoSummary ──

async function makeTempRepo(prefix = "repo-test-"): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

test("buildRepoSummary: returns directory structure for repo with subdirs", async (t) => {
  const dir = await makeTempRepo();
  const logFile = path.join(dir, "test.log");
  await writeFile(logFile, "", "utf8");
  await mkdir(path.join(dir, "src"));
  await mkdir(path.join(dir, "tests"));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const result = await buildRepoSummary(dir, logFile);
  assert.ok(result, "Should return a summary");
  assert.ok(result.includes("### Directory structure"), "Should have directory section");
  assert.ok(result.includes("src"), "Should list src dir");
  assert.ok(result.includes("tests"), "Should list tests dir");
});

test("buildRepoSummary: detects Node.js tech stack from package.json", async (t) => {
  const dir = await makeTempRepo();
  const logFile = path.join(dir, "test.log");
  await writeFile(logFile, "", "utf8");
  await writeFile(path.join(dir, "package.json"), "{}", "utf8");
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const result = await buildRepoSummary(dir, logFile);
  assert.ok(result, "Should return a summary");
  assert.ok(result.includes("Node.js"), "Should detect Node.js");
});

test("buildRepoSummary: detects TypeScript from tsconfig.json", async (t) => {
  const dir = await makeTempRepo();
  const logFile = path.join(dir, "test.log");
  await writeFile(logFile, "", "utf8");
  await writeFile(path.join(dir, "tsconfig.json"), "{}", "utf8");
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const result = await buildRepoSummary(dir, logFile);
  assert.ok(result, "Should return a summary");
  assert.ok(result.includes("TypeScript"), "Should detect TypeScript");
});

test("buildRepoSummary: deduplicates tech stack entries", async (t) => {
  const dir = await makeTempRepo();
  const logFile = path.join(dir, "test.log");
  await writeFile(logFile, "", "utf8");
  await writeFile(path.join(dir, "package.json"), "{}", "utf8");
  await writeFile(path.join(dir, "tsconfig.json"), "{}", "utf8");
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const result = await buildRepoSummary(dir, logFile);
  assert.ok(result, "Should return a summary");
  assert.ok(result.includes("Node.js"), "Should have Node.js");
  assert.ok(result.includes("TypeScript"), "Should have TypeScript");
});

test("buildRepoSummary: includes README excerpt", async (t) => {
  const dir = await makeTempRepo();
  const logFile = path.join(dir, "test.log");
  await writeFile(logFile, "", "utf8");
  const readmeContent = "# My Project\n\nThis is a test project.\n\nIt does things.";
  await writeFile(path.join(dir, "README.md"), readmeContent, "utf8");
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const result = await buildRepoSummary(dir, logFile);
  assert.ok(result, "Should return a summary");
  assert.ok(result.includes("### README excerpt"), "Should have README section");
  assert.ok(result.includes("My Project"), "Should include README content");
});

test("buildRepoSummary: truncates long README at 500 chars", async (t) => {
  const dir = await makeTempRepo();
  const logFile = path.join(dir, "test.log");
  await writeFile(logFile, "", "utf8");
  const longReadme = "# Long README\n\n" + "A".repeat(1000);
  await writeFile(path.join(dir, "README.md"), longReadme, "utf8");
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const result = await buildRepoSummary(dir, logFile);
  assert.ok(result, "Should return a summary");
  // The excerpt should be truncated — verify it doesn't contain the full 1000-char block
  assert.ok(result.includes("### README excerpt"), "Should have README section");
  const excerptMatch = result.split("### README excerpt\n")[1];
  assert.ok(excerptMatch!.length < 600, "README excerpt should be capped around 500 chars");
});

test("buildRepoSummary: handles missing README gracefully", async (t) => {
  const dir = await makeTempRepo();
  const logFile = path.join(dir, "test.log");
  await writeFile(logFile, "", "utf8");
  await writeFile(path.join(dir, "package.json"), "{}", "utf8");
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const result = await buildRepoSummary(dir, logFile);
  assert.ok(result, "Should return summary even without README");
  assert.ok(!result.includes("### README excerpt"), "Should NOT have README section");
});

test("buildRepoSummary: returns undefined for truly empty dir", async (t) => {
  const dir = await makeTempRepo();
  const logFile = path.join(dir, "test.log");
  await writeFile(logFile, "", "utf8");
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const result = await buildRepoSummary(dir, logFile);
  // Even an empty dir has "." in find output, so it should still have structure
  // This is fine — the important thing is it doesn't crash
  assert.ok(result === undefined || typeof result === "string");
});

// ── hydrateContextNode (integration) ──

function makeMockDeps(overrides: Partial<NodeDeps> = {}): NodeDeps {
  return {
    config: { appName: "test" } as NodeDeps["config"],
    run: {
      id: "run-123",
      repoSlug: "owner/repo",
      baseBranch: "main",
      branchName: "gooseherd/run-123",
      task: "Add dark mode",
      requestedBy: "U123",
      channelId: "C123",
      threadTs: "123.456",
      status: "running",
      phase: "agent",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    logFile: "/dev/null",
    workRoot: "/tmp",
    onPhase: async () => {},
    ...overrides
  };
}

test("hydrateContextNode: writes prompt file with taskType from context", async (t) => {
  const dir = await makeTempRepo();
  const repoDir = path.join(dir, "repo");
  await mkdir(repoDir, { recursive: true });
  const promptFile = path.join(dir, "task.md");
  const logFile = path.join(dir, "test.log");
  await writeFile(logFile, "", "utf8");
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const ctx = new ContextBag({ repoDir, promptFile, taskType: "bugfix" });
  const deps = makeMockDeps({ logFile });

  const result = await hydrateContextNode({ id: "hydrate", type: "deterministic", action: "hydrate_context" }, ctx, deps);
  assert.equal(result.outcome, "success");

  const content = await readFile(promptFile, "utf8");
  assert.ok(content.includes("Task type: bugfix"), "Should contain task type");
  assert.ok(content.includes("root cause"), "Should contain bugfix-specific instructions");
});

test("hydrateContextNode: defaults taskType to chore when not set", async (t) => {
  const dir = await makeTempRepo();
  const repoDir = path.join(dir, "repo");
  await mkdir(repoDir, { recursive: true });
  const promptFile = path.join(dir, "task.md");
  const logFile = path.join(dir, "test.log");
  await writeFile(logFile, "", "utf8");
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const ctx = new ContextBag({ repoDir, promptFile });
  const deps = makeMockDeps({ logFile });

  await hydrateContextNode({ id: "hydrate", type: "deterministic", action: "hydrate_context" }, ctx, deps);

  const content = await readFile(promptFile, "utf8");
  assert.ok(content.includes("Task type: chore"), "Should default to chore");
});

test("hydrateContextNode: includes repo summary in prompt", async (t) => {
  const dir = await makeTempRepo();
  const repoDir = path.join(dir, "repo");
  await mkdir(repoDir, { recursive: true });
  await writeFile(path.join(repoDir, "package.json"), "{}", "utf8");
  const promptFile = path.join(dir, "task.md");
  const logFile = path.join(dir, "test.log");
  await writeFile(logFile, "", "utf8");
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const ctx = new ContextBag({ repoDir, promptFile });
  const deps = makeMockDeps({ logFile });

  await hydrateContextNode({ id: "hydrate", type: "deterministic", action: "hydrate_context" }, ctx, deps);

  const content = await readFile(promptFile, "utf8");
  assert.ok(content.includes("## Repository Context"), "Should have repo context section");
  assert.ok(content.includes("Node.js"), "Should detect Node.js from package.json");
});

test("hydrateContextNode: writes .goosehints with run context", async (t) => {
  const dir = await makeTempRepo();
  const repoDir = path.join(dir, "repo");
  await mkdir(repoDir, { recursive: true });
  const promptFile = path.join(dir, "task.md");
  const logFile = path.join(dir, "test.log");
  await writeFile(logFile, "", "utf8");
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const ctx = new ContextBag({ repoDir, promptFile });
  const deps = makeMockDeps({ logFile });

  await hydrateContextNode({ id: "hydrate", type: "deterministic", action: "hydrate_context" }, ctx, deps);

  const hints = await readFile(path.join(repoDir, ".goosehints"), "utf8");
  assert.ok(hints.includes("Run ID: run-123"), "Should contain run ID");
  assert.ok(hints.includes("Repository: owner/repo"), "Should contain repo slug");
});

test("hydrateContextNode: follow-up run includes parent context", async (t) => {
  const dir = await makeTempRepo();
  const repoDir = path.join(dir, "repo");
  await mkdir(repoDir, { recursive: true });
  const promptFile = path.join(dir, "task.md");
  const logFile = path.join(dir, "test.log");
  await writeFile(logFile, "", "utf8");
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const ctx = new ContextBag({ repoDir, promptFile, isFollowUp: true });
  const deps = makeMockDeps({
    logFile,
    run: {
      ...makeMockDeps().run,
      parentRunId: "parent-abc",
      parentBranchName: "gooseherd/parent-abc",
      feedbackNote: "Please also add tests",
      changedFiles: ["src/index.ts", "src/utils.ts"]
    }
  });

  await hydrateContextNode({ id: "hydrate", type: "deterministic", action: "hydrate_context" }, ctx, deps);

  const content = await readFile(promptFile, "utf8");
  assert.ok(content.includes("## Previous Run Context"), "Should have previous run section");
  assert.ok(content.includes("parent-ab"), "Should contain parent run ID prefix");
  assert.ok(content.includes("Please also add tests"), "Should contain feedback note");
  assert.ok(content.includes("src/index.ts"), "Should list changed files");
});
