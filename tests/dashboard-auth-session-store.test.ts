import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { dashboardAuthSessions, teamMembers, teams, users } from "../src/db/schema.js";
import { DashboardAuthSessionStore } from "../src/dashboard/auth-session-store.js";
import { createTestDb } from "./helpers/test-db.js";

test("dashboard auth session store creates, loads, and revokes user sessions", async (t) => {
  const testDb = await createTestDb();
  t.after(async () => { await testDb.cleanup(); });

  const userId = randomUUID();
  await testDb.db.insert(users).values({
    id: userId,
    slackUserId: "U_SESSION",
    displayName: "Session User",
  });

  const store = new DashboardAuthSessionStore(testDb.db);
  const created = await store.createSession({
    principalType: "user",
    authMethod: "slack",
    userId,
    ttlMs: 60_000,
  });

  assert.ok(created.token);
  assert.ok(created.sessionId);

  const loaded = await store.getSessionByToken(created.token);
  assert.equal(loaded?.principalType, "user");
  assert.equal(loaded?.authMethod, "slack");
  assert.equal(loaded?.userId, userId);

  const rows = await testDb.db.select().from(dashboardAuthSessions);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.principalType, "user");

  await store.revokeSession(created.token);
  const revoked = await store.getSessionByToken(created.token);
  assert.equal(revoked, undefined);
});

test("team members and teams expose slack auth mapping fields", async (t) => {
  const testDb = await createTestDb();
  t.after(async () => { await testDb.cleanup(); });

  const userId = randomUUID();
  const teamId = randomUUID();

  await testDb.db.insert(users).values({
    id: userId,
    slackUserId: "U_TEAM_SYNC",
    displayName: "Team Sync User",
  });
  await testDb.db.insert(teams).values({
    id: teamId,
    name: "devops",
    slackChannelId: "C_DEVOPS",
    slackUserGroupId: "S123",
    slackUserGroupHandle: "devops",
  });
  await testDb.db.insert(teamMembers).values({
    teamId,
    userId,
    functionalRoles: [],
    membershipSource: "slack_user_group",
  });

  const teamRows = await testDb.db.select().from(teams);
  const memberRows = await testDb.db.select().from(teamMembers);

  assert.equal(teamRows[0]?.slackUserGroupId, "S123");
  assert.equal(teamRows[0]?.slackUserGroupHandle, "devops");
  assert.equal(memberRows[0]?.membershipSource, "slack_user_group");
});
