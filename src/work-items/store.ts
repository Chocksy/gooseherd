import { randomUUID } from "node:crypto";
import { eq, desc } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { workItems } from "../db/schema.js";
import type { CreateWorkItemInput, UpdateWorkItemStateInput, WorkItemRecord } from "./types.js";

type WorkItemRow = typeof workItems.$inferSelect;

function rowToRecord(row: WorkItemRow): WorkItemRecord {
  return {
    id: row.id,
    workflow: row.workflow as WorkItemRecord["workflow"],
    state: row.state as WorkItemRecord["state"],
    substate: row.substate ?? undefined,
    flags: row.flags ?? [],
    title: row.title,
    summary: row.summary,
    ownerTeamId: row.ownerTeamId,
    homeChannelId: row.homeChannelId,
    homeThreadTs: row.homeThreadTs,
    originChannelId: row.originChannelId ?? undefined,
    originThreadTs: row.originThreadTs ?? undefined,
    jiraIssueKey: row.jiraIssueKey ?? undefined,
    githubPrNumber: row.githubPrNumber ?? undefined,
    githubPrUrl: row.githubPrUrl ?? undefined,
    sourceWorkItemId: row.sourceWorkItemId ?? undefined,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString(),
  };
}

export class WorkItemStore {
  constructor(private readonly db: Database) {}

  async createWorkItem(input: CreateWorkItemInput): Promise<WorkItemRecord> {
    const id = randomUUID();
    const now = new Date();

    await this.db.insert(workItems).values({
      id,
      workflow: input.workflow,
      state: input.state,
      substate: input.substate,
      flags: input.flags ?? [],
      title: input.title,
      summary: input.summary ?? "",
      ownerTeamId: input.ownerTeamId,
      homeChannelId: input.homeChannelId,
      homeThreadTs: input.homeThreadTs,
      originChannelId: input.originChannelId,
      originThreadTs: input.originThreadTs,
      jiraIssueKey: input.jiraIssueKey,
      githubPrNumber: input.githubPrNumber,
      githubPrUrl: input.githubPrUrl,
      sourceWorkItemId: input.sourceWorkItemId,
      createdByUserId: input.createdByUserId,
      createdAt: now,
      updatedAt: now,
    });

    return (await this.getWorkItem(id))!;
  }

  async getWorkItem(id: string): Promise<WorkItemRecord | undefined> {
    const rows = await this.db.select().from(workItems).where(eq(workItems.id, id));
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async listWorkItems(): Promise<WorkItemRecord[]> {
    const rows = await this.db.select().from(workItems).orderBy(desc(workItems.createdAt));
    return rows.map(rowToRecord);
  }

  async findByGitHubPrNumber(githubPrNumber: number): Promise<WorkItemRecord | undefined> {
    const rows = await this.db.select().from(workItems).where(eq(workItems.githubPrNumber, githubPrNumber)).limit(1);
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async findByJiraIssueKey(jiraIssueKey: string): Promise<WorkItemRecord | undefined> {
    const rows = await this.db
      .select()
      .from(workItems)
      .where(eq(workItems.jiraIssueKey, jiraIssueKey))
      .orderBy(desc(workItems.createdAt))
      .limit(1);
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async updateState(id: string, input: UpdateWorkItemStateInput): Promise<WorkItemRecord> {
    const current = await this.getWorkItem(id);
    if (!current) throw new Error(`WorkItem not found: ${id}`);

    const nextFlags = new Set(current.flags);
    for (const flag of input.flagsToAdd ?? []) nextFlags.add(flag);
    for (const flag of input.flagsToRemove ?? []) nextFlags.delete(flag);

    await this.db
      .update(workItems)
      .set({
        state: input.state,
        substate: input.substate ?? null,
        flags: Array.from(nextFlags),
        completedAt: input.state === "done" || input.state === "cancelled" ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(workItems.id, id));

    const updated = await this.getWorkItem(id);
    if (!updated) throw new Error(`WorkItem not found after update: ${id}`);
    return updated;
  }

  async addFlags(id: string, flagsToAdd: string[]): Promise<WorkItemRecord> {
    return this.updateState(id, {
      state: (await this.getWorkItem(id))?.state ?? (() => { throw new Error(`WorkItem not found: ${id}`); })(),
      substate: (await this.getWorkItem(id))?.substate,
      flagsToAdd,
    });
  }

  async setJiraIssueKey(id: string, jiraIssueKey: string): Promise<WorkItemRecord> {
    await this.db
      .update(workItems)
      .set({
        jiraIssueKey,
        updatedAt: new Date(),
      })
      .where(eq(workItems.id, id));

    const updated = await this.getWorkItem(id);
    if (!updated) throw new Error(`WorkItem not found after Jira link: ${id}`);
    return updated;
  }

  async linkPullRequest(id: string, input: { githubPrNumber: number; githubPrUrl?: string }): Promise<WorkItemRecord> {
    await this.db
      .update(workItems)
      .set({
        githubPrNumber: input.githubPrNumber,
        githubPrUrl: input.githubPrUrl ?? null,
        updatedAt: new Date(),
      })
      .where(eq(workItems.id, id));

    const updated = await this.getWorkItem(id);
    if (!updated) throw new Error(`WorkItem not found after PR link: ${id}`);
    return updated;
  }
}
