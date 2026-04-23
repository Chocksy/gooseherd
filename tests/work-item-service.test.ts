import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "./helpers/test-db.js";
import { orgRoleAssignments, reviewRequestComments, teamMembers, teams, users, workItems, reviewRequests, workItemEvents } from "../src/db/schema.js";
import { WorkItemService } from "../src/work-items/service.js";
import { RunStore } from "../src/store.js";

function slackUserActor(userId: string, sessionId = "slack-session-1") {
  return {
    principalType: "user" as const,
    userId,
    authMethod: "slack" as const,
    sessionId,
  };
}

function systemUserActor(userId: string) {
  return {
    principalType: "user" as const,
    userId,
    authMethod: "system" as const,
  };
}

function adminSessionActor(sessionId = "admin-session-1") {
  return {
    principalType: "admin_session" as const,
    authMethod: "admin_password" as const,
    sessionId,
  };
}

async function createServiceFixture() {
  const testDb = await createTestDb();
  const pmUserId = randomUUID();
  const reviewerUserId = randomUUID();
  const outsiderUserId = randomUUID();
  const adminUserId = randomUUID();
  const ctoUserId = randomUUID();
  const ownerTeamId = randomUUID();

  await testDb.db.insert(users).values([
    { id: pmUserId, slackUserId: "U_PM", jiraAccountId: "JIRA_PM", displayName: "PM" },
    { id: reviewerUserId, slackUserId: "U_ENG", displayName: "Engineer" },
    { id: outsiderUserId, slackUserId: "U_OUT", displayName: "Outsider" },
    { id: adminUserId, slackUserId: "U_ADMIN", displayName: "Admin" },
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
  await testDb.db.insert(orgRoleAssignments).values([
    { userId: adminUserId, orgRole: "admin" },
    { userId: ctoUserId, orgRole: "cto" },
  ]);

  return {
    db: testDb.db,
    cleanup: testDb.cleanup,
    service: new WorkItemService(testDb.db),
    pmUserId,
    reviewerUserId,
    outsiderUserId,
    adminUserId,
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
    actor: systemUserActor(pmUserId),
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
    actor: systemUserActor(reviewerUserId),
    comment: "Please tighten the transition model.",
  });

  const backInProgress = await service.getWorkItem(discovery.id);
  assert.equal(backInProgress?.state, "in_progress");

  const supersededRound = await db.select().from(reviewRequests).where(eq(reviewRequests.id, reviewB.id));
  assert.equal(supersededRound[0]?.status, "superseded");

  const [reviewC] = await service.requestReview({
    workItemId: discovery.id,
    actor: systemUserActor(pmUserId),
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
    actor: systemUserActor(reviewerUserId),
    comment: "Looks good now.",
  });

  const waitingForPm = await service.getWorkItem(discovery.id);
  assert.equal(waitingForPm?.state, "waiting_for_pm_confirmation");

  await assert.rejects(() => service.confirmDiscovery({
    workItemId: discovery.id,
    approved: true,
    actor: systemUserActor(pmUserId),
  }), /jira/i);

  const completedDiscovery = await service.confirmDiscovery({
    workItemId: discovery.id,
    approved: true,
    actor: systemUserActor(pmUserId),
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
    actor: systemUserActor(pmUserId),
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
    actor: systemUserActor(outsiderUserId),
    comment: "I should not be able to approve this",
  }), /not authorized/i);

  const updated = await service.recordReviewOutcome({
    reviewRequestId: review.id,
    outcome: "approved",
    actor: systemUserActor(reviewerUserId),
    comment: "Approved by the correct reviewer",
  });
  assert.equal(updated.state, "waiting_for_pm_confirmation");

  const comments = await db.select().from(reviewRequestComments).where(eq(reviewRequestComments.reviewRequestId, review.id));
  assert.equal(comments.length, 1);
  assert.equal(comments[0]?.body, "Approved by the correct reviewer");
});

