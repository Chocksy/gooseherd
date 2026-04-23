import type { IncomingMessage } from "node:http";
import { getDashboardSession, type DashboardSessionLookup } from "./auth.js";
import type {
  DashboardSessionAuthMethod,
  DashboardSessionRecord,
} from "./auth-session-store.js";

export type DashboardUserSessionAuthMethod = Exclude<DashboardSessionAuthMethod, "admin_password">;

export interface DashboardUserActorPrincipal {
  principalType: "user";
  sessionId: string;
  authMethod: DashboardUserSessionAuthMethod;
  userId: string;
}

export interface DashboardAdminActorPrincipal {
  principalType: "admin_session";
  sessionId: string;
  authMethod: "admin_password";
}

export type DashboardActorPrincipal = DashboardUserActorPrincipal | DashboardAdminActorPrincipal;

type DashboardActorSessionStore = DashboardSessionLookup;

function toDashboardActorPrincipal(session: DashboardSessionRecord): DashboardActorPrincipal | undefined {
  if (session.principalType === "user") {
    if (!session.userId || session.authMethod === "admin_password") return undefined;
    return {
      principalType: "user",
      sessionId: session.id,
      authMethod: session.authMethod,
      userId: session.userId,
    };
  }

  if (session.principalType === "admin") {
    if (session.authMethod !== "admin_password") return undefined;
    return {
      principalType: "admin_session",
      sessionId: session.id,
      authMethod: "admin_password",
    };
  }

  return undefined;
}

export async function resolveDashboardActorPrincipal(
  req: IncomingMessage,
  sessionStore?: DashboardActorSessionStore,
): Promise<DashboardActorPrincipal | undefined> {
  const session = await getDashboardSession(req, sessionStore);
  if (!session) return undefined;

  return toDashboardActorPrincipal(session);
}

export function isDashboardAdminPrincipal(
  principal: DashboardActorPrincipal | undefined,
): principal is DashboardAdminActorPrincipal {
  return principal?.principalType === "admin_session";
}

export function requireDashboardUserActor(
  principal: DashboardActorPrincipal | undefined,
): DashboardUserActorPrincipal {
  if (!principal) {
    throw new Error("Dashboard user actor is required");
  }

  if (isDashboardAdminPrincipal(principal)) {
    throw new Error("Admin dashboard sessions are not allowed here");
  }

  return principal;
}
