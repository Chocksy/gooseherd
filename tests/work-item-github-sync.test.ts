import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "./helpers/test-db.js";
import { teams, users, workItemEvents } from "../src/db/schema.js";
import { WorkItemService } from "../src/work-items/service.js";
import { GitHubWorkItemSync, parseJiraIssueKey } from "../src/work-items/github-sync.js";

async function createGitHubSyncFixture() {
  const testDb = await createTestDb();
  const pmUserId = randomUUID();
  const ownerTeamId = randomUUID();

  await testDb.db.insert(users).values({
    id: pmUserId,
    slackUserId: "U_PM",
    githubLogin: "pm-user",
    displayName: "PM",
  });
  await testDb.db.insert(teams).values({
    id: ownerTeamId,
    name: "growth",
    slackChannelId: "C_GROWTH",
  });

  const resolveDeliveryContext = async () => ({
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.500",
    createdByUserId: pmUserId,
  });

  return {
    db: testDb.db,
    cleanup: testDb.cleanup,
    ownerTeamId,
    pmUserId,
    service: new WorkItemService(testDb.db),
    sync: new GitHubWorkItemSync(testDb.db, { resolveDeliveryContext }),
  };
}

test("parseJiraIssueKey extracts issue key from PR body", () => {
  assert.equal(parseJiraIssueKey("Implements feature.\n\nJira: HBL-404"), "HBL-404");
  assert.equal(parseJiraIssueKey("no issue here"), undefined);
});

test("github sync adopts labeled PR into delivery work item", async (t) => {
  const { cleanup, sync, db } = await createGitHubSyncFixture();
  t.after(cleanup);

  const adopted = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "labeled",
    repo: "hubstaff/gooseherd",
    prNumber: 77,
    prTitle: "Automate work item handling",
    prBody: "Implements workflow support\n\nRefs HBL-404",
    prUrl: "https://github.com/hubstaff/gooseherd/pull/77",
    labels: ["ai:assist"],
    baseBranch: "main",
  });

  assert.ok(adopted);
  assert.equal(adopted?.workflow, "feature_delivery");
  assert.equal(adopted?.state, "auto_review");
  assert.equal(adopted?.jiraIssueKey, "HBL-404");
  assert.equal(adopted?.githubPrNumber, 77);
  assert.ok(adopted?.flags.includes("pr_opened"));

  const events = await db.select().from(workItemEvents).where(eq(workItemEvents.workItemId, adopted!.id));
  assert.ok(events.some((event) => event.eventType === "github.label_observed"));
  assert.ok(events.some((event) => event.eventType === "github.pr_adopted"));
});

test("github sync ignores unrelated label", async (t) => {
  const { cleanup, sync } = await createGitHubSyncFixture();
  t.after(cleanup);

  const adopted = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "labeled",
    repo: "hubstaff/gooseherd",
    prNumber: 779,
    prTitle: "Unrelated label should not adopt",
    prBody: "Implements workflow support\n\nRefs HBL-410",
    prUrl: "https://github.com/hubstaff/gooseherd/pull/779",
    labels: ["legacy-assist"],
    baseBranch: "main",
  });

  assert.equal(adopted, undefined);
});

test("github sync links labeled PR to existing delivery item with same jira key", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixture();
  t.after(cleanup);

  const existing = await service.createDeliveryFromJira({
    title: "Existing delivery",
    summary: "Created from Jira before PR adoption",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.550",
    jiraIssueKey: "HBL-499",
    createdByUserId: pmUserId,
  });

  const adopted = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "labeled",
    repo: "hubstaff/gooseherd",
    prNumber: 78,
    prTitle: "Manual PR for existing delivery",
    prBody: "Continues work\n\nRefs HBL-499",
    prUrl: "https://github.com/hubstaff/gooseherd/pull/78",
    labels: ["ai:assist"],
    baseBranch: "main",
  });

  assert.equal(adopted?.id, existing.id);
  assert.equal(adopted?.state, "auto_review");
  assert.equal(adopted?.githubPrNumber, 78);
  assert.ok(adopted?.flags.includes("pr_opened"));
});

test("github sync advances auto review item to engineering review after green CI", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId, db } = await createGitHubSyncFixture();
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "Adopt CI success",
    summary: "Waiting for CI",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.600",
    jiraIssueKey: "HBL-405",
    createdByUserId: pmUserId,
    githubPrNumber: 88,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/88",
    initialState: "auto_review",
    initialSubstate: "waiting_ci",
    flags: ["pr_opened", "self_review_done"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "check_suite",
    action: "completed",
    repo: "hubstaff/gooseherd",
    conclusion: "success",
    status: "completed",
    pullRequestNumbers: [88],
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "engineering_review");
  assert.ok(updated?.flags.includes("ci_green"));

  const events = await db.select().from(workItemEvents).where(eq(workItemEvents.workItemId, delivery.id));
  assert.ok(events.some((event) => event.eventType === "github.ci_updated"));
});

