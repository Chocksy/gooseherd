import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ReadyForMergeActions } from "../src/work-items/ready-for-merge-actions.js";
import type { WorkItemRecord } from "../src/work-items/types.js";

function makeWorkItem(overrides: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {
    id: randomUUID(),
    workflow: "feature_delivery",
    state: "ready_for_merge",
    substate: "waiting_merge",
    flags: ["pr_opened", "self_review_done", "engineering_review_done", "qa_review_done"],
    title: "Ready for merge",
    summary: "Squash and label the PR",
    ownerTeamId: "team-1",
    homeChannelId: "C_CORE",
    homeThreadTs: "1740000000.900",
    jiraIssueKey: "HBL-500",
    githubPrNumber: 501,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/501",
    githubPrBaseBranch: "main",
    githubPrHeadBranch: "feature/hbl-500",
    githubPrHeadSha: "abc123",
    repo: "hubstaff/gooseherd",
    createdByUserId: "user-1",
    createdAt: "2026-04-22T10:00:00.000Z",
    updatedAt: "2026-04-22T10:00:00.000Z",
    ...overrides,
  };
}

test("ready_for_merge actions squash multi-commit PRs before labeling", async () => {
  const calls: string[] = [];
  const actions = new ReadyForMergeActions({
    githubService: {
      getPullRequest: async () => ({
        number: 501,
        url: "https://github.com/hubstaff/gooseherd/pull/501",
        title: "Ready for merge",
        body: "PR body",
        state: "open",
        baseRef: "main",
        headRef: "feature/hbl-500",
        headSha: "abc123",
        baseSha: "def456",
        commitsCount: 3,
        labels: [],
      }),
      addPullRequestLabels: async () => {
        calls.push("label");
      },
    },
    queueReadyForMergeRun: async () => {
      calls.push("queue");
    },
  });

  await actions.handleEntry(makeWorkItem());

  assert.deepEqual(calls, ["queue"]);
});

test("ready_for_merge actions add automerge to single-commit PRs", async () => {
  const labels: string[][] = [];
  const actions = new ReadyForMergeActions({
    githubService: {
      getPullRequest: async () => ({
        number: 501,
        url: "https://github.com/hubstaff/gooseherd/pull/501",
        title: "Ready for merge",
        body: "PR body",
        state: "open",
        baseRef: "main",
        headRef: "feature/hbl-500",
        headSha: "abc123",
        baseSha: "def456",
        commitsCount: 1,
        labels: [],
      }),
      addPullRequestLabels: async (input) => {
        labels.push(input.labels);
      },
    },
    queueReadyForMergeRun: async () => {
      throw new Error("unexpected queue");
    },
  });

  await actions.handleEntry(makeWorkItem());

  assert.deepEqual(labels, [["automerge"]]);
});

test("ready_for_merge actions do nothing when automerge label already exists", async () => {
  let called = false;
  const actions = new ReadyForMergeActions({
    githubService: {
      getPullRequest: async () => ({
        number: 501,
        url: "https://github.com/hubstaff/gooseherd/pull/501",
        title: "Ready for merge",
        body: "PR body",
        state: "open",
        baseRef: "main",
        headRef: "feature/hbl-500",
        headSha: "abc123",
        baseSha: "def456",
        commitsCount: 1,
        labels: ["automerge"],
      }),
      addPullRequestLabels: async () => {
        called = true;
      },
    },
    queueReadyForMergeRun: async () => {
      called = true;
    },
  });

  await actions.handleEntry(makeWorkItem());

  assert.equal(called, false);
});

test("ready_for_merge actions retry transient getPullRequest failures", async () => {
  const calls: string[] = [];
  let attempts = 0;
  const actions = new ReadyForMergeActions({
    githubService: {
      getPullRequest: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("transient github outage");
        }
        return {
          number: 501,
          url: "https://github.com/hubstaff/gooseherd/pull/501",
          title: "Ready for merge",
          body: "PR body",
          state: "open",
          baseRef: "main",
          headRef: "feature/hbl-500",
          headSha: "abc123",
          baseSha: "def456",
          commitsCount: 3,
          labels: [],
        };
      },
      addPullRequestLabels: async () => {
        calls.push("label");
      },
    },
    queueReadyForMergeRun: async () => {
      calls.push("queue");
    },
  });

  await actions.handleEntry(makeWorkItem());

  assert.equal(attempts, 2);
  assert.deepEqual(calls, ["queue"]);
});

test("ready_for_merge actions soft-fail after exhausting pull request retries", async (t) => {
  const errors: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  t.after(() => {
    console.error = originalConsoleError;
  });

  const actions = new ReadyForMergeActions({
    githubService: {
      getPullRequest: async () => {
        throw new Error("github unavailable");
      },
      addPullRequestLabels: async () => {
        throw new Error("unexpected label mutation");
      },
    },
    queueReadyForMergeRun: async () => {
      throw new Error("unexpected queue");
    },
  });

  await assert.doesNotReject(actions.handleEntry(makeWorkItem()));
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]?.[0]), /\[ERROR\] Ready-for-merge actions failed/);
  assert.equal((errors[0]?.[1] as { error?: string } | undefined)?.error, "github unavailable");
});
