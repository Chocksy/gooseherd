import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { teamMembers, teams } from "../db/schema.js";

interface SlackUserGroupMembersResponse {
  ok?: boolean;
  error?: string;
  users?: string[];
}

export interface SlackMappedTeam {
  id: string;
  slackUserGroupId: string;
}

async function fetchSlackUserGroupMembers(botToken: string, slackUserGroupId: string): Promise<string[]> {
  const url = new URL("https://slack.com/api/usergroups.users.list");
  url.searchParams.set("usergroup", slackUserGroupId);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${botToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Slack usergroups lookup failed with ${String(response.status)}`);
  }
  const payload = await response.json() as SlackUserGroupMembersResponse;
  if (!payload.ok) {
    throw new Error(payload.error || "Slack usergroups lookup failed");
  }
  return Array.isArray(payload.users) ? payload.users : [];
}

export async function resolveMappedSlackTeams(db: Database, botToken: string, slackUserId: string): Promise<string[]> {
  const mappedTeams = await db
    .select({
      id: teams.id,
      slackUserGroupId: teams.slackUserGroupId,
    })
    .from(teams)
    .where(isNotNull(teams.slackUserGroupId));

  const matchedTeamIds: string[] = [];
  for (const team of mappedTeams) {
    if (!team.slackUserGroupId) continue;
    const members = await fetchSlackUserGroupMembers(botToken, team.slackUserGroupId);
    if (members.includes(slackUserId)) {
      matchedTeamIds.push(team.id);
    }
  }
  return matchedTeamIds;
}

export async function syncSlackUserGroupMemberships(
  db: Database,
  botToken: string,
  userId: string,
  slackUserId: string,
): Promise<string[]> {
  const matchedTeamIds = await resolveMappedSlackTeams(db, botToken, slackUserId);
  const mappedTeams = await db
    .select({ id: teams.id })
    .from(teams)
    .where(isNotNull(teams.slackUserGroupId));
  const mappedTeamIds = mappedTeams.map((team) => team.id);

  await db.transaction(async (tx) => {
    if (mappedTeamIds.length > 0) {
      await tx
        .delete(teamMembers)
        .where(and(
          eq(teamMembers.userId, userId),
          eq(teamMembers.membershipSource, "slack_user_group"),
          inArray(teamMembers.teamId, mappedTeamIds),
        ));
    }

    if (matchedTeamIds.length > 0) {
      await tx
        .insert(teamMembers)
        .values(matchedTeamIds.map((teamId) => ({
          teamId,
          userId,
          functionalRoles: [],
          membershipSource: "slack_user_group",
        })))
        .onConflictDoNothing({
          target: [teamMembers.teamId, teamMembers.userId],
        });
    }
  });

  return matchedTeamIds;
}
