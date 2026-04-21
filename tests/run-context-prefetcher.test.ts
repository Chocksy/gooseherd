import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createTestDb } from "./helpers/test-db.js";
import { RunContextPrefetcher } from "../src/runtime/run-context-prefetcher.js";
import { teams, users } from "../src/db/schema.js";
import { WorkItemStore } from "../src/work-items/store.js";
import type { RunRecord } from "../src/types.js";
import type { WorkItemRecord } from "../src/work-items/types.js";

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-00000001",
    runtime: "local",
    status: "queued",
    repoSlug: "owner/repo",
    task: "prefetch context",
    baseBranch: "main",
    branchName: "feature/prefetch",
    requestedBy: "U123",
    channelId: "C123",
    threadTs: "123.456",
    createdAt: "2026-04-17T12:00:00.000Z",
    ...overrides,
  };
}

function makeWorkItem(overrides: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    workflow: "feature_delivery",
    state: "auto_review",
    flags: [],
    title: "Prefetch work item",
    summary: "Work item summary",
    ownerTeamId: "team-1",
    homeChannelId: "C123",
    homeThreadTs: "123.456",
    createdByUserId: "U123",
    createdAt: "2026-04-17T11:59:00.000Z",
    updatedAt: "2026-04-17T11:59:00.000Z",
    ...overrides,
  };
}

test("WorkItemStore.requireWorkItem returns a stored work item and throws for missing ids", async (t) => {
  const testDb = await createTestDb();
  t.after(async () => {
    await testDb.cleanup();
  });

  const ownerUserId = randomUUID();
  const ownerTeamId = randomUUID();
  await testDb.db.insert(users).values({
    id: ownerUserId,
    slackUserId: "U_HELPER",
    displayName: "Helper User",
  });
  await testDb.db.insert(teams).values({
    id: ownerTeamId,
    name: "helper-team",
    slackChannelId: "C_HELPER",
  });

  const store = new WorkItemStore(testDb.db);
  const created = await store.createWorkItem({
    workflow: "feature_delivery",
    state: "backlog",
    title: "Lookup helper test",
    summary: "Ensures required lookup behaves predictably",
    ownerTeamId,
    homeChannelId: "C123",
    homeThreadTs: "123.456",
    createdByUserId: ownerUserId,
  });

  const loaded = await store.requireWorkItem(created.id);
  assert.equal(loaded.id, created.id);
  assert.equal(loaded.title, "Lookup helper test");

  const missingId = randomUUID();
  await assert.rejects(() => store.requireWorkItem(missingId), new RegExp(`WorkItem not found: ${missingId}`));
});

test("RunContextPrefetcher returns undefined when the run has no workItemId", async () => {
  let requireWorkItemCalls = 0;
  let githubCalls = 0;
  let jiraCalls = 0;

  const prefetcher = new RunContextPrefetcher({
    workItems: {
      requireWorkItem: async () => {
        requireWorkItemCalls += 1;
        throw new Error("should not be called");
      },
    },
    github: {
      getPullRequest: async () => {
        githubCalls += 1;
        throw new Error("should not be called");
      },
      listPullRequestDiscussionComments: async () => {
        githubCalls += 1;
        throw new Error("should not be called");
      },
      listPullRequestReviews: async () => {
        githubCalls += 1;
        throw new Error("should not be called");
      },
      listUnresolvedReviewComments: async () => {
        githubCalls += 1;
        throw new Error("should not be called");
      },
      getPullRequestCiSnapshot: async () => {
        githubCalls += 1;
        throw new Error("should not be called");
      },
    },
    jira: {
      getIssue: async () => {
        jiraCalls += 1;
        throw new Error("should not be called");
      },
      getComments: async () => {
        jiraCalls += 1;
        throw new Error("should not be called");
      },
    },
  });

  const result = await prefetcher.prefetch(makeRun({ workItemId: undefined }));
  assert.equal(result, undefined);
  assert.equal(requireWorkItemCalls, 0);
  assert.equal(githubCalls, 0);
  assert.equal(jiraCalls, 0);
});

