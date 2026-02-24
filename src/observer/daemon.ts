/**
 * Observer Daemon — main orchestrator for the observer/trigger system.
 *
 * Lifecycle: start() → polling loop + webhook server → stop()
 * Follows the same daemon pattern as WorkspaceCleaner.
 */

import type { WebClient } from "@slack/web-api";
import type { AppConfig } from "../config.js";
import type { RunManager } from "../run-manager.js";
import { logError, logInfo } from "../logger.js";
import { ObserverStateStore } from "./state-store.js";
import { loadTriggerRules, matchTriggerRule } from "./trigger-rules.js";
import { buildDedupKey, getDedupTtl, runSafetyChecks } from "./safety.js";
import { composeRunInput } from "./run-composer.js";
import { startWebhookServer, type OnEventCallback } from "./webhook-server.js";
import { pollSentry, type SentryPollerConfig } from "./sources/sentry-poller.js";
import { triageEvent } from "./smart-triage.js";
import type { LLMCallerConfig } from "../llm/caller.js";
import type { TriggerEvent, TriggerRule } from "./types.js";

const MAX_PENDING_EVENTS = 1000;

export class ObserverDaemon {
  private readonly stateStore: ObserverStateStore;
  private rules: TriggerRule[] = [];
  private sentryPoller: NodeJS.Timeout | undefined;
  private webhookStop: (() => Promise<void>) | undefined;
  private readonly pendingWebhookEvents: TriggerEvent[] = [];
  private processingInterval: NodeJS.Timeout | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly runManager: RunManager,
    private readonly webClient: WebClient
  ) {
    this.stateStore = new ObserverStateStore(config.dataDir);
  }

  async start(): Promise<void> {
    // Load persisted state
    await this.stateStore.load();

    // Load trigger rules
    this.rules = await loadTriggerRules(this.config.observerRulesFile);
    logInfo("Observer: loaded trigger rules", { count: this.rules.length });

    // Start Sentry poller (if configured)
    if (this.config.sentryAuthToken && this.config.sentryOrgSlug && this.config.observerRepoMap.size > 0) {
      const sentryConfig: SentryPollerConfig = {
        authToken: this.config.sentryAuthToken,
        orgSlug: this.config.sentryOrgSlug,
        repoMap: this.config.observerRepoMap,
        pollIntervalSeconds: this.config.observerSentryPollIntervalSeconds,
        alertChannelId: this.config.observerAlertChannelId
      };

      // Initial poll
      await this.runSentryPoll(sentryConfig);

      // Recurring poll
      this.sentryPoller = setInterval(() => {
        this.runSentryPoll(sentryConfig).catch((err) => {
          const msg = err instanceof Error ? err.message : "unknown";
          logError("Observer: Sentry poll error", { error: msg });
        });
      }, sentryConfig.pollIntervalSeconds * 1000);
      this.sentryPoller.unref?.();

      logInfo("Observer: Sentry poller started", {
        intervalSeconds: sentryConfig.pollIntervalSeconds,
        projects: Array.from(sentryConfig.repoMap.keys())
      });
    }

    // Start webhook server (if secret configured)
    if (this.config.observerGithubWebhookSecret) {
      const onEvent: OnEventCallback = (event) => {
        this.enqueueEvent(event);
      };

      const handle = startWebhookServer({
        port: this.config.observerWebhookPort,
        githubWebhookSecret: this.config.observerGithubWebhookSecret
      }, onEvent);

      this.webhookStop = handle.stop;

      logInfo("Observer: webhook server started", { port: this.config.observerWebhookPort });
    }

    // Processing loop — drains pending events every 5 seconds
    this.processingInterval = setInterval(() => {
      this.processPendingEvents().catch((err) => {
        const msg = err instanceof Error ? err.message : "unknown";
        logError("Observer: event processing error", { error: msg });
      });
    }, 5000);
    this.processingInterval.unref?.();

    logInfo("Observer daemon started");
  }

  async stop(): Promise<void> {
    if (this.sentryPoller) {
      clearInterval(this.sentryPoller);
      this.sentryPoller = undefined;
    }

    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = undefined;
    }

    if (this.webhookStop) {
      await this.webhookStop();
      this.webhookStop = undefined;
    }

    // Flush state to disk before exit
    await this.stateStore.flush();

    logInfo("Observer daemon stopped");
  }

  /**
   * Enqueue an event from an external source (e.g., Slack channel adapter).
   * Drops events when queue is full to prevent OOM under flood conditions.
   */
  enqueueEvent(event: TriggerEvent): void {
    if (this.pendingWebhookEvents.length >= MAX_PENDING_EVENTS) {
      logError("Observer: event queue full, dropping event", { eventId: event.id, queueSize: MAX_PENDING_EVENTS });
      return;
    }
    this.pendingWebhookEvents.push(event);
  }

  private async runSentryPoll(sentryConfig: SentryPollerConfig): Promise<void> {
    const events = await pollSentry(sentryConfig, this.stateStore);
    for (const event of events) {
      this.enqueueEvent(event);
    }
    if (events.length > 0) {
      logInfo("Observer: Sentry poll produced events", { count: events.length });
    }
    // Flush state after poll (cursor updates)
    await this.stateStore.flush();
  }

  private async processPendingEvents(): Promise<void> {
    // Drain the queue
    const events = this.pendingWebhookEvents.splice(0);
    if (events.length === 0) return;

    for (const event of events) {
      await this.processEvent(event);
    }

    // Flush state after processing batch
    await this.stateStore.flush();
  }

  private async processEvent(event: TriggerEvent): Promise<void> {
    // 1. Match against trigger rules
    const rule = matchTriggerRule(event, this.rules);
    if (!rule) {
      logInfo("Observer: no matching rule for event", { eventId: event.id, source: event.source });
      return;
    }

    // 1b. Smart triage (optional LLM-based event classification)
    if (this.config.observerSmartTriageEnabled && this.config.anthropicApiKey) {
      const llmConfig: LLMCallerConfig = {
        apiKey: this.config.anthropicApiKey,
        defaultModel: this.config.observerSmartTriageModel,
        defaultTimeoutMs: this.config.observerSmartTriageTimeoutMs
      };
      const triageDecision = await triageEvent(
        event, rule, this.rules, llmConfig,
        this.config.observerSmartTriageTimeoutMs
      );
      if (triageDecision) {
        if (triageDecision.action === "discard" && triageDecision.confidence > 0.7) {
          logInfo("Observer: smart triage discarded event", {
            eventId: event.id,
            reason: triageDecision.reason,
            confidence: triageDecision.confidence
          });
          return;
        }
        if (triageDecision.action === "defer") {
          logInfo("Observer: smart triage deferred event", {
            eventId: event.id,
            reason: triageDecision.reason,
            confidence: triageDecision.confidence
          });
          return; // Drop for now; a future queue system can re-process deferred events
        }
        if (triageDecision.action === "escalate") {
          logInfo("Observer: smart triage escalated event (requires human review)", {
            eventId: event.id,
            reason: triageDecision.reason,
            confidence: triageDecision.confidence
          });
          return; // Escalated events require human intervention, not auto-triggering
        }
        // Apply refined task if triage provided one
        if (triageDecision.task && triageDecision.action === "trigger") {
          event.suggestedTask = triageDecision.task;
        }
        if (triageDecision.priority) {
          event.priority = triageDecision.priority;
        }
      }
    }

    // 2. Run safety pipeline
    const dedupKey = buildDedupKey(event);
    const repoSlug = event.repoSlug ?? rule.repoSlug ?? "";

    if (!repoSlug) {
      logInfo("Observer: event has no repoSlug, allowlist check will be skipped", { eventId: event.id });
    }

    // Prune old rate limit entries before checking
    this.stateStore.pruneRateLimitEvents(event.source, 60 * 60 * 1000);

    // Check dedup first (hasDedup may delete expired entries), then fetch entry for cooldown
    const isDuplicate = this.stateStore.hasDedup(dedupKey);
    const dedupEntry = this.stateStore.getDedupEntry(dedupKey);
    const decision = runSafetyChecks(event, rule, {
      isDuplicate,
      rateLimitTimestamps: this.stateStore.getRateLimitEvents(event.source),
      dailyCount: this.stateStore.getDailyCount(),
      repoCount: repoSlug ? this.stateStore.getDailyPerRepoCount(repoSlug) : 0,
      completedAt: dedupEntry?.completedAt,
      maxDaily: this.config.observerMaxRunsPerDay,
      maxPerRepo: this.config.observerMaxRunsPerRepoPerDay,
      repoAllowlist: this.config.repoAllowlist
    });

    if (decision.action === "deny") {
      logInfo("Observer: event denied by safety pipeline", {
        eventId: event.id,
        reason: decision.reason
      });
      return;
    }

    // 3. Compose NewRunInput (posts seed Slack message for threadTs)
    try {
      const runInput = await composeRunInput(event, rule, this.config, this.webClient);

      // 4. Approval gate (if rule requires it)
      // TODO: Wire observer_approve/observer_reject Slack action handlers in slack-app.ts.
      // Currently approval buttons render but have no backend handler — clicking them is a no-op.
      // For v1, approval-required rules will post the request but never auto-enqueue.
      if (rule.requiresApproval) {
        logInfo("Observer: event requires approval, posting for review", {
          eventId: event.id,
          ruleId: rule.id
        });
        await this.postApprovalRequest(event, rule, runInput);
        // Record dedup and rate limit, increment daily counters
        this.stateStore.setDedup(dedupKey, getDedupTtl(event.source));
        this.stateStore.addRateLimitEvent(event.source, Date.now());
        if (repoSlug) {
          this.stateStore.incrementDailyCount(repoSlug);
        }
        return;
      }

      // 5. Enqueue the run
      const record = await this.runManager.enqueueRun(runInput);

      // Update state
      this.stateStore.setDedup(dedupKey, getDedupTtl(event.source), record.id);
      this.stateStore.addRateLimitEvent(event.source, Date.now());
      if (repoSlug) {
        this.stateStore.incrementDailyCount(repoSlug);
      }

      logInfo("Observer: run enqueued", {
        eventId: event.id,
        runId: record.id,
        ruleId: rule.id,
        repoSlug: runInput.repoSlug
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      logError("Observer: failed to compose/enqueue run", {
        eventId: event.id,
        error: msg
      });
    }
  }

  /**
   * Post an approval request message with interactive buttons.
   *
   * For v1: simple Approve/Reject buttons with a 30-minute timeout hint.
   */
  private async postApprovalRequest(
    event: TriggerEvent,
    rule: TriggerRule,
    runInput: { repoSlug: string; task: string; baseBranch: string; channelId: string; threadTs: string }
  ): Promise<void> {
    const text = [
      `🔔 *Observer trigger requires approval*`,
      `*Source:* ${event.source} | *Rule:* ${rule.id}`,
      `*Repo:* \`${runInput.repoSlug}\` | *Branch:* \`${runInput.baseBranch}\``,
      `*Priority:* ${event.priority}`,
      `*Task:* ${runInput.task.length > 200 ? `${runInput.task.slice(0, 197)}...` : runInput.task}`,
      "",
      "React to approve or reject this auto-fix:"
    ].join("\n");

    await this.webClient.chat.postMessage({
      channel: runInput.channelId,
      thread_ts: runInput.threadTs,
      text,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text }
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              action_id: "observer_approve",
              text: { type: "plain_text", text: "Approve", emoji: true },
              style: "primary",
              value: JSON.stringify({
                eventId: event.id,
                ruleId: rule.id,
                repoSlug: runInput.repoSlug,
                task: runInput.task,
                baseBranch: runInput.baseBranch,
                channelId: runInput.channelId,
                threadTs: runInput.threadTs
              })
            },
            {
              type: "button",
              action_id: "observer_reject",
              text: { type: "plain_text", text: "Reject", emoji: true },
              style: "danger",
              value: event.id
            }
          ]
        },
        {
          type: "context",
          elements: [
            { type: "mrkdwn", text: "This request will auto-expire in 30 minutes." }
          ]
        }
      ]
    });
  }
}
