import type { Database } from "../db/index.js";
import { WorkItemIdentityStore } from "./identity-store.js";

export interface CreateHomeThreadInput {
  channelId: string;
  text: string;
}

export interface ResolveWorkItemContextInput {
  createdByUserId?: string;
  actorJiraAccountId?: string;
  ownerTeamId?: string;
  originChannelId?: string;
  originThreadTs?: string;
  title?: string;
  createHomeThread?: (input: CreateHomeThreadInput) => Promise<string>;
}

export interface ResolvedWorkItemContext {
  createdByUserId: string;
  ownerTeamId: string;
  homeChannelId: string;
  homeThreadTs: string;
  originChannelId?: string;
  originThreadTs?: string;
}

export class WorkItemContextResolver {
  private readonly identity: WorkItemIdentityStore;

  constructor(db: Database) {
    this.identity = new WorkItemIdentityStore(db);
  }

  async resolveDiscoveryContext(input: ResolveWorkItemContextInput): Promise<ResolvedWorkItemContext> {
    return this.resolveContext(input, "Discovery");
  }

  async resolveDeliveryContext(input: ResolveWorkItemContextInput): Promise<ResolvedWorkItemContext> {
    return this.resolveContext(input, "Delivery");
  }

  private async resolveContext(input: ResolveWorkItemContextInput, label: string): Promise<ResolvedWorkItemContext> {
    const actor = await this.resolveActor(input);
    if (!actor.isActive) {
      throw new Error(`Inactive user cannot create ${label.toLowerCase()} work items`);
    }

    const accessibleTeams = await this.identity.listTeamsForUser(actor.id);
    if (accessibleTeams.length === 0) {
      throw new Error(`User ${actor.displayName} does not have access to any teams`);
    }

    const team = await this.resolveOwnerTeam(actor.id, accessibleTeams, input.ownerTeamId);
    const homeChannelId = team.slackChannelId;
    const homeThreadTs = await this.resolveHomeThreadTs({
      homeChannelId,
      originChannelId: input.originChannelId,
      originThreadTs: input.originThreadTs,
      title: input.title ?? `${label} work item`,
      createHomeThread: input.createHomeThread,
    });

    return {
      createdByUserId: actor.id,
      ownerTeamId: team.id,
      homeChannelId,
      homeThreadTs,
      originChannelId: input.originChannelId,
      originThreadTs: input.originThreadTs,
    };
  }

  private async resolveActor(input: ResolveWorkItemContextInput) {
    if (input.createdByUserId) {
      const user = await this.identity.getUser(input.createdByUserId);
      if (!user) throw new Error(`Unknown user: ${input.createdByUserId}`);
      return user;
    }

    if (input.actorJiraAccountId) {
      const user = await this.identity.getUserByJiraAccountId(input.actorJiraAccountId);
      if (!user) throw new Error(`Unknown Jira actor: ${input.actorJiraAccountId}`);
      return user;
    }

    throw new Error("createdByUserId or actorJiraAccountId is required");
  }

  private async resolveOwnerTeam(
    userId: string,
    accessibleTeams: Array<{ id: string; name: string; slackChannelId: string }>,
    ownerTeamId?: string,
  ) {
    if (ownerTeamId) {
      const allowed = accessibleTeams.find((team) => team.id === ownerTeamId);
      if (!allowed) {
        throw new Error(`User is not allowed to create work items for owner team ${ownerTeamId}`);
      }
      return allowed;
    }

    if (accessibleTeams.length === 1) {
      return accessibleTeams[0]!;
    }

    const primaryTeam = await this.identity.getPrimaryTeamForUser(userId);
    if (primaryTeam && accessibleTeams.some((team) => team.id === primaryTeam.id)) {
      return primaryTeam;
    }

    const defaultTeam = await this.identity.getDefaultTeam();
    if (defaultTeam && accessibleTeams.some((team) => team.id === defaultTeam.id)) {
      return defaultTeam;
    }

    throw new Error("owner team must be selected when the actor can access multiple teams");
  }

  private async resolveHomeThreadTs(input: {
    homeChannelId: string;
    originChannelId?: string;
    originThreadTs?: string;
    title: string;
    createHomeThread?: (input: CreateHomeThreadInput) => Promise<string>;
  }): Promise<string> {
    if (input.originChannelId && input.originChannelId === input.homeChannelId && input.originThreadTs) {
      return input.originThreadTs;
    }

    if (!input.createHomeThread) {
      throw new Error("Cannot resolve home thread without a thread creator when origin channel differs from owner team channel");
    }

    return input.createHomeThread({
      channelId: input.homeChannelId,
      text: `Created managed work item thread for: ${input.title}`,
    });
  }
}
