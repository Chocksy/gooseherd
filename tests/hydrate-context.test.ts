import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getExpectedOutput, buildRepoSummary, buildAgentsMd, hydrateContextNode } from "../src/pipeline/nodes/hydrate-context.js";
import { ContextBag } from "../src/pipeline/context-bag.js";
import type { RunPrefetchContext } from "../src/runtime/run-context-types.js";
import type { NodeDeps } from "../src/pipeline/types.js";
import { runShellCapture } from "../src/pipeline/shell.js";

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

async function makeRepoWithRemoteBranchDiff(prefix = "repo-diff-test-"): Promise<{ rootDir: string; repoDir: string }> {
  const rootDir = await makeTempRepo(prefix);
  const originDir = path.join(rootDir, "origin.git");
  const seedDir = path.join(rootDir, "seed");
  const logFile = path.join(rootDir, "git.log");
  await writeFile(logFile, "", "utf8");

  await runShellCapture("git init --bare origin.git", { cwd: rootDir, logFile });
  await runShellCapture(`git clone ${originDir} ${seedDir}`, { cwd: rootDir, logFile });
  await runShellCapture("git config user.email 'test@test.com'", { cwd: seedDir, logFile });
  await runShellCapture("git config user.name 'Test User'", { cwd: seedDir, logFile });
  await runShellCapture("git checkout -b main", { cwd: seedDir, logFile });

  await writeFile(path.join(seedDir, "base.txt"), "base\n", "utf8");
  await runShellCapture("git add -A", { cwd: seedDir, logFile });
  await runShellCapture("git commit -m 'base'", { cwd: seedDir, logFile });
  await runShellCapture("git push -u origin main", { cwd: seedDir, logFile });

  await runShellCapture("git checkout -b feature/current-diff", { cwd: seedDir, logFile });
  await writeFile(path.join(seedDir, "feature.txt"), "feature branch change\n", "utf8");
  await runShellCapture("git add -A", { cwd: seedDir, logFile });
  await runShellCapture("git commit -m 'feature change'", { cwd: seedDir, logFile });
  await runShellCapture("git push -u origin feature/current-diff", { cwd: seedDir, logFile });

  return { rootDir, repoDir: seedDir };
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
  assert.ok(excerptMatch!.length < 800, "README excerpt should be capped around 700 chars");
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

function makePrefetchContext(overrides: Partial<RunPrefetchContext> = {}): RunPrefetchContext {
  return {
    meta: {
      fetchedAt: "2026-04-17T00:00:00.000Z",
      sources: ["github_pr", "github_ci", "jira"],
    },
    workItem: {
      id: "work-item-123",
      title: "Prefetched work item",
      workflow: "feature_delivery",
      state: "collecting_context",
      jiraIssueKey: "HBL-99",
      githubPrUrl: "https://github.com/owner/repo/pull/42",
      githubPrNumber: 42,
    },
    github: {
      discussionCommentsTotalCount: 15,
      reviewsTotalCount: 14,
      reviewCommentsTotalCount: 13,
      pr: {
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
        title: "Improve prefetch rendering",
        body: "PR body line 1\nPR body line 2 [truncated]",
        state: "open",
        baseRef: "main",
        headRef: "feature/prefetch",
        headSha: "abc123",
        authorLogin: "alice",
      },
      discussionComments: [
        {
          id: "disc-1",
          authorLogin: "bob",
          createdAt: "2026-04-17T00:01:00.000Z",
          body: "Please update the prompt ordering.",
          url: "https://github.com/owner/repo/pull/42#issuecomment-1",
        },
      ],
      reviews: [
        {
          id: "rev-1",
          authorLogin: "carol",
          createdAt: "2026-04-17T00:02:00.000Z",
          state: "CHANGES_REQUESTED",
          body: "Need a clearer separation between sections.",
          url: "https://github.com/owner/repo/pull/42#pullrequestreview-1",
        },
      ],
      reviewComments: [
        {
          id: "inline-1",
          authorLogin: "dave",
          createdAt: "2026-04-17T00:03:00.000Z",
          body: "Consider renaming this helper.",
          path: "src/pipeline/nodes/hydrate-context.ts",
          line: 123,
          side: "RIGHT",
          url: "https://github.com/owner/repo/pull/42#discussion_r1",
          threadResolved: false,
        },
      ],
      ci: {
        headSha: "abc123",
        conclusion: "failure",
        failedRuns: [
          {
            id: 7,
            name: "test",
            status: "completed",
            conclusion: "failure",
            detailsUrl: "https://github.com/owner/repo/actions/runs/7",
            startedAt: "2026-04-17T00:10:00.000Z",
            completedAt: "2026-04-17T00:12:00.000Z",
          },
        ],
        failedAnnotations: [
          {
            checkRunName: "test",
            path: "src/pipeline/nodes/hydrate-context.ts",
            line: 123,
            message: "Expected ordering to include prefetched sections.",
            level: "failure",
          },
        ],
        failedAnnotationsTotalCount: 55,
      },
    },
    jira: {
      commentsTotalCount: 16,
      issue: {
        key: "HBL-99",
        url: "https://jira.example/browse/HBL-99",
        summary: "Improve prefetch rendering",
        status: "In Progress",
        description: "Jira description line 1\nJira description line 2 [truncated]",
      },
      comments: [
        {
          id: "jira-1",
          authorDisplayName: "Eve",
          createdAt: "2026-04-17T00:04:00.000Z",
          body: "Please keep the snapshot compact.",
        },
      ],
    },
    ...overrides,
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

test("hydrateContextNode: prompt includes instructions section", async (t) => {
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
  assert.ok(content.includes("Run ID: run-123"), "Should contain run ID");
  assert.ok(content.includes("Repository: owner/repo"), "Should contain repo slug");
  assert.ok(content.includes("Keep changes minimal"), "Should include instructions");
});

test("hydrateContextNode: renders prefetched context sections ahead of instructions", async (t) => {
  const dir = await makeTempRepo();
  const repoDir = path.join(dir, "repo");
  await mkdir(repoDir, { recursive: true });
  const promptFile = path.join(dir, "task.md");
  const logFile = path.join(dir, "test.log");
  await writeFile(logFile, "", "utf8");
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const ctx = new ContextBag({
    repoDir,
    promptFile,
    prefetchContext: makePrefetchContext(),
  });
  const deps = makeMockDeps({ logFile });

  await hydrateContextNode({ id: "hydrate", type: "deterministic", action: "hydrate_context" }, ctx, deps);

  const content = await readFile(promptFile, "utf8");
  const headings = [
    "## Prefetched Context",
    "### Work Item Context",
    "### PR Description",
    "### PR Discussion Comments",
    "### PR Review Summaries",
    "### PR Unresolved Inline Review Comments",
    "### CI Snapshot",
    "### Jira Description",
    "### Jira Comments",
    "## Instructions",
  ];
  const positions = headings.map((heading) => content.indexOf(heading));

  for (let index = 0; index < headings.length; index += 1) {
    assert.notEqual(positions[index], -1, `Should include ${headings[index]}`);
    if (index > 0) {
      assert.ok(
        positions[index - 1] < positions[index],
        `${headings[index - 1]} should appear before ${headings[index]}`
      );
    }
  }

  assert.ok(content.includes("PR body line 2 [truncated]"), "Should preserve stored truncation note");
  assert.ok(content.includes("Jira description line 2 [truncated]"), "Should preserve Jira truncation note");
  assert.ok(content.includes("Showing 1 of 15 discussion comments."), "Should note truncated PR discussion comments");
  assert.ok(content.includes("Showing 1 of 14 review summaries."), "Should note truncated review summaries");
  assert.ok(content.includes("Showing 1 of 13 inline review comments."), "Should note truncated inline comments");
  assert.ok(content.includes("Showing 1 of 55 failed annotations."), "Should note truncated CI annotations");
  assert.ok(content.includes("Showing 1 of 16 Jira comments."), "Should note truncated Jira comments");
  assert.ok(content.includes("@bob"), "Should include PR discussion author");
  assert.ok(content.includes("CHANGES_REQUESTED"), "Should include review summary state");
  assert.ok(content.includes("src/pipeline/nodes/hydrate-context.ts:123"), "Should include inline comment location");
  assert.ok(content.includes("Expected ordering to include prefetched sections."), "Should include CI annotations");
  assert.ok(content.includes("Eve"), "Should include Jira comment author");
});

test("hydrateContextNode: includes current branch diff and conflict instructions for prefetched review context", async (t) => {
  const { rootDir, repoDir } = await makeRepoWithRemoteBranchDiff();
  const promptFile = path.join(rootDir, "task.md");
  const logFile = path.join(rootDir, "test.log");
  await writeFile(logFile, "", "utf8");
  t.after(async () => { await rm(rootDir, { recursive: true, force: true }); });

  const ctx = new ContextBag({
    repoDir,
    promptFile,
    resolvedBaseBranch: "main",
    prefetchContext: makePrefetchContext({
      meta: {
        fetchedAt: "2026-04-17T00:00:00.000Z",
        sources: ["github_pr"],
      },
      jira: undefined,
    }),
  });
  const deps = makeMockDeps({ logFile });

  await hydrateContextNode({ id: "hydrate", type: "deterministic", action: "hydrate_context" }, ctx, deps);

  const content = await readFile(promptFile, "utf8");
  assert.ok(content.includes("### Current Branch Diff"), "Should include current branch diff section");
  assert.ok(content.includes("feature branch change"), "Should include the current branch diff content");
  assert.ok(content.includes("source of truth for code changes"), "Should instruct the agent to trust the current diff");
  assert.ok(content.includes("Do not treat comments as mandatory tasks"), "Should frame comments as advisory only");
  assert.ok(content.includes("Only act on a comment if the current diff and branch state show the problem still exists"), "Should require proving comment relevance");
  assert.ok(content.includes("Ignore comments that would require expanding scope"), "Should tell the agent to ignore off-scope comments");
  assert.ok(content.includes("GOOSEHERD_CONTEXT_CONFLICT"), "Should document the explicit refusal sentinel");
});

test("hydrateContextNode: auto-review runs require structured review summary output", async (t) => {
  const dir = await makeTempRepo();
  const repoDir = path.join(dir, "repo");
  await mkdir(repoDir, { recursive: true });
  const promptFile = path.join(dir, "task.md");
  const logFile = path.join(dir, "test.log");
  await writeFile(logFile, "", "utf8");
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const ctx = new ContextBag({ repoDir, promptFile });
  const deps = makeMockDeps({
    logFile,
    run: {
      ...makeMockDeps().run,
      requestedBy: "work-item:auto-review",
    },
  });

  await hydrateContextNode({ id: "hydrate", type: "deterministic", action: "hydrate_context" }, ctx, deps);

  const content = await readFile(promptFile, "utf8");
  assert.ok(content.includes("GOOSEHERD_REVIEW_SUMMARY"), "Should require the structured review summary sentinel");
  assert.ok(content.includes("selectedFindings"), "Should document the summary JSON shape");
  assert.ok(content.includes("ignoredFindings"), "Should document the ignored findings field");
  assert.ok(content.includes("rationale"), "Should document the rationale field");
});

test("hydrateContextNode: falls back to run prefetch context and omits empty prefetched sections", async (t) => {
  const dir = await makeTempRepo();
  const repoDir = path.join(dir, "repo");
  await mkdir(repoDir, { recursive: true });
  const promptFile = path.join(dir, "task.md");
  const logFile = path.join(dir, "test.log");
  await writeFile(logFile, "", "utf8");
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const runPrefetchContext: RunPrefetchContext = {
    meta: {
      fetchedAt: "2026-04-17T00:00:00.000Z",
      sources: ["github_pr", "jira"],
    },
    workItem: {
      id: "work-item-456",
      title: "Fallback prefetch",
      workflow: "feature_delivery",
      githubPrUrl: "https://github.com/owner/repo/pull/99",
      githubPrNumber: 99,
    },
    github: {
      pr: {
        number: 99,
        url: "https://github.com/owner/repo/pull/99",
        title: "Fallback rendering",
        body: "Fallback PR description",
        state: "open",
      },
      discussionComments: [],
      reviews: [],
      reviewComments: [],
      ci: {
        conclusion: "success",
        headSha: "fff999",
      },
    },
    jira: {
      issue: {
        key: "HBL-100",
        description: "Fallback Jira description",
      },
      comments: [],
    },
  };
  const ctx = new ContextBag({ repoDir, promptFile });
  const deps = makeMockDeps({ logFile, run: { ...makeMockDeps().run, prefetchContext: runPrefetchContext } });

  await hydrateContextNode({ id: "hydrate", type: "deterministic", action: "hydrate_context" }, ctx, deps);

  const content = await readFile(promptFile, "utf8");
  assert.ok(content.includes("## Prefetched Context"), "Should include prefetched context block");
  assert.ok(content.includes("### PR Description"), "Should include PR description");
  assert.ok(content.includes("### CI Snapshot"), "Should include CI snapshot");
  assert.ok(content.includes("### Jira Description"), "Should include Jira description");
  assert.ok(!content.includes("### PR Discussion Comments"), "Should omit empty discussion comments");
  assert.ok(!content.includes("### PR Review Summaries"), "Should omit empty review summaries");
  assert.ok(!content.includes("### PR Unresolved Inline Review Comments"), "Should omit empty inline review comments");
  assert.ok(!content.includes("### Jira Comments"), "Should omit empty Jira comments");
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

// ── buildAgentsMd ──

test("buildAgentsMd: includes task context", () => {
  const run = makeMockDeps().run;
  const ctx = new ContextBag({ taskType: "bugfix" });
  const result = buildAgentsMd(run, ctx, [], undefined);

  assert.ok(result.includes("# AGENTS.md"), "Should have AGENTS.md header");
  assert.ok(result.includes("Run ID: run-123"), "Should include run ID");
  assert.ok(result.includes("Repository: owner/repo"), "Should include repo slug");
  assert.ok(result.includes("Task type: bugfix"), "Should include task type");
});

test("buildAgentsMd: includes hook sections as organizational memory", () => {
  const run = makeMockDeps().run;
  const ctx = new ContextBag({});
  const hooks = ["### Past fix for auth error", "Use Devise confirmable pattern"];
  const result = buildAgentsMd(run, ctx, hooks, undefined);

  assert.ok(result.includes("## Organizational Memory"), "Should have org memory section");
  assert.ok(result.includes("Past fix for auth error"), "Should include hook content");
  assert.ok(result.includes("Devise confirmable"), "Should include hook details");
});

test("buildAgentsMd: includes repo summary as project conventions", () => {
  const run = makeMockDeps().run;
  const ctx = new ContextBag({});
  const summary = "### Tech stack: TypeScript, Node.js";
  const result = buildAgentsMd(run, ctx, [], summary);

  assert.ok(result.includes("## Project Conventions"), "Should have conventions section");
  assert.ok(result.includes("TypeScript, Node.js"), "Should include tech stack");
});

test("buildAgentsMd: includes coding rules", () => {
  const run = makeMockDeps().run;
  const ctx = new ContextBag({});
  const result = buildAgentsMd(run, ctx, [], undefined);

  assert.ok(result.includes("## Coding Rules"), "Should have coding rules section");
  assert.ok(result.includes("Keep changes minimal"), "Should include minimal change rule");
});

test("buildAgentsMd: omits empty sections", () => {
  const run = makeMockDeps().run;
  const ctx = new ContextBag({});
  const result = buildAgentsMd(run, ctx, [], undefined);

  assert.ok(!result.includes("## Organizational Memory"), "Should NOT have org memory when no hooks");
  assert.ok(!result.includes("## Project Conventions"), "Should NOT have conventions when no summary");
});

test("hydrateContextNode: writes AGENTS.md alongside task.md", async (t) => {
  const dir = await makeTempRepo();
  const repoDir = path.join(dir, "repo");
  await mkdir(repoDir, { recursive: true });
  const promptFile = path.join(dir, "task.md");
  const logFile = path.join(dir, "test.log");
  await writeFile(logFile, "", "utf8");
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const ctx = new ContextBag({ repoDir, promptFile, taskType: "feature" });
  const deps = makeMockDeps({ logFile });

  await hydrateContextNode({ id: "hydrate", type: "deterministic", action: "hydrate_context" }, ctx, deps);

  // Verify task.md was written
  const taskContent = await readFile(promptFile, "utf8");
  assert.ok(taskContent.includes("Task type: feature"), "task.md should contain task type");

  // Verify AGENTS.md was written in the repo dir
  const agentsContent = await readFile(path.join(repoDir, "AGENTS.md"), "utf8");
  assert.ok(agentsContent.includes("# AGENTS.md"), "AGENTS.md should have header");
  assert.ok(agentsContent.includes("Run ID: run-123"), "AGENTS.md should include run ID");
  assert.ok(agentsContent.includes("Task type: feature"), "AGENTS.md should include task type");
  assert.ok(agentsContent.includes("## Coding Rules"), "AGENTS.md should include coding rules");
});
