import assert from "node:assert/strict";
import test from "node:test";
import { GitHubService } from "../src/github.js";
import { JiraClient } from "../src/jira.js";
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

test("buildPrBody: filters internal-generated files from changed files", () => {
  const analysis: AgentAnalysis = {
    verdict: "clean",
    filesChanged: ["AGENTS.md", "src/index.ts"],
    diffSummary: "2 files changed",
    diffStats: { added: 10, removed: 0, filesCount: 2 },
    signals: []
  };
  const body = buildPrBody(BASE_RUN, "main", "Gooseherd", false, undefined, analysis, undefined, [
    "AGENTS.md",
    "src/index.ts"
  ]);

  assert.ok(body.includes("`src/index.ts`"));
  assert.ok(!body.includes("`AGENTS.md`"));
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

test("buildPrBody: includes auto-review grounding metrics when present", () => {
  const analysis: AgentAnalysis = {
    verdict: "clean",
    filesChanged: ["app/jobs/queued_message_call_job.rb"],
    diffSummary: "1 file changed",
    diffStats: { added: 10, removed: 2, filesCount: 1 },
    signals: []
  };
  const body = buildPrBody(
    { ...BASE_RUN, requestedBy: "work-item:auto-review" },
    "main",
    "Gooseherd",
    false,
    undefined,
    analysis,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      selectedFindingCount: 2,
      selectedFindingOverlapCount: 1,
      selectedFindingOverlapRatio: 0.5,
      ignoredFindingCount: 1,
      ignoredFindingOverlapCount: 0
    }
  );

  assert.ok(body.includes("Auto-review grounding"));
  assert.ok(body.includes("1/2"));
  assert.ok(body.includes("50%"));
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

test("GitHubService: unresolved review comments keep only unresolved threads", async () => {
  const service = Object.create(GitHubService.prototype) as GitHubService & { octokit: any };
  service.octokit = {
    graphql: async () => ({
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: {
              hasNextPage: false,
              endCursor: undefined
            },
            nodes: [
              {
                id: "thread-1",
                isResolved: false,
                comments: {
                  pageInfo: {
                    hasNextPage: false,
                    endCursor: undefined
                  },
                  nodes: [
                    {
                      id: "r1",
                      author: { login: "reviewer1" },
                      createdAt: "2026-04-17T10:00:00Z",
                      body: "Please rename this",
                      path: "src/app.ts",
                      line: 42,
                      url: "https://github.com/org/repo/pull/1#discussion_r1"
                    }
                  ]
                }
              },
              {
                id: "thread-2",
                isResolved: true,
                comments: {
                  pageInfo: {
                    hasNextPage: false,
                    endCursor: undefined
                  },
                  nodes: [
                    {
                      id: "r2",
                      author: { login: "reviewer2" },
                      createdAt: "2026-04-17T11:00:00Z",
                      body: "Resolved feedback",
                      path: "src/app.ts",
                      line: 99,
                      url: "https://github.com/org/repo/pull/1#discussion_r2"
                    }
                  ]
                }
              }
            ]
          }
        }
      }
    })
  };

  const comments = await service.listUnresolvedReviewComments("org/repo", 1);

  assert.deepEqual(comments, [
    {
      id: "r1",
      authorLogin: "reviewer1",
      createdAt: "2026-04-17T10:00:00Z",
      body: "Please rename this",
      path: "src/app.ts",
      line: 42,
      url: "https://github.com/org/repo/pull/1#discussion_r1",
      threadResolved: false
    }
  ]);
});

