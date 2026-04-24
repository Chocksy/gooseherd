/**
 * Tests for plan-task, local-test, and notify pipeline nodes.
 */

import assert from "node:assert/strict";
import { describe, test, mock } from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContextBag } from "../src/pipeline/context-bag.js";
import { localTestNode } from "../src/pipeline/nodes/local-test.js";
import { lightweightChecksNode } from "../src/pipeline/nodes/lightweight-checks.js";
import { rubySyntaxGateNode } from "../src/pipeline/nodes/ruby-syntax-gate.js";
import { notifyNode } from "../src/pipeline/nodes/notify.js";
import { waitCiNode } from "../src/pipeline/ci/wait-ci-node.js";
import type { NodeConfig, NodeDeps } from "../src/pipeline/types.js";
import type { AppConfig } from "../src/config.js";
import type { RunRecord } from "../src/types.js";
import { runShellCapture } from "../src/pipeline/shell.js";

// ── Helpers ──

function makeNodeConfig(id = "test_node"): NodeConfig {
  return { id, type: "deterministic", action: id };
}

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: `test-${Date.now()}`,
    status: "running",
    phase: "agent",
    repoSlug: "org/repo",
    task: "Test task",
    baseBranch: "main",
    branchName: "gooseherd/test",
    requestedBy: "U_TEST",
    channelId: "C_TEST",
    threadTs: "0000.0000",
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

function makeEligiblePrefetchContext() {
  return {
    meta: {
      fetchedAt: "2026-04-21T12:00:00.000Z",
      sources: ["github_pr", "github_ci"] as const,
    },
    workItem: {
      id: "wi-1",
      title: "Eligible work item",
      workflow: "feature_delivery",
      state: "ready_for_merge",
      flags: ["engineering_review_done", "qa_review_done"],
      githubPrNumber: 17,
      githubPrUrl: "https://github.com/owner/repo/pull/17",
    },
  };
}

function makeDeps(overrides: Partial<NodeDeps> & { configOverrides?: Partial<AppConfig> } = {}): NodeDeps {
  const { configOverrides, ...depsOverrides } = overrides;
  return {
    config: {
      localTestCommand: "",
      agentTimeoutSeconds: 60,
      openrouterApiKey: undefined,
      ...configOverrides
    } as AppConfig,
    run: makeRun(),
    logFile: "/dev/null",
    workRoot: "/tmp",
    onPhase: async () => {},
    ...depsOverrides
  };
}

async function makeGitRepo(prefix = "pipeline-node-git-"): Promise<{ repoDir: string; logFile: string; cleanup: () => Promise<void> }> {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const logFile = path.join(repoDir, "test.log");
  await writeFile(logFile, "", "utf8");
  await runShellCapture("git init", { cwd: repoDir, logFile });
  await runShellCapture("git config user.email 'test@test.com'", { cwd: repoDir, logFile });
  await runShellCapture("git config user.name 'Test User'", { cwd: repoDir, logFile });
  await writeFile(path.join(repoDir, ".gitkeep"), "", "utf8");
  await runShellCapture("git add -A", { cwd: repoDir, logFile });
  await runShellCapture("git commit -m 'init'", { cwd: repoDir, logFile });
  const cleanup = async () => {
    await rm(repoDir, { recursive: true, force: true });
  };
  return { repoDir, logFile, cleanup };
}

async function installFakeRuby(t: { after: (fn: () => void | Promise<void>) => void }): Promise<void> {
  const binDir = await mkdtemp(path.join(os.tmpdir(), "fake-ruby-bin-"));
  const rubyPath = path.join(binDir, "ruby");
  await writeFile(
    rubyPath,
    `#!/bin/sh
if [ "$1" != "-c" ] || [ -z "$2" ]; then
  echo "unsupported ruby invocation" >&2
  exit 2
fi
file="$2"
if grep -q "def call(" "$file"; then
  echo "$file:2: syntax error, unexpected end-of-input" >&2
  exit 1
fi
echo "Syntax OK"
`,
    "utf8"
  );
  await chmod(rubyPath, 0o755);

  const originalPath = process.env.PATH ?? "";
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
  t.after(async () => {
    process.env.PATH = originalPath;
    await rm(binDir, { recursive: true, force: true });
  });
}

