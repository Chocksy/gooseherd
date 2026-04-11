/**
 * Observer Daemon — main orchestrator for the observer/trigger system.
 *
 * Lifecycle: start() → polling loop + webhook server → stop()
 * Follows the same daemon pattern as WorkspaceCleaner.
 */

import path from "node:path";
import type { WebClient } from "@slack/web-api";
import type { AppConfig } from "../config.js";
import type { RunEnqueuer } from "./run-enqueuer.js";
import { logError, logInfo, logWarn } from "../logger.js";
import { loadExtensionAdapters } from "./sources/load-extension-adapters.js";
import { ObserverStateStore } from "./state-store.js";
import { LearningStore } from "./learning-store.js";
import type { Database } from "../db/index.js";

import { loadTriggerRules, matchTriggerRule } from "./trigger-rules.js";
import { buildDedupKey, getDedupTtl, runSafetyChecks } from "./safety.js";
import { composeRunInput } from "./run-composer.js";
import { startWebhookServer, type OnAdapterPayloadCallback, type OnEventCallback, type OnGitHubWebhookPayloadCallback } from "./webhook-server.js";
import { registerAdapter } from "./sources/adapter-registry.js";
import { githubAdapter } from "./sources/github-adapter-wrapper.js";
import { createSentryAdapter } from "./sources/sentry-adapter-wrapper.js";
import { jiraWorkItemAdapter } from "./sources/jira-work-item-adapter.js";
import { pollSentry, type SentryPollerConfig } from "./sources/sentry-poller.js";
import { pollGitHub, type GitHubPollerConfig } from "./sources/github-poller.js";
import { triageEvent } from "./smart-triage.js";
import { startCronScheduler, type CronSchedulerHandle } from "./sources/cron-adapter.js";
import { startAutonomousScheduler, type SchedulerSlotChecker, type SchedulerStats } from "./autonomous-scheduler.js";
import type { LLMCallerConfig } from "../llm/caller.js";
import type { TriggerEvent, TriggerRule, ObserverEventRecord, ObserverStateSnapshot } from "./types.js";

const MAX_PENDING_EVENTS = 1000;
const MAX_EVENT_HISTORY = 200;

