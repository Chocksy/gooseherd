import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { NewRunInput, RunFeedback, RunRecord, RunStatus } from "./types.js";

interface RunStateFile {
  runs: RunRecord[];
}

export class RunStore {
  private readonly filePath: string;
  private lock: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "runs.json");
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await readFile(this.filePath, "utf8");
    } catch {
      const initial: RunStateFile = { runs: [] };
      await writeFile(this.filePath, JSON.stringify(initial, null, 2), "utf8");
    }
  }

  async createRun(
    input: NewRunInput,
    branchPrefix: string,
    existingBranchName?: string
  ): Promise<RunRecord> {
    return this.withLock(async () => {
      const state = await this.readState();
      const id = randomUUID();
      const branchName = existingBranchName ?? `${branchPrefix}/${id.slice(0, 8)}`;

      // Resolve chain fields from parent if this is a follow-up
      let rootRunId: string | undefined;
      let chainIndex = 0;
      if (input.parentRunId) {
        const parent = state.runs.find((r) => r.id === input.parentRunId);
        if (parent) {
          rootRunId = parent.rootRunId ?? parent.id;
          chainIndex = (parent.chainIndex ?? 0) + 1;
        }
      }

      const record: RunRecord = {
        id,
        status: "queued",
        phase: "queued",
        repoSlug: input.repoSlug,
        task: input.task,
        baseBranch: input.baseBranch,
        branchName,
        requestedBy: input.requestedBy,
        channelId: input.channelId,
        threadTs: input.threadTs,
        createdAt: new Date().toISOString(),
        parentRunId: input.parentRunId,
        rootRunId,
        chainIndex,
        parentBranchName: existingBranchName,
        feedbackNote: input.feedbackNote
      };

      state.runs.push(record);
      await this.writeState(state);
      return record;
    });
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    const state = await this.readState();
    return state.runs.find((run) => run.id === id);
  }

  async listRuns(limit = 100): Promise<RunRecord[]> {
    const state = await this.readState();
    const bounded = Math.max(1, Math.min(limit, 500));
    return state.runs.slice(-bounded).reverse();
  }

  async getLatestRunForThread(channelId: string, threadTs: string): Promise<RunRecord | undefined> {
    const state = await this.readState();
    for (let index = state.runs.length - 1; index >= 0; index -= 1) {
      const run = state.runs[index];
      if (run.channelId === channelId && run.threadTs === threadTs) {
        return run;
      }
    }
    return undefined;
  }

  async getRunChain(channelId: string, threadTs: string): Promise<RunRecord[]> {
    const state = await this.readState();
    return state.runs
      .filter((run) => run.channelId === channelId && run.threadTs === threadTs)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getLatestRunForChannel(channelId: string): Promise<RunRecord | undefined> {
    const state = await this.readState();
    for (let index = state.runs.length - 1; index >= 0; index -= 1) {
      const run = state.runs[index];
      if (run.channelId === channelId) {
        return run;
      }
    }
    return undefined;
  }

  async findRunByIdentifier(identifier: string): Promise<RunRecord | undefined> {
    const normalized = normalizeIdentifier(identifier);
    if (!normalized) {
      return undefined;
    }

    const state = await this.readState();

    // Exact ID match first.
    const exact = state.runs.find((run) => run.id === normalized);
    if (exact) {
      return exact;
    }

    // Unique prefix match next (for short IDs).
    const prefixMatches = state.runs.filter((run) => run.id.startsWith(normalized));
    if (prefixMatches.length === 1) {
      return prefixMatches[0];
    }

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
      >
    >
  ): Promise<RunRecord> {
    return this.withLock(async () => {
      const state = await this.readState();
      const index = state.runs.findIndex((run) => run.id === id);
      if (index === -1) {
        throw new Error(`Run not found: ${id}`);
      }

      const current = state.runs[index] as RunRecord;
      const next: RunRecord = {
        ...current,
        ...update
      };

      state.runs[index] = next;
      await this.writeState(state);
      return next;
    });
  }

  async failInProgressRuns(reason: string): Promise<number> {
    return this.withLock(async () => {
      const state = await this.readState();
      let updatedCount = 0;
      for (let index = 0; index < state.runs.length; index += 1) {
        const run = state.runs[index] as RunRecord;
        if (
          run.status === "queued" ||
          run.status === "running" ||
          run.status === "validating" ||
          run.status === "pushing"
        ) {
          state.runs[index] = {
            ...run,
            status: "failed",
            phase: "failed",
            finishedAt: new Date().toISOString(),
            error: reason
          };
          updatedCount += 1;
        }
      }

      if (updatedCount > 0) {
        await this.writeState(state);
      }
      return updatedCount;
    });
  }

  async recoverInProgressRuns(reason: string): Promise<RunRecord[]> {
    return this.withLock(async () => {
      const state = await this.readState();
      const recovered: RunRecord[] = [];
      for (let index = 0; index < state.runs.length; index += 1) {
        const run = state.runs[index] as RunRecord;
        if (
          run.status === "queued" ||
          run.status === "running" ||
          run.status === "validating" ||
          run.status === "pushing"
        ) {
          const next: RunRecord = {
            ...run,
            status: "queued",
            phase: "queued",
            startedAt: undefined,
            finishedAt: undefined,
            error: reason
          };
          state.runs[index] = next;
          recovered.push(next);
        }
      }

      if (recovered.length > 0) {
        await this.writeState(state);
      }
      return recovered;
    });
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
      `Created at: ${run.createdAt}`
    ];

    if (run.prUrl) {
      details.push(`PR: ${run.prUrl}`);
    }
    if (run.error) {
      details.push(`Error: ${run.error}`);
    }
    if (run.logsPath) {
      details.push(`Logs: ${run.logsPath}`);
    }
    if (run.commitSha) {
      details.push(`Commit: ${run.commitSha}`);
    }
    if (run.changedFiles && run.changedFiles.length > 0) {
      details.push(`Changed files: ${String(run.changedFiles.length)}`);
    }
    if (run.feedback) {
      details.push(`Feedback: ${run.feedback.rating}${run.feedback.note ? ` (${run.feedback.note})` : ""}`);
    }

    return details.join("\n");
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release: (() => void) | undefined;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await fn();
    } finally {
      release?.();
    }
  }

  private async readState(): Promise<RunStateFile> {
    const raw = await readFile(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as RunStateFile;
    if (!Array.isArray(parsed.runs)) {
      return { runs: [] };
    }
    return parsed;
  }

  private async writeState(state: RunStateFile): Promise<void> {
    await writeFile(this.filePath, JSON.stringify(state, null, 2), "utf8");
  }
}

function normalizeIdentifier(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }

  const uuidMatch = trimmed.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuidMatch?.[0]) {
    return uuidMatch[0].toLowerCase();
  }

  const shortIdMatch = trimmed.match(/[0-9a-f]{6,32}/i);
  if (shortIdMatch?.[0]) {
    return shortIdMatch[0].toLowerCase();
  }

  return trimmed.replace(/[`<>()[\]{}]/g, "").toLowerCase();
}

function shortRunId(id: string): string {
  return id.slice(0, 8);
}

export function mapExecutorPhaseToRunStatus(phase: string): RunStatus {
  if (phase === "validating") {
    return "validating";
  }
  if (phase === "pushing") {
    return "pushing";
  }
  return "running";
}