test("RunContextPrefetcher returns undefined when the linked work item has no PR or Jira source", async () => {
  let githubCalls = 0;
  let jiraCalls = 0;

  const prefetcher = new RunContextPrefetcher({
    workItems: {
      requireWorkItem: async () => makeWorkItem(),
    },
    github: {
      getPullRequest: async () => {
        githubCalls += 1;
        throw new Error("should not be called");
      },
      listPullRequestDiscussionComments: async () => {
        githubCalls += 1;
        throw new Error("should not be called");
      },
      listPullRequestReviews: async () => {
        githubCalls += 1;
        throw new Error("should not be called");
      },
      listUnresolvedReviewComments: async () => {
        githubCalls += 1;
        throw new Error("should not be called");
      },
      getPullRequestCiSnapshot: async () => {
        githubCalls += 1;
        throw new Error("should not be called");
      },
    },
    jira: {
      getIssue: async () => {
        jiraCalls += 1;
        throw new Error("should not be called");
      },
      getComments: async () => {
        jiraCalls += 1;
        throw new Error("should not be called");
      },
    },
  });

  const result = await prefetcher.prefetch(makeRun({ workItemId: "11111111-1111-1111-1111-111111111111" }));
  assert.equal(result, undefined);
  assert.equal(githubCalls, 0);
  assert.equal(jiraCalls, 0);
});

