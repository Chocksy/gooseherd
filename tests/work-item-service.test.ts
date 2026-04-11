import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "./helpers/test-db.js";
import { orgRoleAssignments, reviewRequestComments, teamMembers, teams, users, workItems, reviewRequests, workItemEvents } from "../src/db/schema.js";
import { WorkItemService } from "../src/work-items/service.js";
import { RunStore } from "../src/store.js";

async function createServiceFixture() {
  const testDb = await createTestDb();
  const pmUserId = randomUUID();
  const reviewerUserId = randomUUID();
  const outsiderUserId = randomUUID();
  const ctoUserId = randomUUID();
  const ownerTeamId = randomUUID();

  await testDb.db.insert(users).values([
    { id: pmUserId, slackUserId: "U_PM", jiraAccountId: "JIRA_PM", displayName: "PM" },
    { id: reviewerUserId, slackUserId: "U_ENG", displayName: "Engineer" },
    { id: outsiderUserId, slackUserId: "U_OUT", displayName: "Outsider" },
    { id: ctoUserId, slackUserId: "U_CTO", displayName: "CTO" },
  ]);
  await testDb.db.insert(teams).values({
    id: ownerTeamId,
    name: "growth",
    slackChannelId: "C_GROWTH",
  });
  await testDb.db.insert(teamMembers).values([
    { teamId: ownerTeamId, userId: pmUserId, functionalRoles: ["pm"] },
    { teamId: ownerTeamId, userId: reviewerUserId, functionalRoles: ["engineer"] },
  ]);
  await testDb.db.insert(orgRoleAssignments).values({
    userId: ctoUserId,
    orgRole: "cto",
  });

  return {
    db: testDb.db,
    cleanup: testDb.cleanup,
    service: new WorkItemService(testDb.db),
    pmUserId,
    reviewerUserId,
    outsiderUserId,
    ctoUserId,
    ownerTeamId,
  };
}