test("github sync routes engineering review outcomes back into delivery flow", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixture();
  t.after(cleanup);

  const changesRequestedItem = await service.createDeliveryFromJira({
    title: "Review webhook handling",
    summary: "PR awaits review",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.700",
    jiraIssueKey: "HBL-406",
    createdByUserId: pmUserId,
    githubPrNumber: 99,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/99",
    initialState: "engineering_review",
    flags: ["pr_opened", "ci_green", "self_review_done"],
  });

  const sentBack = await sync.handleWebhookPayload({
    eventType: "pull_request_review",
    action: "submitted",
    repo: "hubstaff/gooseherd",
    prNumber: 99,
    state: "changes_requested",
    reviewer: "reviewer-a",
  });

  assert.equal(sentBack?.id, changesRequestedItem.id);
  assert.equal(sentBack?.state, "auto_review");

  const approvedItem = await service.createDeliveryFromJira({
    title: "Approved review webhook handling",
    summary: "PR awaits approval",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.701",
    jiraIssueKey: "HBL-407",
    createdByUserId: pmUserId,
    githubPrNumber: 100,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/100",
    initialState: "engineering_review",
    flags: ["pr_opened", "ci_green", "self_review_done"],
  });

  const approved = await sync.handleWebhookPayload({
    eventType: "pull_request_review",
    action: "submitted",
    repo: "hubstaff/gooseherd",
    prNumber: 100,
    state: "approved",
    reviewer: "reviewer-a",
  });

  assert.equal(approved?.id, approvedItem.id);
  assert.equal(approved?.state, "qa_preparation");
});

test("github sync advances qa preparation to qa review after green CI when product review is not required", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixture();
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "QA prep completes",
    summary: "Ready for QA review",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.702",
    jiraIssueKey: "HBL-408",
    createdByUserId: pmUserId,
    githubPrNumber: 101,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/101",
    initialState: "qa_preparation",
    initialSubstate: "running_e2e",
    flags: ["pr_opened", "engineering_review_done"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "check_suite",
    action: "completed",
    repo: "hubstaff/gooseherd",
    conclusion: "success",
    status: "completed",
    pullRequestNumbers: [101],
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "qa_review");
  assert.equal(updated?.substate, "waiting_qa_review");
  assert.ok(updated?.flags.includes("ci_green"));
});

test("github sync advances qa preparation to product review when required", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixture();
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "QA prep with product review",
    summary: "Needs product sign-off",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.703",
    jiraIssueKey: "HBL-409",
    createdByUserId: pmUserId,
    githubPrNumber: 102,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/102",
    initialState: "qa_preparation",
    initialSubstate: "running_e2e",
    flags: ["pr_opened", "engineering_review_done", "product_review_required"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "check_suite",
    action: "completed",
    repo: "hubstaff/gooseherd",
    conclusion: "success",
    status: "completed",
    pullRequestNumbers: [102],
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "product_review");
  assert.equal(updated?.substate, "waiting_product_review");
});

test("github sync marks delivery done when linked pull request is merged", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixture();
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "Merged PR",
    summary: "Ready to close",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.704",
    jiraIssueKey: "HBL-410",
    createdByUserId: pmUserId,
    githubPrNumber: 103,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/103",
    initialState: "ready_for_merge",
    initialSubstate: "waiting_merge",
    flags: ["pr_opened", "engineering_review_done", "qa_review_done"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "closed",
    repo: "hubstaff/gooseherd",
    prNumber: 103,
    prUrl: "https://github.com/hubstaff/gooseherd/pull/103",
    merged: true,
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "done");
  assert.equal(updated?.substate, "merged");
  assert.ok(updated?.flags.includes("merged"));
});

test("github sync resets ready_for_merge to auto review on synchronize", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixture();
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "Branch updated before merge",
    summary: "Fresh commits landed",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.705",
    jiraIssueKey: "HBL-411",
    createdByUserId: pmUserId,
    githubPrNumber: 104,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/104",
    initialState: "ready_for_merge",
    initialSubstate: "waiting_merge",
    flags: ["pr_opened", "ci_green", "engineering_review_done", "qa_review_done"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "synchronize",
    repo: "hubstaff/gooseherd",
    prNumber: 104,
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "auto_review");
  assert.equal(updated?.substate, "waiting_ci");
  assert.ok(!updated?.flags.includes("ci_green"));
});