test("RunContextPrefetcher normalizes GitHub and Jira bundles into a prefetched snapshot", async () => {
  const workItem = makeWorkItem({
    flags: ["github_pr_adopted"],
    githubPrUrl: "https://github.com/owner/repo/pull/17?expand=1#discussion_r1",
    jiraIssueKey: "HBL-17",
  });

  const githubCalls: string[] = [];
  const jiraCalls: string[] = [];
  const prefetcher = new RunContextPrefetcher({
    workItems: {
      requireWorkItem: async () => workItem,
    },
    github: {
      getPullRequest: async (repoSlug, prNumber) => {
        githubCalls.push(`getPullRequest:${repoSlug}:${prNumber}`);
        return {
          number: prNumber,
          url: `https://github.com/${repoSlug}/pull/${prNumber}`,
          title: "Prefetched PR",
          body: "PR body",
          state: "open",
          baseRef: "main",
          headRef: "feature/prefetch",
          headSha: "sha-123",
          authorLogin: "alice",
        };
      },
      listPullRequestDiscussionComments: async (repoSlug, prNumber) => {
        githubCalls.push(`discussion:${repoSlug}:${prNumber}`);
        return Array.from({ length: 15 }, (_, index) => ({
          id: `c${index + 1}`,
          authorLogin: "bob",
          createdAt: `2026-04-17T11:${String(index).padStart(2, "0")}:00.000Z`,
          body: `Discussion comment ${index + 1}`,
          url: `https://github.com/owner/repo/pull/17#issuecomment-${index + 1}`,
        }));
      },
      listPullRequestReviews: async (repoSlug, prNumber) => {
        githubCalls.push(`reviews:${repoSlug}:${prNumber}`);
        return Array.from({ length: 14 }, (_, index) => ({
          id: `r${index + 1}`,
          authorLogin: "carol",
          createdAt: `2026-04-17T12:${String(index).padStart(2, "0")}:00.000Z`,
          state: "approved",
          body: `Review ${index + 1}`,
          url: `https://github.com/owner/repo/pull/17#pullrequestreview-${index + 1}`,
        }));
      },
      listUnresolvedReviewComments: async (repoSlug, prNumber) => {
        githubCalls.push(`reviewComments:${repoSlug}:${prNumber}`);
        return Array.from({ length: 13 }, (_, index) => ({
          id: `rc${index + 1}`,
          authorLogin: "dave",
          createdAt: `2026-04-17T13:${String(index).padStart(2, "0")}:00.000Z`,
          body: `Inline comment ${index + 1}`,
          path: "src/app.ts",
          line: 42 + index,
          side: "RIGHT",
          url: `https://github.com/owner/repo/pull/17#discussion_r${index + 1}`,
          threadResolved: false as const,
        }));
      },
      getPullRequestCiSnapshot: async (repoSlug, headSha) => {
        githubCalls.push(`ci:${repoSlug}:${headSha}`);
        return {
          headSha,
          conclusion: "failure",
          failedRuns: [
            {
              id: 99,
              name: "test-suite",
              status: "completed",
              conclusion: "failure",
              detailsUrl: "https://github.com/owner/repo/actions/runs/99",
              startedAt: "2026-04-17T11:20:00.000Z",
              completedAt: "2026-04-17T11:25:00.000Z",
            },
          ],
          primaryFailedRun: {
            id: 99,
            name: "test-suite",
            status: "completed",
            conclusion: "failure",
            detailsUrl: "https://github.com/owner/repo/actions/runs/99",
            startedAt: "2026-04-17T11:20:00.000Z",
            completedAt: "2026-04-17T11:25:00.000Z",
          },
          failedAnnotations: Array.from({ length: 55 }, (_, index) => ({
            checkRunName: "test-suite",
            path: "src/app.ts",
            line: index + 1,
            message: `Expected boolean result ${index + 1}`,
            level: "failure",
          })),
          failedLogTail: "bundle exec rspec\nExpected boolean result 55\n",
        };
      },
    },
    jira: {
      getIssue: async (issueKey) => {
        jiraCalls.push(`getIssue:${issueKey}`);
        return {
          key: issueKey,
          url: `https://example.atlassian.net/browse/${issueKey}`,
          summary: "Prefetched ticket",
          status: "In Progress",
          description: "Jira description",
        };
      },
      getComments: async (issueKey) => {
        jiraCalls.push(`getComments:${issueKey}`);
        return Array.from({ length: 16 }, (_, index) => ({
          id: `j${index + 1}`,
          authorDisplayName: "Jira User",
          createdAt: `2026-04-17T14:${String(index).padStart(2, "0")}:00.000Z`,
          body: `Jira comment ${index + 1}`,
        }));
      },
    },
  });

  const result = await prefetcher.prefetch(makeRun({ workItemId: workItem.id }));
  assert.ok(result);
  assert.deepEqual(result.meta.sources.sort(), ["github_ci", "github_pr", "jira"]);
  assert.equal(result.workItem.id, workItem.id);
  assert.equal(result.workItem.title, "Prefetch work item");
  assert.equal(result.workItem.isAdoptedPr, true);
  assert.equal(result.github?.pr.number, 17);
  assert.equal(result.github?.pr.headSha, "sha-123");
  assert.equal(result.workItem.githubPrNumber, 17);
  assert.equal(result.github?.discussionCommentsTotalCount, 15);
  assert.equal(result.github?.discussionComments.length, 12);
  assert.equal(result.github?.discussionComments[0]?.body, "Discussion comment 4");
  assert.equal(result.github?.discussionComments[11]?.body, "Discussion comment 15");
  assert.equal(result.github?.reviewsTotalCount, 14);
  assert.equal(result.github?.reviews.length, 12);
  assert.equal(result.github?.reviews[0]?.body, "Review 3");
  assert.equal(result.github?.reviews[11]?.body, "Review 14");
  assert.equal(result.github?.reviews[0]?.state, "approved");
  assert.equal(result.github?.reviewCommentsTotalCount, 13);
  assert.equal(result.github?.reviewComments.length, 12);
  assert.equal(result.github?.reviewComments[0]?.body, "Inline comment 2");
  assert.equal(result.github?.reviewComments[11]?.body, "Inline comment 13");
  assert.equal(result.github?.reviewComments[0]?.threadResolved, false);
  assert.equal(result.github?.ci.conclusion, "failure");
  assert.equal(result.github?.ci.failedRuns?.[0]?.name, "test-suite");
  assert.equal(result.github?.ci.primaryFailedRun?.id, 99);
  assert.equal(result.github?.ci.failedAnnotationsTotalCount, 55);
  assert.equal(result.github?.ci.failedAnnotations?.length, 50);
  assert.equal(result.github?.ci.failedAnnotations?.[0]?.line, 6);
  assert.equal(result.github?.ci.failedAnnotations?.[49]?.line, 55);
  assert.equal(result.github?.ci.failedLogTail, "bundle exec rspec\nExpected boolean result 55\n");
  assert.equal(result.jira?.issue.key, "HBL-17");
  assert.equal(result.jira?.issue.description, "Jira description");
  assert.equal(result.jira?.commentsTotalCount, 16);
  assert.equal(result.jira?.comments.length, 12);
  assert.equal(result.jira?.comments[0]?.body, "Jira comment 5");
  assert.equal(result.jira?.comments[11]?.body, "Jira comment 16");
  assert.deepEqual(githubCalls, [
    "getPullRequest:owner/repo:17",
    "discussion:owner/repo:17",
    "reviews:owner/repo:17",
    "reviewComments:owner/repo:17",
    "ci:owner/repo:sha-123",
  ]);
  assert.deepEqual(jiraCalls, ["getIssue:HBL-17", "getComments:HBL-17"]);
});