test("service rejects unauthorized override actors but allows org-role admins", async (t) => {
  const { cleanup, service, pmUserId, outsiderUserId, adminUserId, ctoUserId, ownerTeamId } = await createServiceFixture();
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
    actor: systemUserActor(outsiderUserId),
    reason: "I should not be allowed",
  }), /not authorized/i);

  await assert.rejects(() => service.guardedOverrideState({
    workItemId: delivery.id,
    state: "cancelled",
    actor: systemUserActor(ctoUserId),
    reason: "Non-admin org role should not override",
  }), /not authorized/i);

  const overridden = await service.guardedOverrideState({
    workItemId: delivery.id,
    state: "cancelled",
    actor: systemUserActor(adminUserId),
    reason: "Org admin override",
  });
  assert.equal(overridden.state, "cancelled");
});

test("service only allows owner-team PM to request review and confirm discovery through manual path", async (t) => {
  const { cleanup, service, pmUserId, reviewerUserId, ownerTeamId } = await createServiceFixture();
  t.after(cleanup);

  const discovery = await service.createDiscoveryWorkItem({
    title: "PM-gated management",
    summary: "Only PM can manage manual flow",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.370",
    createdByUserId: pmUserId,
  });
  await service.startDiscovery(discovery.id);

  await assert.rejects(() => service.requestReview({
    workItemId: discovery.id,
    actor: systemUserActor(reviewerUserId),
    requests: [
      {
        type: "review",
        targetType: "team",
        targetRef: { teamId: ownerTeamId },
        title: "Engineer cannot request",
      },
    ],
  }), /not authorized/i);

  const [review] = await service.requestReview({
    workItemId: discovery.id,
    actor: systemUserActor(pmUserId),
    requests: [
      {
        type: "review",
        targetType: "user",
        targetRef: { userId: reviewerUserId },
        title: "PM can request",
      },
    ],
  });

  await service.recordReviewOutcome({
    reviewRequestId: review.id,
    outcome: "approved",
    actor: systemUserActor(reviewerUserId),
  });

  await assert.rejects(() => service.confirmDiscovery({
    workItemId: discovery.id,
    approved: false,
    actor: systemUserActor(reviewerUserId),
  }), /not authorized/i);

  const updated = await service.confirmDiscovery({
    workItemId: discovery.id,
    approved: false,
    actor: systemUserActor(pmUserId),
  });

  assert.equal(updated.state, "in_progress");
});

test("service stop processing requires manual transition authority, while override requires explicit admin override", async (t) => {
  const { db, cleanup, service, pmUserId, reviewerUserId, adminUserId, ownerTeamId } = await createServiceFixture();
  t.after(cleanup);

  const workItem = await service.createDeliveryFromJira({
    title: "Split manual and override auth",
    summary: "PM can stop processing but not override state",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.402",
    jiraIssueKey: "HBL-305",
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
      threadTs: "1740000000.402",
    },
    "gooseherd"
  );
  await runStore.linkToWorkItem(run.id, workItem.id);
  await runStore.updateRun(run.id, {
    status: "running",
    phase: "agent",
    startedAt: new Date().toISOString(),
  });

  await assert.rejects(() => service.stopProcessing({
    workItemId: workItem.id,
    actor: systemUserActor(reviewerUserId),
    cancelRun: async () => true,
  }), /not authorized/i);

  const stopResult = await service.stopProcessing({
    workItemId: workItem.id,
    actor: systemUserActor(pmUserId),
    cancelRun: async (runId) => {
      await runStore.updateRun(runId, {
        status: "cancel_requested",
        phase: "cancel_requested",
      });
      return true;
    },
  });
  assert.deepEqual(stopResult.stoppedRunIds, [run.id]);

  await assert.rejects(() => service.guardedOverrideState({
    workItemId: workItem.id,
    state: "cancelled",
    actor: systemUserActor(pmUserId),
    reason: "PM cannot globally override",
  }), /not authorized/i);

  const overridden = await service.guardedOverrideState({
    workItemId: workItem.id,
    state: "cancelled",
    actor: systemUserActor(adminUserId),
    reason: "Admin override",
  });
  assert.equal(overridden.state, "cancelled");
});

