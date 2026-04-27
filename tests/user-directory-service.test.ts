import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import { teamMembers, teams, users } from "../src/db/schema.js";
import { createTestDb } from "./helpers/test-db.js";
import { UserDirectoryService } from "../src/user-directory/service.js";

async function createFixture() {
  const testDb = await createTestDb();
  const service = new UserDirectoryService(testDb.db);
  return {
    db: testDb.db,
    service,
    cleanup: testDb.cleanup,
  };
}

test("user directory lists users sorted by display name", async (t) => {
  const { db, service, cleanup } = await createFixture();
  t.after(cleanup);

  await db.insert(users).values([
    { id: randomUUID(), displayName: "Zulu", slackUserId: "U_ZULU" },
    { id: randomUUID(), displayName: "Alpha", slackUserId: "U_ALPHA" },
  ]);

  const records = await service.listUsers();

  assert.deepEqual(records.map((record) => record.displayName), ["Alpha", "Zulu"]);
});

test("user directory normalizes empty identity fields to null on create and update", async (t) => {
  const { service, cleanup } = await createFixture();
  t.after(cleanup);

  const created = await service.createUser({
    displayName: "  Mapped User  ",
    slackUserId: "  ",
    githubLogin: "  gh-user  ",
    jiraAccountId: "",
    primaryTeamId: "  ",
    isActive: true,
  });

  assert.equal(created.displayName, "Mapped User");
  assert.equal(created.slackUserId, null);
  assert.equal(created.githubLogin, "gh-user");
  assert.equal(created.jiraAccountId, null);
  assert.equal(created.primaryTeamId, null);

  const updated = await service.updateUser(created.id, {
    displayName: "  Updated Name ",
    slackUserId: " U_UPDATED ",
    githubLogin: "",
    jiraAccountId: "  ",
    primaryTeamId: "",
    isActive: false,
  });

  assert.equal(updated.displayName, "Updated Name");
  assert.equal(updated.slackUserId, "U_UPDATED");
  assert.equal(updated.githubLogin, null);
  assert.equal(updated.jiraAccountId, null);
  assert.equal(updated.primaryTeamId, null);
  assert.equal(updated.isActive, false);
});

test("user directory stores a primary team only when membership already exists", async (t) => {
  const { db, service, cleanup } = await createFixture();
  t.after(cleanup);

  const teamId = randomUUID();
  await db.insert(teams).values({
    id: teamId,
    name: "growth",
    slackChannelId: "C_GROWTH",
  });

  const created = await service.createUser({
    displayName: "Primary Team User",
    slackUserId: "U_PRIMARY",
    githubLogin: "primary-user",
    jiraAccountId: null,
    primaryTeamId: null,
    isActive: true,
  });

  await db.insert(teamMembers).values({
    teamId,
    userId: created.id,
    functionalRoles: ["pm"],
  });

  const updated = await service.updateUser(created.id, {
    displayName: "Primary Team User",
    slackUserId: "U_PRIMARY",
    githubLogin: "primary-user",
    jiraAccountId: null,
    primaryTeamId: teamId,
    isActive: true,
  });

  assert.equal(updated.primaryTeamId, teamId);
});

test("user directory creates the primary-team membership when a new user is created with primaryTeamId", async (t) => {
  const { db, service, cleanup } = await createFixture();
  t.after(cleanup);

  const teamId = randomUUID();
  await db.insert(teams).values({
    id: teamId,
    name: "delivery",
    slackChannelId: "C_DELIVERY",
  });

  const created = await service.createUser({
    displayName: "Create With Primary Team",
    slackUserId: "U_CREATE_PRIMARY",
    githubLogin: "create-with-primary",
    jiraAccountId: null,
    primaryTeamId: teamId,
    isActive: true,
  });

  assert.equal(created.primaryTeamId, teamId);

  const memberships = await db.select().from(teamMembers).where(eq(teamMembers.userId, created.id));
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0]?.teamId, teamId);
});

test("user directory rejects primary team changes without an existing membership", async (t) => {
  const { db, service, cleanup } = await createFixture();
  t.after(cleanup);

  const teamId = randomUUID();
  await db.insert(teams).values({
    id: teamId,
    name: "platform",
    slackChannelId: "C_PLATFORM",
  });

  const created = await service.createUser({
    displayName: "No Membership User",
    slackUserId: "U_NO_MEMBERSHIP",
    githubLogin: "no-membership",
    jiraAccountId: null,
    primaryTeamId: null,
    isActive: true,
  });

  await assert.rejects(() => service.updateUser(created.id, {
    displayName: "No Membership User",
    slackUserId: "U_NO_MEMBERSHIP",
    githubLogin: "no-membership",
    jiraAccountId: null,
    primaryTeamId: teamId,
    isActive: true,
  }), /must already be a member/i);
});

test("user directory rejects duplicate identity fields with readable errors", async (t) => {
  const { service, cleanup } = await createFixture();
  t.after(cleanup);

  await service.createUser({
    displayName: "Existing",
    slackUserId: "U_EXISTING",
    githubLogin: "existing-gh",
    jiraAccountId: "JIRA_EXISTING",
    isActive: true,
  });

  await assert.rejects(
    service.createUser({
      displayName: "Duplicate Slack",
      slackUserId: "U_EXISTING",
      githubLogin: "new-gh",
      jiraAccountId: "JIRA_NEW",
      isActive: true,
    }),
    /Slack user already exists/,
  );

  await assert.rejects(
    service.createUser({
      displayName: "Duplicate GitHub",
      slackUserId: "U_NEW",
      githubLogin: "existing-gh",
      jiraAccountId: "JIRA_NEW_2",
      isActive: true,
    }),
    /GitHub login already exists/,
  );

  await assert.rejects(
    service.createUser({
      displayName: "Duplicate Jira",
      slackUserId: "U_NEW_2",
      githubLogin: "new-gh-2",
      jiraAccountId: "JIRA_EXISTING",
      isActive: true,
    }),
    /Jira account already exists/,
  );
});

test("user directory requires a non-empty display name", async (t) => {
  const { service, cleanup } = await createFixture();
  t.after(cleanup);

  await assert.rejects(
    service.createUser({
      displayName: "   ",
      slackUserId: "",
      githubLogin: "",
      jiraAccountId: "",
      isActive: true,
    }),
    /display name is required/i,
  );
});