test("RunContextPrefetcher fail-closes when GitHub fetch fails for a linked PR", async () => {
  const prefetcher = new RunContextPrefetcher({
    workItems: {
      requireWorkItem: async () =>
        makeWorkItem({
          githubPrNumber: 17,
          githubPrUrl: "https://github.com/owner/repo/pull/17",
        }),
    },
    github: {
      getPullRequest: async () => {
        throw new Error("GitHub API down");
      },
      listPullRequestDiscussionComments: async () => [],
      listPullRequestReviews: async () => [],
      listUnresolvedReviewComments: async () => [],
      getPullRequestCiSnapshot: async () => ({ headSha: "sha-123", conclusion: "success" }),
    },
  });

  await assert.rejects(
    () => prefetcher.prefetch(makeRun({ workItemId: "11111111-1111-1111-1111-111111111111" })),
    /GitHub prefetch failed/i
  );
});

test("RunContextPrefetcher fail-closes when Jira fetch fails for a linked Jira issue", async () => {
  const prefetcher = new RunContextPrefetcher({
    workItems: {
      requireWorkItem: async () =>
        makeWorkItem({
          jiraIssueKey: "HBL-17",
        }),
    },
    jira: {
      getIssue: async () => {
        throw new Error("Jira API down");
      },
      getComments: async () => [],
    },
  });

  await assert.rejects(
    () => prefetcher.prefetch(makeRun({ workItemId: "11111111-1111-1111-1111-111111111111" })),
    /Jira prefetch failed/i
  );
});

test("RunContextPrefetcher surfaces source aborts as run cancellation", async () => {
  const abortController = new AbortController();
  const prefetcher = new RunContextPrefetcher({
    workItems: {
      requireWorkItem: async () =>
        makeWorkItem({
          githubPrNumber: 17,
          githubPrUrl: "https://github.com/owner/repo/pull/17",
        }),
    },
    github: {
      getPullRequest: async (_repoSlug, _prNumber, signal) => {
        assert.equal(signal, abortController.signal);
        abortController.abort();
        throw new DOMException("The operation was aborted", "AbortError");
      },
      listPullRequestDiscussionComments: async () => [],
      listPullRequestReviews: async () => [],
      listUnresolvedReviewComments: async () => [],
      getPullRequestCiSnapshot: async () => ({ headSha: "sha-123", conclusion: "success" }),
    },
  });

  await assert.rejects(
    () => prefetcher.prefetch(makeRun({ workItemId: "11111111-1111-1111-1111-111111111111" }), abortController.signal),
    /Run cancelled/
  );
});

