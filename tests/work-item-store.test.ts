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

test("work item store enforces a single feature delivery per discovery source", async (t) => {
  const { db, cleanup, workItems, ownerUserId, ownerTeamId } = await createStores();
  t.after(cleanup);

  const discovery = await workItems.createWorkItem({
    workflow: "product_discovery",
    state: "done",
    title: "Discovery source",
    summary: "Only one delivery should point here",
    ownerTeamId,
    homeChannelId: "C_TEAM_1",
    homeThreadTs: "1740000000.202",
    createdByUserId: ownerUserId,
  });

  await workItems.createWorkItem({
    workflow: "feature_delivery",
    state: "backlog",
    title: "Delivery A",
    summary: "First delivery",
    ownerTeamId,
    homeChannelId: "C_TEAM_1",
    homeThreadTs: "1740000000.203",
    createdByUserId: ownerUserId,
    jiraIssueKey: "HBL-500",
    sourceWorkItemId: discovery.id,
  });

  await assert.rejects(() => workItems.createWorkItem({
    workflow: "feature_delivery",
    state: "backlog",
    title: "Delivery B",
    summary: "Duplicate source",
    ownerTeamId,
    homeChannelId: "C_TEAM_1",
    homeThreadTs: "1740000000.204",
    createdByUserId: ownerUserId,
    jiraIssueKey: "HBL-501",
    sourceWorkItemId: discovery.id,
  }));

  const deliveryRows = await db.select().from(workItemsTable).where(eq(workItemsTable.sourceWorkItemId, discovery.id));
  assert.equal(deliveryRows.length, 1);
});
