import assert from "node:assert/strict";
import test from "node:test";
import {
  hasQaUatInPullRequestBody,
  hasQaUatInPullRequestConversationComments,
  QaPreparationActions,
} from "../src/work-items/qa-preparation-actions.js";
import type { WorkItemRecord } from "../src/work-items/types.js";

function makeDeliveryWorkItem(input: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {
    id: "wi-qa-uat-1",
    workflow: "feature_delivery",
    state: "qa_preparation",
    flags: [],
    title: "Add weekly report export",
    summary: "Users can export weekly reports from the dashboard.",
    ownerTeamId: "team-1",
    homeChannelId: "C1",
    homeThreadTs: "1.1",
    createdByUserId: "user-1",
    createdAt: "2026-04-26T00:00:00.000Z",
    updatedAt: "2026-04-26T00:00:00.000Z",
    repo: "hubstaff/gooseherd",
    githubPrNumber: 123,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/123",
    jiraIssueKey: "HBL-123",
    ...input,
  };
}

test("hasQaUatInPullRequestBody detects an existing QA UAT section", () => {
  assert.equal(hasQaUatInPullRequestBody("## QA UAT\n\n- Check export"), true);
  assert.equal(hasQaUatInPullRequestBody("### QA / UAT\n\n- Check export"), true);
  assert.equal(hasQaUatInPullRequestBody("## Verification\n\n- Tests pass"), false);
});

test("QaPreparationActions queues a QA preparation run when the PR description has none", async () => {
  const calls: Array<{ workItemId: string; reason?: string }> = [];
  const actions = new QaPreparationActions({
    githubService: {
      getPullRequest: async () => ({
        number: 123,
        url: "https://github.com/hubstaff/gooseherd/pull/123",
        title: "Add export button",
        body: "## Summary\n\nAdds export button.",
        state: "open",
      }),
      listPullRequestDiscussionComments: async () => [],
    },
    queueQaPreparationRun: async (workItemId, reason) => {
      calls.push({ workItemId, reason });
    },
  });

  await actions.handleEntry(makeDeliveryWorkItem());

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    workItemId: "wi-qa-uat-1",
    reason: "qa_preparation.entered",
  });
});

test("QaPreparationActions skips queuing when the PR description already has QA UAT", async () => {
  const calls: Array<{ workItemId: string; reason?: string }> = [];
  const actions = new QaPreparationActions({
    githubService: {
      getPullRequest: async () => ({
        number: 123,
        url: "https://github.com/hubstaff/gooseherd/pull/123",
        title: "Add export button",
        body: "## QA UAT\n\n- Already documented",
        state: "open",
      }),
      listPullRequestDiscussionComments: async () => [],
    },
    queueQaPreparationRun: async (workItemId, reason) => {
      calls.push({ workItemId, reason });
    },
  });

  await actions.handleEntry(makeDeliveryWorkItem());

  assert.equal(calls.length, 0);
});

test("QaPreparationActions skips queuing when a previous PR comment already has QA UAT", async () => {
  const calls: Array<{ workItemId: string; reason?: string }> = [];
  const actions = new QaPreparationActions({
    githubService: {
      getPullRequest: async () => ({
        number: 123,
        url: "https://github.com/hubstaff/gooseherd/pull/123",
        title: "Add export button",
        body: "## Summary\n\nAdds export button.",
        state: "open",
      }),
      listPullRequestDiscussionComments: async () => [
        {
          id: "1",
          body: "## QA UAT\n\n- Existing generated checks.",
        },
      ],
    },
    queueQaPreparationRun: async (workItemId, reason) => {
      calls.push({ workItemId, reason });
    },
  });

  await actions.handleEntry(makeDeliveryWorkItem());

  assert.equal(calls.length, 0);
});

test("hasQaUatInPullRequestConversationComments detects existing QA UAT comments", () => {
  assert.equal(
    hasQaUatInPullRequestConversationComments([
      { body: "## Summary\n\nNo QA section" },
      { body: "### QA UAT\n\n- Existing checks" },
    ]),
    true,
  );
  assert.equal(hasQaUatInPullRequestConversationComments([{ body: "## Summary\n\nNo QA section" }]), false);
});