test("GitHubService: CI snapshot keeps only failed runs and annotations", async () => {
  const service = Object.create(GitHubService.prototype) as GitHubService & { octokit: any };
  service.octokit = {
    checks: {
      listForRef: async () => ({
        data: {
          check_runs: [
            {
              id: 10,
              name: "lint",
              status: "completed",
              conclusion: "success"
            },
            {
              id: 11,
              name: "tests",
              status: "completed",
              conclusion: "failure"
            }
          ]
        }
      }),
      listAnnotations: async ({ check_run_id }: { check_run_id: number }) => ({
        data: check_run_id === 11
          ? [
              {
                path: "src/app.ts",
                start_line: 7,
                message: "Expected true but got false",
                annotation_level: "failure"
              }
            ]
          : []
      })
    }
  };

  const snapshot = await service.getPullRequestCiSnapshot("org/repo", "abc123");

  assert.deepEqual(snapshot, {
    headSha: "abc123",
    conclusion: "failure",
    failedRuns: [
      {
        id: 11,
        name: "tests",
        status: "completed",
        conclusion: "failure",
        detailsUrl: undefined,
        startedAt: undefined,
        completedAt: undefined
      }
    ],
    failedAnnotations: [
      {
        checkRunName: "tests",
        path: "src/app.ts",
        line: 7,
        message: "Expected true but got false",
        level: "failure"
      }
    ]
  });
});

test("GitHubService: CI snapshot reports no_ci without failed run details", async () => {
  const service = Object.create(GitHubService.prototype) as GitHubService & { octokit: any };
  service.octokit = {
    checks: {
      listForRef: async () => ({ data: { check_runs: [] } })
    }
  };

  const snapshot = await service.getPullRequestCiSnapshot("org/repo", "abc123");

  assert.deepEqual(snapshot, {
    headSha: "abc123",
    conclusion: "no_ci"
  });
});

test("GitHubService: discussion comments paginate across pages", async () => {
  const calls: Array<{ page: number; per_page: number }> = [];
  const service = Object.create(GitHubService.prototype) as GitHubService & { octokit: any };
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    user: { login: `alice-${index + 1}` },
    created_at: `2026-04-17T10:${String(index).padStart(2, "0")}:00Z`,
    body: `First page ${index + 1}`,
    html_url: `https://github.com/org/repo/pull/1#issuecomment-${index + 1}`
  }));
  service.octokit = {
    issues: {
      listComments: async ({ page, per_page }: { page: number; per_page: number }) => {
        calls.push({ page, per_page });
        if (page === 1) {
          return {
            data: firstPage
          };
        }
        if (page === 2) {
          return {
            data: [
              {
                id: 2,
                user: { login: "bob" },
                created_at: "2026-04-17T11:00:00Z",
                body: "Second page",
                html_url: "https://github.com/org/repo/pull/1#issuecomment-2"
              }
            ]
          };
        }
        return { data: [] };
      }
    }
  };

  const comments = await service.listPullRequestDiscussionComments("org/repo", 1);

  assert.deepEqual(calls, [
    { page: 1, per_page: 100 },
    { page: 2, per_page: 100 }
  ]);
  assert.equal(comments.length, 101);
  assert.deepEqual(comments[0], {
    id: "1",
    authorLogin: "alice-1",
    createdAt: "2026-04-17T10:00:00Z",
    body: "First page 1",
    url: "https://github.com/org/repo/pull/1#issuecomment-1"
  });
  assert.deepEqual(comments[99], {
    id: "100",
    authorLogin: "alice-100",
    createdAt: "2026-04-17T10:99:00Z",
    body: "First page 100",
    url: "https://github.com/org/repo/pull/1#issuecomment-100"
  });
  assert.deepEqual(comments[100], {
    id: "2",
    authorLogin: "bob",
    createdAt: "2026-04-17T11:00:00Z",
    body: "Second page",
    url: "https://github.com/org/repo/pull/1#issuecomment-2"
  });
});

