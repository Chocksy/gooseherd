import { randomUUID } from "node:crypto";
import { eq, desc, and, sql, inArray, ne } from "drizzle-orm";
import type { NewRunInput, RunFeedback, RunRecord, RunStatus } from "./types.js";
import type { Database } from "./db/index.js";
import { runs } from "./db/schema.js";

type RunRow = typeof runs.$inferSelect;

function rowToRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    runtime: row.runtime as RunRecord["runtime"],
    status: row.status as RunStatus,
    phase: row.phase as RunRecord["phase"],
    repoSlug: row.repoSlug,
    task: row.task,
    baseBranch: row.baseBranch,
    branchName: row.branchName,
    requestedBy: row.requestedBy,
    channelId: row.channelId,
    threadTs: row.threadTs,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString(),
    finishedAt: row.finishedAt?.toISOString(),
    logsPath: row.logsPath ?? undefined,
    statusMessageTs: row.statusMessageTs ?? undefined,
    commitSha: row.commitSha ?? undefined,
    changedFiles: row.changedFiles ?? undefined,
    prUrl: row.prUrl ?? undefined,
    feedback: row.feedback as RunFeedback | undefined,
    error: row.error ?? undefined,
    parentRunId: row.parentRunId ?? undefined,
    rootRunId: row.rootRunId ?? undefined,
    chainIndex: row.chainIndex ?? undefined,
    parentBranchName: row.parentBranchName ?? undefined,
    feedbackNote: row.feedbackNote ?? undefined,
    pipelineHint: row.pipelineHint ?? undefined,
    skipNodes: row.skipNodes ?? undefined,
    enableNodes: row.enableNodes ?? undefined,
    ciFixAttempts: row.ciFixAttempts ?? undefined,
    ciConclusion: row.ciConclusion ?? undefined,
    prNumber: row.prNumber ?? undefined,
    title: row.title ?? undefined,
    tokenUsage: row.tokenUsage as RunRecord["tokenUsage"],
    teamId: row.teamId ?? undefined,
    workItemId: row.workItemId ?? undefined,
  };
}

