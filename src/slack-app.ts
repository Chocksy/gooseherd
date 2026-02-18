import { App } from "@slack/bolt";
import type { AppConfig } from "./config.js";
import { parseCommand } from "./command-parser.js";
import { logInfo } from "./logger.js";
import { RunManager } from "./run-manager.js";

function isRepoAllowed(repoSlug: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) {
    return true;
  }
  return allowlist.includes(repoSlug);
}

function isChannelAllowed(channelId: string, channelAllowlist: string[]): boolean {
  if (channelAllowlist.length === 0) {
    return true;
  }
  return channelAllowlist.includes(channelId);
}

function stripMentions(text: string): string {
  return text.replace(/<@[^>]+>/g, "").trim();
}

function botCommand(config: AppConfig, command: string): string {
  return `@${config.slackCommandName} ${command}`.trim();
}

function shortRunId(id: string): string {
  return id.slice(0, 8);
}

/** Patterns that indicate casual/approval messages — should NOT trigger a run */
const CASUAL_PATTERNS =
  /^(thanks|thank you|thx|ty|ok|okay|k|cool|nice|great|awesome|perfect|good|yep|yea|yeah|yes|no|nah|nope|sure|np|👍|👎|🎉|✅|❌|lol|haha|wow)[\s!.?]*$/i;

/** Patterns that indicate approval — save as positive feedback */
const APPROVAL_PATTERNS =
  /^(lgtm|looks good|approved|approve|ship it|ship|merge it|merge|good to go|all good)[\s!.?]*$/i;

function classifyThreadMessage(
  text: string
): "casual" | "approval" | "retry" | "follow_up" {
  const cleaned = stripMentions(text).trim();
  if (!cleaned) {
    return "casual";
  }
  if (CASUAL_PATTERNS.test(cleaned)) {
    return "casual";
  }
  if (APPROVAL_PATTERNS.test(cleaned)) {
    return "approval";
  }
  if (/^(retry|rerun|run again|try again)\b/i.test(cleaned)) {
    return "retry";
  }
  // Short messages without action verbs are likely casual
  if (cleaned.length < 15 && !/\b(add|fix|change|update|remove|move|rename|refactor|implement|create|delete|use|try|make|set|wrap|lint|test|run|split|merge|revert|undo|convert|enable|disable)\b/i.test(cleaned)) {
    return "casual";
  }
  return "follow_up";
}

function parseFollowUpMessage(text: string): { task: string; baseBranch?: string; retry: boolean } {
  const cleaned = stripMentions(text);
  if (!cleaned) {
    return { task: "", retry: false };
  }

  let baseBranch: string | undefined;
  let task = cleaned;

  const baseDirectiveMatch = task.match(/\b(?:base|branch)\s*[:=]\s*([A-Za-z0-9._/-]+)/i);
  if (baseDirectiveMatch?.[1]) {
    baseBranch = baseDirectiveMatch[1];
    task = task.replace(baseDirectiveMatch[0], "").trim();
  } else {
    const naturalBranchMatch = task.match(
      /\b(?:base|branch)\b[^.\n]*?\b(?:is|to)\s+([A-Za-z0-9._/-]+)/i
    );
    if (naturalBranchMatch?.[1]) {
      baseBranch = naturalBranchMatch[1];
      task = task.replace(naturalBranchMatch[0], "").trim();
    }
  }

  const retry = /^(retry|rerun|run again|try again)\b/i.test(task);

  return {
    task,
    baseBranch,
    retry
  };
}

