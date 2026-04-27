import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createTestDb } from "./helpers/test-db.js";
import { teams } from "../src/db/schema.js";
import { ensureDefaultTeam } from "../src/work-items/default-team-bootstrap.js";

test("ensureDefaultTeam creates the default team when missing", async (t) => {
  const testDb = await createTestDb();
  t.after(testDb.cleanup);

  const team = await ensureDefaultTeam(testDb.db, {
    defaultTeamName: "default",
    defaultTeamSlackChannelId: "C_DEFAULT",
  });

  assert.equal(team.name, "default");
  assert.equal(team.slackChannelId, "C_DEFAULT");
  assert.equal(team.isDefault, true);

  const rows = await testDb.db.select().from(teams).where(eq(teams.isDefault, true));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, team.id);
});

test("ensureDefaultTeam updates the existing default team row", async (t) => {
  const testDb = await createTestDb();
  t.after(testDb.cleanup);

  const teamId = randomUUID();
  await testDb.db.insert(teams).values({
    id: teamId,
    name: "old-default",
    slackChannelId: "C_OLD",
    isDefault: true,
  });

  const team = await ensureDefaultTeam(testDb.db, {
    defaultTeamName: "growth",
    defaultTeamSlackChannelId: "C_GROWTH",
  });

  assert.equal(team.id, teamId);
  assert.equal(team.name, "growth");
  assert.equal(team.slackChannelId, "C_GROWTH");
  assert.equal(team.isDefault, true);
});

test("ensureDefaultTeam fails when the default team Slack channel id is missing", async (t) => {
  const testDb = await createTestDb();
  t.after(testDb.cleanup);

  await assert.rejects(() => ensureDefaultTeam(testDb.db, {
    defaultTeamName: "default",
    defaultTeamSlackChannelId: undefined,
  }), /DEFAULT_TEAM_SLACK_CHANNEL_ID/i);
});