export class RunStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async init(): Promise<void> {
    // No-op — migrations handle schema
  }

  async createRun(
    input: NewRunInput,
    branchPrefix: string,
    existingBranchName?: string
  ): Promise<RunRecord> {
    const id = randomUUID();
    const branchName = existingBranchName ?? `${branchPrefix}/${id.slice(0, 8)}`;

    // Resolve chain fields from parent
    let rootRunId: string | undefined;
    let chainIndex = 0;
    if (input.parentRunId) {
      const parentRows = await this.db
        .select()
        .from(runs)
        .where(eq(runs.id, input.parentRunId));
      const parent = parentRows[0];
      if (parent) {
        rootRunId = parent.rootRunId ?? parent.id;
        chainIndex = (parent.chainIndex ?? 0) + 1;
      }
    }

    await this.db.insert(runs).values({
      id,
      runtime: input.runtime,
      status: "queued",
      phase: "queued",
      repoSlug: input.repoSlug,
      task: input.task,
      baseBranch: input.baseBranch,
      branchName,
      requestedBy: input.requestedBy,
      channelId: input.channelId,
      threadTs: input.threadTs,
      createdAt: new Date(),
      parentRunId: input.parentRunId,
      rootRunId,
      chainIndex,
      parentBranchName: existingBranchName,
      feedbackNote: input.feedbackNote,
      pipelineHint: input.pipelineHint,
      skipNodes: input.skipNodes,
      enableNodes: input.enableNodes,
      teamId: input.teamId,
    });

    return (await this.getRun(id))!;
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    const rows = await this.db.select().from(runs).where(eq(runs.id, id));
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async listRuns(filter: { limit?: number; teamId?: string } | number = 100): Promise<RunRecord[]> {
    const opts = typeof filter === "number" ? { limit: filter } : filter;
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));

    const conditions = [];
    if (opts.teamId) {
      conditions.push(eq(runs.teamId, opts.teamId));
    }

    const rows = await this.db
      .select()
      .from(runs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(runs.createdAt))
      .limit(limit);

    return rows.map(rowToRecord);
  }

  async getLatestRunForThread(channelId: string, threadTs: string): Promise<RunRecord | undefined> {
    const rows = await this.db
      .select()
      .from(runs)
      .where(and(eq(runs.channelId, channelId), eq(runs.threadTs, threadTs)))
      .orderBy(desc(runs.createdAt))
      .limit(1);
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async getRunChain(channelId: string, threadTs: string): Promise<RunRecord[]> {
    const rows = await this.db
      .select()
      .from(runs)
      .where(and(eq(runs.channelId, channelId), eq(runs.threadTs, threadTs)))
      .orderBy(runs.createdAt);
    return rows.map(rowToRecord);
  }

  async listRunsForWorkItem(workItemId: string): Promise<RunRecord[]> {
    const rows = await this.db
      .select()
      .from(runs)
      .where(eq(runs.workItemId, workItemId))
      .orderBy(desc(runs.createdAt));
    return rows.map(rowToRecord);
  }

  async getRecentRuns(repoSlug?: string, limit = 10): Promise<RunRecord[]> {
    const conditions = repoSlug ? eq(runs.repoSlug, repoSlug) : undefined;
    const rows = await this.db
      .select()
      .from(runs)
      .where(conditions)
      .orderBy(desc(runs.createdAt))
      .limit(limit);
    return rows.map(rowToRecord);
  }

  async getLatestRunForChannel(channelId: string): Promise<RunRecord | undefined> {
    const rows = await this.db
      .select()
      .from(runs)
      .where(eq(runs.channelId, channelId))
      .orderBy(desc(runs.createdAt))
      .limit(1);
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async findRunByIdentifier(identifier: string): Promise<RunRecord | undefined> {
    const normalized = normalizeIdentifier(identifier);
    if (!normalized) return undefined;

    // Full UUID → exact match
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (UUID_RE.test(normalized)) {
      const exact = await this.db.select().from(runs).where(eq(runs.id, normalized));
      if (exact[0]) return rowToRecord(exact[0]);
      return undefined;
    }

    // Short ID → prefix match (cast uuid to text for LIKE)
    const prefixRows = await this.db
      .select()
      .from(runs)
      .where(sql`${runs.id}::text LIKE ${normalized + "%"}`)
      .limit(2);
    if (prefixRows.length === 1) return rowToRecord(prefixRows[0]!);

    return undefined;
  }

  async saveFeedback(id: string, feedback: RunFeedback): Promise<RunRecord> {
    return this.updateRun(id, { feedback });
  }

  async updateRun(
    id: string,
    update: Partial<
      Pick<
        RunRecord,
        | "status"
        | "phase"
        | "startedAt"
        | "finishedAt"
        | "logsPath"
        | "statusMessageTs"
        | "commitSha"
        | "changedFiles"
        | "prUrl"
        | "feedback"
        | "error"
        | "parentRunId"
        | "rootRunId"
        | "chainIndex"
        | "parentBranchName"
        | "feedbackNote"
        | "tokenUsage"
        | "title"
        | "workItemId"
      >
    >
  ): Promise<RunRecord> {
    const dbUpdate: Record<string, unknown> = {};

    if (update.status !== undefined) dbUpdate.status = update.status;
    if (update.phase !== undefined) dbUpdate.phase = update.phase;
    if (update.startedAt !== undefined) dbUpdate.startedAt = update.startedAt ? new Date(update.startedAt) : null;
    if (update.finishedAt !== undefined) dbUpdate.finishedAt = update.finishedAt ? new Date(update.finishedAt) : null;
    if (update.logsPath !== undefined) dbUpdate.logsPath = update.logsPath;
    if (update.statusMessageTs !== undefined) dbUpdate.statusMessageTs = update.statusMessageTs;
    if (update.commitSha !== undefined) dbUpdate.commitSha = update.commitSha;
    if (update.changedFiles !== undefined) dbUpdate.changedFiles = update.changedFiles;
    if (update.prUrl !== undefined) dbUpdate.prUrl = update.prUrl;
    if (update.feedback !== undefined) dbUpdate.feedback = update.feedback;
    if (update.error !== undefined) dbUpdate.error = update.error;
    if (update.parentRunId !== undefined) dbUpdate.parentRunId = update.parentRunId;
    if (update.rootRunId !== undefined) dbUpdate.rootRunId = update.rootRunId;
    if (update.chainIndex !== undefined) dbUpdate.chainIndex = update.chainIndex;
    if (update.parentBranchName !== undefined) dbUpdate.parentBranchName = update.parentBranchName;
    if (update.feedbackNote !== undefined) dbUpdate.feedbackNote = update.feedbackNote;
    if (update.tokenUsage !== undefined) dbUpdate.tokenUsage = update.tokenUsage;
    if (update.title !== undefined) dbUpdate.title = update.title;
    if (update.workItemId !== undefined) dbUpdate.workItemId = update.workItemId;

    await this.db.update(runs).set(dbUpdate).where(eq(runs.id, id));
    const result = await this.getRun(id);
    if (!result) throw new Error(`Run not found: ${id}`);
    return result;
  }

  async linkToWorkItem(runId: string, workItemId: string): Promise<RunRecord> {
    return this.updateRun(runId, { workItemId });
  }

  async failInProgressRuns(reason: string): Promise<number> {
    const inProgressStatuses = ["queued", "running", "validating", "pushing"];
    const affected = await this.db
      .update(runs)
      .set({
        status: "failed",
        phase: "failed",
        finishedAt: new Date(),
        error: reason,
      })
      .where(inArray(runs.status, inProgressStatuses))
      .returning({ id: runs.id });

    return affected.length;
  }

  async getInProgressRuns(): Promise<RunRecord[]> {
    const inProgressStatuses = ["queued", "running", "validating", "pushing", "cancel_requested"];
    const rows = await this.db
      .select()
      .from(runs)
      .where(inArray(runs.status, inProgressStatuses));
    return rows.map(rowToRecord);
  }

  async recoverInProgressRuns(reason: string): Promise<RunRecord[]> {
    const inProgressStatuses = ["queued", "running", "validating", "pushing"];
    const affected = await this.db
      .select()
      .from(runs)
      .where(and(
        inArray(runs.status, inProgressStatuses),
        ne(runs.runtime, "kubernetes"),
      ));

    if (affected.length === 0) return [];

    await this.db
      .update(runs)
      .set({
        status: "queued",
        phase: "queued",
        startedAt: null,
        finishedAt: null,
        error: reason,
      })
      .where(and(
        inArray(runs.status, inProgressStatuses),
        ne(runs.runtime, "kubernetes"),
      ));

    // Re-fetch after update
    const ids = affected.map((r) => r.id);
    const rows = await this.db.select().from(runs).where(inArray(runs.id, ids));
    return rows.map(rowToRecord);
  }

  formatRunStatus(run: RunRecord): string {
    const details: string[] = [
      `Run: ${shortRunId(run.id)}`,
      `Status: ${run.status}`,
      `Phase: ${run.phase ?? "queued"}`,
      `Repo: ${run.repoSlug}`,
      `Branch: ${run.branchName}`,
      `Base: ${run.baseBranch}`,
      `Requested by: <@${run.requestedBy}>`,
      `Created at: ${run.createdAt}`,
    ];

    if (run.prUrl) details.push(`PR: ${run.prUrl}`);
    if (run.error) details.push(`Error: ${run.error}`);
    if (run.logsPath) details.push(`Logs: ${run.logsPath}`);
    if (run.commitSha) details.push(`Commit: ${run.commitSha}`);
    if (run.changedFiles && run.changedFiles.length > 0) {
      details.push(`Changed files: ${String(run.changedFiles.length)}`);
    }
    if (run.feedback) {
      details.push(`Feedback: ${run.feedback.rating}${run.feedback.note ? ` (${run.feedback.note})` : ""}`);
    }

    return details.join("\n");
  }
}

function normalizeIdentifier(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";

  const uuidMatch = trimmed.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuidMatch?.[0]) return uuidMatch[0].toLowerCase();

  const shortIdMatch = trimmed.match(/[0-9a-f]{6,32}/i);
  if (shortIdMatch?.[0]) return shortIdMatch[0].toLowerCase();

  return trimmed.replace(/[`<>()[\]{}]/g, "").toLowerCase();
}

function shortRunId(id: string): string {
  return id.slice(0, 8);
}

export function mapPhaseToRunStatus(phase: string): RunStatus {
  if (phase === "validating") return "validating";
  if (phase === "pushing") return "pushing";
  if (phase === "awaiting_ci") return "awaiting_ci";
  if (phase === "ci_fixing") return "ci_fixing";
  return "running";
}