test("service creates discovery item, manages review round, and confirms discovery only together with Jira and delivery creation", async (t) => {
  const { db, cleanup, service, pmUserId, reviewerUserId, ownerTeamId } = await createServiceFixture();
  t.after(cleanup);

  const discovery = await service.createDiscoveryWorkItem({
    title: "Automate work items",
    summary: "Initial discovery summary",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.200",
    createdByUserId: pmUserId,
  });

  assert.equal(discovery.workflow, "product_discovery");
  assert.equal(discovery.state, "backlog");

  const started = await service.startDiscovery(discovery.id);
  assert.equal(started.state, "in_progress");
  assert.equal(started.substate, "collecting_context");

  const [reviewA, reviewB] = await service.requestReview({
    workItemId: discovery.id,
    requestedByUserId: pmUserId,
    requests: [
      {
        type: "review",
        targetType: "user",
        targetRef: { userId: reviewerUserId },
        title: "Check architecture",
        requestMessage: "Need eyes on round logic",
        focusPoints: ["review rounds"],
      },
      {
        type: "review",
        targetType: "team",
        targetRef: { teamId: ownerTeamId },
        title: "Check ownership",
        requestMessage: "Need team-level feedback",
        focusPoints: ["owner team"],
      },
    ],
  });

  const waiting = await service.getWorkItem(discovery.id);
  assert.equal(waiting?.state, "waiting_for_review");
  assert.equal(waiting?.substate, "waiting_review_responses");
  assert.equal(reviewA.reviewRound, 1);
  assert.equal(reviewB.reviewRound, 1);

  await service.recordReviewOutcome({
    reviewRequestId: reviewA.id,
    outcome: "changes_requested",
    authorUserId: reviewerUserId,
    comment: "Please tighten the transition model.",
  });

  const backInProgress = await service.getWorkItem(discovery.id);
  assert.equal(backInProgress?.state, "in_progress");

  const supersededRound = await db.select().from(reviewRequests).where(eq(reviewRequests.id, reviewB.id));
  assert.equal(supersededRound[0]?.status, "superseded");

  const [reviewC] = await service.requestReview({
    workItemId: discovery.id,
    requestedByUserId: pmUserId,
    requests: [
      {
        type: "review",
        targetType: "user",
        targetRef: { userId: reviewerUserId },
        title: "Check revised draft",
        requestMessage: "Second pass",
        focusPoints: ["state naming"],
      },
    ],
  });

  assert.equal(reviewC.reviewRound, 2);

  await service.recordReviewOutcome({
    reviewRequestId: reviewC.id,
    outcome: "approved",
    authorUserId: reviewerUserId,
    comment: "Looks good now.",
  });

  const waitingForPm = await service.getWorkItem(discovery.id);
  assert.equal(waitingForPm?.state, "waiting_for_pm_confirmation");

  await assert.rejects(() => service.confirmDiscovery({
    workItemId: discovery.id,
    approved: true,
    actorUserId: pmUserId,
  }), /jira/i);

  const completedDiscovery = await service.confirmDiscovery({
    workItemId: discovery.id,
    approved: true,
    actorUserId: pmUserId,
    jiraIssueKey: "HBL-101",
  });
  assert.equal(completedDiscovery.state, "done");
  assert.equal(completedDiscovery.jiraIssueKey, "HBL-101");

  const deliveryRows = await db.select().from(workItems).where(eq(workItems.sourceWorkItemId, discovery.id));
  assert.equal(deliveryRows.length, 1);
  assert.equal(deliveryRows[0]?.workflow, "feature_delivery");
  assert.equal(deliveryRows[0]?.state, "backlog");
  assert.equal(deliveryRows[0]?.jiraIssueKey, "HBL-101");

  const storedDiscovery = await db.select().from(workItems).where(eq(workItems.id, discovery.id));
  assert.ok((storedDiscovery[0]?.flags ?? []).includes("delivery_work_item_created"));
  assert.ok((storedDiscovery[0]?.flags ?? []).includes("jira_created"));

  const events = await db.select().from(workItemEvents).where(eq(workItemEvents.workItemId, discovery.id));
  assert.ok(events.length >= 4, "expected discovery lifecycle events to be recorded");
});

test("service creates delivery item directly from jira trigger", async (t) => {
  const { service, cleanup, pmUserId, ownerTeamId } = await createServiceFixture();
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "Automate CI recovery",
    summary: "Created from Jira webhook",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.300",
    jiraIssueKey: "HBL-202",
    createdByUserId: pmUserId,
  });

  assert.equal(delivery.workflow, "feature_delivery");
  assert.equal(delivery.state, "backlog");
  assert.equal(delivery.jiraIssueKey, "HBL-202");
});

test("service enforces target-aware authorization for review responses", async (t) => {
  const { db, cleanup, service, pmUserId, reviewerUserId, outsiderUserId, ownerTeamId } = await createServiceFixture();
  t.after(cleanup);

  const discovery = await service.createDiscoveryWorkItem({
    title: "Protected review",
    summary: "Only target user may respond",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.350",
    createdByUserId: pmUserId,
  });
  await service.startDiscovery(discovery.id);
  const [review] = await service.requestReview({
    workItemId: discovery.id,
    requestedByUserId: pmUserId,
    requests: [
      {
        type: "review",
        targetType: "user",
        targetRef: { userId: reviewerUserId },
        title: "Targeted review",
      },
    ],
  });

  await assert.rejects(() => service.recordReviewOutcome({
    reviewRequestId: review.id,
    outcome: "approved",
    authorUserId: outsiderUserId,
    comment: "I should not be able to approve this",
  }), /not authorized/i);

  const updated = await service.recordReviewOutcome({
    reviewRequestId: review.id,
    outcome: "approved",
    authorUserId: reviewerUserId,
    comment: "Approved by the correct reviewer",
  });
  assert.equal(updated.state, "waiting_for_pm_confirmation");

  const comments = await db.select().from(reviewRequestComments).where(eq(reviewRequestComments.reviewRequestId, review.id));
  assert.equal(comments.length, 1);
  assert.equal(comments[0]?.body, "Approved by the correct reviewer");
});

