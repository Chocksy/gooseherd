import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeAgentOutput } from "../src/pipeline/nodes/implement.js";
import { runShellCapture } from "../src/pipeline/shell.js";

// ── Helper: create a real git repo with changes ──

async function makeGitRepo(prefix = "impl-test-"): Promise<{ dir: string; logFile: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  // Log file lives OUTSIDE the repo to avoid polluting git diff
  const logDir = await mkdtemp(path.join(os.tmpdir(), "impl-log-"));
  const logFile = path.join(logDir, "test.log");
  await writeFile(logFile, "", "utf8");
  await runShellCapture("git init && git config user.email 'test@test.com' && git config user.name 'Test'", { cwd: dir, logFile });
  // Create initial commit so HEAD exists
  await writeFile(path.join(dir, ".gitkeep"), "", "utf8");
  await runShellCapture("git add -A && git commit -m 'init'", { cwd: dir, logFile });
  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(logDir, { recursive: true, force: true });
  };
  return { dir, logFile, cleanup };
}

// ── analyzeAgentOutput: verdict logic ──

test("analyzeAgentOutput: no changes → verdict empty", async (t) => {
  const { dir, logFile, cleanup } = await makeGitRepo();
  t.after(cleanup);

  const result = await analyzeAgentOutput(dir, "", "", logFile);
  assert.equal(result.verdict, "empty");
  assert.equal(result.filesChanged.length, 0);
  assert.equal(result.diffStats.filesCount, 0);
  assert.ok(result.signals.some(s => s.includes("no file changes")));
});

test("analyzeAgentOutput: normal changes → verdict clean", async (t) => {
  const { dir, logFile, cleanup } = await makeGitRepo();
  t.after(cleanup);

  // Make some changes
  await writeFile(path.join(dir, "src.ts"), "const x = 1;\nconst y = 2;\nconst z = 3;\n", "utf8");
  await writeFile(path.join(dir, "test.ts"), "assert(true);\n", "utf8");

  const result = await analyzeAgentOutput(dir, "all good", "", logFile);
  assert.equal(result.verdict, "clean");
  assert.equal(result.filesChanged.length, 2);
  assert.ok(result.diffStats.added > 0);
  assert.equal(result.diffStats.filesCount, 2);
});

test("analyzeAgentOutput: mass deletion → verdict suspect", async (t) => {
  const { dir, logFile, cleanup } = await makeGitRepo();
  t.after(cleanup);

  // Create 6 files with lots of content, commit them, then delete most content
  for (let i = 1; i <= 6; i++) {
    const content = Array.from({ length: 25 }, (_, j) => `line ${String(j + 1)} of file ${String(i)}`).join("\n") + "\n";
    await writeFile(path.join(dir, `file${String(i)}.ts`), content, "utf8");
  }
  await runShellCapture("git add -A && git commit -m 'add files'", { cwd: dir, logFile });

  // Now delete most content (keep 1 line each → removed ~144, added ~6)
  for (let i = 1; i <= 6; i++) {
    await writeFile(path.join(dir, `file${String(i)}.ts`), "x\n", "utf8");
  }

  const result = await analyzeAgentOutput(dir, "", "", logFile);
  assert.equal(result.verdict, "suspect");
  assert.ok(result.signals.some(s => s.includes("mass deletion")));
});

test("analyzeAgentOutput: deletion under thresholds → clean (not suspect)", async (t) => {
  const { dir, logFile, cleanup } = await makeGitRepo();
  t.after(cleanup);

  // Only 3 files (under the >5 files threshold)
  for (let i = 1; i <= 3; i++) {
    const content = Array.from({ length: 50 }, (_, j) => `line ${String(j + 1)}`).join("\n") + "\n";
    await writeFile(path.join(dir, `file${String(i)}.ts`), content, "utf8");
  }
  await runShellCapture("git add -A && git commit -m 'add files'", { cwd: dir, logFile });

  for (let i = 1; i <= 3; i++) {
    await writeFile(path.join(dir, `file${String(i)}.ts`), "x\n", "utf8");
  }

  const result = await analyzeAgentOutput(dir, "", "", logFile);
  assert.equal(result.verdict, "clean", "Should be clean — only 3 files, under >5 threshold");
});

// ── analyzeAgentOutput: signal parsing ──