test("GitHubService: review comments paginate across pages", async () => {
  const calls: Array<{ page: number; per_page: number }> = [];
  const service = Object.create(GitHubService.prototype) as GitHubService & { octokit: any };
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    id: index + 10,
    user: { login: `reviewer-a-${index + 1}` },
    submitted_at: `2026-04-17T09:${String(index).padStart(2, "0")}:00Z`,
    state: "APPROVED",
    body: `Looks good ${index + 1}`,
    html_url: `https://github.com/org/repo/pull/1#pullrequestreview-${index + 10}`
  }));
  service.octokit = {
    pulls: {
      listReviews: async ({ page, per_page }: { page: number; per_page: number }) => {
        calls.push({ page, per_page });
        if (page === 1) {
          return {
            data: firstPage
          };
        }
        if (page === 2) {
          return {
            data: [
              {
                id: 11,
                user: { login: "reviewer-b" },
                submitted_at: "2026-04-17T12:00:00Z",
                state: "CHANGES_REQUESTED",
                body: "Please fix",
                html_url: "https://github.com/org/repo/pull/1#pullrequestreview-11"
              }
            ]
          };
        }
        return { data: [] };
      }
    }
  };

  const reviews = await service.listPullRequestReviews("org/repo", 1);

  assert.deepEqual(calls, [
    { page: 1, per_page: 100 },
    { page: 2, per_page: 100 }
  ]);
  assert.equal(reviews.length, 101);
  assert.deepEqual(reviews[0], {
    id: "10",
    authorLogin: "reviewer-a-1",
    createdAt: "2026-04-17T09:00:00Z",
    state: "APPROVED",
    body: "Looks good 1",
    url: "https://github.com/org/repo/pull/1#pullrequestreview-10"
  });
  assert.deepEqual(reviews[99], {
    id: "109",
    authorLogin: "reviewer-a-100",
    createdAt: "2026-04-17T09:99:00Z",
    state: "APPROVED",
    body: "Looks good 100",
    url: "https://github.com/org/repo/pull/1#pullrequestreview-109"
  });
  assert.deepEqual(reviews[100], {
    id: "11",
    authorLogin: "reviewer-b",
    createdAt: "2026-04-17T12:00:00Z",
    state: "CHANGES_REQUESTED",
    body: "Please fix",
    url: "https://github.com/org/repo/pull/1#pullrequestreview-11"
  });
});

test("GitHubService: unresolved review comments paginate threads and thread comments", async () => {
  const calls: Array<{ kind: string; after?: string; threadId?: string }> = [];
  const service = Object.create(GitHubService.prototype) as GitHubService & { octokit: any };
  service.octokit = {
    graphql: async (_query: string, variables: Record<string, unknown>) => {
      if ("threadId" in variables) {
        calls.push({ kind: "thread-comments", threadId: String(variables.threadId), after: variables.after as string | undefined });
        if (variables.after === "comment-cursor-1") {
          return {
            node: {
              comments: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: "comment-cursor-2"
                },
                nodes: [
                  {
                    id: "c2",
                    author: { login: "reviewer-1" },
                    createdAt: "2026-04-17T10:05:00Z",
                    body: "Second comment on thread 1",
                    path: "src/app.ts",
                    line: 43,
                    url: "https://github.com/org/repo/pull/1#discussion_r2"
                  }
                ]
              }
            }
          };
        }
        return {
          node: {
            comments: {
              pageInfo: {
                hasNextPage: false,
                endCursor: undefined
              },
              nodes: []
            }
          }
        };
      }

      calls.push({ kind: "threads", after: variables.after as string | undefined });
      if (variables.after === "thread-cursor-1") {
        return {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: "thread-cursor-2"
                },
                nodes: [
                  {
                    id: "thread-2",
                    isResolved: false,
                    comments: {
                      pageInfo: {
                        hasNextPage: false,
                        endCursor: undefined
                      },
                      nodes: [
                        {
                          id: "c3",
                          author: { login: "reviewer-2" },
                          createdAt: "2026-04-17T11:00:00Z",
                          body: "Thread 2 comment",
                          path: "src/app.ts",
                          line: 99,
                          url: "https://github.com/org/repo/pull/1#discussion_r3"
                        }
                      ]
                    }
                  }
                ]
              }
            }
          }
        };
      }

      return {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: {
                hasNextPage: true,
                endCursor: "thread-cursor-1"
              },
              nodes: [
                {
                  id: "thread-1",
                  isResolved: false,
                  comments: {
                    pageInfo: {
                      hasNextPage: true,
                      endCursor: "comment-cursor-1"
                    },
                    nodes: [
                      {
                        id: "c1",
                        author: { login: "reviewer-1" },
                        createdAt: "2026-04-17T10:00:00Z",
                        body: "First comment on thread 1",
                        path: "src/app.ts",
                        line: 42,
                        url: "https://github.com/org/repo/pull/1#discussion_r1"
                      }
                    ]
                  }
                },
                {
                  id: "thread-resolved",
                  isResolved: true,
                  comments: {
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: undefined
                    },
                    nodes: [
                      {
                        id: "resolved",
                        author: { login: "reviewer-3" },
                        createdAt: "2026-04-17T12:00:00Z",
                        body: "Resolved comment",
                        path: "src/app.ts",
                        line: 123,
                        url: "https://github.com/org/repo/pull/1#discussion_r4"
                      }
                    ]
                  }
                }
              ]
            }
          }
        }
      };
    }
  };

  const comments = await service.listUnresolvedReviewComments("org/repo", 1);

  assert.deepEqual(calls, [
    { kind: "threads", after: undefined },
    { kind: "thread-comments", threadId: "thread-1", after: "comment-cursor-1" },
    { kind: "threads", after: "thread-cursor-1" }
  ]);
  assert.deepEqual(comments, [
    {
      id: "c1",
      authorLogin: "reviewer-1",
      createdAt: "2026-04-17T10:00:00Z",
      body: "First comment on thread 1",
      path: "src/app.ts",
      line: 42,
      url: "https://github.com/org/repo/pull/1#discussion_r1",
      threadResolved: false
    },
    {
      id: "c2",
      authorLogin: "reviewer-1",
      createdAt: "2026-04-17T10:05:00Z",
      body: "Second comment on thread 1",
      path: "src/app.ts",
      line: 43,
      url: "https://github.com/org/repo/pull/1#discussion_r2",
      threadResolved: false
    },
    {
      id: "c3",
      authorLogin: "reviewer-2",
      createdAt: "2026-04-17T11:00:00Z",
      body: "Thread 2 comment",
      path: "src/app.ts",
      line: 99,
      url: "https://github.com/org/repo/pull/1#discussion_r3",
      threadResolved: false
    }
  ]);
});