export class ObserverDaemon {
  private readonly stateStore: ObserverStateStore;
  private readonly learningStore: LearningStore;
  private readonly onGitHubWebhookPayload?: OnGitHubWebhookPayloadCallback;
  private readonly onAdapterPayload?: OnAdapterPayloadCallback;
  private rules: TriggerRule[] = [];
  private sentryPoller: NodeJS.Timeout | undefined;
  private githubPoller: NodeJS.Timeout | undefined;
  private webhookStop: (() => Promise<void>) | undefined;
  private readonly pendingWebhookEvents: TriggerEvent[] = [];
  private readonly eventHistory: ObserverEventRecord[] = [];
  private processingInterval: NodeJS.Timeout | undefined;
  private cronScheduler: CronSchedulerHandle | undefined;
  private autonomousScheduler: ReturnType<typeof startAutonomousScheduler> | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly runManager: RunEnqueuer,
    private readonly webClient: WebClient | undefined,
    private readonly tokenGetter?: () => Promise<string>,
    learningStore?: LearningStore,
    db?: Database,
    hooks?: {
      onGitHubWebhookPayload?: OnGitHubWebhookPayloadCallback;
      onAdapterPayload?: OnAdapterPayloadCallback;
    }
  ) {
    const database = db ?? (learningStore as unknown as { db: Database })?.db;
    if (!database) throw new Error("ObserverDaemon requires a Database instance");
    this.stateStore = new ObserverStateStore(database);
    this.learningStore = learningStore ?? new LearningStore(database);
    this.onGitHubWebhookPayload = hooks?.onGitHubWebhookPayload;
    this.onAdapterPayload = hooks?.onAdapterPayload;
  }

  async start(): Promise<void> {
    // Load persisted state
    await this.stateStore.load();
    await this.learningStore.load();

    // Register learning loop callback — when a run finishes, update dedup + enrich ruleId
    this.runManager.onRunTerminal((runId, status) => {
      (async () => {
        await this.stateStore.markDedupCompleted(runId, status);

        // Enrich existing learning record with observer-specific ruleId
        const ruleId = await this.stateStore.getRuleIdForRun(runId);
        if (ruleId) {
          await this.learningStore.enrichOutcome(runId, { ruleId });
          await this.learningStore.flush();
        }
      })().catch(() => {});
    });

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

    // Start GitHub Actions poller (if configured)
    if (this.tokenGetter && this.config.observerGithubWatchedRepos.length > 0) {
      // Initial poll
      await this.runGitHubPollWithFreshToken();

      // Recurring poll — resolves a fresh token on each cycle
      this.githubPoller = setInterval(() => {
        this.runGitHubPollWithFreshToken().catch((err) => {
          const msg = err instanceof Error ? err.message : "unknown";
          logError("Observer: GitHub poll error", { error: msg });
        });
      }, this.config.observerGithubPollIntervalSeconds * 1000);
      this.githubPoller.unref?.();

      logInfo("Observer: GitHub Actions poller started", {
        intervalSeconds: this.config.observerGithubPollIntervalSeconds,
        repos: this.config.observerGithubWatchedRepos
      });
    }

    // Register built-in webhook adapters
    registerAdapter(githubAdapter);
    if (this.config.observerAlertChannelId) {
      registerAdapter(createSentryAdapter(this.config.observerAlertChannelId));
    }
    registerAdapter(jiraWorkItemAdapter);

    // Load extension adapters from extensions/adapters/
    const extensionDir = path.resolve("extensions/adapters");
    const extensionAdapters = await loadExtensionAdapters(extensionDir);
    if (extensionAdapters.length > 0) {
      logInfo("Observer: loaded extension adapters", {
        count: extensionAdapters.length,
        sources: extensionAdapters.map(a => a.source)
      });
    }

    // Start webhook server (if any webhook secret configured)
    const hasGitHubWebhook = Boolean(this.config.observerGithubWebhookSecret);
    const hasSentryWebhook = Boolean(this.config.observerSentryWebhookSecret);
    const hasCustomAdapters = Object.keys(this.config.observerWebhookSecrets).length > 0;
    if (hasGitHubWebhook || hasSentryWebhook || hasCustomAdapters) {
      const onEvent: OnEventCallback = (event) => {
        this.enqueueEvent(event);
      };

      const handle = startWebhookServer({
        port: this.config.observerWebhookPort,
        githubWebhookSecret: this.config.observerGithubWebhookSecret,
        sentryWebhookSecret: this.config.observerSentryWebhookSecret,
        sentryAlertChannelId: this.config.observerAlertChannelId,
        adapterSecrets: this.config.observerWebhookSecrets
      }, onEvent, {
        onGitHubWebhookPayload: this.onGitHubWebhookPayload,
        onAdapterPayload: this.onAdapterPayload,
      });

      this.webhookStop = handle.stop;

      const sources = [hasGitHubWebhook && "github", hasSentryWebhook && "sentry"].filter(Boolean);
      logInfo("Observer: webhook server started", { port: this.config.observerWebhookPort, sources });
    }

    // Start cron scheduler (if any cron rules exist)
    const cronRules = this.rules.filter(r => r.source === "cron");
    if (cronRules.length > 0) {
      this.cronScheduler = startCronScheduler(cronRules, (event) => {
        this.enqueueEvent(event);
      });
      logInfo("Observer: cron scheduler started", { ruleCount: cronRules.length });
    }

    // Processing loop — drains pending events every 5 seconds
    this.processingInterval = setInterval(() => {
      this.processPendingEvents().catch((err) => {
        const msg = err instanceof Error ? err.message : "unknown";
        logError("Observer: event processing error", { error: msg });
      });
    }, 5000);
    this.processingInterval.unref?.();

    // Start autonomous scheduler (if enabled)
    if (this.config.autonomousSchedulerEnabled) {
      const slotChecker: SchedulerSlotChecker = {
        hasCapacity: async () => {
          const dailyCount = await this.stateStore.getDailyCount();
          return dailyCount < this.config.observerMaxRunsPerDay;
        },
        activeRunCount: async () => this.stateStore.getDailyCount()
      };

      this.autonomousScheduler = startAutonomousScheduler(
        {
          enabled: true,
          maxDeferredEvents: this.config.autonomousSchedulerMaxDeferred,
          evaluateIntervalMs: this.config.autonomousSchedulerIntervalMs,
          maxRetries: 10,
          maxAge: 24 * 60 * 60 * 1000  // 24 hours
        },
        slotChecker,
        (event, rule) => {
          logInfo("Autonomous scheduler: triggering deferred event", { eventId: event.id, ruleId: rule.id });
          this.enqueueEvent(event);
        }
      );
      logInfo("Observer: autonomous scheduler started");
    }

    logInfo("Observer daemon started");
  }

  async stop(): Promise<void> {
    if (this.sentryPoller) {
      clearInterval(this.sentryPoller);
      this.sentryPoller = undefined;
    }

    if (this.githubPoller) {
      clearInterval(this.githubPoller);
      this.githubPoller = undefined;
    }

    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = undefined;
    }

    if (this.cronScheduler) {
      this.cronScheduler.stop();
      this.cronScheduler = undefined;
    }

    if (this.autonomousScheduler) {
      this.autonomousScheduler.stop();
      this.autonomousScheduler = undefined;
    }

    if (this.webhookStop) {
      await this.webhookStop();
      this.webhookStop = undefined;
    }

    // Flush state to disk before exit
    await this.stateStore.flush();
    await this.learningStore.flush();

    logInfo("Observer daemon stopped");
  }

  /**
   * Hot-reload: stop pollers/webhook server and restart with new config.
   * Preserves state store (dedup, counters, outcomes) across reload.
   */
  async reload(newConfig: AppConfig): Promise<void> {
    logInfo("Observer: reloading configuration");

    // Stop existing pollers and webhook server (preserves state store in memory)
    if (this.sentryPoller) {
      clearInterval(this.sentryPoller);
      this.sentryPoller = undefined;
    }
    if (this.githubPoller) {
      clearInterval(this.githubPoller);
      this.githubPoller = undefined;
    }
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = undefined;
    }
    if (this.cronScheduler) {
      this.cronScheduler.stop();
      this.cronScheduler = undefined;
    }
    if (this.autonomousScheduler) {
      this.autonomousScheduler.stop();
      this.autonomousScheduler = undefined;
    }
    if (this.webhookStop) {
      await this.webhookStop();
      this.webhookStop = undefined;
    }

    // Flush current state before switching config
    await this.stateStore.flush();
    await this.learningStore.flush();

    // Update config reference — TypeScript doesn't allow reassigning readonly,
    // so we use Object.assign to replace the contents
    Object.assign(this, { config: newConfig });

    // Re-start with new config (start() is idempotent for state loading)
    await this.start();

    logInfo("Observer: reload complete");
  }

  /**
   * Reload trigger rules from disk without restarting pollers.
   */
  async reloadRules(): Promise<void> {
    this.rules = await loadTriggerRules(this.config.observerRulesFile);
    logInfo("Observer: trigger rules reloaded", { count: this.rules.length });
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

  // ── Dashboard query methods ──

  /** Get state snapshot for dashboard display. */
  async getStateSnapshot(): Promise<ObserverStateSnapshot> {
    return this.stateStore.getSnapshot();
  }

  /** Get recent processed events (newest first). */
  getRecentEvents(limit = 50): ObserverEventRecord[] {
    return this.eventHistory.slice(-limit).reverse();
  }

  /** Get autonomous scheduler stats for dashboard display. */
  getSchedulerStats(): SchedulerStats {
    return this.autonomousScheduler?.getStats() ?? { queueSize: 0, totalDeferred: 0, totalTriggered: 0, totalDropped: 0 };
  }

  /** Get loaded trigger rules. */
  getRules(): TriggerRule[] {
    return [...this.rules];
  }

  /** Get recent run outcome records from the learning store (newest first). */
  async getRecentOutcomes(limit = 50): Promise<import("./learning-store.js").RunOutcomeRecord[]> {
    return this.learningStore.getRecentOutcomes(limit);
  }

  /** Get aggregated learnings for all rules. */
  async getAllRuleLearnings(): Promise<import("./learning-store.js").RuleLearnings[]> {
    return this.learningStore.getAllRuleLearnings();
  }

  private recordEvent(record: ObserverEventRecord): void {
    this.eventHistory.push(record);
    if (this.eventHistory.length > MAX_EVENT_HISTORY) {
      this.eventHistory.splice(0, this.eventHistory.length - MAX_EVENT_HISTORY);
    }
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

  private async runGitHubPollWithFreshToken(): Promise<void> {
    const token = await this.tokenGetter!();
    const ghConfig: GitHubPollerConfig = {
      githubToken: token,
      watchedRepos: this.config.observerGithubWatchedRepos,
      pollIntervalSeconds: this.config.observerGithubPollIntervalSeconds,
      alertChannelId: this.config.observerAlertChannelId
    };
    await this.runGitHubPoll(ghConfig);
  }

  private async runGitHubPoll(ghConfig: GitHubPollerConfig): Promise<void> {
    const events = await pollGitHub(ghConfig, this.stateStore);
    for (const event of events) {
      this.enqueueEvent(event);
    }
    if (events.length > 0) {
      logInfo("Observer: GitHub poll produced events", { count: events.length });
    }
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
    const now = new Date().toISOString();

    // 1. Match against trigger rules
    const rule = matchTriggerRule(event, this.rules);
    if (!rule) {
      logInfo("Observer: no matching rule for event", { eventId: event.id, source: event.source });
      this.recordEvent({
        eventId: event.id, source: event.source, timestamp: event.timestamp,
        repoSlug: event.repoSlug, outcome: "no_match", reason: "No matching rule", processedAt: now
      });
      return;
    }

    // 1b. Smart triage (optional LLM-based event classification)
    if (this.config.observerSmartTriageEnabled && this.config.openrouterApiKey) {
      const llmConfig: LLMCallerConfig = {
        apiKey: this.config.openrouterApiKey,
        defaultModel: this.config.observerSmartTriageModel,
        defaultTimeoutMs: this.config.observerSmartTriageTimeoutMs,
        providerPreferences: this.config.openrouterProviderPreferences
      };
      const learningSummary = await this.learningStore.getTriageSummary(rule.id);
      const triageDecision = await triageEvent(
        event, rule, this.rules, llmConfig,
        this.config.observerSmartTriageTimeoutMs,
        learningSummary || undefined
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
          if (this.autonomousScheduler) {
            this.autonomousScheduler.defer(event, rule, triageDecision.reason);
          }
          return;
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
        if (triageDecision.pipeline) {
          event.pipelineHint = triageDecision.pipeline;
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
    await this.stateStore.pruneRateLimitEvents(event.source, 60 * 60 * 1000);

    // Check dedup first (hasDedup may delete expired entries), then fetch entry for cooldown
    const isDuplicate = await this.stateStore.hasDedup(dedupKey);
    const dedupEntry = await this.stateStore.getDedupEntry(dedupKey);
    const decision = runSafetyChecks(event, rule, {
      isDuplicate,
      rateLimitTimestamps: await this.stateStore.getRateLimitEvents(event.source),
      dailyCount: await this.stateStore.getDailyCount(),
      repoCount: repoSlug ? await this.stateStore.getDailyPerRepoCount(repoSlug) : 0,
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
      this.recordEvent({
        eventId: event.id, source: event.source, timestamp: event.timestamp,
        repoSlug: event.repoSlug, matchedRuleId: rule.id,
        outcome: "denied", reason: decision.reason, processedAt: now
      });
      return;
    }

    // 3. Compose NewRunInput (posts seed Slack message for threadTs)
    try {
      const runInput = await composeRunInput(event, rule, this.config, this.webClient);

      // 4. Approval gate (if rule requires it and Slack is available)
      if (rule.requiresApproval && this.webClient) {
        logInfo("Observer: event requires approval, posting for review", {
          eventId: event.id,
          ruleId: rule.id
        });
        await this.postApprovalRequest(event, rule, runInput);
        // Record dedup and rate limit, increment daily counters
        await this.stateStore.setDedup(dedupKey, getDedupTtl(event.source));
        await this.stateStore.addRateLimitEvent(event.source, Date.now());
        if (repoSlug) {
          await this.stateStore.incrementDailyCount(repoSlug);
        }
        this.recordEvent({
          eventId: event.id, source: event.source, timestamp: event.timestamp,
          repoSlug: event.repoSlug, matchedRuleId: rule.id,
          outcome: "approval_required", reason: "Rule requires approval", processedAt: now
        });
        return;
      }
      if (rule.requiresApproval && !this.webClient) {
        logWarn("Observer: approval required but Slack not configured — auto-approving", {
          ruleId: rule.id, eventId: event.id
        });
      }

      // 5. Enqueue the run
      const record = await this.runManager.enqueueRun(runInput);

      // Update state (include ruleId for learning loop outcome tracking)
      await this.stateStore.setDedup(dedupKey, getDedupTtl(event.source), record.id, rule.id);
      await this.stateStore.addRateLimitEvent(event.source, Date.now());
      if (repoSlug) {
        await this.stateStore.incrementDailyCount(repoSlug);
      }

      this.recordEvent({
        eventId: event.id, source: event.source, timestamp: event.timestamp,
        repoSlug: event.repoSlug, matchedRuleId: rule.id,
        outcome: "triggered", reason: "Run enqueued", runId: record.id, processedAt: now
      });

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

    await this.webClient!.chat.postMessage({
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
