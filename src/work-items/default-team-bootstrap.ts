import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { teams } from "../db/schema.js";
import type { AppConfig } from "../config.js";

type DefaultTeamBootstrapConfig = Pick<
  AppConfig,
  "defaultTeamName" | "defaultTeamSlackChannelId"
>;

type TeamRow = typeof teams.$inferSelect;

export async function ensureDefaultTeam(db: Database, config: DefaultTeamBootstrapConfig): Promise<TeamRow> {
  const slackChannelId = config.defaultTeamSlackChannelId?.trim();
  if (!slackChannelId) {
    throw new Error("DEFAULT_TEAM_SLACK_CHANNEL_ID is required to bootstrap the default team");
  }

  const existingRows = await db.select().from(teams).where(eq(teams.isDefault, true)).limit(1);
  const existing = existingRows[0];
  const now = new Date();

  if (existing) {
    await db
      .update(teams)
      .set({
        name: config.defaultTeamName,
        slackChannelId,
        isDefault: true,
        updatedAt: now,
      })
      .where(eq(teams.id, existing.id));

    const updatedRows = await db.select().from(teams).where(eq(teams.id, existing.id)).limit(1);
    return updatedRows[0]!;
  }

  const id = randomUUID();
  await db.insert(teams).values({
    id,
    name: config.defaultTeamName,
    slackChannelId,
    isDefault: true,
    createdAt: now,
    updatedAt: now,
  });

  const createdRows = await db.select().from(teams).where(eq(teams.id, id)).limit(1);
  return createdRows[0]!;
}
