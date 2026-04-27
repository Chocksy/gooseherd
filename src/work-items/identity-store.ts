import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { orgRoleAssignments, teamMembers, teams, users } from "../db/schema.js";

export interface IdentityUserRecord {
  id: string;
  slackUserId?: string;
  githubLogin?: string;
  jiraAccountId?: string;
  primaryTeamId?: string;
  displayName: string;
  isActive: boolean;
}

export interface IdentityTeamRecord {
  id: string;
  name: string;
  slackChannelId: string;
  isDefault: boolean;
}

export class WorkItemIdentityStore {
  constructor(private readonly db: Database) {}

  async getUserByGitHubLogin(githubLogin: string): Promise<IdentityUserRecord | undefined> {
    const rows = await this.db.select().from(users).where(eq(users.githubLogin, githubLogin)).limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      slackUserId: row.slackUserId ?? undefined,
      githubLogin: row.githubLogin ?? undefined,
      jiraAccountId: row.jiraAccountId ?? undefined,
      primaryTeamId: row.primaryTeamId ?? undefined,
      displayName: row.displayName,
      isActive: row.isActive,
    };
  }

  async getUser(id: string): Promise<IdentityUserRecord | undefined> {
    const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      slackUserId: row.slackUserId ?? undefined,
      githubLogin: row.githubLogin ?? undefined,
      jiraAccountId: row.jiraAccountId ?? undefined,
      primaryTeamId: row.primaryTeamId ?? undefined,
      displayName: row.displayName,
      isActive: row.isActive,
    };
  }

  async getUserBySlackUserId(slackUserId: string): Promise<IdentityUserRecord | undefined> {
    const rows = await this.db.select().from(users).where(eq(users.slackUserId, slackUserId)).limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      slackUserId: row.slackUserId ?? undefined,
      githubLogin: row.githubLogin ?? undefined,
      jiraAccountId: row.jiraAccountId ?? undefined,
      primaryTeamId: row.primaryTeamId ?? undefined,
      displayName: row.displayName,
      isActive: row.isActive,
    };
  }

  async getUserByJiraAccountId(jiraAccountId: string): Promise<IdentityUserRecord | undefined> {
    const rows = await this.db.select().from(users).where(eq(users.jiraAccountId, jiraAccountId)).limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      slackUserId: row.slackUserId ?? undefined,
      githubLogin: row.githubLogin ?? undefined,
      jiraAccountId: row.jiraAccountId ?? undefined,
      primaryTeamId: row.primaryTeamId ?? undefined,
      displayName: row.displayName,
      isActive: row.isActive,
    };
  }

  async getTeam(id: string): Promise<IdentityTeamRecord | undefined> {
    const rows = await this.db.select().from(teams).where(eq(teams.id, id)).limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      slackChannelId: row.slackChannelId,
      isDefault: row.isDefault,
    };
  }

  async getDefaultTeam(): Promise<IdentityTeamRecord | undefined> {
    const rows = await this.db.select().from(teams).where(eq(teams.isDefault, true)).limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      slackChannelId: row.slackChannelId,
      isDefault: row.isDefault,
    };
  }

  async getPrimaryTeamForUser(userId: string): Promise<IdentityTeamRecord | undefined> {
    const user = await this.getUser(userId);
    if (!user?.primaryTeamId) return undefined;
    return this.getTeam(user.primaryTeamId);
  }

  async ensureUserTeamMembership(
    userId: string,
    teamId: string,
    membershipSource: string,
    createIfMissing = false
  ): Promise<void> {
    const rows = await this.db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, userId), eq(teamMembers.teamId, teamId)))
      .limit(1);
    if (rows.length > 0) {
      return;
    }

    if (!createIfMissing) {
      throw new Error(`User ${userId} must already be a member of team ${teamId} before setting ${membershipSource}`);
    }

    await this.db.insert(teamMembers).values({
      teamId,
      userId,
      functionalRoles: [],
      membershipSource,
    });
  }

  async listTeamsForUser(userId: string): Promise<IdentityTeamRecord[]> {
    const memberships = await this.db.select().from(teamMembers).where(eq(teamMembers.userId, userId));
    const teamIds = memberships.map((membership) => membership.teamId);
    if (teamIds.length === 0) return [];
    const rows = await this.db.select().from(teams).where(inArray(teams.id, teamIds));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slackChannelId: row.slackChannelId,
      isDefault: row.isDefault,
    }));
  }

  async isUserOnTeam(userId: string, teamId: string): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, userId), eq(teamMembers.teamId, teamId)))
      .limit(1);
    return rows.length > 0;
  }

  async userHasTeamFunctionalRole(userId: string, teamId: string, role: string): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, userId), eq(teamMembers.teamId, teamId)))
      .limit(1);
    return Array.isArray(rows[0]?.functionalRoles) && rows[0]!.functionalRoles.includes(role);
  }

  async userIsPmForTeam(userId: string, teamId: string): Promise<boolean> {
    return this.userHasTeamFunctionalRole(userId, teamId, "pm");
  }

  async userIsAdmin(userId: string): Promise<boolean> {
    return this.userHasOrgRole(userId, "admin");
  }

  async userHasOrgRole(userId: string, orgRole: string): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(orgRoleAssignments)
      .where(and(eq(orgRoleAssignments.userId, userId), eq(orgRoleAssignments.orgRole, orgRole)))
      .limit(1);
    return rows.length > 0;
  }

  async listUsersForTeamRole(teamId: string, role: string): Promise<IdentityUserRecord[]> {
    const memberships = await this.db.select().from(teamMembers).where(eq(teamMembers.teamId, teamId));
    const userIds = memberships
      .filter((membership) => Array.isArray(membership.functionalRoles) && membership.functionalRoles.includes(role))
      .map((membership) => membership.userId);

    return this.listUsersByIds(userIds);
  }

  async listUsersForOrgRole(orgRole: string): Promise<IdentityUserRecord[]> {
    const assignments = await this.db.select().from(orgRoleAssignments).where(eq(orgRoleAssignments.orgRole, orgRole));
    return this.listUsersByIds(assignments.map((assignment) => assignment.userId));
  }

  private async listUsersByIds(userIds: string[]): Promise<IdentityUserRecord[]> {
    if (userIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .select()
      .from(users)
      .where(and(inArray(users.id, userIds), eq(users.isActive, true)));

    return rows.map((row) => ({
      id: row.id,
      slackUserId: row.slackUserId ?? undefined,
      githubLogin: row.githubLogin ?? undefined,
      jiraAccountId: row.jiraAccountId ?? undefined,
      primaryTeamId: row.primaryTeamId ?? undefined,
      displayName: row.displayName,
      isActive: row.isActive,
    }));
  }
}