export async function startSlackApp(config: AppConfig, runManager: RunManager): Promise<void> {
  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    signingSecret: config.slackSigningSecret,
    socketMode: true
  });

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
      ].join("\n")
    });

    await client.chat.postEphemeral({
      channel: containerChannelId,
      user: userId,
      text: `Retry queued as ${shortRunId(retried.id)}.`
    });
  });

  app.event("app_mention", async ({ event, say }) => {
    const replyThreadTs = event.thread_ts ?? event.ts;

    if (!isChannelAllowed(event.channel, config.slackAllowedChannels)) {
      await say({
        text: `This channel is not allowed for ${config.slackCommandName} runs.`,
        thread_ts: replyThreadTs
      });
      return;
    }

    const command = parseCommand(event.text);

    if (command.type === "help") {
      await say({
        thread_ts: replyThreadTs,
        text: [
          `${config.appName} commands:`,
          `- \`${botCommand(config, "run owner/repo[@base-branch] | your task")}\``,
          `- \`${botCommand(config, "status")}\` (latest in thread/channel)`,
          `- \`${botCommand(config, "status <run-id-or-prefix>")}\``,
          `- \`${botCommand(config, "tail")}\` (latest logs in thread/channel)`,
          `- \`${botCommand(config, "tail <run-id-or-prefix>")}\``,
          `- \`${botCommand(config, "help")}\``,
          "",
          "Thread follow-up mode:",
          "- In a run thread, mention the bot with plain text to queue a follow-up run on the same repo.",
          "- Optional base override in thread: `base=master retry` or `branch is master retry`."
        ].join("\n")
      });
      return;
    }

    if (command.type === "invalid") {
      if (event.thread_ts && event.user) {
        const latestRun = await runManager.getLatestRunForThread(event.channel, event.thread_ts);
        if (latestRun) {
          const messageType = classifyThreadMessage(event.text);

          // Casual messages — ignore silently
          if (messageType === "casual") {
            return;
          }

          // Approval signals — save as positive feedback, don't trigger run
          if (messageType === "approval") {
            await runManager.saveFeedbackFromSlackAction({
              runId: latestRun.id,
              rating: "up",
              userId: event.user,
              note: stripMentions(event.text).trim()
            });
            await say({
              thread_ts: replyThreadTs,
              text: `Noted! Saved positive feedback for *${latestRun.repoSlug}* run ${shortRunId(latestRun.id)}.`
            });
            return;
          }

          // Retry — re-enqueue same task from scratch
          if (messageType === "retry") {
            const run = await runManager.retryRun(latestRun.id, event.user);
            if (run) {
              await say({
                thread_ts: replyThreadTs,
                text: [
                  `Queued retry for *${run.repoSlug}*`,
                  `Branch: \`${run.branchName}\``,
                  `Use \`${botCommand(config, "status")}\` for latest thread status, or \`${botCommand(config, "tail")}\` for logs.`
                ].join("\n")
              });
            }
            return;
          }

          // Follow-up — continue the run chain with new instructions
          const followUp = parseFollowUpMessage(event.text);
          const feedbackNote = followUp.task || stripMentions(event.text).trim();

          if (feedbackNote.length > config.maxTaskChars) {
            await say({
              thread_ts: replyThreadTs,
              text: `Task is too long. Maximum ${String(config.maxTaskChars)} characters.`
            });
            return;
          }

          const run = await runManager.continueRun(latestRun.id, feedbackNote, event.user);
          if (run) {
            await say({
              thread_ts: replyThreadTs,
              text: [
                `Queued follow-up for *${run.repoSlug}* (continuing from ${shortRunId(latestRun.id)})`,
                `Branch: \`${run.branchName}\``,
                `Use \`${botCommand(config, "status")}\` for latest thread status, or \`${botCommand(config, "tail")}\` for logs.`
              ].join("\n")
            });
          }
          return;
        }
      }

      await say({ thread_ts: replyThreadTs, text: `Invalid command: ${command.reason}` });
      return;
    }

    if (command.type === "status") {
      const status = await runManager.formatRunStatus(command.runId, event.channel, event.thread_ts);
      await say({ thread_ts: replyThreadTs, text: status });
      return;
    }

    if (command.type === "tail") {
      const tail = await runManager.tailRunLogs(command.runId, event.channel, event.thread_ts, 40);
      await say({ thread_ts: replyThreadTs, text: tail });
      return;
    }

    const payload = command.payload;
    if (!isRepoAllowed(payload.repoSlug, config.repoAllowlist)) {
      await say({
        thread_ts: replyThreadTs,
        text: `Repo not allowed: ${payload.repoSlug}`
      });
      return;
    }

    if (payload.task.length > config.maxTaskChars) {
      await say({
        thread_ts: replyThreadTs,
        text: `Task is too long. Maximum ${String(config.maxTaskChars)} characters.`
      });
      return;
    }

    if (!event.user) {
      await say({
        thread_ts: replyThreadTs,
        text: "Unable to identify requesting user for this event."
      });
      return;
    }

    const run = await runManager.enqueueRun({
      repoSlug: payload.repoSlug,
      task: payload.task,
      baseBranch: payload.baseBranch ?? config.defaultBaseBranch,
      requestedBy: event.user,
      channelId: event.channel,
      threadTs: replyThreadTs
    });

    await say({
      thread_ts: replyThreadTs,
      text: [
        `Queued run for *${run.repoSlug}*`,
        `Branch: \`${run.branchName}\``,
        `Use \`${botCommand(config, "status")}\` for latest thread status, or \`${botCommand(config, "tail")}\` for logs.`
      ].join("\n")
    });
  });

  await app.start();
  logInfo("Slack bot started in Socket Mode");
}