test("service records actor principal metadata in work item events", async (t) => {
  const { db, cleanup, service, pmUserId, reviewerUserId, ownerTeamId } = await createServiceFixture();
  t.after(cleanup);

  const discovery = await service.createDiscoveryWorkItem({
    title: "Actor metadata",
    summary: "Events should preserve actor principal details",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.403",
    createdByUserId: pmUserId,
  });
  await service.startDiscovery(discovery.id);

  const [review] = await service.requestReview({
    workItemId: discovery.id,
    actor: slackUserActor(pmUserId, "slack-session-request"),
    requests: [
      {
        type: "review",
        targetType: "user",
        targetRef: { userId: reviewerUserId },
        title: "Record actor principal",
      },
    ],
  });

  await service.recordReviewOutcome({
    reviewRequestId: review.id,
    actor: systemUserActor(reviewerUserId),
    outcome: "approved",
    comment: "Approved from system bridge",
  });

  const events = await db.select().from(workItemEvents).where(eq(workItemEvents.workItemId, discovery.id));
  const createdEvent = events.find((event) => event.eventType === "review_request.created");
  assert.ok(createdEvent);
  assert.equal(createdEvent.actorUserId, pmUserId);
  assert.equal(createdEvent.payload.actorPrincipalType, "user");
  assert.equal(createdEvent.payload.actorAuthMethod, "slack");
  assert.equal(createdEvent.payload.actorSessionId, "slack-session-request");

  const completedEvent = events.find((event) => event.eventType === "review_request.completed");
  assert.ok(completedEvent);
  assert.equal(completedEvent.actorUserId, reviewerUserId);
  assert.equal(completedEvent.payload.actorPrincipalType, "user");
  assert.equal(completedEvent.payload.actorAuthMethod, "system");
  assert.equal(completedEvent.payload.actorSessionId, undefined);
});

test("admin_session may override but cannot confirm discovery as a normal participant", async (t) => {
  const { db, cleanup, service, pmUserId, reviewerUserId, ownerTeamId } = await createServiceFixture();
  t.after(cleanup);

  const discovery = await service.createDiscoveryWorkItem({
    title: "Admin session boundary",
    summary: "Admin session is override-only",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.404",
    createdByUserId: pmUserId,
  });
  await service.startDiscovery(discovery.id);
  const [review] = await service.requestReview({
    workItemId: discovery.id,
    actor: slackUserActor(pmUserId, "pm-session"),
    requests: [
      {
        type: "review",
        targetType: "user",
        targetRef: { userId: reviewerUserId },
        title: "PM review request",
      },
    ],
  });
  await service.recordReviewOutcome({
    reviewRequestId: review.id,
    actor: slackUserActor(reviewerUserId, "reviewer-session"),
    outcome: "approved",
  });

  await assert.rejects(() => service.confirmDiscovery({
    workItemId: discovery.id,
    approved: false,
    actor: adminSessionActor("admin-confirm"),
  }), /not authorized/i);

  const overridden = await service.guardedOverrideState({
    workItemId: discovery.id,
    state: "cancelled",
    actor: adminSessionActor("admin-override"),
    reason: "Emergency dashboard override",
  });
  assert.equal(overridden.state, "cancelled");

  const events = await db.select().from(workItemEvents).where(eq(workItemEvents.workItemId, discovery.id));
  const overrideRequested = events.find((event) => event.eventType === "override.requested");
  assert.ok(overrideRequested);
  assert.equal(overrideRequested.actorUserId, null);
  assert.equal(overrideRequested.payload.actorPrincipalType, "admin_session");
  assert.equal(overrideRequested.payload.actorAuthMethod, "admin_password");
  assert.equal(overrideRequested.payload.actorSessionId, "admin-override");
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
  const { db, service, cleanup, pmUserId, adminUserId, ownerTeamId } = await createServiceFixture();
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
    actor: systemUserActor(adminUserId),
    reason: "stuck worker",
    hasActiveProcessing: async () => service.hasActiveProcessing(workItem.id),
  }), /processing is active/);

  const stopResult = await service.stopProcessing({
    workItemId: workItem.id,
    actor: systemUserActor(pmUserId),
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
    actor: systemUserActor(adminUserId),
    reason: "stopped the worker first",
    hasActiveProcessing: async () => service.hasActiveProcessing(workItem.id),
  });

  assert.equal(overridden.state, "cancelled");
});