async function makeGitRepoWithOrigin(prefix = "pipeline-node-origin-"): Promise<{
  originDir: string;
  repoDir: string;
  logFile: string;
  cleanup: () => Promise<void>;
}> {
  const originDir = await mkdtemp(path.join(os.tmpdir(), `${prefix}origin-`));
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), `${prefix}repo-root-`));
  const repoDir = path.join(repoRoot, "repo");
  const logFile = path.join(repoRoot, "test.log");
  await writeFile(logFile, "", "utf8");

  await runShellCapture("git init -b main", { cwd: originDir, logFile });
  await runShellCapture("git config user.email 'test@test.com'", { cwd: originDir, logFile });
  await runShellCapture("git config user.name 'Test User'", { cwd: originDir, logFile });
  await writeFile(path.join(originDir, "conflict.txt"), "base\n", "utf8");
  await runShellCapture("git add conflict.txt", { cwd: originDir, logFile });
  await runShellCapture("git commit -m 'init main'", { cwd: originDir, logFile });

  await runShellCapture(`git clone ${originDir} ${repoDir}`, { cwd: originDir, logFile });
  await runShellCapture("git config user.email 'test@test.com'", { cwd: repoDir, logFile });
  await runShellCapture("git config user.name 'Test User'", { cwd: repoDir, logFile });
  await runShellCapture("git checkout -b feature/rebase-test", { cwd: repoDir, logFile });

  const cleanup = async () => {
    await rm(originDir, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  };

  return { originDir, repoDir, logFile, cleanup };
}

// ═══════════════════════════════════════════════════════
// Local Test Node
// ═══════════════════════════════════════════════════════

