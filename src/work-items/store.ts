import { randomUUID } from "node:crypto";
import { and, arrayContains, desc, eq, isNotNull, not, or, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { workItems } from "../db/schema.js";
import type { CreateWorkItemInput, UpdateWorkItemStateInput, WorkItemRecord } from "./types.js";
import { assertStateMatchesWorkflow, assertStateTransitionAllowed } from "./workflow-policy.js";

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
    githubPrBaseBranch: row.githubPrBaseBranch ?? undefined,
    githubPrHeadBranch: row.githubPrHeadBranch ?? undefined,
    githubPrHeadSha: row.githubPrHeadSha ?? undefined,
    sourceWorkItemId: row.sourceWorkItemId ?? undefined,
    repo: row.repo ?? undefined,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString(),
  };
}

export class WorkItemStore {
  constructor(private readonly db: Database) {}

  private async withLockedWorkItem<T>(id: string, callback: (store: WorkItemStore) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const txDb = tx as unknown as Database;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${id}))`);
      return callback(new WorkItemStore(txDb));
    });
  }

  async createWorkItem(input: CreateWorkItemInput): Promise<WorkItemRecord> {
    const id = randomUUID();
    const now = new Date();

    assertStateMatchesWorkflow(input.workflow, input.state);

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
      githubPrBaseBranch: input.githubPrBaseBranch,
      githubPrHeadBranch: input.githubPrHeadBranch,
      githubPrHeadSha: input.githubPrHeadSha,
      sourceWorkItemId: input.sourceWorkItemId,
      repo: input.repo,
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

  async requireWorkItem(id: string): Promise<WorkItemRecord> {
    const workItem = await this.getWorkItem(id);
    if (!workItem) {
      throw new Error(`WorkItem not found: ${id}`);
    }
    return workItem;
  }

  async listWorkItems(): Promise<WorkItemRecord[]> {
    const rows = await this.db.select().from(workItems).orderBy(desc(workItems.createdAt));
    return rows.map(rowToRecord);
  }

  async listBranchSyncCandidateWorkItems(): Promise<WorkItemRecord[]> {
    const rows = await this.db
      .select()
      .from(workItems)
      .where(and(
        eq(workItems.workflow, "feature_delivery"),
        isNotNull(workItems.repo),
        isNotNull(workItems.githubPrNumber),
        or(
          not(sql`${workItems.state} in ('done', 'cancelled')`),
          and(
            eq(workItems.state, "cancelled"),
            arrayContains(workItems.flags, ["ai_assist_disabled"]),
            not(arrayContains(workItems.flags, ["pr_closed"])),
          ),
        ),
      ))
      .orderBy(desc(workItems.createdAt));
    return rows.map(rowToRecord);
  }

  async findByGitHubPrNumber(githubPrNumber: number): Promise<WorkItemRecord | undefined> {
    const rows = await this.db.select().from(workItems).where(eq(workItems.githubPrNumber, githubPrNumber)).limit(1);
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async findByRepoAndGitHubPrNumber(repo: string, githubPrNumber: number): Promise<WorkItemRecord | undefined> {
    const rows = await this.db
      .select()
      .from(workItems)
      .where(and(eq(workItems.repo, repo), eq(workItems.githubPrNumber, githubPrNumber)))
      .limit(1);
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async findUniqueLegacyByGitHubPrNumber(githubPrNumber: number): Promise<WorkItemRecord | undefined> {
    const rows = await this.db
      .select()
      .from(workItems)
      .where(eq(workItems.githubPrNumber, githubPrNumber))
      .limit(2);
    if (rows.length !== 1) {
      return undefined;
    }
    const row = rows[0]!;
    if (row.repo) {
      return undefined;
    }
    return rowToRecord(row);
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

  async findProductDiscoveryByJiraIssueKey(jiraIssueKey: string): Promise<WorkItemRecord | undefined> {
    const rows = await this.db
      .select()
      .from(workItems)
      .where(and(eq(workItems.jiraIssueKey, jiraIssueKey), eq(workItems.workflow, "product_discovery")))
      .orderBy(desc(workItems.createdAt))
      .limit(1);
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async listFeatureDeliveriesByJiraIssueKey(jiraIssueKey: string): Promise<WorkItemRecord[]> {
    const rows = await this.db
      .select()
      .from(workItems)
      .where(and(eq(workItems.jiraIssueKey, jiraIssueKey), eq(workItems.workflow, "feature_delivery")))
      .orderBy(desc(workItems.createdAt));
    return rows.map(rowToRecord);
  }

  async listFeatureDeliveryAdoptionCandidatesByJiraIssueKey(jiraIssueKey: string): Promise<WorkItemRecord[]> {
    const rows = await this.db
      .select()
      .from(workItems)
      .where(
        and(
          eq(workItems.jiraIssueKey, jiraIssueKey),
          eq(workItems.workflow, "feature_delivery"),
          sql`github_pr_number IS NULL`,
          sql`state NOT IN ('done', 'cancelled')`
        )
      )
      .orderBy(desc(workItems.createdAt));
    return rows.map(rowToRecord);
  }

  async findFeatureDeliveryBySourceWorkItemId(sourceWorkItemId: string): Promise<WorkItemRecord | undefined> {
    const rows = await this.db
      .select()
      .from(workItems)
      .where(and(eq(workItems.sourceWorkItemId, sourceWorkItemId), eq(workItems.workflow, "feature_delivery")))
      .limit(1);
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async listFeatureDeliveriesBySourceWorkItemId(sourceWorkItemId: string): Promise<WorkItemRecord[]> {
    const rows = await this.db
      .select()
      .from(workItems)
      .where(and(eq(workItems.sourceWorkItemId, sourceWorkItemId), eq(workItems.workflow, "feature_delivery")))
      .orderBy(desc(workItems.createdAt));
    return rows.map(rowToRecord);
  }

  async updateState(id: string, input: UpdateWorkItemStateInput): Promise<WorkItemRecord> {
    return this.withLockedWorkItem(id, async (txWorkItems) => {
      const current = await txWorkItems.getWorkItem(id);
      if (!current) throw new Error(`WorkItem not found: ${id}`);

      assertStateTransitionAllowed(current, input.state);

      const nextFlags = new Set(current.flags);
      for (const flag of input.flagsToAdd ?? []) nextFlags.add(flag);
      for (const flag of input.flagsToRemove ?? []) nextFlags.delete(flag);

      await txWorkItems.db
        .update(workItems)
        .set({
          state: input.state,
          substate: input.substate ?? null,
          flags: Array.from(nextFlags),
          completedAt: input.state === "done" || input.state === "cancelled" ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(workItems.id, id));

      const updated = await txWorkItems.getWorkItem(id);
      if (!updated) throw new Error(`WorkItem not found after update: ${id}`);
      return updated;
    });
  }

  async rollbackAutoReviewCollectingContext(input: {
    workItemId: string;
    expectedState: "auto_review";
    expectedSubstate: "collecting_context";
    targetSubstate: string;
  }): Promise<WorkItemRecord | undefined> {
    const rows = await this.db
      .update(workItems)
      .set({
        state: "auto_review",
        substate: input.targetSubstate,
        updatedAt: new Date(),
      })
      .where(and(
        eq(workItems.id, input.workItemId),
        eq(workItems.state, input.expectedState),
        eq(workItems.substate, input.expectedSubstate),
      ))
      .returning();

    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async addFlags(id: string, flagsToAdd: string[]): Promise<WorkItemRecord> {
    return this.updateState(id, {
      state: (await this.getWorkItem(id))?.state ?? (() => { throw new Error(`WorkItem not found: ${id}`); })(),
      substate: (await this.getWorkItem(id))?.substate,
      flagsToAdd,
    });
  }

  async setFlagState(id: string, flag: string, enabled: boolean): Promise<WorkItemRecord> {
    return this.withLockedWorkItem(id, async (txWorkItems) => {
      const current = await txWorkItems.getWorkItem(id);
      if (!current) {
        throw new Error(`WorkItem not found: ${id}`);
      }

      const nextFlags = new Set(current.flags);
      if (enabled) {
        nextFlags.add(flag);
      } else {
        nextFlags.delete(flag);
      }

      if (nextFlags.size === current.flags.length && current.flags.every((value) => nextFlags.has(value))) {
        return current;
      }

      await txWorkItems.db
        .update(workItems)
        .set({
          flags: Array.from(nextFlags),
          updatedAt: new Date(),
        })
        .where(eq(workItems.id, id));

      return txWorkItems.requireWorkItem(id);
    });
  }

  async setJiraIssueKey(id: string, jiraIssueKey: string): Promise<WorkItemRecord> {
    return this.withLockedWorkItem(id, async (txWorkItems) => {
      await txWorkItems.db
        .update(workItems)
        .set({
          jiraIssueKey,
          updatedAt: new Date(),
        })
        .where(eq(workItems.id, id));

      const updated = await txWorkItems.getWorkItem(id);
      if (!updated) throw new Error(`WorkItem not found after Jira link: ${id}`);
      return updated;
    });
  }

  async linkPullRequest(
    id: string,
    input: {
      repo?: string;
      githubPrNumber: number;
      githubPrUrl?: string;
      githubPrBaseBranch?: string;
      githubPrHeadBranch?: string;
      githubPrHeadSha?: string;
    }
  ): Promise<WorkItemRecord> {
    return this.withLockedWorkItem(id, async (txWorkItems) => {
      await txWorkItems.db
        .update(workItems)
        .set({
          repo: input.repo,
          githubPrNumber: input.githubPrNumber,
          githubPrUrl: input.githubPrUrl ?? null,
          githubPrBaseBranch: input.githubPrBaseBranch ?? null,
          githubPrHeadBranch: input.githubPrHeadBranch ?? null,
          githubPrHeadSha: input.githubPrHeadSha ?? null,
          updatedAt: new Date(),
        })
        .where(eq(workItems.id, id));

      const updated = await txWorkItems.getWorkItem(id);
      if (!updated) throw new Error(`WorkItem not found after PR link: ${id}`);
      return updated;
    });
  }
}
