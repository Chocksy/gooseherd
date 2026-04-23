import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { dashboardAuthSessions } from "../db/schema.js";

export type DashboardSessionPrincipalType = "admin" | "user";
export type DashboardSessionAuthMethod = "admin_password" | "slack";

export interface CreateDashboardSessionInput {
  principalType: DashboardSessionPrincipalType;
  authMethod: DashboardSessionAuthMethod;
  userId?: string;
  ttlMs: number;
}

export interface CreatedDashboardSession {
  sessionId: string;
  token: string;
}

export interface DashboardSessionRecord {
  id: string;
  principalType: DashboardSessionPrincipalType;
  authMethod: DashboardSessionAuthMethod;
  userId?: string;
  expiresAt: string;
  lastSeenAt: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function toSessionRecord(row: typeof dashboardAuthSessions.$inferSelect): DashboardSessionRecord {
  return {
    id: row.id,
    principalType: row.principalType as DashboardSessionPrincipalType,
    authMethod: row.authMethod as DashboardSessionAuthMethod,
    userId: row.userId ?? undefined,
    expiresAt: row.expiresAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

export class DashboardAuthSessionStore {
  constructor(private readonly db: Database) {}

  async createSession(input: CreateDashboardSessionInput): Promise<CreatedDashboardSession> {
    const now = new Date();
    const token = randomBytes(24).toString("hex");
    const sessionId = randomUUID();

    await this.db.insert(dashboardAuthSessions).values({
      id: sessionId,
      tokenHash: hashToken(token),
      principalType: input.principalType,
      authMethod: input.authMethod,
      userId: input.userId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + Math.max(1, input.ttlMs)),
      lastSeenAt: now,
      revokedAt: null,
    });

    return { sessionId, token };
  }

  async getSessionByToken(token: string): Promise<DashboardSessionRecord | undefined> {
    const now = new Date();
    const rows = await this.db
      .select()
      .from(dashboardAuthSessions)
      .where(and(
        eq(dashboardAuthSessions.tokenHash, hashToken(token)),
        isNull(dashboardAuthSessions.revokedAt),
        gt(dashboardAuthSessions.expiresAt, now),
      ))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;

    await this.db
      .update(dashboardAuthSessions)
      .set({ lastSeenAt: now })
      .where(eq(dashboardAuthSessions.id, row.id));

    return toSessionRecord({ ...row, lastSeenAt: now });
  }

  async revokeSession(token: string): Promise<void> {
    await this.db
      .update(dashboardAuthSessions)
      .set({ revokedAt: new Date() })
      .where(eq(dashboardAuthSessions.tokenHash, hashToken(token)));
  }
}
