import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "./helpers/test-db.js";
import { users, teams, reviewRequestComments, workItemEvents, workItems as workItemsTable } from "../src/db/schema.js";
import { WorkItemStore } from "../src/work-items/store.js";
import { ReviewRequestStore } from "../src/work-items/review-request-store.js";
import { WorkItemEventsStore } from "../src/work-items/events-store.js";

async function createStores() {
  const testDb = await createTestDb();
  const workItems = new WorkItemStore(testDb.db);
  const reviewRequests = new ReviewRequestStore(testDb.db);
  const events = new WorkItemEventsStore(testDb.db);

  const ownerUserId = randomUUID();
  const ownerTeamId = randomUUID();

  await testDb.db.insert(users).values({
    id: ownerUserId,
    slackUserId: "U_PM_1",
    displayName: "PM One",
  });
  await testDb.db.insert(teams).values({
    id: ownerTeamId,
    name: "core-product",
    slackChannelId: "C_TEAM_1",
  });

  return {
    db: testDb.db,
    cleanup: testDb.cleanup,
    workItems,
    reviewRequests,
    events,
    ownerUserId,
    ownerTeamId,
  };
}

test("work item stores persist work item state, review requests, comments, and events", async (t) => {
  const {
    db,
    cleanup,
    workItems,
    reviewRequests,
    events,
    ownerUserId,
    ownerTeamId,
  } = await createStores();
  t.after(cleanup);

  const workItem = await workItems.createWorkItem({
    workflow: "product_discovery",
    state: "backlog",
    title: "Design work items",
    summary: "Spec and workflow design",
    ownerTeamId,
    homeChannelId: "C_TEAM_1",
    homeThreadTs: "1740000000.100",
    createdByUserId: ownerUserId,
    flags: [],
  });

  assert.equal(workItem.workflow, "product_discovery");
  assert.equal(workItem.state, "backlog");
  assert.deepEqual(workItem.flags, []);

  const started = await workItems.updateState(workItem.id, {
    state: "in_progress",
    substate: "collecting_context",
  });

  assert.equal(started.state, "in_progress");
  assert.equal(started.substate, "collecting_context");

  const updated = await workItems.updateState(workItem.id, {
    state: "waiting_for_review",
    substate: "waiting_review_responses",
    flagsToAdd: ["spec_draft_ready"],
  });

  assert.equal(updated.state, "waiting_for_review");
  assert.equal(updated.substate, "waiting_review_responses");
  assert.deepEqual(updated.flags, ["spec_draft_ready"]);

  const reviewRequest = await reviewRequests.createReviewRequest({
    workItemId: workItem.id,
    reviewRound: 1,
    type: "review",
    targetType: "team",
    targetRef: { teamId: ownerTeamId },
    status: "pending",
    title: "Review spec draft",
    requestMessage: "Need feedback on workflow boundaries",
    focusPoints: ["review round logic", "owner team model"],
    requestedByUserId: ownerUserId,
  });

  assert.equal(reviewRequest.status, "pending");
  assert.deepEqual(reviewRequest.focusPoints, ["review round logic", "owner team model"]);

  const completed = await reviewRequests.completeReviewRequest(reviewRequest.id, {
    outcome: "approved",
    resolvedAt: "2026-04-11T12:00:00.000Z",
  });

  assert.equal(completed.status, "completed");
  assert.equal(completed.outcome, "approved");

  await reviewRequests.addComment({
    reviewRequestId: reviewRequest.id,
    authorUserId: ownerUserId,
    source: "dashboard",
    body: "Looks good from discovery side.",
  });

  await reviewRequests.addComment({
    reviewRequestId: reviewRequest.id,
    authorUserId: ownerUserId,
    source: "system",
    body: "Recorded final outcome.",
  });

  const comments = await db.select().from(reviewRequestComments).where(eq(reviewRequestComments.reviewRequestId, reviewRequest.id));
  assert.equal(comments.length, 2);
  assert.equal(comments[0]?.body, "Looks good from discovery side.");
  assert.deepEqual(
    (await reviewRequests.listComments(reviewRequest.id)).map((comment) => ({ source: comment.source, body: comment.body })),
    [
      { source: "system", body: "Recorded final outcome." },
      { source: "dashboard", body: "Looks good from discovery side." },
    ],
  );

  await events.append({
    workItemId: workItem.id,
    eventType: "review_request.completed",
    actorUserId: ownerUserId,
    payload: { reviewRequestId: reviewRequest.id, outcome: "approved" },
  });

  const eventRows = await db.select().from(workItemEvents).where(eq(workItemEvents.workItemId, workItem.id));
  assert.equal(eventRows.length, 1);
  assert.equal(eventRows[0]?.eventType, "review_request.completed");
});

