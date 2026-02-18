import PQueue from "p-queue";
import type { WebClient } from "@slack/web-api";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Block, KnownBlock } from "@slack/types";
import type { AppConfig } from "./config.js";
import { logError, logInfo } from "./logger.js";
import { RunExecutor, type ParentRunContext } from "./executor.js";
import type { RunLifecycleHooks } from "./hooks/run-lifecycle.js";
import { RunStore, mapExecutorPhaseToRunStatus } from "./store.js";
import type { NewRunInput, RunRecord } from "./types.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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
  if (status === "validating") {
    return "🧪";
  }
  if (status === "pushing") {
    return "🚀";
  }
  return "🤖";
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

function isRetryableStatus(status: RunRecord["status"]): boolean {
  return status === "failed" || status === "completed";
}

export class RunManager {
  private readonly queue: PQueue;

  constructor(
    private readonly config: AppConfig,
    private readonly store: RunStore,
    private readonly executor: RunExecutor,
    private readonly slackClient: WebClient,
    private readonly hooks?: RunLifecycleHooks
  ) {
    this.queue = new PQueue({ concurrency: config.runnerConcurrency });
  }

  async enqueueRun(input: NewRunInput): Promise<RunRecord> {
    const record = await this.store.createRun(input, this.config.branchPrefix);

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

  async retryRun(originalRunId: string, requestedBy: string): Promise<RunRecord | undefined> {
    const original = await this.store.findRunByIdentifier(originalRunId);
    if (!original) {
      return undefined;
    }

    return this.enqueueRun({
      repoSlug: original.repoSlug,
      task: original.task,
      baseBranch: original.baseBranch,
      requestedBy,
      channelId: original.channelId,
      threadTs: original.threadTs
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

    const input: NewRunInput = {
      repoSlug: parent.repoSlug,
      task: feedbackNote,
      baseBranch: parent.baseBranch,
      requestedBy,
      channelId: parent.channelId,
      threadTs: parent.threadTs,
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
    };

    try {
      run = await this.store.updateRun(stableRunId, {
        status: "running",
        phase: "cloning",
        startedAt: new Date().toISOString(),
        logsPath: path.resolve(this.config.workRoot, stableRunId, "run.log"),
        error: undefined
      });

      await upsertRunCard("Run accepted by worker.");
      heartbeat = setInterval(() => {
        heartbeatTick += 1;
        upsertRunCard("Still working...").catch((error) => {
          const message = error instanceof Error ? error.message : "Unknown heartbeat error";
          logError("Failed to update heartbeat status card", { runId: run.id, error: message });
        });
      }, Math.max(5, this.config.slackProgressHeartbeatSeconds) * 1000);
      heartbeat.unref?.();

      // Build parent context for follow-up runs
      let parentContext: ParentRunContext | undefined;
      if (run.parentRunId && run.parentBranchName) {
        const parentRun = await this.store.getRun(run.parentRunId);
        parentContext = {
          parentRunId: run.parentRunId,
          parentBranchName: run.parentBranchName,
          parentChangedFiles: parentRun?.changedFiles,
          parentCommitSha: parentRun?.commitSha,
          feedbackNote: run.feedbackNote
        };
      }

      const result = await this.executor.execute(run, async (phase) => {
        currentPhase = phase;
        const nextStatus = mapExecutorPhaseToRunStatus(phase);
        const updated = await this.store.updateRun(stableRunId, { status: nextStatus, phase });
        run = updated;
        await upsertRunCard();
      }, parentContext);
      stopHeartbeat();

      run = await this.store.updateRun(stableRunId, {
        status: "completed",
        phase: "completed",
        finishedAt: new Date().toISOString(),
        logsPath: result.logsPath,
        commitSha: result.commitSha,
        changedFiles: result.changedFiles,
        prUrl: result.prUrl,
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

      // Store run completion via lifecycle hooks (fire-and-forget, errors swallowed internally)
      this.hooks?.onRunComplete(run, result);
    } catch (error) {
      stopHeartbeat();
      const message = error instanceof Error ? error.message : "Unknown error";
      const failed = await this.store.updateRun(stableRunId, {
        status: "failed",
        phase: "failed",
        finishedAt: new Date().toISOString(),
        error: message
      });
      run = failed;
      currentPhase = "failed";

      await upsertRunCard(
        `Run failed: ${message}\nUse \`${this.botCommand("status")}\` to inspect latest thread run, or \`${this.botCommand("tail")}\` for logs.`
      );
      logError("Run failed", { runId: failed.id, error: message });
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
    const text = this.formatRunCardText(run, args);
    const blocks = this.formatRunCardBlocks(run, args);
    if (args.statusMessageTs) {
      await this.slackClient.chat.update({
        channel: run.channelId,
        ts: args.statusMessageTs,
        text,
        blocks
      });
      return args.statusMessageTs;
    }

    const response = await this.slackClient.chat.postMessage({
      channel: run.channelId,
      thread_ts: run.threadTs,
      text,
      blocks
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
        url: `http://${this.config.dashboardHost}:${String(this.config.dashboardPort)}`,
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
}