test("GitHubService: CI snapshot paginates failed runs and failed annotations", async () => {
  const calls: Array<{ kind: string; page?: number; check_run_id?: number }> = [];
  const service = Object.create(GitHubService.prototype) as GitHubService & { octokit: any };
  service.octokit = {
    checks: {
      listForRef: async ({ page, per_page }: { page: number; per_page: number }) => {
        calls.push({ kind: "check-runs", page });
        if (page === 1) {
          return {
            data: {
              check_runs: Array.from({ length: per_page }, (_, index) => ({
                id: index + 1,
                name: `check-${index + 1}`,
                status: "completed",
                conclusion: "success"
              }))
            }
          };
        }
        return {
          data: {
            check_runs: [
              {
                id: 101,
                name: "test-suite",
                status: "completed",
                conclusion: "failure",
                details_url: "https://github.com/org/repo/actions/runs/101",
                started_at: "2026-04-17T12:00:00Z",
                completed_at: "2026-04-17T12:05:00Z"
              }
            ]
          }
        };
      },
      listAnnotations: async ({ check_run_id, page }: { check_run_id: number; page: number }) => {
        calls.push({ kind: "annotations", check_run_id, page });
        if (page === 1) {
          return {
            data: Array.from({ length: 100 }, (_, index) => ({
              path: "src/app.ts",
              start_line: index + 1,
              message: `annotation-${index + 1}`,
              annotation_level: "failure"
            }))
          };
        }
        return {
          data: [
            {
              path: "src/app.ts",
              start_line: 101,
              message: "annotation-101",
              annotation_level: "failure"
            }
          ]
        };
      }
    }
  };

  const snapshot = await service.getPullRequestCiSnapshot("org/repo", "abc123");

  assert.deepEqual(calls, [
    { kind: "check-runs", page: 1 },
    { kind: "check-runs", page: 2 },
    { kind: "annotations", check_run_id: 101, page: 1 },
    { kind: "annotations", check_run_id: 101, page: 2 }
  ]);
  assert.equal(snapshot.conclusion, "failure");
  assert.deepEqual(snapshot.failedRuns, [
    {
      id: 101,
      name: "test-suite",
      status: "completed",
      conclusion: "failure",
      detailsUrl: "https://github.com/org/repo/actions/runs/101",
      startedAt: "2026-04-17T12:00:00Z",
      completedAt: "2026-04-17T12:05:00Z"
    }
  ]);
  assert.equal(snapshot.failedAnnotations?.length, 101);
  assert.deepEqual(snapshot.failedAnnotations?.[0], {
    checkRunName: "test-suite",
    path: "src/app.ts",
    line: 1,
    message: "annotation-1",
    level: "failure"
  });
  assert.deepEqual(snapshot.failedAnnotations?.[100], {
    checkRunName: "test-suite",
    path: "src/app.ts",
    line: 101,
    message: "annotation-101",
    level: "failure"
  });
});

