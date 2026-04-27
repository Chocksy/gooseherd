import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ContextBag } from "../src/pipeline/context-bag.js";
import { forbiddenFilesNode } from "../src/pipeline/quality-gates/forbidden-files-node.js";
import { runShellCapture } from "../src/pipeline/shell.js";
import type { AppConfig } from "../src/config.js";
import type { NodeDeps } from "../src/pipeline/types.js";
import type { RunRecord } from "../src/types.js";

function makeRun(overrides?: Partial<RunRecord>): RunRecord {
  return {
    id: "test-run-001",
    status: "running",
    repoSlug: "owner/repo",
    task: "Implement image model support",
    baseBranch: "main",
    branchName: "feature/branch",
    requestedBy: "U_TEST",
    channelId: "C123",
    threadTs: "1234567890.000000",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeDeps(logFile: string, overrides?: Partial<NodeDeps>): NodeDeps {
  return {
    config: {} as AppConfig,
    run: makeRun(),
    logFile,
    workRoot: "/tmp",
    onPhase: async () => undefined,
    ...overrides,
  };
}

async function makeGitRepo(prefix = "forbidden-files-node-"): Promise<{
  repoDir: string;
  logFile: string;
  cleanup: () => Promise<void>;
}> {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const logFile = path.join(repoDir, "test.log");
  await writeFile(logFile, "", "utf8");
  await runShellCapture("git init", { cwd: repoDir, logFile });
  await runShellCapture("git config user.email 'test@test.com'", { cwd: repoDir, logFile });
  await runShellCapture("git config user.name 'Test User'", { cwd: repoDir, logFile });
  await writeFile(path.join(repoDir, ".gitkeep"), "", "utf8");
  await runShellCapture("git add -A", { cwd: repoDir, logFile });
  await runShellCapture("git commit -m 'init'", { cwd: repoDir, logFile });
  return {
    repoDir,
    logFile,
    cleanup: async () => {
      await rm(repoDir, { recursive: true, force: true });
    },
  };
}

test("forbiddenFilesNode: ignores internal generated files even when AGENTS.md is tracked", async (t) => {
  const { repoDir, logFile, cleanup } = await makeGitRepo();
  t.after(cleanup);

  await writeFile(path.join(repoDir, "AGENTS.md"), "# project instructions\n", "utf8");
  await runShellCapture("git add AGENTS.md", { cwd: repoDir, logFile });
  await runShellCapture("git commit -m 'add project agents file'", { cwd: repoDir, logFile });

  await writeFile(path.join(repoDir, "AGENTS.md"), "# generated\n", "utf8");
  await writeFile(path.join(repoDir, "src.ts"), "export const value = 1;\n", "utf8");

  const ctx = new ContextBag({ repoDir });
  const result = await forbiddenFilesNode(
    { id: "forbidden_files", type: "conditional", action: "forbidden_files" },
    ctx,
    makeDeps(logFile),
  );

  assert.equal(result.outcome, "success");
});