test("work item store rejects workflow-incompatible or non-whitelisted state changes", async (t) => {
  const { cleanup, workItems, ownerUserId, ownerTeamId } = await createStores();
  t.after(cleanup);

  await assert.rejects(() => workItems.createWorkItem({
    workflow: "product_discovery",
    state: "qa_review",
    title: "Invalid discovery state",
    summary: "Should not be creatable",
    ownerTeamId,
    homeChannelId: "C_TEAM_1",
    homeThreadTs: "1740000000.200",
    createdByUserId: ownerUserId,
  }), /product_discovery/i);

  const delivery = await workItems.createWorkItem({
    workflow: "feature_delivery",
    state: "backlog",
    title: "Strict transitions",
    summary: "Should not skip directly to merge-ready",
    ownerTeamId,
    homeChannelId: "C_TEAM_1",
    homeThreadTs: "1740000000.201",
    createdByUserId: ownerUserId,
  });

  await assert.rejects(() => workItems.updateState(delivery.id, {
    state: "ready_for_merge",
  }), /transition/i);
});

test("work item store allows multiple feature deliveries to share the same Jira issue key", async (t) => {
  const { db, cleanup, workItems, ownerUserId, ownerTeamId } = await createStores();
  t.after(cleanup);

  await workItems.createWorkItem({
    workflow: "feature_delivery",
    state: "backlog",
    title: "Delivery A",
    summary: "First delivery",
    ownerTeamId,
    homeChannelId: "C_TEAM_1",
    homeThreadTs: "1740000000.202",
    createdByUserId: ownerUserId,
    jiraIssueKey: "HBL-500",
  });

  await workItems.createWorkItem({
    workflow: "feature_delivery",
    state: "backlog",
    title: "Delivery B",
    summary: "Second delivery",
    ownerTeamId,
    homeChannelId: "C_TEAM_1",
    homeThreadTs: "1740000000.203",
    createdByUserId: ownerUserId,
    jiraIssueKey: "HBL-500",
  });

  const deliveryRows = await db.select().from(workItemsTable).where(eq(workItemsTable.jiraIssueKey, "HBL-500"));
  assert.equal(deliveryRows.length, 2);
});

test("work item store rejects duplicate product discovery Jira issue keys", async (t) => {
  const { cleanup, db, ownerUserId, ownerTeamId } = await createStores();
  t.after(cleanup);

  await db.insert(workItemsTable).values({
    id: randomUUID(),
    workflow: "product_discovery",
    state: "backlog",
    title: "Discovery A",
    summary: "First discovery",
    ownerTeamId,
    homeChannelId: "C_TEAM_1",
    homeThreadTs: "1740000000.200",
    createdByUserId: ownerUserId,
    jiraIssueKey: "HBL-501",
  });

  await assert.rejects(() => db.insert(workItemsTable).values({
    id: randomUUID(),
    workflow: "product_discovery",
    state: "backlog",
    title: "Discovery B",
    summary: "Duplicate discovery key",
    ownerTeamId,
    homeChannelId: "C_TEAM_1",
    homeThreadTs: "1740000000.201",
    createdByUserId: ownerUserId,
    jiraIssueKey: "HBL-501",
  }));
});

test("work item store preserves repo on create and read", async (t) => {
  const { cleanup, workItems, ownerUserId, ownerTeamId } = await createStores();
  t.after(cleanup);

  const workItem = await workItems.createWorkItem({
    workflow: "feature_delivery",
    state: "backlog",
    title: "Repo scoped delivery",
    summary: "Round-trip repo mapping",
    ownerTeamId,
    homeChannelId: "C_TEAM_1",
    homeThreadTs: "1740000000.202",
    createdByUserId: ownerUserId,
    repo: "acme/widgets",
  });

  assert.equal(workItem.repo, "acme/widgets");
});

test("work item store serializes concurrent state updates for the same work item", async (t) => {
  const { cleanup, workItems, ownerUserId, ownerTeamId } = await createStores();
  t.after(cleanup);

  const delivery = await workItems.createWorkItem({
    workflow: "feature_delivery",
    state: "engineering_review",
    substate: "waiting_engineering_review",
    title: "Concurrent webhook updates",
    summary: "Two webhook callbacks should not clobber each other's flags",
    ownerTeamId,
    homeChannelId: "C_TEAM_1",
    homeThreadTs: "1740000000.203",
    createdByUserId: ownerUserId,
    flags: ["pr_opened"],
  });

  const originalGetWorkItem = WorkItemStore.prototype.getWorkItem;
  let signalFirstRead: (() => void) | undefined;
  const firstReadReached = new Promise<void>((resolve) => {
    signalFirstRead = resolve;
  });
  let releaseFirstRead: (() => void) | undefined;
  const firstReadReleased = new Promise<void>((resolve) => {
    releaseFirstRead = resolve;
  });
  let shouldHoldFirstRead = true;

  WorkItemStore.prototype.getWorkItem = async function patchedGetWorkItem(id: string) {
    const current = await originalGetWorkItem.call(this, id);
    if (id === delivery.id && shouldHoldFirstRead) {
      shouldHoldFirstRead = false;
      signalFirstRead?.();
      await firstReadReleased;
    }
    return current;
  };
  t.after(() => {
    WorkItemStore.prototype.getWorkItem = originalGetWorkItem;
  });

  const firstUpdate = workItems.updateState(delivery.id, {
    state: "engineering_review",
    substate: "waiting_engineering_review",
    flagsToAdd: ["engineering_review_done"],
  });

  await firstReadReached;

  const secondUpdate = workItems.updateState(delivery.id, {
    state: "engineering_review",
    substate: "waiting_engineering_review",
    flagsToAdd: ["qa_review_done"],
  });

  const secondFinishedWhileFirstWasBlocked = await Promise.race([
    secondUpdate.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
  ]);

  assert.equal(secondFinishedWhileFirstWasBlocked, false);

  releaseFirstRead?.();
  await Promise.all([firstUpdate, secondUpdate]);

  const updated = await workItems.requireWorkItem(delivery.id);
  assert.ok(updated.flags.includes("engineering_review_done"));
  assert.ok(updated.flags.includes("qa_review_done"));
});

