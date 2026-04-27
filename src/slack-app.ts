import { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { resolveTeamFromChannel, type AppConfig } from "./config.js";
import { logInfo } from "./logger.js";
import { RunManager } from "./run-manager.js";
import type { ObserverDaemon } from "./observer/index.js";
import { parseSlackAlert, type SlackChannelAdapterConfig, type SlackMessageEvent } from "./slack-alert-adapter.js";
import { handleMessage } from "./orchestrator/orchestrator.js";
import { buildSystemContext } from "./orchestrator/system-context.js";
import { ConversationStore } from "./orchestrator/conversation-store.js";
import type { HandleMessageDeps, HandleMessageRequest } from "./orchestrator/types.js";
import type { LLMCallerConfig } from "./llm/caller.js";
import type { MemoryProvider } from "./memory/provider.js";
import type { GitHubService } from "./github.js";
import { parseWorkItemSlackActionValue } from "./slack-review-actions.js";
import type { ReviewRequestRecord } from "./work-items/types.js";

function isChannelAllowed(channelId: string, channelAllowlist: string[]): boolean {
  if (channelAllowlist.length === 0) {
    return true;
  }
  return channelAllowlist.includes(channelId);
}

export function stripMentions(text: string): string {
  return text.replace(/<@[^>]+>/g, "").trim();
}

function botCommand(config: AppConfig, command: string): string {
  return `@${config.slackCommandName} ${command}`.trim();
}

function shortRunId(id: string): string {
  return id.slice(0, 8);
}

/** Patterns that indicate casual messages — filter before LLM */
const CASUAL_PATTERNS =
  /^(thanks|thank you|thx|ty|ok|okay|k|cool|nice|great|awesome|perfect|good|yep|yea|yeah|yes|no|nah|nope|sure|np|👍|👎|🎉|✅|❌|lol|haha|wow)[\s!.?]*$/i;

/** Patterns that indicate approval — save as positive feedback */
const APPROVAL_PATTERNS =
  /^(lgtm|looks good|approved|approve|ship it|ship|merge it|merge|good to go|all good)[\s!.?]*$/i;

/**
 * Check if a message is casual (no LLM needed).
 * Also returns true for empty messages.
 */
export function isCasualMessage(text: string): boolean {
  const cleaned = stripMentions(text).trim();
  if (!cleaned) return true;
  if (CASUAL_PATTERNS.test(cleaned)) return true;
  // Short messages without action verbs are likely casual
  if (cleaned.length < 15 && !/\b(add|fix|change|update|remove|move|rename|refactor|implement|create|delete|use|try|make|set|wrap|lint|test|run|split|merge|revert|undo|convert|enable|disable|what|how|why|where|when|who|which|help|status|tail|list|show|tell|explain|describe|check|retry|rerun)\b/i.test(cleaned)) {
    return true;
  }
  return false;
}

/** Fast-path checks for help/status/tail. Returns the type or null for non-matches. */
function detectFastPath(text: string): { type: "help" } | { type: "status"; runId?: string } | { type: "tail"; runId?: string } | null {
  const normalized = stripMentions(text).trim();
  if (!normalized || normalized.toLowerCase() === "help") {
    return { type: "help" };
  }
  if (normalized.toLowerCase() === "status") {
    return { type: "status" };
  }
  if (normalized.toLowerCase().startsWith("status ")) {
    const runId = normalized.slice("status ".length).trim();
    return { type: "status", runId: runId || undefined };
  }
  if (normalized.toLowerCase() === "tail") {
    return { type: "tail" };
  }
  if (normalized.toLowerCase().startsWith("tail ")) {
    const runId = normalized.slice("tail ".length).trim();
    return { type: "tail", runId: runId || undefined };
  }
  return null;
}

/**
 * Gather thread run history for the orchestrator.
 * Thread text history is no longer needed — the ConversationStore
 * provides full multi-turn LLM history instead.
 */
async function gatherThreadContext(
  _client: WebClient,
  channelId: string,
  threadTs: string,
  runManager: RunManager
): Promise<{ existingRunRepo?: string; existingRunId?: string }> {
  let existingRunRepo: string | undefined;
  let existingRunId: string | undefined;

  try {
    const runs = await runManager.getRunChain(channelId, threadTs);
    if (runs.length > 0) {
      const latestRun = runs[runs.length - 1];
      existingRunRepo = latestRun.repoSlug;
      existingRunId = latestRun.id;
    }
  } catch {
    // Run chain fetch failed — not critical
  }

  return { existingRunRepo, existingRunId };
}

/**
 * Build HandleMessageDeps from the app's services.
 */
function buildHandleMessageDeps(
  config: AppConfig,
  runManager: RunManager,
  memoryProvider?: MemoryProvider,
  githubService?: GitHubService
): HandleMessageDeps {
  const deps: HandleMessageDeps = {
    repoAllowlist: config.repoAllowlist,

    enqueueRun: async (repo, task, opts) => {
      if (opts.continueFrom) {
        const continued = await runManager.continueRun(opts.continueFrom, task, "orchestrator");
        if (!continued) {
          throw new Error(`Could not continue from run ${opts.continueFrom}`);
        }
        return { id: continued.id, branchName: continued.branchName, repoSlug: continued.repoSlug };
      }

      const run = await runManager.enqueueRun({
        repoSlug: repo,
        task,
        baseBranch: config.defaultBaseBranch,
        requestedBy: "orchestrator",
        channelId: "",
        threadTs: "",
        runtime: config.sandboxRuntime,
        skipNodes: opts.skipNodes,
        enableNodes: opts.enableNodes,
        pipelineHint: opts.pipeline,
        teamId: undefined
      });
      return { id: run.id, branchName: run.branchName, repoSlug: run.repoSlug };
    },

    listRuns: async (repoSlug?: string) => {
      const runs = await runManager.getRecentRuns(repoSlug);
      return JSON.stringify(runs.map(r => ({
        id: r.id.slice(0, 8),
        status: r.status,
        repo: r.repoSlug,
        task: r.task.slice(0, 80),
        requestedBy: r.requestedBy,
        createdAt: r.createdAt
      })));
    },

    getConfig: async (key?: string) => {
      const safeKeys = [
        "browserVerifyModel", "browserVerifyMaxSteps", "browserVerifyExecTimeoutMs", "pipelineFile",
        "orchestratorModel", "planTaskModel", "agentTimeoutSeconds",
        "maxValidationRounds", "ciMaxFixRounds"
      ];
      if (key && safeKeys.includes(key)) {
        return JSON.stringify({ [key]: (config as unknown as Record<string, unknown>)[key] });
      }
      const subset: Record<string, unknown> = {};
      for (const k of safeKeys) {
        subset[k] = (config as unknown as Record<string, unknown>)[k];
      }
      return JSON.stringify(subset);
    }
  };

  if (memoryProvider) {
    deps.searchMemory = async (query: string) => {
      return memoryProvider.searchMemories(query);
    };
  }

  if (githubService) {
    deps.searchCode = async (query: string, repoSlug: string) => {
      const results = await githubService.searchCode(query, repoSlug);
      return results.map(r => `${r.path}\n${r.textMatches.map(m => `  ${m}`).join("\n")}`).join("\n\n");
    };

    deps.describeRepo = async (repoSlug: string) => {
      const info = await githubService.describeRepo(repoSlug);
      const parts: string[] = [];

      // Language breakdown
      const totalBytes = Object.values(info.languages).reduce((a, b) => a + b, 0);
      if (totalBytes > 0) {
        const langLines = Object.entries(info.languages)
          .sort((a, b) => b[1] - a[1])
          .map(([lang, bytes]) => `- ${lang}: ${((bytes / totalBytes) * 100).toFixed(1)}%`);
        parts.push(`Languages:\n${langLines.join("\n")}`);
      }

      // Root files
      if (info.files.length > 0) {
        parts.push(`Root files:\n${info.files.join("\n")}`);
      }

      // README snippet
      if (info.readmeSnippet) {
        parts.push(`README (first 500 chars):\n${info.readmeSnippet}`);
      }

      return parts.join("\n\n") || "No information available for this repository.";
    };

    deps.readFile = async (repoSlug: string, path: string) => {
      return githubService.readFile(repoSlug, path);
    };

    deps.listFiles = async (repoSlug: string, path: string) => {
      const entries = await githubService.listDirectory(repoSlug, path);
      return entries
        .map(e => `${e.type === "dir" ? "📁" : "📄"} ${e.name}${e.type === "dir" ? "/" : ""} (${String(e.size)}B)`)
        .join("\n");
    };
  }

  return deps;
}

/** Build help blocks for the App Home tab and /help responses. */
export function buildHelpBlocks(config: AppConfig): Array<Record<string, unknown>> {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: `${config.appName} — Quick Start`, emoji: true }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*Mention the bot* in any allowed channel to get help with code.`,
          "",
          `\`@${config.slackCommandName} fix the login timeout in yourorg/yourrepo\``,
          "",
          `The agent understands natural language — just describe what you need.`,
          `It can answer questions, make code changes, and check run status.`
        ].join("\n")
      }
    },
    { type: "divider" },
    {
      type: "header",
      text: { type: "plain_text", text: "Quick Commands", emoji: true }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `\`${botCommand(config, "status")}\` — latest run in thread/channel`,
          `\`${botCommand(config, "status <run-id>")}\` — specific run status`,
          `\`${botCommand(config, "tail")}\` — latest logs`,
          `\`${botCommand(config, "tail <run-id>")}\` — specific run logs`,
          `\`${botCommand(config, "help")}\` — this help text`
        ].join("\n")
      }
    },
    { type: "divider" },
    {
      type: "header",
      text: { type: "plain_text", text: "Conversations", emoji: true }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          "Just talk naturally in threads. The bot understands context:",
          "",
          `\`@${config.slackCommandName} fix the login timeout in yourorg/yourrepo\` — starts a run`,
          `\`@${config.slackCommandName} also fix the tests\` — follow-up in same thread`,
          `\`@${config.slackCommandName} what model does browser verify use?\` — answers questions`,
          `\`@${config.slackCommandName} retry\` — retry the last run`,
          "",
          "Casual messages (thanks, lgtm, etc.) are handled gracefully."
        ].join("\n")
      }
    }
  ];
}

