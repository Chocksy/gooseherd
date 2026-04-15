import PQueue from "p-queue";
import type { WebClient } from "@slack/web-api";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Block, KnownBlock } from "@slack/types";
import { writeFile, mkdir } from "node:fs/promises";
import type { AppConfig } from "./config.js";
import { logError, logInfo } from "./logger.js";
import type { RunLifecycleHooks } from "./hooks/run-lifecycle.js";
import { RunStore, mapPhaseToRunStatus } from "./store.js";
import type { ExecutionResult, NewRunInput, RunRecord } from "./types.js";
import type { PipelineStore } from "./pipeline/pipeline-store.js";
import type { LearningStore } from "./observer/learning-store.js";
import { getRuntimeBackend, type RuntimeRegistry } from "./runtime/backend.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface ClassifiedError {
  category: string;
  friendly: string;
  suggestion: string;
}

const ERROR_PATTERNS: Array<{ test: RegExp; result: ClassifiedError }> = [
  {
    test: /failed to clone|clone.*failed|fatal:.*repository|failed to (fetch|checkout).*branch/i,
    result: { category: "clone", friendly: "Failed to clone repository", suggestion: "Check that the repo exists and your GitHub credentials (GITHUB_TOKEN or GitHub App) have access." }
  },
  {
    test: /timed out|timeout:|exceeded \d+s.*terminating|\[timeout[^\]]*\]/i,
    result: { category: "timeout", friendly: "Agent timed out", suggestion: "The task may be too complex. Try breaking it into smaller steps or increase AGENT_TIMEOUT_SECONDS." }
  },
  {
    test: /no meaningful changes|no file changes|whitespace-only|mass deletion detected/i,
    result: { category: "no_changes", friendly: "Agent produced no useful changes", suggestion: "Try rephrasing the task with more specific instructions." }
  },
  {
    test: /validation failed after \d+ retry/i,
    result: { category: "validation", friendly: "Validation failed after retries", suggestion: "The linter or tests are failing. Run your validation command locally to debug." }
  },
  {
    test: /agent exited with code|command failed with exit code/i,
    result: { category: "agent_crash", friendly: "Agent process crashed", suggestion: "Check the run logs for details. The agent may have hit an internal error." }
  },
  {
    test: /push.*rejected|failed to push|remote:.*rejected/i,
    result: { category: "push", friendly: "Push to remote was rejected", suggestion: "The branch may have conflicts or branch protection rules. Check repository settings." }
  },
  {
    test: /pr.*failed|pull request.*failed|create_pr.*failed/i,
    result: { category: "pr", friendly: "Failed to create pull request", suggestion: "Check that your GitHub credentials (GITHUB_TOKEN or GitHub App) have permission to create PRs on this repo." }
  },
];


export function classifyError(message: string): ClassifiedError {
  for (const { test, result } of ERROR_PATTERNS) {
    if (test.test(message)) return result;
  }
  return { category: "unknown", friendly: "Run failed", suggestion: "Check the run logs for details." };
}

function shortRunId(id: string): string {
  return id.slice(0, 8);
}

function formatPhase(phase: string): string {
  if (phase === "cloning") {
    return "cloning repo";
  }
  if (phase === "agent") {
    return "agent coding";
  }
  if (phase === "validating") {
    return "validation";
  }
  if (phase === "pushing") {
    return "push/pr";
  }
  if (phase === "cancel_requested") {
    return "cancellation requested";
  }
  if (phase === "cancelled") {
    return "cancelled";
  }
  return phase;
}

function statusEmoji(status: RunRecord["status"]): string {
  if (status === "queued") {
    return "⏳";
  }
  if (status === "completed") {
    return "✅";
  }
  if (status === "failed") {
    return "❌";
  }
  if (status === "cancel_requested" || status === "cancelled") {
    return "🛑";
  }
  if (status === "validating") {
    return "🧪";
  }
  if (status === "pushing") {
    return "🚀";
  }
  return "🤖";
}

function isSlackChannelId(channelId: string): boolean {
  return /^[CGD][A-Z0-9]+$/.test(channelId);
}

function formatElapsed(startedAt?: string): string | undefined {
  if (!startedAt) {
    return undefined;
  }
  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) {
    return undefined;
  }
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${String(elapsedSeconds)}s`;
  }
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${String(minutes)}m ${String(seconds)}s`;
}