test("work item store allows multiple feature deliveries to share the same source work item id", async (t) => {
  const { db, cleanup, workItems, ownerUserId, ownerTeamId } = await createStores();
  t.after(cleanup);

  const discovery = await workItems.createWorkItem({
    workflow: "product_discovery",
    state: "done",
    title: "Discovery source",
    summary: "Multiple deliveries should point here",
    ownerTeamId,
    homeChannelId: "C_TEAM_1",
    homeThreadTs: "1740000000.204",
    createdByUserId: ownerUserId,
  });

  await workItems.createWorkItem({
    workflow: "feature_delivery",
    state: "backlog",
    title: "Delivery A",
    summary: "First delivery",
    ownerTeamId,
    homeChannelId: "C_TEAM_1",
    homeThreadTs: "1740000000.205",
    createdByUserId: ownerUserId,
    sourceWorkItemId: discovery.id,
  });

  await workItems.createWorkItem({
    workflow: "feature_delivery",
    state: "backlog",
    title: "Delivery B",
    summary: "Second delivery",
    ownerTeamId,
    homeChannelId: "C_TEAM_1",
    homeThreadTs: "1740000000.206",
    createdByUserId: ownerUserId,
    sourceWorkItemId: discovery.id,
  });

  const deliveryRows = await db.select().from(workItemsTable).where(eq(workItemsTable.sourceWorkItemId, discovery.id));
  assert.equal(deliveryRows.length, 2);
});

test("work item store allows multiple feature deliveries with null GitHub PR numbers", async (t) => {
  const { db, cleanup, ownerUserId, ownerTeamId } = await createStores();
  t.after(cleanup);

  await db.insert(workItemsTable).values({
    id: randomUUID(),
    workflow: "feature_delivery",
    state: "backlog",
    title: "Delivery A",
    summary: "Null PR number one",
    ownerTeamId,
    homeChannelId: "C_TEAM_1",
    homeThreadTs: "1740000000.207",
    createdByUserId: ownerUserId,
  });

  await db.insert(workItemsTable).values({
    id: randomUUID(),
    workflow: "feature_delivery",
    state: "backlog",
    title: "Delivery B",
    summary: "Null PR number two",
    ownerTeamId,
    homeChannelId: "C_TEAM_1",
    homeThreadTs: "1740000000.208",
    createdByUserId: ownerUserId,
  });

  const rows = await db.select().from(workItemsTable).where(eq(workItemsTable.ownerTeamId, ownerTeamId));
  const nullPrRows = rows.filter((row) => row.workflow === "feature_delivery" && row.githubPrNumber === null);
  assert.equal(nullPrRows.length, 2);
});

test("work item store rejects duplicate feature deliveries for the same repo and GitHub PR number", async (t) => {
  const { cleanup, db, ownerUserId, ownerTeamId } = await createStores();
  t.after(cleanup);

  await db.insert(workItemsTable).values({
    id: randomUUID(),
    workflow: "feature_delivery",
    state: "backlog",
    title: "Delivery A",
    summary: "First repo-scoped PR",
    ownerTeamId,
    homeChannelId: "C_TEAM_1",
    homeThreadTs: "1740000000.209",
    createdByUserId: ownerUserId,
    repo: "acme/widgets",
    githubPrNumber: 42,
  });

  await assert.rejects(() => db.insert(workItemsTable).values({
    id: randomUUID(),
    workflow: "feature_delivery",
    state: "backlog",
    title: "Delivery B",
    summary: "Duplicate repo-scoped PR",
    ownerTeamId,
    homeChannelId: "C_TEAM_1",
    homeThreadTs: "1740000000.210",
    createdByUserId: ownerUserId,
    repo: "acme/widgets",
    githubPrNumber: 42,
  }));
});