describe("localTestNode", () => {
  test("skips when localTestCommand is empty", async () => {
    const ctx = new ContextBag({ repoDir: "/tmp" });
    const deps = makeDeps({ configOverrides: { localTestCommand: "" } });
    const result = await localTestNode(makeNodeConfig("local_test"), ctx, deps);
    assert.equal(result.outcome, "skipped");
  });

  test("skips when localTestCommand is whitespace", async () => {
    const ctx = new ContextBag({ repoDir: "/tmp" });
    const deps = makeDeps({ configOverrides: { localTestCommand: "   " } });
    const result = await localTestNode(makeNodeConfig("local_test"), ctx, deps);
    assert.equal(result.outcome, "skipped");
  });

  test("returns success when test command exits 0", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "lt-pass-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const ctx = new ContextBag({ repoDir: tmpDir });
    const deps = makeDeps({
      configOverrides: { localTestCommand: "true" },
      logFile
    });

    const result = await localTestNode(makeNodeConfig("local_test"), ctx, deps);
    assert.equal(result.outcome, "success");

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns failure with rawOutput when test command exits non-zero", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "lt-fail-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const ctx = new ContextBag({ repoDir: tmpDir });
    const deps = makeDeps({
      configOverrides: { localTestCommand: "echo 'test output' && exit 1" },
      logFile
    });

    const result = await localTestNode(makeNodeConfig("local_test"), ctx, deps);
    assert.equal(result.outcome, "failure");
    assert.ok(result.error?.includes("exit code 1"));
    assert.ok(result.rawOutput !== undefined);

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("throws when repoDir is missing from context", async () => {
    const ctx = new ContextBag();
    const deps = makeDeps({ configOverrides: { localTestCommand: "true" } });

    await assert.rejects(
      () => localTestNode(makeNodeConfig("local_test"), ctx, deps),
      { message: /required key 'repoDir' is missing/ }
    );
  });
});

describe("rubySyntaxGateNode", () => {
  test("skips when there are no changed Ruby files", async (t) => {
    const { repoDir, logFile, cleanup } = await makeGitRepo("ruby-gate-skip-");
    t.after(cleanup);

    await writeFile(path.join(repoDir, "index.ts"), "export const value = 1;\n", "utf8");

    const ctx = new ContextBag({ repoDir });
    const deps = makeDeps({ logFile });

    const result = await rubySyntaxGateNode(makeNodeConfig("ruby_syntax_gate"), ctx, deps);
    assert.equal(result.outcome, "skipped");
  });

  test("returns success when changed Ruby files pass syntax check", async (t) => {
    const { repoDir, logFile, cleanup } = await makeGitRepo("ruby-gate-pass-");
    t.after(cleanup);
    await installFakeRuby(t);

    await writeFile(path.join(repoDir, "worker.rb"), "class Worker\n  def call\n    :ok\n  end\nend\n", "utf8");

    const ctx = new ContextBag({ repoDir });
    const deps = makeDeps({ logFile });

    const result = await rubySyntaxGateNode(makeNodeConfig("ruby_syntax_gate"), ctx, deps);
    assert.equal(result.outcome, "success");
  });

  test("returns failure with rawOutput when a changed Ruby file has invalid syntax", async (t) => {
    const { repoDir, logFile, cleanup } = await makeGitRepo("ruby-gate-fail-");
    t.after(cleanup);
    await installFakeRuby(t);

    await writeFile(path.join(repoDir, "broken.rb"), "class Broken\n  def call(\nend\n", "utf8");

    const ctx = new ContextBag({ repoDir });
    const deps = makeDeps({ logFile });

    const result = await rubySyntaxGateNode(makeNodeConfig("ruby_syntax_gate"), ctx, deps);
    assert.equal(result.outcome, "failure");
    assert.match(result.error ?? "", /Ruby syntax check failed/i);
    assert.ok(result.rawOutput?.includes("broken.rb"));
  });
});

describe("lightweightChecksNode", () => {
  test("returns success when changed JavaScript files pass syntax check", async (t) => {
    const { repoDir, logFile, cleanup } = await makeGitRepo("lightweight-js-pass-");
    t.after(cleanup);

    await writeFile(path.join(repoDir, "worker.js"), "export function call() { return 1; }\n", "utf8");

    const ctx = new ContextBag({ repoDir });
    const deps = makeDeps({ logFile });

    const result = await lightweightChecksNode(makeNodeConfig("lightweight_checks"), ctx, deps);
    assert.equal(result.outcome, "success");
  });

  test("returns failure with rawOutput when a changed JavaScript file has invalid syntax", async (t) => {
    const { repoDir, logFile, cleanup } = await makeGitRepo("lightweight-js-fail-");
    t.after(cleanup);

    await writeFile(path.join(repoDir, "broken.js"), "const foo = ;\n", "utf8");

    const ctx = new ContextBag({ repoDir });
    const deps = makeDeps({ logFile });

    const result = await lightweightChecksNode(makeNodeConfig("lightweight_checks"), ctx, deps);
    assert.equal(result.outcome, "failure");
    assert.match(result.error ?? "", /JavaScript syntax check failed/i);
    assert.ok(result.rawOutput?.includes("broken.js"));
  });
});

describe("pipeline-loader accepts lightweight_checks and ruby_syntax_gate", () => {
  test("lightweight_checks is a valid registered action", async () => {
    const { loadPipelineFromString } = await import("../src/pipeline/pipeline-loader.js");

    const pipeline = loadPipelineFromString(`
version: 1
name: "lightweight-checks-test"
nodes:
  - id: checks
    type: deterministic
    action: lightweight_checks
`);

    assert.equal(pipeline.nodes.length, 1);
    assert.equal(pipeline.nodes[0].action, "lightweight_checks");
  });

  test("ruby_syntax_gate is a valid registered action", async () => {
    const { loadPipelineFromString } = await import("../src/pipeline/pipeline-loader.js");

    const pipeline = loadPipelineFromString(`
version: 1
name: "ruby-syntax-gate-test"
nodes:
  - id: ruby
    type: deterministic
    action: ruby_syntax_gate
`);

    assert.equal(pipeline.nodes.length, 1);
    assert.equal(pipeline.nodes[0].action, "ruby_syntax_gate");
  });
});

describe("syncBaseBranchNode", () => {
  test("sync_base_branch is a valid registered action", async () => {
    const { loadPipelineFromString } = await import("../src/pipeline/pipeline-loader.js");

    const pipeline = loadPipelineFromString(`
version: 1
name: "sync-base-branch-test"
nodes:
  - id: sync
    type: deterministic
    action: sync_base_branch
`);

    assert.equal(pipeline.nodes.length, 1);
    assert.equal(pipeline.nodes[0].action, "sync_base_branch");
  });

  test("returns a no-op when the branch is not behind enough commits", async (t) => {
    const { originDir, repoDir, logFile, cleanup } = await makeGitRepoWithOrigin("sync-base-noop-");
    t.after(cleanup);

    await writeFile(path.join(originDir, "base-only.txt"), "main change\n", "utf8");
    await runShellCapture("git add base-only.txt", { cwd: originDir, logFile });
    await runShellCapture("git commit -m 'advance main once'", { cwd: originDir, logFile });

    const oldHead = (await runShellCapture("git rev-parse HEAD", { cwd: repoDir, logFile })).stdout.trim();
    const { syncBaseBranchNode } = await import("../src/pipeline/nodes/sync-base-branch.js");
    const ctx = new ContextBag({ repoDir, resolvedBaseBranch: "main" });
    const deps = makeDeps({
      logFile,
      run: makeRun({
        baseBranch: "main",
        branchName: "feature/rebase-test",
        prefetchContext: makeEligiblePrefetchContext(),
      }),
      configOverrides: { autoReviewBranchSyncMaxBehindCommits: 5 } as Partial<AppConfig>,
    });

    const result = await syncBaseBranchNode(makeNodeConfig("sync_base_branch"), ctx, deps);
    const newHead = (await runShellCapture("git rev-parse HEAD", { cwd: repoDir, logFile })).stdout.trim();

    assert.equal(result.outcome, "success");
    assert.equal(result.outputs?.rebasePerformed, false);
    assert.equal(result.outputs?.requiresForcePush, false);
    assert.equal(oldHead, newHead);
  });

  test("rebases stale branches and prefers feature content on auto-resolved conflicts", async (t) => {
    const { originDir, repoDir, logFile, cleanup } = await makeGitRepoWithOrigin("sync-base-rebase-");
    t.after(cleanup);

    await writeFile(path.join(originDir, "conflict.txt"), "main-version\n", "utf8");
    await runShellCapture("git add conflict.txt", { cwd: originDir, logFile });
    await runShellCapture("git commit -m 'main conflict change'", { cwd: originDir, logFile });

    await writeFile(path.join(repoDir, "conflict.txt"), "feature-version\n", "utf8");
    await runShellCapture("git add conflict.txt", { cwd: repoDir, logFile });
    await runShellCapture("git commit -m 'feature conflict change'", { cwd: repoDir, logFile });

    const oldHead = (await runShellCapture("git rev-parse HEAD", { cwd: repoDir, logFile })).stdout.trim();
    const { syncBaseBranchNode } = await import("../src/pipeline/nodes/sync-base-branch.js");
    const ctx = new ContextBag({ repoDir, resolvedBaseBranch: "main" });
    const deps = makeDeps({
      logFile,
      run: makeRun({
        baseBranch: "main",
        branchName: "feature/rebase-test",
        prefetchContext: makeEligiblePrefetchContext(),
      }),
      configOverrides: { autoReviewBranchSyncMaxBehindCommits: 0 } as Partial<AppConfig>,
    });

    const result = await syncBaseBranchNode(makeNodeConfig("sync_base_branch"), ctx, deps);
    const newHead = (await runShellCapture("git rev-parse HEAD", { cwd: repoDir, logFile })).stdout.trim();
    const content = await readFile(path.join(repoDir, "conflict.txt"), "utf8");
    const status = await runShellCapture("git status --porcelain", { cwd: repoDir, logFile });

    assert.equal(result.outcome, "success");
    assert.equal(result.outputs?.rebasePerformed, true);
    assert.equal(result.outputs?.requiresForcePush, true);
    assert.notEqual(oldHead, newHead);
    assert.equal(content.trim(), "feature-version");
    assert.equal(status.stdout.trim(), "");
  });

  test("prefers the current PR base branch over a stale run base branch", async (t) => {
    const { originDir, repoDir, logFile, cleanup } = await makeGitRepoWithOrigin("sync-base-pr-base-");
    t.after(cleanup);

    await runShellCapture("git checkout -b release/2026.04", { cwd: originDir, logFile });
    await writeFile(path.join(originDir, "release-only.txt"), "release change\n", "utf8");
    await runShellCapture("git add release-only.txt", { cwd: originDir, logFile });
    await runShellCapture("git commit -m 'advance release branch'", { cwd: originDir, logFile });
    await runShellCapture("git checkout main", { cwd: originDir, logFile });

    const { syncBaseBranchNode } = await import("../src/pipeline/nodes/sync-base-branch.js");
    const ctx = new ContextBag({ repoDir, resolvedBaseBranch: "main" });
    const deps = makeDeps({
      logFile,
      run: makeRun({
        baseBranch: "main",
        branchName: "feature/rebase-test",
        prefetchContext: {
          ...makeEligiblePrefetchContext(),
          github: {
            pr: {
              number: 17,
              url: "https://github.com/owner/repo/pull/17",
              title: "Keep PR branch fresh",
              body: "Rebase onto the current PR base branch.",
              state: "open",
              baseRef: "release/2026.04",
              headRef: "feature/rebase-test",
            },
            discussionComments: [],
            reviews: [],
            reviewComments: [],
            ci: {
              conclusion: "no_ci",
            },
          },
        },
      }),
      configOverrides: { autoReviewBranchSyncMaxBehindCommits: 0 } as Partial<AppConfig>,
    });

    const result = await syncBaseBranchNode(makeNodeConfig("sync_base_branch"), ctx, deps);
    const releaseOnlyFile = await readFile(path.join(repoDir, "release-only.txt"), "utf8");

    assert.equal(result.outcome, "success");
    assert.equal(result.outputs?.rebasePerformed, true);
    assert.equal(result.outputs?.requiresForcePush, true);
    assert.equal(releaseOnlyFile.trim(), "release change");
  });

  test("does not rebase when engineering and QA reviews are not both complete", async (t) => {
    const { originDir, repoDir, logFile, cleanup } = await makeGitRepoWithOrigin("sync-base-guard-");
    t.after(cleanup);

    await writeFile(path.join(originDir, "base-only.txt"), "main change\n", "utf8");
    await runShellCapture("git add base-only.txt", { cwd: originDir, logFile });
    await runShellCapture("git commit -m 'advance main once'", { cwd: originDir, logFile });

    const oldHead = (await runShellCapture("git rev-parse HEAD", { cwd: repoDir, logFile })).stdout.trim();
    const { syncBaseBranchNode } = await import("../src/pipeline/nodes/sync-base-branch.js");
    const ctx = new ContextBag({ repoDir, resolvedBaseBranch: "main" });
    const deps = makeDeps({
      logFile,
      run: makeRun({
        baseBranch: "main",
        branchName: "feature/rebase-test",
        prefetchContext: {
          ...makeEligiblePrefetchContext(),
          workItem: {
            ...makeEligiblePrefetchContext().workItem,
            flags: ["engineering_review_done"],
          },
        },
      }),
      configOverrides: { autoReviewBranchSyncMaxBehindCommits: 0 } as Partial<AppConfig>,
    });

    const result = await syncBaseBranchNode(makeNodeConfig("sync_base_branch"), ctx, deps);
    const newHead = (await runShellCapture("git rev-parse HEAD", { cwd: repoDir, logFile })).stdout.trim();

    assert.equal(result.outcome, "success");
    assert.equal(result.outputs?.rebasePerformed, false);
    assert.equal(result.outputs?.requiresForcePush, false);
    assert.equal(oldHead, newHead);
  });
});

describe("squashReadyForMergeNode", () => {
  test("squash_ready_for_merge is a valid registered action", async () => {
    const { loadPipelineFromString } = await import("../src/pipeline/pipeline-loader.js");

    const pipeline = loadPipelineFromString(`
version: 1
name: "ready-for-merge-test"
nodes:
  - id: squash
    type: deterministic
    action: squash_ready_for_merge
`);

    assert.equal(pipeline.nodes.length, 1);
    assert.equal(pipeline.nodes[0].action, "squash_ready_for_merge");
  });

  test("returns a no-op when the PR branch already has a single commit", async (t) => {
    const { repoDir, logFile, cleanup } = await makeGitRepoWithOrigin("squash-ready-noop-");
    t.after(cleanup);

    await writeFile(path.join(repoDir, "feature-only.txt"), "feature change\n", "utf8");
    await runShellCapture("git add feature-only.txt", { cwd: repoDir, logFile });
    await runShellCapture("git commit -m 'feature change'", { cwd: repoDir, logFile });

    const oldHead = (await runShellCapture("git rev-parse HEAD", { cwd: repoDir, logFile })).stdout.trim();
    const { squashReadyForMergeNode } = await import("../src/pipeline/nodes/squash-ready-for-merge.js");
    const ctx = new ContextBag({ repoDir, resolvedBaseBranch: "main" });
    const deps = makeDeps({
      logFile,
      run: makeRun({
        baseBranch: "main",
        branchName: "feature/rebase-test",
      }),
    });

    const result = await squashReadyForMergeNode(makeNodeConfig("squash_ready_for_merge"), ctx, deps);
    const newHead = (await runShellCapture("git rev-parse HEAD", { cwd: repoDir, logFile })).stdout.trim();

    assert.equal(result.outcome, "success");
    assert.equal(result.outputs?.squashPerformed, false);
    assert.equal(result.outputs?.requiresForcePush, false);
    assert.equal(oldHead, newHead);
  });

  test("squashes multi-commit PR branches into one commit using the first subject and the remaining subjects in body", async (t) => {
    const { repoDir, logFile, cleanup } = await makeGitRepoWithOrigin("squash-ready-run-");
    t.after(cleanup);

    await writeFile(path.join(repoDir, "feature-only.txt"), "first change\n", "utf8");
    await runShellCapture("git add feature-only.txt", { cwd: repoDir, logFile });
    await runShellCapture("git commit -m 'feature change 1'", { cwd: repoDir, logFile });

    await writeFile(path.join(repoDir, "feature-only.txt"), "second change\n", "utf8");
    await runShellCapture("git add feature-only.txt", { cwd: repoDir, logFile });
    await runShellCapture("git commit -m 'feature change 2'", { cwd: repoDir, logFile });

    await writeFile(path.join(repoDir, "feature-only.txt"), "third change\n", "utf8");
    await runShellCapture("git add feature-only.txt", { cwd: repoDir, logFile });
    await runShellCapture("git commit -m 'feature change 3'", { cwd: repoDir, logFile });

    const oldHead = (await runShellCapture("git rev-parse HEAD", { cwd: repoDir, logFile })).stdout.trim();
    const { squashReadyForMergeNode } = await import("../src/pipeline/nodes/squash-ready-for-merge.js");
    const ctx = new ContextBag({ repoDir, resolvedBaseBranch: "main" });
    const deps = makeDeps({
      logFile,
      run: makeRun({
        baseBranch: "main",
        branchName: "feature/rebase-test",
        prefetchContext: {
          ...makeEligiblePrefetchContext(),
          github: {
            pr: {
              number: 17,
              url: "https://github.com/owner/repo/pull/17",
              title: "Squash me",
              body: "Combine feature commits before merge.",
              state: "open",
              baseRef: "main",
              headRef: "feature/rebase-test",
            },
            discussionComments: [],
            reviews: [],
            reviewComments: [],
            ci: {
              conclusion: "no_ci",
            },
          },
        },
      }),
    });

    const result = await squashReadyForMergeNode(makeNodeConfig("squash_ready_for_merge"), ctx, deps);
    const newHead = (await runShellCapture("git rev-parse HEAD", { cwd: repoDir, logFile })).stdout.trim();
    const commitCount = (await runShellCapture("git rev-list --count origin/main..HEAD", { cwd: repoDir, logFile })).stdout.trim();
    const commitSubject = (await runShellCapture("git log -1 --format=%s", { cwd: repoDir, logFile })).stdout.trim();
    const commitBody = (await runShellCapture("git log -1 --format=%b", { cwd: repoDir, logFile })).stdout.trim();
    const status = await runShellCapture("git status --porcelain", { cwd: repoDir, logFile });

    assert.equal(result.outcome, "success");
    assert.equal(result.outputs?.squashPerformed, true);
    assert.equal(result.outputs?.requiresForcePush, true);
    assert.equal(result.outputs?.forcePushWithLease, true);
    assert.notEqual(oldHead, newHead);
    assert.equal(commitCount, "1");
    assert.equal(commitSubject, "feature change 1");
    assert.equal(commitBody, "feature change 2\nfeature change 3");
    assert.equal(status.stdout.trim(), "");
  });
});

// ═══════════════════════════════════════════════════════
// Plan Task Node (import separately — depends on LLM module)
// ═══════════════════════════════════════════════════════

describe("planTaskNode", () => {
  // Dynamic import to avoid issues if LLM module has side effects
  let planTaskNode: typeof import("../src/pipeline/nodes/plan-task.js")["planTaskNode"];

  test("skips when no openrouterApiKey is set", async () => {
    // Import the module
    const mod = await import("../src/pipeline/nodes/plan-task.js");
    planTaskNode = mod.planTaskNode;

    const ctx = new ContextBag({ repoSummary: "some context" });
    const deps = makeDeps({ configOverrides: { openrouterApiKey: undefined } });

    const result = await planTaskNode(makeNodeConfig("plan_task"), ctx, deps);
    assert.equal(result.outcome, "skipped");
  });

  test("skips when openrouterApiKey is empty string", async () => {
    const mod = await import("../src/pipeline/nodes/plan-task.js");
    planTaskNode = mod.planTaskNode;

    const ctx = new ContextBag({ repoSummary: "some context" });
    // Config with explicitly undefined API key (empty string gets trimmed to undefined in config loader)
    const deps = makeDeps({ configOverrides: { openrouterApiKey: undefined } });

    const result = await planTaskNode(makeNodeConfig("plan_task"), ctx, deps);
    assert.equal(result.outcome, "skipped");
  });
});

// ═══════════════════════════════════════════════════════
// Notify Node
// ═══════════════════════════════════════════════════════

function makeNotifyConfig(config?: Record<string, unknown>): NodeConfig {
  return { id: "notify", type: "deterministic", action: "notify", config };
}

describe("notifyNode", () => {
  test("skips when no webhook_url configured", async () => {
    const ctx = new ContextBag();
    const deps = makeDeps({ configOverrides: { appName: "TestApp" } });
    const result = await notifyNode(makeNotifyConfig(), ctx, deps);
    assert.equal(result.outcome, "skipped");
  });

  test("skips when webhook_url is empty string", async () => {
    const ctx = new ContextBag();
    const deps = makeDeps({ configOverrides: { appName: "TestApp" } });
    const result = await notifyNode(makeNotifyConfig({ webhook_url: "" }), ctx, deps);
    assert.equal(result.outcome, "skipped");
  });

  test("skips when webhook_url has invalid scheme", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "notify-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const ctx = new ContextBag();
    const deps = makeDeps({ configOverrides: { appName: "TestApp" }, logFile });
    const result = await notifyNode(
      makeNotifyConfig({ webhook_url: "ftp://bad.example.com" }),
      ctx,
      deps
    );
    assert.equal(result.outcome, "skipped");

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns success on 200 response", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "notify-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const mockFetch = mock.method(globalThis, "fetch", async () => {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const ctx = new ContextBag({ prUrl: "https://github.com/org/repo/pull/1" });
    const deps = makeDeps({ configOverrides: { appName: "TestApp" }, logFile });
    const result = await notifyNode(
      makeNotifyConfig({ webhook_url: "https://hook.example.com/test" }),
      ctx,
      deps
    );

    assert.equal(result.outcome, "success");
    assert.equal(mockFetch.mock.calls.length, 1);

    const callArgs = mockFetch.mock.calls[0]!.arguments;
    assert.equal(callArgs[0], "https://hook.example.com/test");
    const body = JSON.parse((callArgs[1] as RequestInit).body as string) as Record<string, unknown>;
    assert.equal(body["event"], "pipeline_completed");
    assert.equal(body["pr_url"], "https://github.com/org/repo/pull/1");

    mockFetch.mock.restore();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns soft_fail on non-2xx response", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "notify-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const mockFetch = mock.method(globalThis, "fetch", async () => {
      return new Response("Internal Server Error", { status: 500 });
    });

    const ctx = new ContextBag();
    const deps = makeDeps({ configOverrides: { appName: "TestApp" }, logFile });
    const result = await notifyNode(
      makeNotifyConfig({ webhook_url: "https://hook.example.com/test" }),
      ctx,
      deps
    );

    assert.equal(result.outcome, "soft_fail");
    assert.ok(result.error?.includes("500"));

    mockFetch.mock.restore();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns soft_fail on network error", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "notify-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const mockFetch = mock.method(globalThis, "fetch", async () => {
      throw new Error("Connection refused");
    });

    const ctx = new ContextBag();
    const deps = makeDeps({ configOverrides: { appName: "TestApp" }, logFile });
    const result = await notifyNode(
      makeNotifyConfig({ webhook_url: "https://hook.example.com/test" }),
      ctx,
      deps
    );

    assert.equal(result.outcome, "soft_fail");
    assert.ok(result.error?.includes("Connection refused"));

    mockFetch.mock.restore();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("includes custom headers in webhook request", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "notify-"));
    const logFile = path.join(tmpDir, "test.log");
    await writeFile(logFile, "", "utf8");

    const mockFetch = mock.method(globalThis, "fetch", async () => {
      return new Response("OK", { status: 200 });
    });

    const ctx = new ContextBag();
    const deps = makeDeps({ configOverrides: { appName: "TestApp" }, logFile });
    await notifyNode(
      makeNotifyConfig({
        webhook_url: "https://hook.example.com/test",
        webhook_headers: { Authorization: "Bearer secret123" }
      }),
      ctx,
      deps
    );

    const callArgs = mockFetch.mock.calls[0]!.arguments;
    const headers = (callArgs[1] as RequestInit).headers as Record<string, string>;
    assert.equal(headers["Authorization"], "Bearer secret123");
    assert.equal(headers["Content-Type"], "application/json");

    mockFetch.mock.restore();
    await rm(tmpDir, { recursive: true, force: true });
  });
});

describe("waitCiNode", () => {
  test("emits external CI checkpoint after entering awaiting_ci", async () => {
    const checkpoints: unknown[] = [];
    const phases: string[] = [];
    const ctx = new ContextBag({ commitSha: "abc123456789", prNumber: 42 });
    const deps = makeDeps({
      configOverrides: {
        ciWaitEnabled: true,
        ciCheckFilter: [],
        ciPatienceTimeoutSeconds: 0,
        ciMaxWaitSeconds: 1,
        ciPollIntervalSeconds: 1,
      },
      githubService: {
        listCheckRuns: async () => [],
      } as unknown as NodeDeps["githubService"],
      onPhase: async (phase) => {
        phases.push(phase);
      },
      emitRunCheckpoint: async (checkpoint) => {
        checkpoints.push(checkpoint);
      },
    });

    const result = await waitCiNode(makeNodeConfig("wait_ci"), ctx, deps);

    assert.equal(result.outcome, "success");
    assert.deepEqual(phases, ["awaiting_ci"]);
    assert.deepEqual(checkpoints, [{
      checkpointKey: "external_ci_wait_started",
      checkpointType: "run.waiting_external_ci",
      payload: {
        nodeId: "wait_ci",
        commitSha: "abc123456789",
        repo: "org/repo",
        prNumber: 42,
      },
    }]);
  });
});