test("JiraClient: comments paginate across pages", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/comment?startAt=0&maxResults=100")) {
        return new Response(JSON.stringify({
          comments: Array.from({ length: 100 }, (_, index) => ({
            id: index + 1,
            author: { displayName: "Alice" },
            created: `2026-04-17T10:${String(index).padStart(2, "0")}:00Z`,
            body: `Comment ${index + 1}`
          })),
          isLast: false,
          maxResults: 100,
          startAt: 0,
          total: 101
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/comment?startAt=100&maxResults=100")) {
        return new Response(JSON.stringify({
          comments: [
            {
              id: 101,
              author: { displayName: "Bob" },
              created: "2026-04-17T12:00:00Z",
              body: "Comment 101"
            }
          ],
          isLast: true,
          maxResults: 100,
          startAt: 100,
          total: 101
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/issue/ABC-1?")) {
        return new Response(JSON.stringify({
          key: "ABC-1",
          fields: {
            summary: "Example issue",
            status: { name: "In Progress" },
            description: "Issue description"
          }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    };

    const client = new JiraClient({
      jiraBaseUrl: "https://example.atlassian.net",
      jiraCloudId: "cloud-123",
      jiraUser: "jira-user@example.com",
      jiraApiToken: "jira-token",
      jiraRequestTimeoutMs: 5_000
    });

    const comments = await client.getComments("ABC-1");

    assert.deepEqual(calls, [
      "https://api.atlassian.com/ex/jira/cloud-123/rest/api/3/issue/ABC-1/comment?startAt=0&maxResults=100",
      "https://api.atlassian.com/ex/jira/cloud-123/rest/api/3/issue/ABC-1/comment?startAt=100&maxResults=100"
    ]);
    assert.equal(comments.length, 101);
    assert.deepEqual(comments[0], {
      id: "1",
      authorDisplayName: "Alice",
      createdAt: "2026-04-17T10:00:00Z",
      body: "Comment 1"
    });
    assert.deepEqual(comments[100], {
      id: "101",
      authorDisplayName: "Bob",
      createdAt: "2026-04-17T12:00:00Z",
      body: "Comment 101"
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("JiraClient: resolves cloudId from tenant_info for scoped requests", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === "https://example.atlassian.net/_edge/tenant_info") {
        return new Response(JSON.stringify({ cloudId: "cloud-tenant-123" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url === "https://api.atlassian.com/ex/jira/cloud-tenant-123/rest/api/3/issue/ABC-1?fields=summary,status,description") {
        return new Response(JSON.stringify({
          key: "ABC-1",
          fields: {
            summary: "Scoped issue",
            status: { name: "Open" },
            description: "Scoped description"
          }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    };

    const client = new JiraClient({
      jiraBaseUrl: "https://example.atlassian.net",
      jiraUser: "jira-user@example.com",
      jiraApiToken: "jira-token",
      jiraRequestTimeoutMs: 5_000
    });

    const issue = await client.getIssue("ABC-1");

    assert.deepEqual(calls, [
      "https://example.atlassian.net/_edge/tenant_info",
      "https://api.atlassian.com/ex/jira/cloud-tenant-123/rest/api/3/issue/ABC-1?fields=summary,status,description"
    ]);
    assert.deepEqual(issue, {
      key: "ABC-1",
      url: "https://example.atlassian.net/browse/ABC-1",
      summary: "Scoped issue",
      status: "Open",
      description: "Scoped description"
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
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