/** Format the exact duration between two ISO timestamps (for summaries). */
function formatDuration(startedAt: string, finishedAt: string): string | undefined {
  const startedMs = Date.parse(startedAt);
  const finishedMs = Date.parse(finishedAt);
  if (Number.isNaN(startedMs) || Number.isNaN(finishedMs)) {
    return undefined;
  }
  const elapsedSeconds = Math.max(0, Math.floor((finishedMs - startedMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${String(elapsedSeconds)}s`;
  }
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${String(minutes)}m ${String(seconds)}s`;
}

function isRetryableStatus(status: RunRecord["status"]): boolean {
  return status === "failed" || status === "completed";
}

export type RunTerminalCallback = (runId: string, status: string, runtime: RunRecord["runtime"]) => void;
type EnqueueRunInput = Omit<NewRunInput, "runtime"> & { runtime?: NewRunInput["runtime"] };

export class RunManager {
  private readonly queue: PQueue;
  private readonly terminalCallbacks: RunTerminalCallback[] = [];
  /** AbortControllers for in-progress runs — enables cancellation. */
  private readonly runAbortControllers = new Map<string, AbortController>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: RunStore,
    private readonly runtimeRegistry: RuntimeRegistry,
    private readonly slackClient: WebClient | undefined,
    private readonly hooks?: RunLifecycleHooks,
    private readonly pipelineStore?: PipelineStore,
    private readonly learningStore?: LearningStore
  ) {
    this.queue = new PQueue({ concurrency: config.runnerConcurrency });

    if (learningStore) {
      this.onRunTerminal((runId, status) => {
        this.recordLearningOutcome(runId, status).catch(err => {
          const msg = err instanceof Error ? err.message : "unknown";
          logError("Failed to record learning outcome", { runId, error: msg });
        });
      });
    }
  }

  private getBackend(runtime: RunRecord["runtime"]) {
    return getRuntimeBackend(this.runtimeRegistry, runtime);
  }

  private async recordLearningOutcome(runId: string, status: string): Promise<void> {
    if (!this.learningStore) return;
    const run = await this.store.getRun(runId);
    if (!run) return;

    const startMs = run.startedAt ? Date.parse(run.startedAt) : Date.parse(run.createdAt);
    const endMs = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
    const durationMs = Math.max(0, endMs - startMs);

    let errorCategory: string | undefined;
    if (status !== "completed" && run.error) {
      errorCategory = classifyError(run.error).category;
    } else if (status !== "completed") {
      errorCategory = "unknown";
    }

    await this.learningStore.recordOutcome({
      runId,
      source: this.determineRunSource(run),
      repoSlug: run.repoSlug,
      status,
      errorCategory,
      durationMs,
      costUsd: run.tokenUsage?.costUsd ?? 0,
      changedFiles: run.changedFiles?.length ?? 0,
      pipelineId: run.pipelineHint,
      timestamp: new Date().toISOString()
    });
  }

  private determineRunSource(run: RunRecord): string {
    if (run.channelId === "eval") return "eval";
    if (run.channelId === "local") return "local";
    if (run.channelId === "dashboard") return "dashboard";
    if (run.channelId === "api") return "api";
    // Observer runs get enriched with ruleId by ObserverDaemon's terminal callback
    return "slack";
  }

  /**
   * Resolve a pipeline hint to a file path.
   * Checks the PipelineStore first (for custom pipelines), falls back to disk.
   * For store-only pipelines, writes the YAML to a temp file in the run's work dir.
   */
  private async resolvePipeline(hint: string | undefined, runId: string): Promise<string> {
    if (!hint) return this.config.pipelineFile;

    if (!/^[a-zA-Z0-9_-]+$/.test(hint)) {
      logInfo("Invalid pipelineHint, using default", { hint });
      return this.config.pipelineFile;
    }

    // Check pipeline store for custom (non-built-in) pipelines
    if (this.pipelineStore) {
      const stored = this.pipelineStore.get(hint);
      if (stored && !stored.isBuiltIn) {
        const runDir = path.resolve(this.config.workRoot, runId);
        await mkdir(runDir, { recursive: true });
        const tmpYaml = path.join(runDir, `pipeline-${hint}.yml`);
        await writeFile(tmpYaml, stored.yaml, "utf8");
        logInfo("Using custom pipeline from store", { hint, file: tmpYaml });
        return tmpYaml;
      }
    }

    // Built-in: resolve from pipelines/ directory on disk
    return path.resolve("pipelines", `${hint}.yml`);
  }

  /**
   * Cancel an in-progress run. Sends abort signal to the pipeline execution.
   * Returns true if the run was found and cancellation was requested.
   */
  async cancelRun(runId: string): Promise<boolean> {
    const run = await this.store.getRun(runId);
    if (!run) return false;
    const controller = this.runAbortControllers.get(runId);
    if (!controller) {
      if (run.runtime === "kubernetes" && run.status === "queued") {
        const cancelled = await this.store.updateRun(runId, {
          status: "cancelled",
          phase: "cancelled",
          finishedAt: new Date().toISOString(),
          error: "Run cancelled before execution started",
        });
        this.fireTerminalCallbacks(cancelled.id, "cancelled", cancelled.runtime);
        return true;
      }
      return false;
    }
    if (run.runtime === "kubernetes") {
      await this.store.updateRun(runId, {
        status: "cancel_requested",
        phase: "cancel_requested",
      });
      return true;
    }
    await this.store.updateRun(runId, {
      status: "cancel_requested",
      phase: "cancel_requested",
    });
    controller.abort();
    return true;
  }

  /** Register a callback that fires when any run reaches terminal status. */
  onRunTerminal(cb: RunTerminalCallback): void {
    this.terminalCallbacks.push(cb);
  }

  private fireTerminalCallbacks(runId: string, status: string, runtime: RunRecord["runtime"]): void {
    for (const cb of this.terminalCallbacks) {
      try {
        cb(runId, status, runtime);
      } catch {
        // Swallow errors from callbacks to avoid disrupting the run manager
      }
    }
  }

  async enqueueRun(input: EnqueueRunInput): Promise<RunRecord> {
    const runtime = input.runtime ?? this.config.sandboxRuntime;
    this.getBackend(runtime);
    const record = await this.store.createRun({ ...input, runtime }, this.config.branchPrefix);

    this.queue.add(async () => {
      await this.processRun(record.id);
    });

    return record;
  }

  requeueExistingRun(runId: string): void {
    this.queue.add(async () => {
      await this.processRun(runId);
    });
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    return this.store.getRun(id);
  }

  /** Alias for getRun — satisfies RunEnqueuer.findRun for the learning store. */
  async findRun(id: string): Promise<RunRecord | undefined> {
    return this.store.getRun(id);
  }

  async retryRun(originalRunId: string, requestedBy: string): Promise<RunRecord | undefined> {
    const original = await this.store.findRunByIdentifier(originalRunId);
    if (!original || !isRetryableStatus(original.status)) {
      return undefined;
    }

    return this.enqueueRun({
      repoSlug: original.repoSlug,
      task: original.task,
      baseBranch: original.baseBranch,
      requestedBy,
      channelId: original.channelId,
      threadTs: original.threadTs,
      runtime: this.config.sandboxRuntime,
      skipNodes: original.skipNodes,
      enableNodes: original.enableNodes
    });
  }

  async continueRun(
    parentRunId: string,
    feedbackNote: string,
    requestedBy: string
  ): Promise<RunRecord | undefined> {
    const parent = await this.store.findRunByIdentifier(parentRunId);
    if (!parent) {
      return undefined;
    }

    const runtime = this.config.sandboxRuntime;
    this.getBackend(runtime);
    const input: NewRunInput = {
      repoSlug: parent.repoSlug,
      task: feedbackNote,
      baseBranch: parent.baseBranch,
      requestedBy,
      channelId: parent.channelId,
      threadTs: parent.threadTs,
      runtime,
      parentRunId: parent.id,
      feedbackNote
    };

    const record = await this.store.createRun(
      input,
      this.config.branchPrefix,
      parent.branchName
    );

    this.queue.add(async () => {
      await this.processRun(record.id);
    });

    return record;
  }

  async getLatestRunForThread(channelId: string, threadTs: string): Promise<RunRecord | undefined> {
    return this.store.getLatestRunForThread(channelId, threadTs);
  }

  async getRunChain(channelId: string, threadTs: string): Promise<RunRecord[]> {
    return this.store.getRunChain(channelId, threadTs);
  }

  async getRecentRuns(repoSlug?: string): Promise<RunRecord[]> {
    return this.store.getRecentRuns(repoSlug);
  }

  async saveFeedbackFromSlackAction(params: {
    runId: string;
    rating: "up" | "down";
    userId: string;
    note?: string;
  }): Promise<RunRecord | undefined> {
    const run = await this.store.findRunByIdentifier(params.runId);
    if (!run) {
      return undefined;
    }

    const updated = await this.store.saveFeedback(run.id, {
      rating: params.rating,
      by: params.userId,
      note: params.note?.trim() || undefined,
      at: new Date().toISOString()
    });

    // Store feedback via lifecycle hooks (hooks handle filtering + error swallowing internally)
    this.hooks?.onFeedback(run, params.rating, params.note);

    if (updated.statusMessageTs) {
      await this.postOrUpdateRunCard(updated, {
        phase: updated.phase ?? updated.status,
        heartbeatTick: 0,
        statusMessageTs: updated.statusMessageTs
      });
    }

    return updated;
  }

  async formatRunStatus(
    runId: string | undefined,
    channelId: string,
    threadTs?: string
  ): Promise<string> {
    const run = await this.resolveRun(runId, channelId, threadTs);
    if (!run) {
      if (runId) {
        return `Run not found: ${runId}`;
      }
      return `No run found for this thread yet. Use \`${this.botCommand("run owner/repo[@base] | task")}\` first.`;
    }
    return this.store.formatRunStatus(run);
  }

  async tailRunLogs(
    runId: string | undefined,
    channelId: string,
    threadTs?: string,
    lineCount = 40
  ): Promise<string> {
    const run = await this.resolveRun(runId, channelId, threadTs);
    if (!run) {
      if (runId) {
        return `Run not found: ${runId}`;
      }
      return "No run found for this thread yet.";
    }

    const logsPath = run.logsPath ?? path.resolve(this.config.workRoot, run.id, "run.log");
    try {
      const content = await readFile(logsPath, "utf8");
      const lines = content.split("\n");
      const tail = lines.slice(-Math.max(1, lineCount)).join("\n");
      return [
        `Run: ${shortRunId(run.id)}`,
        `Status: ${run.status}`,
        `Logs: ${logsPath}`,
        "```",
        tail.length > 2800 ? tail.slice(-2800) : tail,
        "```"
      ].join("\n");
    } catch {
      return `No logs available yet for run ${shortRunId(run.id)}.`;
    }
  }

  private async resolveRun(
    runId: string | undefined,
    channelId: string,
    threadTs?: string
  ): Promise<RunRecord | undefined> {
    if (runId && runId.trim() !== "") {
      return this.store.findRunByIdentifier(runId);
    }

    if (threadTs) {
      const fromThread = await this.store.getLatestRunForThread(channelId, threadTs);
      if (fromThread) {
        return fromThread;
      }
    }

    return this.store.getLatestRunForChannel(channelId);
  }

  private async processRun(runId: string): Promise<void> {
    const existingRun = await this.store.getRun(runId);
    if (!existingRun) {
      return;
    }
    let run = existingRun;
    const stableRunId = run.id;
    if (run.status === "cancelled" || run.status === "completed" || run.status === "failed") {
      return;
    }
    let statusMessageTs: string | undefined = run.statusMessageTs;
    let heartbeatTick = 0;
    let currentPhase = "cloning";
    let heartbeat: NodeJS.Timeout | undefined;

    const stopHeartbeat = (): void => {
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      heartbeat = undefined;
    };

    const upsertRunCard = async (detail?: string): Promise<void> => {
      try {
        const nextTs = await this.postOrUpdateRunCard(run, {
          phase: currentPhase,
          detail,
          heartbeatTick,
          statusMessageTs
        });
        if (nextTs && nextTs !== statusMessageTs) {
          statusMessageTs = nextTs;
          run = await this.store.updateRun(stableRunId, { statusMessageTs: nextTs });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        logError("Failed to post/update run card", { runId: stableRunId, channelId: run.channelId, error: message });
      }
    };

    try {
      run = await this.store.updateRun(stableRunId, {
        status: "running",
        phase: "cloning",
        startedAt: new Date().toISOString(),
        logsPath: path.resolve(this.config.workRoot, stableRunId, "run.log"),
        error: undefined
      });

      // Throttled detail callback for progress updates (max once per 5s)
      let lastDetailTime = 0;
      const onDetail = async (detail: string) => {
        const now = Date.now();
        if (now - lastDetailTime < 5000) return;
        lastDetailTime = now;
        await upsertRunCard(detail);
      };

      await upsertRunCard("Run accepted by worker.");
      heartbeat = setInterval(() => {
        heartbeatTick += 1;
        upsertRunCard("Still working...").catch((error) => {
          const message = error instanceof Error ? error.message : "Unknown heartbeat error";
          logError("Failed to update heartbeat status card", { runId: run.id, error: message });
        });
      }, Math.max(5, this.config.slackProgressHeartbeatSeconds) * 1000);
      heartbeat.unref?.();

      const phaseCallback = async (phase: string): Promise<void> => {
        currentPhase = phase;
        const nextStatus = mapPhaseToRunStatus(phase);
        const runPhase = phase as import("./types.js").RunPhase;
        const updated = await this.store.updateRun(stableRunId, { status: nextStatus, phase: runPhase });
        run = updated;
        await upsertRunCard();
      };

      const pipelineFile = await this.resolvePipeline(run.pipelineHint, run.id);
      const abortController = new AbortController();
      this.runAbortControllers.set(stableRunId, abortController);
      const backend = this.getBackend(run.runtime);
      const result = await backend.execute(run, {
        onPhase: phaseCallback,
        onDetail,
        abortSignal: abortController.signal,
        pipelineFile
      });
      stopHeartbeat();
      this.runAbortControllers.delete(stableRunId);

      run = await this.store.updateRun(stableRunId, {
        status: "completed",
        phase: "completed",
        finishedAt: new Date().toISOString(),
        logsPath: result.logsPath,
        commitSha: result.commitSha,
        changedFiles: result.changedFiles,
        prUrl: result.prUrl,
        tokenUsage: result.tokenUsage,
        title: result.title,
        error: undefined
      });
      currentPhase = "completed";

      if (result.prUrl) {
        await upsertRunCard(`PR created: ${result.prUrl}`);
      } else {
        await upsertRunCard(
          `Completed in DRY_RUN mode. Branch \`${result.branchName}\` created locally.`
        );
      }

      logInfo("Run completed", { runId: run.id, prUrl: result.prUrl });

      // Post a conversational summary in the thread
      await this.postRunSummary(run, result);

      // Store run completion via lifecycle hooks (fire-and-forget, errors swallowed internally)
      this.hooks?.onRunComplete(run, result);

      // Notify terminal listeners (observer learning loop)
      this.fireTerminalCallbacks(run.id, "completed", run.runtime);
    } catch (error) {
      stopHeartbeat();
      this.runAbortControllers.delete(stableRunId);
      const message = error instanceof Error ? error.message : "Unknown error";
      const latest = await this.store.getRun(stableRunId) ?? run;
      const cancelled = latest.runtime === "kubernetes" && latest.status === "cancel_requested";
      const terminalRun = await this.store.updateRun(stableRunId, {
        status: cancelled ? "cancelled" : "failed",
        phase: cancelled ? "cancelled" : "failed",
        finishedAt: new Date().toISOString(),
        error: message
      });
      run = terminalRun;
      currentPhase = cancelled ? "cancelled" : "failed";

      if (cancelled) {
        await upsertRunCard(
          `Run cancelled.\nUse \`${this.botCommand("status")}\` to inspect latest thread run, or \`${this.botCommand("tail")}\` for logs.`
        );
      } else {
        await upsertRunCard(
          `Run failed: ${message}\nUse \`${this.botCommand("status")}\` to inspect latest thread run, or \`${this.botCommand("tail")}\` for logs.`
        );
      }

      await this.postRunSummary(terminalRun);

      if (cancelled) {
        logInfo("Run cancelled", { runId: terminalRun.id });
      } else {
        logError("Run failed", { runId: terminalRun.id, error: message });
      }

      // Notify terminal listeners (observer learning loop)
      this.fireTerminalCallbacks(terminalRun.id, terminalRun.status, terminalRun.runtime);
    }
  }

  private async postRunSummary(run: RunRecord, result?: ExecutionResult): Promise<void> {
    if (!this.shouldPostToSlack(run)) {
      return;
    }
    try {
      const lines: string[] = [];

      if (run.status === "completed") {
        lines.push(`*Run complete* for *${run.repoSlug}*`);

        if (run.task) {
          const taskPreview = (run.task.length > 120 ? run.task.slice(0, 120) + "..." : run.task)
            .split("\n").map((l) => `> ${l}`).join("\n");
          lines.push(taskPreview);
        }

        if (result?.changedFiles && result.changedFiles.length > 0) {
          const fileList = result.changedFiles.slice(0, 10).map((f) => `\`${f}\``).join(", ");
          const extra = result.changedFiles.length > 10 ? ` (+${String(result.changedFiles.length - 10)} more)` : "";
          lines.push(`*Files changed:* ${fileList}${extra}`);
        }

        if (run.startedAt && run.finishedAt) {
          const duration = formatDuration(run.startedAt, run.finishedAt);
          if (duration) {
            lines.push(`*Duration:* ${duration}`);
          }
        }

        if (run.commitSha) {
          lines.push(`*Commit:* \`${run.commitSha.slice(0, 8)}\``);
        }

        if (run.prUrl) {
          lines.push(`*PR:* ${run.prUrl}`);
        }

        lines.push("");
        lines.push("---");
        lines.push(`Ready for instructions. Reply in this thread to request changes or say \`retry\` to start over.`);
      } else if (run.status === "failed") {
        const classified = run.error ? classifyError(run.error) : undefined;
        lines.push(`*Run failed* for *${run.repoSlug}*`);

        if (classified && classified.category !== "unknown") {
          lines.push(`*${classified.friendly}*`);
          if (run.error) {
            const errorPreview = (run.error.length > 150 ? run.error.slice(0, 150) + "..." : run.error)
              .split("\n").map((l) => `> ${l}`).join("\n");
            lines.push(errorPreview);
          }
          lines.push(`_Suggestion: ${classified.suggestion}_`);
        } else if (run.error) {
          const errorPreview = (run.error.length > 200 ? run.error.slice(0, 200) + "..." : run.error)
            .split("\n").map((l) => `> ${l}`).join("\n");
          lines.push(errorPreview);
        }

        if (run.startedAt && run.finishedAt) {
          const duration = formatDuration(run.startedAt, run.finishedAt);
          if (duration) {
            lines.push(`*Duration:* ${duration}`);
          }
        }

        lines.push("");
        lines.push("---");
        lines.push(`Ready for instructions. Reply with \`retry\` to try again, or describe what to change.`);
      } else if (run.status === "cancelled") {
        lines.push(`*Run cancelled* for *${run.repoSlug}*`);
        if (run.error) {
          const errorPreview = (run.error.length > 200 ? run.error.slice(0, 200) + "..." : run.error)
            .split("\n").map((l) => `> ${l}`).join("\n");
          lines.push(errorPreview);
        }
        if (run.startedAt && run.finishedAt) {
          const duration = formatDuration(run.startedAt, run.finishedAt);
          if (duration) {
            lines.push(`*Duration:* ${duration}`);
          }
        }
        lines.push("");
        lines.push("---");
        lines.push(`Ready for instructions. Reply with a new request when you want to run it again.`);
      } else {
        return;
      }

      await this.slackClient!.chat.postMessage({
        channel: run.channelId,
        thread_ts: run.threadTs,
        text: lines.join("\n"),
        ...(this.config.slackCommandName ? { username: this.config.slackCommandName } : {})
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logError("Failed to post run summary", { runId: run.id, error: message });
    }
  }

  private async postOrUpdateRunCard(
    run: RunRecord,
    args: {
      phase: string;
      detail?: string;
      heartbeatTick: number;
      statusMessageTs?: string;
    }
  ): Promise<string | undefined> {
    if (!this.shouldPostToSlack(run)) {
      return args.statusMessageTs;
    }

    const text = this.formatRunCardText(run, args);
    const blocks = this.formatRunCardBlocks(run, args);
    if (args.statusMessageTs) {
      await this.slackClient!.chat.update({
        channel: run.channelId,
        ts: args.statusMessageTs,
        text,
        blocks
      });
      return args.statusMessageTs;
    }

    const response = await this.slackClient!.chat.postMessage({
      channel: run.channelId,
      thread_ts: run.threadTs,
      text,
      blocks,
      ...(this.config.slackCommandName ? { username: this.config.slackCommandName } : {})
    });
    return response.ts;
  }

  private formatRunCardText(
    run: RunRecord,
    args: {
      phase: string;
      detail?: string;
      heartbeatTick: number;
    }
  ): string {
    const liveSpinner =
      run.status === "running" || run.status === "validating" || run.status === "pushing"
        ? `${SPINNER_FRAMES[args.heartbeatTick % SPINNER_FRAMES.length] ?? "⏳"} `
        : "";

    const lines: string[] = [
      `${statusEmoji(run.status)} ${liveSpinner}*${this.config.slackCommandName} • ${run.repoSlug}*`,
      `Branch: \`${run.branchName}\``,
      `Phase: \`${formatPhase(args.phase)}\``
    ];

    const elapsed = formatElapsed(run.startedAt);
    if (elapsed) {
      lines.push(`Elapsed: \`${elapsed}\``);
    }
    if (run.prUrl) {
      lines.push(`PR: ${run.prUrl}`);
    }
    if (args.detail) {
      lines.push(args.detail);
    }

    lines.push(`Use \`${this.botCommand("status")}\` or \`${this.botCommand("tail")}\`.`);
    return lines.join("\n");
  }

  private formatRunCardBlocks(
    run: RunRecord,
    args: {
      phase: string;
      detail?: string;
      heartbeatTick: number;
    }
  ): Array<KnownBlock | Block> {
    const liveSpinner =
      run.status === "running" || run.status === "validating" || run.status === "pushing"
        ? `${SPINNER_FRAMES[args.heartbeatTick % SPINNER_FRAMES.length] ?? "⏳"} `
        : "";
    const elapsed = formatElapsed(run.startedAt);
    const lines: string[] = [
      `${statusEmoji(run.status)} ${liveSpinner}*${this.config.slackCommandName} • ${run.repoSlug}*`,
      `*Branch:* \`${run.branchName}\``,
      `*${formatPhase(args.phase)}*${elapsed ? ` • ${elapsed}` : ""}`
    ];
    if (run.prUrl) {
      lines.push(`*PR:* ${run.prUrl}`);
    }
    if (args.detail) {
      lines.push(args.detail);
    }

    const blocks: Array<KnownBlock | Block> = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: lines.join("\n")
        }
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Use \`${this.botCommand("status")}\` or \`${this.botCommand("tail")}\` for details.`
          }
        ]
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "run_feedback_up",
            text: { type: "plain_text", text: "👍 Good", emoji: true },
            style: "primary",
            value: run.id
          },
          {
            type: "button",
            action_id: "run_feedback_down",
            text: { type: "plain_text", text: "👎 Bad", emoji: true },
            style: "danger",
            value: run.id
          }
        ]
      }
    ];
    const actionBlock = blocks[2] as { elements?: Array<Record<string, unknown>> };

    if (isRetryableStatus(run.status)) {
      actionBlock.elements?.push({
        type: "button",
        action_id: "run_retry",
        text: { type: "plain_text", text: "🔁 Retry", emoji: true },
        value: run.id
      });
    }

    if (this.config.dashboardEnabled) {
      actionBlock.elements?.push({
        type: "button",
        text: { type: "plain_text", text: "Open Dashboard", emoji: true },
        url: this.config.dashboardPublicUrl ?? `http://${this.config.dashboardHost}:${String(this.config.dashboardPort)}`,
        value: run.id
      });
    }

    if (run.status === "failed" && run.error?.includes("Recovered after process restart")) {
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "This run was interrupted by a restart. Click *Retry* to queue it again."
          }
        ]
      });
    }

    if (run.feedback) {
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Feedback saved: ${run.feedback.rating === "up" ? "👍" : "👎"}${run.feedback.by ? ` by <@${run.feedback.by}>` : ""}${run.feedback.note ? ` — ${run.feedback.note}` : ""}`
          }
        ]
      });
    }

    return blocks;
  }

  private botCommand(command: string): string {
    return `@${this.config.slackCommandName} ${command}`.trim();
  }

  private shouldPostToSlack(run: RunRecord): boolean {
    return Boolean(this.slackClient) && isSlackChannelId(run.channelId);
  }
}
