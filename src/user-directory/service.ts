import type { Database } from "../db/index.js";
import { WorkItemIdentityStore } from "../work-items/identity-store.js";
import {
  type CreateUserDirectoryInput,
  type UpdateUserDirectoryInput,
  type UserDirectoryRecord,
  UserDirectoryStore,
} from "./store.js";

export interface UserDirectoryMutationInput {
  displayName?: string;
  slackUserId?: string | null;
  githubLogin?: string | null;
  jiraAccountId?: string | null;
  primaryTeamId?: string | null;
  isActive?: boolean;
}

export class UserDirectoryService {
  private readonly db: Database;
  private readonly store: UserDirectoryStore;

  constructor(db: Database) {
    this.db = db;
    this.store = new UserDirectoryStore(db);
  }

  async listUsers(): Promise<UserDirectoryRecord[]> {
    return this.store.listUsers();
  }

  async createUser(input: UserDirectoryMutationInput): Promise<UserDirectoryRecord> {
    const normalized = normalizeInput(input);
    try {
      return await this.db.transaction(async (tx) => {
        const txDb = tx as unknown as Database;
        const txStore = new UserDirectoryStore(txDb);
        const txIdentity = new WorkItemIdentityStore(txDb);
        const created = await txStore.createUser(normalized);
        if (created.primaryTeamId) {
          await txIdentity.ensureUserTeamMembership(created.id, created.primaryTeamId, "primary_team", true);
        }
        return created;
      });
    } catch (error) {
      throw rewriteUserDirectoryError(error);
    }
  }

  async updateUser(id: string, input: UserDirectoryMutationInput): Promise<UserDirectoryRecord> {
    const normalized = normalizeInput(input);
    try {
      return await this.db.transaction(async (tx) => {
        const txDb = tx as unknown as Database;
        const txStore = new UserDirectoryStore(txDb);
        const txIdentity = new WorkItemIdentityStore(txDb);
        const updated = await txStore.updateUser(id, normalized);
        if (updated.primaryTeamId) {
          await txIdentity.ensureUserTeamMembership(updated.id, updated.primaryTeamId, "primary_team");
        }
        return updated;
      });
    } catch (error) {
      throw rewriteUserDirectoryError(error);
    }
  }
}

function normalizeInput(input: UserDirectoryMutationInput): CreateUserDirectoryInput | UpdateUserDirectoryInput {
  const displayName = typeof input.displayName === "string" ? input.displayName.trim() : "";
  if (!displayName) {
    throw new Error("Display name is required");
  }

  return {
    displayName,
    slackUserId: normalizeOptionalIdentity(input.slackUserId),
    githubLogin: normalizeOptionalIdentity(input.githubLogin),
    jiraAccountId: normalizeOptionalIdentity(input.jiraAccountId),
    primaryTeamId: normalizeOptionalIdentity(input.primaryTeamId),
    isActive: input.isActive ?? true,
  };
}

function normalizeOptionalIdentity(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}

function rewriteUserDirectoryError(error: unknown): Error {
  const resolvedError = unwrapError(error);

  if (resolvedError instanceof Error && resolvedError.message.startsWith("User not found:")) {
    return resolvedError;
  }
  if (!isUniqueConstraintError(resolvedError)) {
    return resolvedError instanceof Error ? resolvedError : new Error(String(resolvedError));
  }

  if (resolvedError.constraint_name === "users_slack_user_id_idx") {
    return new Error("Slack user already exists");
  }
  if (resolvedError.constraint_name === "users_github_login_idx") {
    return new Error("GitHub login already exists");
  }
  if (resolvedError.constraint_name === "users_jira_account_id_idx") {
    return new Error("Jira account already exists");
  }

  return resolvedError instanceof Error ? resolvedError : new Error(String(resolvedError));
}

function isUniqueConstraintError(error: unknown): error is Error & { code: string; constraint_name?: string } {
  return error instanceof Error && "code" in error && (error as { code?: string }).code === "23505";
}

function unwrapError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const nested = "cause" in error ? (error as Error & { cause?: unknown }).cause : undefined;
  return nested ?? error;
}
