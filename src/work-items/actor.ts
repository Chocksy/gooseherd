export type WorkItemActor =
  | {
      principalType: "user";
      userId: string;
      authMethod: "slack" | "system";
      sessionId?: string;
    }
  | {
      principalType: "admin_session";
      authMethod: "admin_password";
      sessionId: string;
    };

export function requireUserActor(actor: WorkItemActor): Extract<WorkItemActor, { principalType: "user" }> {
  if (actor.principalType !== "user") {
    throw new Error("Actor is not authorized to participate in the workflow");
  }
  return actor;
}

export function isAdminOverrideActor(actor: WorkItemActor): actor is Extract<WorkItemActor, { principalType: "admin_session" }> {
  return actor.principalType === "admin_session";
}

export function actorAuditFields(actor: WorkItemActor): {
  actorPrincipalType: WorkItemActor["principalType"];
  actorAuthMethod: WorkItemActor["authMethod"];
  actorSessionId?: string;
} {
  return {
    actorPrincipalType: actor.principalType,
    actorAuthMethod: actor.authMethod,
    actorSessionId: actor.sessionId,
  };
}
