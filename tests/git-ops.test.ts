import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { commitCaptureAndPush } from "../src/pipeline/git-ops.js";
import { filterInternalGeneratedFiles, isInternalGeneratedFile } from "../src/pipeline/internal-generated-files.js";
import { runShellCapture } from "../src/pipeline/shell.js";

async function makeGitRepo(prefix = "git-ops-test-"): Promise<{ dir: string; logFile: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const logDir = await mkdtemp(path.join(os.tmpdir(), "git-ops-log-"));
  const logFile = path.join(logDir, "test.log");
  await writeFile(logFile, "", "utf8");
  await runShellCapture("git init && git config user.email 'test@test.com' && git config user.name 'Test'", { cwd: dir, logFile });
  await writeFile(path.join(dir, ".gitkeep"), "", "utf8");
  await runShellCapture("git add -A && git commit -m 'init'", { cwd: dir, logFile });
  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(logDir, { recursive: true, force: true });
  };
  return { dir, logFile, cleanup };
}

test("internal-generated-files: detects and filters AGENTS.md", () => {
  assert.equal(isInternalGeneratedFile("AGENTS.md"), true);
  assert.equal(isInternalGeneratedFile("src/index.ts"), false);
  assert.deepEqual(
    filterInternalGeneratedFiles(["AGENTS.md", "src/index.ts", "tests/app.test.ts"]),
    ["src/index.ts", "tests/app.test.ts"]
  );
});

test("commitCaptureAndPush: excludes AGENTS.md from commit and changedFiles", async (t) => {
  const { dir, logFile, cleanup } = await makeGitRepo();
  t.after(cleanup);

  await writeFile(path.join(dir, "AGENTS.md"), "# generated\n", "utf8");
  await writeFile(path.join(dir, "src.ts"), "export const value = 1;\n", "utf8");

  const result = await commitCaptureAndPush(dir, "test commit", logFile);
  assert.ok(result.commitSha.length > 0);
  assert.deepEqual(result.changedFiles, ["src.ts"]);
  assert.deepEqual(result.internalArtifacts, ["AGENTS.md"]);

  const showResult = await runShellCapture("git show --name-only --pretty='' HEAD", { cwd: dir, logFile });
  assert.equal(showResult.code, 0);
  assert.equal(showResult.stdout.includes("AGENTS.md"), false);
  assert.equal(showResult.stdout.includes("src.ts"), true);

  const statusResult = await runShellCapture("git status --short", { cwd: dir, logFile });
  assert.equal(statusResult.code, 0);
  assert.equal(statusResult.stdout.includes("AGENTS.md"), true, "AGENTS.md should remain uncommitted");
});

test("commitCaptureAndPush: fails clearly when only internal-generated files changed", async (t) => {
  const { dir, logFile, cleanup } = await makeGitRepo();
  t.after(cleanup);

  await writeFile(path.join(dir, "AGENTS.md"), "# generated\n", "utf8");

  await assert.rejects(
    () => commitCaptureAndPush(dir, "test commit", logFile),
    /No committable user changes/i
  );
});
