import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { users } from "../db/schema.js";

export interface UserDirectoryRecord {
  id: string;
  displayName: string;
  slackUserId: string | null;
  githubLogin: string | null;
  jiraAccountId: string | null;
  primaryTeamId: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateUserDirectoryInput {
  displayName: string;
  slackUserId: string | null;
  githubLogin: string | null;
  jiraAccountId: string | null;
  primaryTeamId: string | null;
  isActive: boolean;
}

export interface UpdateUserDirectoryInput extends CreateUserDirectoryInput {}

function toRecord(row: typeof users.$inferSelect): UserDirectoryRecord {
  return {
    id: row.id,
    displayName: row.displayName,
    slackUserId: row.slackUserId ?? null,
    githubLogin: row.githubLogin ?? null,
    jiraAccountId: row.jiraAccountId ?? null,
    primaryTeamId: row.primaryTeamId ?? null,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class UserDirectoryStore {
  constructor(private readonly db: Database) {}

  async listUsers(): Promise<UserDirectoryRecord[]> {
    const rows = await this.db.select().from(users).orderBy(asc(users.displayName), asc(users.createdAt));
    return rows.map(toRecord);
  }

  async getUser(id: string): Promise<UserDirectoryRecord | undefined> {
    const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : undefined;
  }

  async createUser(input: CreateUserDirectoryInput): Promise<UserDirectoryRecord> {
    const id = randomUUID();
    const now = new Date();
    await this.db.insert(users).values({
      id,
      displayName: input.displayName,
      slackUserId: input.slackUserId,
      githubLogin: input.githubLogin,
      jiraAccountId: input.jiraAccountId,
      primaryTeamId: input.primaryTeamId,
      isActive: input.isActive,
      createdAt: now,
      updatedAt: now,
    });
    return (await this.getUser(id))!;
  }

  async updateUser(id: string, input: UpdateUserDirectoryInput): Promise<UserDirectoryRecord> {
    await this.db.update(users).set({
      displayName: input.displayName,
      slackUserId: input.slackUserId,
      githubLogin: input.githubLogin,
      jiraAccountId: input.jiraAccountId,
      primaryTeamId: input.primaryTeamId,
      isActive: input.isActive,
      updatedAt: new Date(),
    }).where(eq(users.id, id));

    const updated = await this.getUser(id);
    if (!updated) {
      throw new Error(`User not found: ${id}`);
    }
    return updated;
  }
}
