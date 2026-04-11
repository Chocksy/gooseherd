import type { Database } from "../db/index.js";
import { WorkItemIdentityStore } from "./identity-store.js";
import type { ReviewRequestRecord, WorkItemRecord } from "./types.js";

export class WorkItemAuthorization {
  private readonly identity: WorkItemIdentityStore;

  constructor(db: Database) {
    this.identity = new WorkItemIdentityStore(db);
  }

  async assertCanCreateForTeam(actorUserId: string, ownerTeamId: string): Promise<void> {
    const actor = await this.requireActiveUser(actorUserId);
    if (actor.id === actorUserId && await this.identity.isUserOnTeam(actorUserId, ownerTeamId)) {
      return;
    }
    if (await this.identity.userHasAnyOrgRole(actorUserId)) {
      return;
    }
    throw new Error("Actor is not authorized to create work items for this team");
  }

  async assertCanManageWorkItem(actorUserId: string | undefined, workItem: WorkItemRecord): Promise<void> {
    if (!actorUserId) return;

    const actor = await this.requireActiveUser(actorUserId);
    if (actor.id === workItem.createdByUserId) {
      return;
    }
    if (await this.identity.isUserOnTeam(actorUserId, workItem.ownerTeamId)) {
      return;
    }
    if (await this.identity.userHasAnyOrgRole(actorUserId)) {
      return;
    }
    throw new Error("Actor is not authorized for this work item");
  }

  async assertCanRespondToReviewRequest(
    actorUserId: string | undefined,
    workItem: WorkItemRecord,
    reviewRequest: ReviewRequestRecord,
  ): Promise<void> {
    if (!actorUserId) return;
    await this.requireActiveUser(actorUserId);

    if (await this.identity.userHasAnyOrgRole(actorUserId)) {
      return;
    }

    const ref = reviewRequest.targetRef ?? {};
    if (reviewRequest.targetType === "user") {
      if (typeof ref.userId === "string" && ref.userId === actorUserId) {
        return;
      }
      throw new Error("Actor is not authorized to respond to this review request");
    }

    if (reviewRequest.targetType === "team") {
      const teamId = typeof ref.teamId === "string" ? ref.teamId : workItem.ownerTeamId;
      if (await this.identity.isUserOnTeam(actorUserId, teamId)) {
        return;
      }
      throw new Error("Actor is not authorized to respond to this review request");
    }

    if (reviewRequest.targetType === "team_role") {
      const teamId = typeof ref.teamId === "string" ? ref.teamId : workItem.ownerTeamId;
      const role = typeof ref.role === "string" ? ref.role : typeof ref.teamRole === "string" ? ref.teamRole : undefined;
      if (role && await this.identity.userHasTeamRole(actorUserId, teamId, role)) {
        return;
      }
      throw new Error("Actor is not authorized to respond to this review request");
    }

    if (reviewRequest.targetType === "org_role") {
      const role = typeof ref.role === "string" ? ref.role : typeof ref.orgRole === "string" ? ref.orgRole : undefined;
      if (role && await this.identity.userHasOrgRole(actorUserId, role)) {
        return;
      }
      throw new Error("Actor is not authorized to respond to this review request");
    }
  }

  private async requireActiveUser(userId: string) {
    const actor = await this.identity.getUser(userId);
    if (!actor || !actor.isActive) {
      throw new Error("Unknown or inactive actor");
    }
    return actor;
  }
}
