import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createTestDb } from "./helpers/test-db.js";
import { teamMembers, teams, users } from "../src/db/schema.js";
import { WorkItemContextResolver } from "../src/work-items/context-resolver.js";

async function createResolverFixture() {
  const testDb = await createTestDb();
  const pmUserId = randomUUID();
  const growthTeamId = randomUUID();
  const platformTeamId = randomUUID();

  await testDb.db.insert(users).values({
    id: pmUserId,
    slackUserId: "U_PM",
    jiraAccountId: "JIRA_PM",
    displayName: "PM",
  });
  await testDb.db.insert(teams).values([
    { id: growthTeamId, name: "growth", slackChannelId: "C_GROWTH" },
    { id: platformTeamId, name: "platform", slackChannelId: "C_PLATFORM" },
  ]);

  return {
    db: testDb.db,
    cleanup: testDb.cleanup,
    resolver: new WorkItemContextResolver(testDb.db),
    pmUserId,
    growthTeamId,
    platformTeamId,
  };
}

test("context resolver auto-selects the only accessible team and keeps origin thread when already in the home channel", async (t) => {
  const { db, cleanup, resolver, pmUserId, growthTeamId } = await createResolverFixture();
  t.after(cleanup);

  await db.insert(teamMembers).values({
    teamId: growthTeamId,
    userId: pmUserId,
    functionalRoles: ["pm"],
  });

  const resolved = await resolver.resolveDiscoveryContext({
    createdByUserId: pmUserId,
    originChannelId: "C_GROWTH",
    originThreadTs: "1740000000.300",
  });

  assert.equal(resolved.ownerTeamId, growthTeamId);
  assert.equal(resolved.homeChannelId, "C_GROWTH");
  assert.equal(resolved.homeThreadTs, "1740000000.300");
});

test("context resolver requires explicit owner team when actor can access multiple teams", async (t) => {
  const { db, cleanup, resolver, pmUserId, growthTeamId, platformTeamId } = await createResolverFixture();
  t.after(cleanup);

  await db.insert(teamMembers).values([
    { teamId: growthTeamId, userId: pmUserId, functionalRoles: ["pm"] },
    { teamId: platformTeamId, userId: pmUserId, functionalRoles: ["pm"] },
  ]);

  await assert.rejects(() => resolver.resolveDiscoveryContext({
    createdByUserId: pmUserId,
    originChannelId: "C_RANDOM",
    originThreadTs: "1740000000.301",
  }), /owner team/i);
});

test("context resolver creates a new home thread when origin channel differs from team channel", async (t) => {
  const { db, cleanup, resolver, pmUserId, growthTeamId } = await createResolverFixture();
  t.after(cleanup);

  await db.insert(teamMembers).values({
    teamId: growthTeamId,
    userId: pmUserId,
    functionalRoles: ["pm"],
  });

  const created: Array<{ channelId: string; text: string }> = [];
  const resolved = await resolver.resolveDiscoveryContext({
    createdByUserId: pmUserId,
    ownerTeamId: growthTeamId,
    originChannelId: "C_RANDOM",
    originThreadTs: "1740000000.302",
    createHomeThread: async (input) => {
      created.push(input);
      return "1740000001.999";
    },
  });

  assert.equal(resolved.homeChannelId, "C_GROWTH");
  assert.equal(resolved.homeThreadTs, "1740000001.999");
  assert.equal(created.length, 1);
});