test("service rejects unauthorized override actors but allows org-role admins", async (t) => {
  const { cleanup, service, pmUserId, outsiderUserId, ctoUserId, ownerTeamId } = await createServiceFixture();
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "Override auth",
    summary: "Only owner team or admin can override",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.360",
    jiraIssueKey: "HBL-203",
    createdByUserId: pmUserId,
  });

  await assert.rejects(() => service.guardedOverrideState({
    workItemId: delivery.id,
    state: "cancelled",
    actorUserId: outsiderUserId,
    reason: "I should not be allowed",
  }), /not authorized/i);

  const overridden = await service.guardedOverrideState({
    workItemId: delivery.id,
    state: "cancelled",
    actorUserId: ctoUserId,
    reason: "Org admin override",
  });
  assert.equal(overridden.state, "cancelled");
});

test("service can attach an existing run to a work item", async (t) => {
  const { db, service, cleanup, pmUserId, ownerTeamId } = await createServiceFixture();
  t.after(cleanup);

  const workItem = await service.createDeliveryFromJira({
    title: "Adopt run chain",
    summary: "Attach ad-hoc run",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.400",
    jiraIssueKey: "HBL-303",
    createdByUserId: pmUserId,
  });

  const runStore = new RunStore(db);
  const run = await runStore.createRun(
    {
      runtime: "local",
      repoSlug: "hubstaff/gooseherd",
      task: "Fix specs",
      baseBranch: "main",
      requestedBy: "U_PM",
      channelId: "C_GROWTH",
      threadTs: "1740000000.400",
    },
    "gooseherd"
  );

  await service.attachRunToWorkItem({
    workItemId: workItem.id,
    runId: run.id,
    actorUserId: pmUserId,
  });

  const storedRun = await runStore.getRun(run.id);
  assert.equal(storedRun?.workItemId, workItem.id);
});

test("service stops active processing before guarded override", async (t) => {
  const { db, service, cleanup, pmUserId, ownerTeamId } = await createServiceFixture();
  t.after(cleanup);

  const workItem = await service.createDeliveryFromJira({
    title: "Stop delivery processing",
    summary: "Need to interrupt active run",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.401",
    jiraIssueKey: "HBL-304",
    createdByUserId: pmUserId,
  });

  const runStore = new RunStore(db);
  const run = await runStore.createRun(
    {
      runtime: "local",
      repoSlug: "hubstaff/gooseherd",
      task: "Active work",
      baseBranch: "main",
      requestedBy: "U_PM",
      channelId: "C_GROWTH",
      threadTs: "1740000000.401",
    },
    "gooseherd"
  );
  await runStore.linkToWorkItem(run.id, workItem.id);
  await runStore.updateRun(run.id, {
    status: "running",
    phase: "agent",
    startedAt: new Date().toISOString(),
  });

  assert.equal(await service.hasActiveProcessing(workItem.id), true);

  await assert.rejects(() => service.guardedOverrideState({
    workItemId: workItem.id,
    state: "cancelled",
    actorUserId: pmUserId,
    reason: "stuck worker",
    hasActiveProcessing: async () => service.hasActiveProcessing(workItem.id),
  }), /processing is active/);

  const stopResult = await service.stopProcessing({
    workItemId: workItem.id,
    actorUserId: pmUserId,
    cancelRun: async (runId) => {
      await runStore.updateRun(runId, {
        status: "cancel_requested",
        phase: "cancel_requested",
      });
      return true;
    },
  });

  assert.deepEqual(stopResult.stoppedRunIds, [run.id]);
  assert.equal(await service.hasActiveProcessing(workItem.id), false);

  const overridden = await service.guardedOverrideState({
    workItemId: workItem.id,
    state: "cancelled",
    actorUserId: pmUserId,
    reason: "stopped the worker first",
    hasActiveProcessing: async () => service.hasActiveProcessing(workItem.id),
  });

  assert.equal(overridden.state, "cancelled");
});