test("RunContextPrefetcher fail-closes when a GitHub-linked URL does not contain a pull request number", async () => {
  const prefetcher = new RunContextPrefetcher({
    workItems: {
      requireWorkItem: async () =>
        makeWorkItem({
          githubPrUrl: "https://github.com/owner/repo/issues/not-a-pr",
        }),
    },
  });

  await assert.rejects(
    () => prefetcher.prefetch(makeRun({ workItemId: "11111111-1111-1111-1111-111111111111" })),
    /could not parse pull request number from URL/i
  );
});

test("RunContextPrefetcher accepts pull request URLs with browser query and fragment suffixes", async () => {
  const calls: string[] = [];
  const prefetcher = new RunContextPrefetcher({
    workItems: {
      requireWorkItem: async () =>
        makeWorkItem({
          githubPrUrl: "https://github.com/owner/repo/pull/42/files?diff=split#discussion_r99",
        }),
    },
    github: {
      getPullRequest: async (_repoSlug, prNumber) => {
        calls.push(`getPullRequest:${prNumber}`);
        return {
          number: prNumber,
          url: `https://github.com/owner/repo/pull/${prNumber}`,
          title: "PR",
          body: "PR body",
          state: "open",
          headSha: "sha-42",
        };
      },
      listPullRequestDiscussionComments: async () => [],
      listPullRequestReviews: async () => [],
      listUnresolvedReviewComments: async () => [],
      getPullRequestCiSnapshot: async () => ({ headSha: "sha-42", conclusion: "success" }),
    },
  });

  const result = await prefetcher.prefetch(makeRun({ workItemId: "11111111-1111-1111-1111-111111111111" }));

  assert.equal(result?.github?.pr.number, 42);
  assert.equal(result?.workItem.githubPrNumber, 42);
  assert.equal(result?.github?.ci.failedAnnotations, undefined);
  assert.equal(result?.github?.ci.failedAnnotationsTotalCount, undefined);
  assert.deepEqual(calls, ["getPullRequest:42"]);
});

test("RunContextPrefetcher marks truncated long bodies in the snapshot", async () => {
  const longBody = "x".repeat(2_100);
  const prefetcher = new RunContextPrefetcher({
    workItems: {
      requireWorkItem: async () =>
        makeWorkItem({
          githubPrNumber: 17,
          githubPrUrl: "https://github.com/owner/repo/pull/17",
          jiraIssueKey: "HBL-17",
        }),
    },
    github: {
      getPullRequest: async () => ({
        number: 17,
        url: "https://github.com/owner/repo/pull/17",
        title: "PR",
        body: longBody,
        state: "open",
        headSha: "sha-17",
      }),
      listPullRequestDiscussionComments: async () => [
        {
          id: "c1",
          body: longBody,
        },
      ],
      listPullRequestReviews: async () => [],
      listUnresolvedReviewComments: async () => [],
      getPullRequestCiSnapshot: async () => ({ headSha: "sha-17", conclusion: "success" }),
    },
    jira: {
      getIssue: async () => ({
        key: "HBL-17",
        description: longBody,
      }),
      getComments: async () => [
        {
          id: "j1",
          body: longBody,
        },
      ],
    },
  });

  const result = await prefetcher.prefetch(makeRun({ workItemId: "11111111-1111-1111-1111-111111111111" }));

  assert.ok(result);
  assert.equal(result.github?.pr.body.length, 2000);
  assert.match(result.github?.pr.body ?? "", /\[truncated\]$/);
  assert.equal(result.github?.discussionComments[0]?.body.length, 2000);
  assert.match(result.github?.discussionComments[0]?.body ?? "", /\[truncated\]$/);
  assert.equal(result.jira?.issue.description.length, 2000);
  assert.match(result.jira?.issue.description ?? "", /\[truncated\]$/);
  assert.equal(result.jira?.comments[0]?.body.length, 2000);
  assert.match(result.jira?.comments[0]?.body ?? "", /\[truncated\]$/);
});