test("analyzeAgentOutput: detects fatal error signal", async (t) => {
  const { dir, logFile, cleanup } = await makeGitRepo();
  t.after(cleanup);

  await writeFile(path.join(dir, "new.ts"), "code\n", "utf8");
  const result = await analyzeAgentOutput(dir, "fatal error occurred", "", logFile);
  assert.ok(result.signals.some(s => s.includes('error signal') && s.includes('fatal')));
});

test("analyzeAgentOutput: detects panic signal", async (t) => {
  const { dir, logFile, cleanup } = await makeGitRepo();
  t.after(cleanup);

  await writeFile(path.join(dir, "new.ts"), "code\n", "utf8");
  const result = await analyzeAgentOutput(dir, "", "goroutine panic", logFile);
  assert.ok(result.signals.some(s => s.includes('error signal') && s.includes('panic')));
});

test("analyzeAgentOutput: detects warning signal", async (t) => {
  const { dir, logFile, cleanup } = await makeGitRepo();
  t.after(cleanup);

  await writeFile(path.join(dir, "new.ts"), "code\n", "utf8");
  const result = await analyzeAgentOutput(dir, "warning: deprecated API", "", logFile);
  assert.ok(result.signals.some(s => s.includes('warning signal')));
});

test("analyzeAgentOutput: no signals in clean output", async (t) => {
  const { dir, logFile, cleanup } = await makeGitRepo();
  t.after(cleanup);

  await writeFile(path.join(dir, "new.ts"), "code\n", "utf8");
  const result = await analyzeAgentOutput(dir, "All tests passed successfully", "", logFile);
  assert.equal(result.signals.length, 0, "Should have no signals for clean output");
});

test("analyzeAgentOutput: case insensitive signal detection", async (t) => {
  const { dir, logFile, cleanup } = await makeGitRepo();
  t.after(cleanup);

  await writeFile(path.join(dir, "new.ts"), "code\n", "utf8");
  const result = await analyzeAgentOutput(dir, "FATAL ERROR", "", logFile);
  assert.ok(result.signals.some(s => s.includes('error signal')));
});

test("analyzeAgentOutput: detects signals from stderr", async (t) => {
  const { dir, logFile, cleanup } = await makeGitRepo();
  t.after(cleanup);

  await writeFile(path.join(dir, "new.ts"), "code\n", "utf8");
  const result = await analyzeAgentOutput(dir, "", "unhandled exception in module", logFile);
  assert.ok(result.signals.some(s => s.includes('error signal') && s.includes('unhandled exception')));
});

// ── analyzeAgentOutput: diff stats ──

test("analyzeAgentOutput: correct line counts for additions", async (t) => {
  const { dir, logFile, cleanup } = await makeGitRepo();
  t.after(cleanup);

  await writeFile(path.join(dir, "new.ts"), "line1\nline2\nline3\n", "utf8");
  const result = await analyzeAgentOutput(dir, "", "", logFile);
  assert.equal(result.diffStats.added, 3);
  assert.equal(result.diffStats.removed, 0);
  assert.equal(result.diffStats.filesCount, 1);
});

test("analyzeAgentOutput: correct line counts for modifications", async (t) => {
  const { dir, logFile, cleanup } = await makeGitRepo();
  t.after(cleanup);

  // Create and commit a file, then modify it
  await writeFile(path.join(dir, "existing.ts"), "old line 1\nold line 2\n", "utf8");
  await runShellCapture("git add -A && git commit -m 'add file'", { cwd: dir, logFile });
  await writeFile(path.join(dir, "existing.ts"), "new line 1\nnew line 2\nnew line 3\n", "utf8");

  const result = await analyzeAgentOutput(dir, "", "", logFile);
  assert.ok(result.diffStats.added > 0, "Should have additions");
  assert.ok(result.diffStats.removed > 0, "Should have removals");
  assert.equal(result.diffStats.filesCount, 1);
  assert.deepEqual(result.filesChanged, ["existing.ts"]);
});

test("analyzeAgentOutput: diffSummary is populated", async (t) => {
  const { dir, logFile, cleanup } = await makeGitRepo();
  t.after(cleanup);

  await writeFile(path.join(dir, "new.ts"), "hello\n", "utf8");
  const result = await analyzeAgentOutput(dir, "", "", logFile);
  assert.ok(result.diffSummary.length > 0, "diffSummary should not be empty");
  assert.ok(result.diffSummary.includes("new.ts"), "diffSummary should mention the file");
});
