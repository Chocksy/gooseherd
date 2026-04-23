import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createTestDb } from "./helpers/test-db.js";
import { orgRoleAssignments, teamMembers, teams, users } from "../src/db/schema.js";
import { WorkItemAuthorization } from "../src/work-items/authorization.js";
import type { ReviewRequestRecord, WorkItemRecord } from "../src/work-items/types.js";

function makeWorkItem(ownerTeamId: string, createdByUserId: string): WorkItemRecord {
  return {
    id: randomUUID(),
    workflow: "product_discovery",
    state: "in_progress",
    flags: [],
    title: "Work item",
    summary: "",
    ownerTeamId,
    homeChannelId: "C_WORK",
    homeThreadTs: "1.23",
    createdByUserId,
    createdAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:00.000Z",
  };
}

function makeTeamReviewRequest(teamId: string): ReviewRequestRecord {
  return {
    id: randomUUID(),
    workItemId: randomUUID(),
    reviewRound: 1,
    type: "review",
    targetType: "team",
    targetRef: { teamId },
    status: "pending",
    title: "Team review",
    requestMessage: "",
    focusPoints: [],
    requestedByUserId: randomUUID(),
    requestedAt: "2026-04-13T00:00:00.000Z",
    createdAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:00.000Z",
  };
}

async function createAuthorizationFixture() {
  const testDb = await createTestDb();
  const ownerTeamId = randomUUID();
  const otherTeamId = randomUUID();

  const ownerPmUserId = randomUUID();
  const ownerEngineerUserId = randomUUID();
  const ownerDesignerUserId = randomUUID();
  const ownerInactiveQaUserId = randomUUID();
  const otherTeamPmUserId = randomUUID();
  const adminUserId = randomUUID();
  const ctoUserId = randomUUID();
  const outsiderUserId = randomUUID();

  await testDb.db.insert(users).values([
    { id: ownerPmUserId, displayName: "Owner PM", slackUserId: "U_OWNER_PM" },
    { id: ownerEngineerUserId, displayName: "Owner Engineer", slackUserId: "U_OWNER_ENG" },
    { id: ownerDesignerUserId, displayName: "Owner Designer", slackUserId: "U_OWNER_DES" },
    { id: ownerInactiveQaUserId, displayName: "Inactive QA", slackUserId: "U_OWNER_QA", isActive: false },
    { id: otherTeamPmUserId, displayName: "Other PM", slackUserId: "U_OTHER_PM" },
    { id: adminUserId, displayName: "Admin", slackUserId: "U_ADMIN" },
    { id: ctoUserId, displayName: "CTO", slackUserId: "U_CTO" },
    { id: outsiderUserId, displayName: "Outsider", slackUserId: "U_OUT" },
  ]);

  await testDb.db.insert(teams).values([
    { id: ownerTeamId, name: "Owner", slackChannelId: "C_OWNER" },
    { id: otherTeamId, name: "Other", slackChannelId: "C_OTHER" },
  ]);

  await testDb.db.insert(teamMembers).values([
    { teamId: ownerTeamId, userId: ownerPmUserId, functionalRoles: ["pm"] },
    { teamId: ownerTeamId, userId: ownerEngineerUserId, functionalRoles: ["engineer"] },
    { teamId: ownerTeamId, userId: ownerDesignerUserId, functionalRoles: ["designer"] },
    { teamId: ownerTeamId, userId: ownerInactiveQaUserId, functionalRoles: ["qa"] },
    { teamId: otherTeamId, userId: otherTeamPmUserId, functionalRoles: ["pm"] },
  ]);

  await testDb.db.insert(orgRoleAssignments).values([
    { userId: adminUserId, orgRole: "admin" },
    { userId: ctoUserId, orgRole: "cto" },
  ]);

  return {
    cleanup: testDb.cleanup,
    authorization: new WorkItemAuthorization(testDb.db),
    ownerTeamId,
    ownerPmUserId,
    ownerEngineerUserId,
    ownerDesignerUserId,
    ownerInactiveQaUserId,
    otherTeamPmUserId,
    adminUserId,
    ctoUserId,
    outsiderUserId,
  };
}

test("only owner-team PM or admin can request review and apply manual transitions", async (t) => {
  const fixture = await createAuthorizationFixture();
  t.after(fixture.cleanup);

  const workItem = makeWorkItem(fixture.ownerTeamId, fixture.ownerPmUserId);

  await fixture.authorization.assertCanRequestReview(fixture.ownerPmUserId, workItem);
  await fixture.authorization.assertCanApplyManualTransition(fixture.ownerPmUserId, workItem);
  await fixture.authorization.assertCanRequestReview(fixture.adminUserId, workItem);
  await fixture.authorization.assertCanApplyManualTransition(fixture.adminUserId, workItem);

  await assert.rejects(
    () => fixture.authorization.assertCanRequestReview(fixture.ownerEngineerUserId, workItem),
    /not authorized/i,
  );
  await assert.rejects(
    () => fixture.authorization.assertCanApplyManualTransition(fixture.ownerEngineerUserId, workItem),
    /not authorized/i,
  );
  await assert.rejects(
    () => fixture.authorization.assertCanRequestReview(fixture.otherTeamPmUserId, workItem),
    /not authorized/i,
  );
  await assert.rejects(
    () => fixture.authorization.assertCanApplyManualTransition(fixture.outsiderUserId, workItem),
    /not authorized/i,
  );
});

test("team-targeted review may be answered by any active team member", async (t) => {
  const fixture = await createAuthorizationFixture();
  t.after(fixture.cleanup);

  const workItem = makeWorkItem(fixture.ownerTeamId, fixture.ownerPmUserId);
  const reviewRequest = makeTeamReviewRequest(fixture.ownerTeamId);

  await fixture.authorization.assertCanRespondToReviewRequest(fixture.ownerPmUserId, workItem, reviewRequest);
  await fixture.authorization.assertCanRespondToReviewRequest(fixture.ownerEngineerUserId, workItem, reviewRequest);
  await fixture.authorization.assertCanRespondToReviewRequest(fixture.ownerDesignerUserId, workItem, reviewRequest);

  await assert.rejects(
    () => fixture.authorization.assertCanRespondToReviewRequest(fixture.ownerInactiveQaUserId, workItem, reviewRequest),
    /inactive actor/i,
  );
  await assert.rejects(
    () => fixture.authorization.assertCanRespondToReviewRequest(fixture.outsiderUserId, workItem, reviewRequest),
    /not authorized/i,
  );
});

test("non-admin org roles are not elevated for management or manual transitions", async (t) => {
  const fixture = await createAuthorizationFixture();
  t.after(fixture.cleanup);

  const workItem = makeWorkItem(fixture.ownerTeamId, fixture.ownerPmUserId);

  await assert.rejects(
    () => fixture.authorization.assertCanRequestReview(fixture.ctoUserId, workItem),
    /not authorized/i,
  );
  await assert.rejects(
    () => fixture.authorization.assertCanApplyManualTransition(fixture.ctoUserId, workItem),
    /not authorized/i,
  );
  await assert.rejects(
    () => fixture.authorization.assertCanOverrideWorkItem(fixture.ctoUserId),
    /not authorized/i,
  );
});