export async function startSlackApp(
  config: AppConfig,
  runManager: RunManager,
  observer?: ObserverDaemon,
  memoryProvider?: MemoryProvider,
  githubService?: GitHubService,
  sharedConversationStore?: ConversationStore,
  workItems?: {
    recordReviewOutcome(input: {
      reviewRequestId: string;
      outcome: NonNullable<ReviewRequestRecord["outcome"]>;
      authorUserId?: string;
      comment?: string;
    }): Promise<unknown>;
  }
): Promise<void> {
  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    signingSecret: config.slackSigningSecret,
    socketMode: true
  });

  const usernameOpt = config.slackCommandName ? { username: config.slackCommandName } : {};

  // Pre-build system context (stable across requests)
  const systemContext = buildSystemContext(config);

  // Resolve API key for LLM calls
  const apiKey = config.openrouterApiKey ?? config.openaiApiKey ?? config.anthropicApiKey;
  const llmConfig: LLMCallerConfig | undefined = apiKey
    ? { apiKey, defaultModel: config.orchestratorModel, defaultTimeoutMs: 10_000, providerPreferences: config.openrouterProviderPreferences }
    : undefined;

  // Pre-build deps (stable across requests)
  const handleMessageDeps = buildHandleMessageDeps(config, runManager, memoryProvider, githubService);

  // Conversation memory — persists full LLM history per thread
  const conversationStore = sharedConversationStore!;

  /** Wrapper around say() that always includes username override */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function sayAs(say: (...args: any[]) => Promise<unknown>, msg: Record<string, unknown>): Promise<unknown> {
    return say({ ...msg, ...usernameOpt });
  }

  app.action("run_feedback_up", async ({ ack, body, client }) => {
    await ack();
    const action = (body as { actions?: Array<{ value?: string }> }).actions?.[0];
    const runId = action?.value;
    const userId = (body as { user?: { id?: string } }).user?.id;
    const containerChannelId = (body as { container?: { channel_id?: string } }).container?.channel_id;

    if (!runId || !userId || !containerChannelId) {
      return;
    }

    const updated = await runManager.saveFeedbackFromSlackAction({
      runId,
      rating: "up",
      userId
    });
    if (!updated) {
      await client.chat.postEphemeral({
        channel: containerChannelId,
        user: userId,
        text: `Could not find run ${shortRunId(runId)}.`
      });
      return;
    }

    await client.chat.postEphemeral({
      channel: containerChannelId,
      user: userId,
      text: `Saved feedback: 👍 for ${updated.repoSlug}`
    });
  });

  app.action("run_feedback_down", async ({ ack, body, client }) => {
    await ack();
    const action = (body as { actions?: Array<{ value?: string }> }).actions?.[0];
    const runId = action?.value;
    const userId = (body as { user?: { id?: string } }).user?.id;
    const containerChannelId = (body as { container?: { channel_id?: string } }).container?.channel_id;

    if (!runId || !userId || !containerChannelId) {
      return;
    }

    const updated = await runManager.saveFeedbackFromSlackAction({
      runId,
      rating: "down",
      userId
    });
    if (!updated) {
      await client.chat.postEphemeral({
        channel: containerChannelId,
        user: userId,
        text: `Could not find run ${shortRunId(runId)}.`
      });
      return;
    }

    await client.chat.postEphemeral({
      channel: containerChannelId,
      user: userId,
      text: `Saved feedback: 👎 for ${updated.repoSlug}`
    });
  });

  app.action("observer_approve", async ({ ack, body, client }) => {
    await ack();
    const action = (body as { actions?: Array<{ value?: string }> }).actions?.[0];
    const userId = (body as { user?: { id?: string } }).user?.id;
    const containerChannelId = (body as { container?: { channel_id?: string } }).container?.channel_id;

    if (!action?.value || !userId || !containerChannelId) {
      return;
    }

    let payload: { repoSlug: string; task: string; baseBranch: string; channelId: string; threadTs: string };
    try {
      payload = JSON.parse(action.value) as typeof payload;
    } catch {
      await client.chat.postEphemeral({
        channel: containerChannelId,
        user: userId,
        text: "Invalid approval payload."
      });
      return;
    }

    const run = await runManager.enqueueRun({
      repoSlug: payload.repoSlug,
      task: payload.task,
      baseBranch: payload.baseBranch,
      requestedBy: userId,
      channelId: payload.channelId,
      threadTs: payload.threadTs,
      runtime: config.sandboxRuntime,
      teamId: resolveTeamFromChannel(payload.channelId, config.teamChannelMap)
    });

    await client.chat.postMessage({
      channel: payload.channelId,
      thread_ts: payload.threadTs,
      text: `Approved by <@${userId}>. Queued run for *${run.repoSlug}* (${shortRunId(run.id)}).`,
      ...usernameOpt
    });

    logInfo("Observer approval accepted", { runId: run.id, approvedBy: userId });
  });

  app.action("observer_reject", async ({ ack, body, client }) => {
    await ack();
    const userId = (body as { user?: { id?: string } }).user?.id;
    const containerChannelId = (body as { container?: { channel_id?: string } }).container?.channel_id;
    const containerThreadTs = (body as { container?: { thread_ts?: string } }).container?.thread_ts;

    if (!userId || !containerChannelId) {
      return;
    }

    if (containerThreadTs) {
      await client.chat.postMessage({
        channel: containerChannelId,
        thread_ts: containerThreadTs,
        text: `Rejected by <@${userId}>.`,
        ...usernameOpt
      });
    }

    await client.chat.postEphemeral({
      channel: containerChannelId,
      user: userId,
      text: "Observer trigger rejected."
    });

    logInfo("Observer approval rejected", { rejectedBy: userId });
  });

  app.action("run_retry", async ({ ack, body, client }) => {
    await ack();
    const action = (body as { actions?: Array<{ value?: string }> }).actions?.[0];
    const runId = action?.value;
    const userId = (body as { user?: { id?: string } }).user?.id;
    const containerChannelId = (body as { container?: { channel_id?: string } }).container?.channel_id;

    if (!runId || !userId || !containerChannelId) {
      return;
    }

    const retried = await runManager.retryRun(runId, userId);
    if (!retried) {
      await client.chat.postEphemeral({
        channel: containerChannelId,
        user: userId,
        text: "Could not retry this run because it was not found."
      });
      return;
    }

    await client.chat.postMessage({
      channel: retried.channelId,
      thread_ts: retried.threadTs,
      text: [
        `Queued retry for *${retried.repoSlug}*`,
        `Branch: \`${retried.branchName}\``,
        `Use \`${botCommand(config, "status")}\` for latest thread status, or \`${botCommand(config, "tail")}\` for logs.`
      ].join("\n"),
      ...usernameOpt
    });

    await client.chat.postEphemeral({
      channel: containerChannelId,
      user: userId,
      text: `Retry queued as ${shortRunId(retried.id)}.`
    });
  });

  app.action("work_item_review_approve", async ({ ack, body, client }) => {
    await ack();
    const action = (body as { actions?: Array<{ value?: string }> }).actions?.[0];
    const payload = parseWorkItemSlackActionValue(action?.value);
    const userId = (body as { user?: { id?: string } }).user?.id;
    const containerChannelId = (body as { container?: { channel_id?: string } }).container?.channel_id;

    if (!payload || !userId || !containerChannelId || !workItems) {
      return;
    }

    try {
      await workItems.recordReviewOutcome({
        reviewRequestId: payload.reviewRequestId,
        outcome: "approved",
        authorUserId: userId,
        comment: `Approved from Slack by <@${userId}>`,
      });

      await client.chat.postMessage({
        channel: payload.homeChannelId,
        thread_ts: payload.homeThreadTs,
        text: `<@${userId}> approved review request *${payload.requestTitle}*.`,
        ...usernameOpt,
      });

      await client.chat.postEphemeral({
        channel: containerChannelId,
        user: userId,
        text: `Saved approval for ${payload.requestTitle}.`,
      });
    } catch (error) {
      await client.chat.postEphemeral({
        channel: containerChannelId,
        user: userId,
        text: error instanceof Error ? error.message : "Failed to save approval.",
      });
    }
  });

  app.action("work_item_review_changes", async ({ ack, body, client }) => {
    await ack();
    const action = (body as { actions?: Array<{ value?: string }> }).actions?.[0];
    const payload = parseWorkItemSlackActionValue(action?.value);
    const userId = (body as { user?: { id?: string } }).user?.id;
    const containerChannelId = (body as { container?: { channel_id?: string } }).container?.channel_id;

    if (!payload || !userId || !containerChannelId || !workItems) {
      return;
    }

    try {
      await workItems.recordReviewOutcome({
        reviewRequestId: payload.reviewRequestId,
        outcome: "changes_requested",
        authorUserId: userId,
        comment: `Changes requested from Slack by <@${userId}>`,
      });

      await client.chat.postMessage({
        channel: payload.homeChannelId,
        thread_ts: payload.homeThreadTs,
        text: `<@${userId}> requested changes for *${payload.requestTitle}*.`,
        ...usernameOpt,
      });

      await client.chat.postEphemeral({
        channel: containerChannelId,
        user: userId,
        text: `Saved changes request for ${payload.requestTitle}.`,
      });
    } catch (error) {
      await client.chat.postEphemeral({
        channel: containerChannelId,
        user: userId,
        text: error instanceof Error ? error.message : "Failed to save changes request.",
      });
    }
  });

  // ── Observer: Slack channel alert watcher ──────────────────────
  if (observer && config.observerSlackWatchedChannels.length > 0) {
    const adapterConfig: SlackChannelAdapterConfig = {
      watchedChannels: config.observerSlackWatchedChannels,
      botAllowlist: config.observerSlackBotAllowlist,
      repoMap: config.observerRepoMap,
      alertChannelId: config.observerAlertChannelId
    };

    app.message(async ({ message }) => {
      // Only process bot messages (alert bots have bot_id)
      const msg = message as unknown as Record<string, unknown>;
      if (!msg.bot_id) return;

      const slackEvent: SlackMessageEvent = {
        type: (msg.type as string) ?? "message",
        subtype: msg.subtype as string | undefined,
        bot_id: msg.bot_id as string,
        bot_profile: msg.bot_profile as SlackMessageEvent["bot_profile"],
        text: msg.text as string | undefined,
        channel: msg.channel as string,
        ts: msg.ts as string,
        attachments: msg.attachments as SlackMessageEvent["attachments"],
        blocks: msg.blocks as SlackMessageEvent["blocks"]
      };

      const triggerEvent = parseSlackAlert(slackEvent, adapterConfig);
      if (triggerEvent) {
        observer.enqueueEvent(triggerEvent);
        logInfo("Observer: Slack channel alert detected", {
          channel: slackEvent.channel,
          botId: slackEvent.bot_id,
          eventId: triggerEvent.id
        });
      }
    });

    logInfo("Observer: Slack channel watcher registered", {
      channels: config.observerSlackWatchedChannels.length
    });
  }

  // ── App Home Tab ──────────────────────────────────────
  app.event("app_home_opened", async ({ event, client }) => {
    try {
      await client.views.publish({
        user_id: event.user,
        view: {
          type: "home",
          blocks: buildHelpBlocks(config) as any[]
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      logInfo("Failed to publish App Home tab", { error: msg });
    }
  });

  // ── Main Message Handler ──────────────────────────────
  app.event("app_mention", async ({ event, say, client }) => {
    const replyThreadTs = event.thread_ts ?? event.ts;

    if (!isChannelAllowed(event.channel, config.slackAllowedChannels)) {
      await sayAs(say, {
        text: `This channel is not allowed for ${config.slackCommandName}.`,
        thread_ts: replyThreadTs
      });
      return;
    }

    // ── Fast paths (no LLM) ──
    const fastPath = detectFastPath(event.text);
    if (fastPath) {
      if (fastPath.type === "help") {
        await sayAs(say, {
          thread_ts: replyThreadTs,
          blocks: buildHelpBlocks(config),
          text: `${config.appName} help`
        });
        return;
      }
      if (fastPath.type === "status") {
        const status = await runManager.formatRunStatus(fastPath.runId, event.channel, event.thread_ts);
        await sayAs(say, { thread_ts: replyThreadTs, text: status });
        return;
      }
      if (fastPath.type === "tail") {
        const tail = await runManager.tailRunLogs(fastPath.runId, event.channel, event.thread_ts, 40);
        await sayAs(say, { thread_ts: replyThreadTs, text: tail });
        return;
      }
    }

    // ── Casual pre-filter (no LLM) ──
    const stripped = stripMentions(event.text);
    if (isCasualMessage(event.text)) {
      // In threads with existing runs, save approval feedback
      if (event.thread_ts && event.user && APPROVAL_PATTERNS.test(stripped)) {
        const latestRun = await runManager.getLatestRunForThread(event.channel, event.thread_ts);
        if (latestRun) {
          await runManager.saveFeedbackFromSlackAction({
            runId: latestRun.id,
            rating: "up",
            userId: event.user,
            note: stripped
          });
          await sayAs(say, {
            thread_ts: replyThreadTs,
            text: `Noted! Saved positive feedback for *${latestRun.repoSlug}* run ${shortRunId(latestRun.id)}.`
          });
        }
      }
      return;
    }

    // ── LLM Orchestrator ──
    if (!llmConfig) {
      await sayAs(say, {
        thread_ts: replyThreadTs,
        text: "No API key configured for the orchestrator. Set OPENROUTER_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY."
      });
      return;
    }

    if (!event.user) {
      await sayAs(say, {
        thread_ts: replyThreadTs,
        text: "Unable to identify requesting user."
      });
      return;
    }

    // Gather run history for this thread
    const threadCtx = event.thread_ts
      ? await gatherThreadContext(client as unknown as WebClient, event.channel, event.thread_ts, runManager)
      : {};

    // Load prior conversation from memory store
    const threadKey = `${event.channel}:${replyThreadTs}`;
    const priorMessages = await conversationStore.get(threadKey);
    const maskedMessages = priorMessages
      ? conversationStore.maskOldObservations(priorMessages, 12)
      : undefined;

    // Build request with conversation history
    const request: HandleMessageRequest = {
      message: stripped,
      userId: event.user,
      channelId: event.channel,
      threadTs: replyThreadTs,
      priorMessages: maskedMessages,
      existingRunRepo: threadCtx.existingRunRepo,
      existingRunId: threadCtx.existingRunId
    };

    // Override enqueueRun to use actual user/channel/thread context
    const depsWithContext: HandleMessageDeps = {
      ...handleMessageDeps,
      enqueueRun: async (repo, task, opts) => {
        if (opts.continueFrom) {
          const continued = await runManager.continueRun(opts.continueFrom, task, event.user!);
          if (!continued) {
            throw new Error(`Could not continue from run ${opts.continueFrom}`);
          }
          return { id: continued.id, branchName: continued.branchName, repoSlug: continued.repoSlug };
        }

        const run = await runManager.enqueueRun({
          repoSlug: repo,
          task,
          baseBranch: config.defaultBaseBranch,
          requestedBy: event.user!,
          channelId: event.channel,
          threadTs: replyThreadTs,
          runtime: config.sandboxRuntime,
          skipNodes: opts.skipNodes,
          enableNodes: opts.enableNodes,
          pipelineHint: opts.pipeline,
          teamId: resolveTeamFromChannel(event.channel, config.teamChannelMap)
        });
        return { id: run.id, branchName: run.branchName, repoSlug: run.repoSlug };
      }
    };

    // Post a "thinking" indicator that we'll update with progress
    const TOOL_LABELS: Record<string, string> = {
      describe_repo: "Examining repository",
      search_code: "Searching code",
      read_file: "Reading file",
      list_files: "Browsing files",
      search_memory: "Searching memory",
      execute_task: "Queuing run",
      list_runs: "Checking runs",
      get_config: "Loading config"
    };

    let thinkingTs: string | undefined;
    try {
      const thinkingMsg = await (client as unknown as WebClient).chat.postMessage({
        channel: event.channel,
        thread_ts: replyThreadTs,
        text: ":hourglass_flowing_sand: Thinking...",
        ...usernameOpt
      });
      thinkingTs = thinkingMsg.ts;
    } catch {
      // If posting thinking message fails, continue without it
    }

    const result = await handleMessage(
      llmConfig,
      config.orchestratorModel,
      systemContext,
      request,
      depsWithContext,
      {
        onToolCall: (toolName, args) => {
          if (!thinkingTs) return;
          const label = TOOL_LABELS[toolName] ?? toolName;
          const detail = args["path"] ? ` \`${args["path"] as string}\`` :
                         args["repoSlug"] ? ` in ${args["repoSlug"] as string}` :
                         args["query"] ? ` for "${(args["query"] as string).slice(0, 40)}"` : "";
          (client as unknown as WebClient).chat.update({
            channel: event.channel,
            ts: thinkingTs!,
            text: `:mag: ${label}${detail}...`
          }).catch(() => { /* ignore update failures */ });
        },
        timeoutMs: config.orchestratorTimeoutMs,
        wallClockTimeoutMs: config.orchestratorWallClockTimeoutMs
      }
    );

    // Store the full conversation back for future messages in this thread
    await conversationStore.set(threadKey, result.messages);

    // Replace thinking message with final response, or delete if empty
    if (result.response) {
      if (thinkingTs) {
        try {
          await (client as unknown as WebClient).chat.update({
            channel: event.channel,
            ts: thinkingTs,
            text: result.response
          });
        } catch {
          // If update fails, post a new message
          await sayAs(say, { thread_ts: replyThreadTs, text: result.response });
        }
      } else {
        await sayAs(say, { thread_ts: replyThreadTs, text: result.response });
      }
    } else if (thinkingTs) {
      // Delete the thinking message if there's no response
      try {
        await (client as unknown as WebClient).chat.delete({
          channel: event.channel,
          ts: thinkingTs
        });
      } catch { /* ignore */ }
    }
  });

  await app.start();
  logInfo("Slack bot started in Socket Mode");
}
