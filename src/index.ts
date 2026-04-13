import dotenv from "dotenv";
dotenv.config({ override: true });
import path from "node:path";
import { loadConfig, type AppConfig } from "./config.js";
import { initDatabase, closeDatabase, type Database } from "./db/index.js";
import { RunStore } from "./store.js";
import { GitHubService } from "./github.js";
import { PipelineEngine } from "./pipeline/index.js";
import { CemsProvider } from "./memory/cems-provider.js";
import { RunLifecycleHooks } from "./hooks/run-lifecycle.js";
import { RunManager } from "./run-manager.js";
import { startSlackApp } from "./slack-app.js";
import { startDashboardServer, type DashboardWorkItemsSource } from "./dashboard-server.js";
import { WorkspaceCleaner } from "./workspace-cleaner.js";
import { ObserverDaemon } from "./observer/index.js";
import { execSync } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { logError, logInfo, logWarn } from "./logger.js";
import { ContainerManager } from "./sandbox/container-manager.js";
import { setSandboxManager } from "./pipeline/shell.js";
import { RunSupervisor } from "./supervisor/run-supervisor.js";
import { ConversationStore } from "./orchestrator/conversation-store.js";
import { PipelineStore } from "./pipeline/pipeline-store.js";
import { loadPlugins, getPluginDir } from "./plugins/plugin-loader.js";
import { NODE_HANDLERS, VALID_ACTIONS } from "./pipeline/node-registry.js";
import { SessionManager, createLLMPlanGoal, createLLMEvaluateProgress } from "./sessions/session-manager.js";
import { callLLMForJSON, type LLMCallerConfig } from "./llm/caller.js";
import { LearningStore } from "./observer/learning-store.js";
import { EvalStore } from "./eval/eval-store.js";
import { SetupStore } from "./db/setup-store.js";
import { AgentProfileStore } from "./db/agent-profile-store.js";
import { DockerExecutionBackend } from "./runtime/docker-backend.js";
import { LocalExecutionBackend } from "./runtime/local-backend.js";
import type { RuntimeRegistry } from "./runtime/backend.js";
import { KubernetesExecutionBackend } from "./runtime/kubernetes-backend.js";
import { ControlPlaneStore } from "./runtime/control-plane-store.js";
import { FileArtifactStore } from "./runtime/file-artifact-store.js";
import type { ArtifactStore } from "./runtime/artifact-store.js";
import { RuntimeReconciler } from "./runtime/reconciler.js";
import { KubernetesRuntimeFactsReader } from "./runtime/kubernetes/runtime-facts.js";
import { recoverRunsAfterRestart } from "./runtime/startup-recovery.js";
import { WorkItemStore } from "./work-items/store.js";
import { ReviewRequestStore } from "./work-items/review-request-store.js";
import { WorkItemEventsStore } from "./work-items/events-store.js";
import { WorkItemService } from "./work-items/service.js";
import { postWorkItemReviewNotifications } from "./work-items/slack-actions.js";
import { WorkItemIdentityStore } from "./work-items/identity-store.js";
import { WorkItemContextResolver } from "./work-items/context-resolver.js";
import { GitHubWorkItemSync, parseGitHubWorkItemWebhookPayload } from "./work-items/github-sync.js";
import { JiraWorkItemSync, parseJiraWorkItemWebhookPayload } from "./work-items/jira-sync.js";
import {
  hasSandboxRuntimeHotReloadChange,
  preflightSandboxRuntime
} from "./runtime/runtime-mode.js";

// ── Service container ──

interface Services {
  config: AppConfig;
  store: RunStore;
  agentProfileStore: AgentProfileStore;
  githubService: GitHubService | undefined;
  memoryProvider: CemsProvider | undefined;
  hooks: RunLifecycleHooks;
  containerManager: ContainerManager | undefined;
  pipelineEngine: PipelineEngine;
  pipelineStore: PipelineStore;
  learningStore: LearningStore;
  evalStore: EvalStore;
  webClient: import("@slack/web-api").WebClient | undefined;
  runManager: RunManager;
  conversationStore: ConversationStore;
  controlPlaneStore: ControlPlaneStore;
  runnerArtifactStore: ArtifactStore;
  runtimeReconciler: RuntimeReconciler;
  dashboardWorkItemsSource: DashboardWorkItemsSource;
  workItemService: WorkItemService;
  workItemGitHubSync: GitHubWorkItemSync;
  workItemJiraSync: JiraWorkItemSync;
}

function resolveKubernetesRunnerImage(): string {
  return process.env.KUBERNETES_RUNNER_IMAGE?.trim() || "gooseherd/k8s-runner:dev";
}

function resolveKubernetesNamespace(): string {
  return process.env.KUBERNETES_NAMESPACE?.trim() || "default";
}

function resolveKubernetesRunnerEnvSecretName(): string | undefined {
  return process.env.KUBERNETES_RUNNER_ENV_SECRET?.trim() || "gooseherd-env";
}

function resolveKubernetesRunnerEnvConfigMapName(): string | undefined {
  return process.env.KUBERNETES_RUNNER_ENV_CONFIGMAP?.trim() || "gooseherd-config";
}

function resolveKubernetesInternalBaseUrl(config: AppConfig): string {
  const explicit = process.env.KUBERNETES_INTERNAL_BASE_URL?.trim();
  if (explicit) {
    return explicit;
  }

  if (config.dashboardPublicUrl && !/localhost|127\.0\.0\.1/.test(config.dashboardPublicUrl)) {
    return config.dashboardPublicUrl;
  }

  return `http://host.minikube.internal:${String(config.dashboardPort)}`;
}

async function createServices(config: AppConfig, db: Database): Promise<Services> {
  const store = new RunStore(db);
  await store.init();
  const agentProfileStore = new AgentProfileStore(db, config);
  await agentProfileStore.init();

  const githubService = GitHubService.create(config);
  const memoryProvider = config.cemsEnabled && config.cemsApiUrl && config.cemsApiKey
    ? new CemsProvider({ apiUrl: config.cemsApiUrl, apiKey: config.cemsApiKey, teamId: config.cemsTeamId })
    : undefined;
  const hooks = new RunLifecycleHooks(memoryProvider);
  if (memoryProvider) {
    logInfo("Memory integration enabled", { provider: memoryProvider.name, url: config.cemsApiUrl });
  }

  // Sandbox container manager (Docker-out-of-Docker)
  let containerManager: ContainerManager | undefined;
  const sandboxPreflight = await preflightSandboxRuntime(config, {
    pingDocker: async () => {
      containerManager ??= new ContainerManager();
      return containerManager.ping();
    }
  });
  if (!sandboxPreflight.sandboxEnabled) {
    if (sandboxPreflight.fallbackReason === "missing_host_work_path") {
      logWarn("SANDBOX_HOST_WORK_PATH is required when SANDBOX_RUNTIME=docker — sandbox disabled");
    }
    if (sandboxPreflight.fallbackReason === "docker_unreachable") {
      logWarn("Docker daemon not reachable — sandbox disabled. Mount the Docker socket or set SANDBOX_RUNTIME=local");
    }
    containerManager = undefined;
    config.sandboxEnabled = false;
  } else if (containerManager) {
    const orphans = await containerManager.cleanupOrphans();
    if (orphans > 0) {
      logInfo("Cleaned up orphaned sandbox containers", { count: orphans });
    }
    setSandboxManager(containerManager, config.workRoot);
    logInfo("Sandbox mode enabled", { image: config.sandboxImage, hostWorkPath: config.sandboxHostWorkPath });
  }

  const pipelineStore = new PipelineStore(db);
  await pipelineStore.init(path.resolve("pipelines"));
  logInfo("Pipeline store ready", { count: pipelineStore.list().length });

  const pipelineEngine = new PipelineEngine(config, githubService, hooks, containerManager);
  logInfo("Pipeline engine ready", { pipelineFile: config.pipelineFile });
  const learningStore = new LearningStore(db);
  await learningStore.load();

  const evalStore = new EvalStore(db);

  const { WebClient } = await import("@slack/web-api");
  const webClient = config.slackBotToken ? new WebClient(config.slackBotToken) : undefined;

  const controlPlaneStore = new ControlPlaneStore(db);
  const workItemStore = new WorkItemStore(db);
  const reviewRequestStore = new ReviewRequestStore(db);
  const workItemEventsStore = new WorkItemEventsStore(db);
  const workItemService = new WorkItemService(db);
  const workItemIdentityStore = new WorkItemIdentityStore(db);
  const workItemContextResolver = new WorkItemContextResolver(db);
  const createHomeThread = webClient
    ? async (input: { channelId: string; text: string }) => {
        const response = await webClient.chat.postMessage({
          channel: input.channelId,
          text: input.text,
          ...(config.slackCommandName ? { username: config.slackCommandName } : {}),
        });
        if (!response.ts) {
          throw new Error(`Slack did not return a thread timestamp for channel ${input.channelId}`);
        }
        return response.ts;
      }
    : undefined;
  const workItemGitHubSync = new GitHubWorkItemSync(db, {
    adoptionLabels: config.workItemGithubAdoptionLabels,
    resetEngineeringReviewOnNewCommits: config.featureDeliveryResetEngineeringReviewOnNewCommits,
    resetQaReviewOnNewCommits: config.featureDeliveryResetQaReviewOnNewCommits,
    resolveDeliveryContext: async ({ jiraIssueKey }) => {
      const existing = await workItemStore.findByJiraIssueKey(jiraIssueKey);
      if (existing) {
        return {
          ownerTeamId: existing.ownerTeamId,
          homeChannelId: existing.homeChannelId,
          homeThreadTs: existing.homeThreadTs,
          createdByUserId: existing.createdByUserId,
          originChannelId: existing.originChannelId,
          originThreadTs: existing.originThreadTs,
        };
      }
      return undefined;
    },
  });
  const workItemJiraSync = new JiraWorkItemSync(db, {
    resolveDiscoveryContext: (input) => workItemContextResolver.resolveDiscoveryContext({
      ...input,
      createHomeThread,
    }),
    resolveDeliveryContext: (input) => workItemContextResolver.resolveDeliveryContext({
      ...input,
      createHomeThread,
    }),
  });
  const runtimeFactsReader = config.sandboxRuntime === "kubernetes"
    ? new KubernetesRuntimeFactsReader({
      namespace: resolveKubernetesNamespace(),
    })
    : {
      getTerminalFact: async () => "running" as const,
    };
  const runtimeReconciler = new RuntimeReconciler(
    controlPlaneStore,
    runtimeFactsReader,
    store
  );
  const publicBaseUrl = config.dashboardPublicUrl ?? `http://${config.dashboardHost}:${String(config.dashboardPort)}`;
  const runnerArtifactStore: ArtifactStore = new FileArtifactStore(
    config.workRoot,
    publicBaseUrl,
    controlPlaneStore,
  );
  const kubernetesBackend = config.sandboxRuntime === "kubernetes"
    ? new KubernetesExecutionBackend({
      controlPlaneStore,
      artifactStore: runnerArtifactStore,
      runStore: store,
      workRoot: config.workRoot,
      runnerImage: resolveKubernetesRunnerImage(),
      internalBaseUrl: resolveKubernetesInternalBaseUrl(config),
      dryRun: config.dryRun,
      runnerEnvSecretName: resolveKubernetesRunnerEnvSecretName(),
      runnerEnvConfigMapName: resolveKubernetesRunnerEnvConfigMapName(),
      namespace: resolveKubernetesNamespace(),
    })
    : undefined;
  const runtimeRegistry: RuntimeRegistry = {
    local: new LocalExecutionBackend(pipelineEngine),
    docker: new DockerExecutionBackend(pipelineEngine),
    kubernetes: kubernetesBackend,
  };
  const runManager = new RunManager(config, store, runtimeRegistry, webClient, hooks, pipelineStore, learningStore);
  runManager.onRunTerminal((runId, _status, runtime) => {
    if (runtime !== "kubernetes") {
      return;
    }

    runtimeReconciler.reconcileRun(runId).catch((error) => {
      const message = error instanceof Error ? error.message : "unknown";
      logError("Failed to reconcile terminal kubernetes run", { runId, error: message });
    });
  });

  const conversationStore = new ConversationStore({ db });
  await conversationStore.load();
  conversationStore.startCleanupTimer();

  const dashboardWorkItemsSource: DashboardWorkItemsSource = {
    listWorkItems: async (workflow?: string) => {
      const workItems = await workItemStore.listWorkItems();
      return workflow ? workItems.filter((workItem) => workItem.workflow === workflow) : workItems;
    },
    getWorkItem: (id) => workItemStore.getWorkItem(id),
    listReviewRequestsForWorkItem: (workItemId) => reviewRequestStore.listReviewRequestsForWorkItem(workItemId),
    listReviewRequestComments: (reviewRequestId) => reviewRequestStore.listComments(reviewRequestId),
    listEventsForWorkItem: (workItemId) => workItemEventsStore.listForWorkItem(workItemId),
    createDiscoveryWorkItem: async (input) => {
      if (!input.ownerTeamId || !input.homeChannelId || !input.homeThreadTs) {
        const resolved = await workItemContextResolver.resolveDiscoveryContext({
          createdByUserId: input.createdByUserId,
          ownerTeamId: input.ownerTeamId,
          originChannelId: input.originChannelId,
          originThreadTs: input.originThreadTs,
          title: input.title,
          createHomeThread,
        });
        return workItemService.createDiscoveryWorkItem({
          title: input.title,
          summary: input.summary,
          ownerTeamId: resolved.ownerTeamId,
          homeChannelId: resolved.homeChannelId,
          homeThreadTs: resolved.homeThreadTs,
          originChannelId: resolved.originChannelId,
          originThreadTs: resolved.originThreadTs,
          jiraIssueKey: input.jiraIssueKey,
          createdByUserId: resolved.createdByUserId,
        });
      }
      return workItemService.createDiscoveryWorkItem({
        title: input.title,
        summary: input.summary,
        ownerTeamId: input.ownerTeamId,
        homeChannelId: input.homeChannelId,
        homeThreadTs: input.homeThreadTs,
        originChannelId: input.originChannelId,
        originThreadTs: input.originThreadTs,
        jiraIssueKey: input.jiraIssueKey,
        createdByUserId: input.createdByUserId,
      });
    },
    createReviewRequests: async (input) => {
      const reviewRequests = await workItemService.requestReview(input);
      if (webClient) {
        const workItem = await workItemService.getWorkItem(input.workItemId);
        if (workItem) {
          await postWorkItemReviewNotifications(webClient, config, workItemIdentityStore, workItem, reviewRequests);
        }
      }
      return reviewRequests;
    },
    respondToReviewRequest: (input) => workItemService.recordReviewOutcome(input),
    confirmDiscovery: (input) => workItemService.confirmDiscovery(input),
    stopProcessing: (input) => workItemService.stopProcessing({
      ...input,
      cancelRun: (runId) => runManager.cancelRun(runId),
    }),
    guardedOverrideState: (input) => workItemService.guardedOverrideState({
      ...input,
      hasActiveProcessing: async (workItem) => workItemService.hasActiveProcessing(workItem.id),
    }),
  };

  return {
    config, store, agentProfileStore, githubService, memoryProvider, hooks, containerManager,
    pipelineEngine, pipelineStore, learningStore, evalStore, webClient, runManager, conversationStore,
    controlPlaneStore, runnerArtifactStore, runtimeReconciler, dashboardWorkItemsSource, workItemService, workItemGitHubSync, workItemJiraSync,
  };
}

// ── Helpers ──

function checkAgentDefault(config: { agentCommandTemplate: string }): void {
  if (!config.agentCommandTemplate.includes("dummy-agent")) return;

  try {
    execSync("which pi", { stdio: "pipe" });
    logWarn("Using dummy agent but pi is on PATH. Set AGENT_COMMAND_TEMPLATE to use the real agent.");
  } catch {
    logWarn("No AGENT_COMMAND_TEMPLATE set and pi not found on PATH. Using dummy agent.");
  }
}

// ── Main ──

async function main(): Promise<void> {
  // 1. Database + setup wizard config injection
  const db = await initDatabase(process.env.DATABASE_URL ?? "postgres://gooseherd:gooseherd@postgres:5432/gooseherd");
  const setupStore = new SetupStore(db, process.env.ENCRYPTION_KEY);
  if (await setupStore.isComplete()) {
    await setupStore.applyToEnv();
  }

  // 2. Load config (reads env vars, including any injected by wizard)
  const config = loadConfig();

  // 3. One-time registrations (plugins)
  const pluginResult = await loadPlugins(getPluginDir());
  if (pluginResult.loaded.length > 0) {
    logInfo("Plugins loaded", { count: pluginResult.loaded.length, names: pluginResult.loaded });
  }
  for (const [action, handler] of Object.entries(pluginResult.nodeHandlers)) {
    NODE_HANDLERS[action] = handler;
    VALID_ACTIONS.add(action);
  }

  // 4. Create core services
  const svc = await createServices(config, db);
  const activeAgentProfile = await svc.agentProfileStore.getActive();
  if (activeAgentProfile) {
    config.agentCommandTemplate = await svc.agentProfileStore.getEffectiveCommandTemplate(config.baseAgentCommandTemplate ?? config.agentCommandTemplate);
    config.activeAgentProfile = {
      id: activeAgentProfile.id,
      name: activeAgentProfile.name,
      runtime: activeAgentProfile.runtime,
      provider: activeAgentProfile.provider,
      model: activeAgentProfile.model,
      commandTemplate: config.agentCommandTemplate,
      source: "profile",
    };
  } else {
    config.activeAgentProfile = {
      id: "env-template",
      name: "Raw AGENT_COMMAND_TEMPLATE",
      runtime: "custom",
      commandTemplate: config.agentCommandTemplate,
      source: "env",
    };
  }
  checkAgentDefault(config);
  globalRefs.config = config;

  // 5. Recover stale in-progress runs from before restart
  const recovery = await recoverRunsAfterRestart(
    svc.store,
    svc.runManager,
    svc.runtimeReconciler,
    "Recovered after process restart. Auto-requeued."
  );
  if (recovery.recoveredRuns.length > 0) {
    logInfo("Recovered stale in-progress runs", { count: recovery.recoveredRuns.length });
  }
  if (recovery.requeuedCount > 0) {
    logInfo("Auto-requeued recovered runs", { count: recovery.requeuedCount });
  }
  if (recovery.skippedLocalCount > 0) {
    logInfo("Skipped auto-requeue for local-trigger runs", { count: recovery.skippedLocalCount });
  }
  if (recovery.kubernetesRuns.length > 0) {
    logInfo("Reconciled in-progress kubernetes runs after restart", { count: recovery.kubernetesRuns.length });
  }

  // 6. Session manager (multi-run goal-oriented loops)
  if (config.openrouterApiKey) {
    const sessionLlmConfig: LLMCallerConfig = {
      apiKey: config.openrouterApiKey,
      defaultModel: config.defaultLlmModel,
      defaultTimeoutMs: 30_000,
      providerPreferences: config.openrouterProviderPreferences,
    };
    const planGoal = createLLMPlanGoal(async <T>(system: string, userMessage: string, maxTokens: number) => {
      const { parsed } = await callLLMForJSON<T>(sessionLlmConfig, { system, userMessage, maxTokens });
      return parsed;
    });
    const evaluateProgress = createLLMEvaluateProgress(async <T>(system: string, userMessage: string, maxTokens: number) => {
      const { parsed } = await callLLMForJSON<T>(sessionLlmConfig, { system, userMessage, maxTokens });
      return parsed;
    });
    const sessionManager = new SessionManager(db, svc.runManager, planGoal, evaluateProgress);
    await sessionManager.load();
    svc.runManager.onRunTerminal((runId, status) => {
      sessionManager.onRunCompleted(runId, status).catch((err) => {
        const msg = err instanceof Error ? err.message : "unknown";
        logWarn("SessionManager: onRunCompleted error", { runId, error: msg });
      });
    });
    logInfo("Session manager enabled");
  }

  // 7. Background services
  const cleaner = new WorkspaceCleaner(config, svc.store);
  cleaner.start();

  if (config.supervisorEnabled) {
    const supervisor = new RunSupervisor(config, svc.runManager, svc.pipelineEngine, svc.store, svc.webClient);
    supervisor.start();
    globalRefs.supervisor = supervisor;
    logInfo("Run supervisor enabled");
  }

  if (config.observerEnabled) {
    const tokenGetter = svc.githubService ? () => svc.githubService!.getToken() : undefined;
    const observer = new ObserverDaemon(config, svc.runManager, svc.webClient, tokenGetter, svc.learningStore, db, {
      onGitHubWebhookPayload: async (headers, payload) => {
        const webhookPayload = parseGitHubWorkItemWebhookPayload(headers, payload);
        if (!webhookPayload) return;
        await svc.workItemGitHubSync.handleWebhookPayload(webhookPayload);
      },
      onAdapterPayload: async (source, _headers, payload) => {
        if (source !== "jira") return false;
        const webhookPayload = parseJiraWorkItemWebhookPayload(payload);
        if (!webhookPayload) return false;
        await svc.workItemJiraSync.handleWebhookPayload(webhookPayload);
        return true;
      },
    });
    await observer.start();
    globalRefs.observer = observer;
    logInfo("Observer system enabled");

    try {
      let debounce: NodeJS.Timeout | undefined;
      globalRefs.rulesWatcher = watch(config.observerRulesFile, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          logInfo("Trigger rules file changed — reloading");
          observer.reloadRules().catch((err) => {
            const msg = err instanceof Error ? err.message : "unknown";
            logError("Failed to reload trigger rules", { error: msg });
          });
        }, 500);
      });
      logInfo("Watching trigger rules for hot-reload", { file: config.observerRulesFile });
    } catch {
      logWarn("Could not watch trigger rules file (file may not exist yet)", { file: config.observerRulesFile });
    }
  }

  // 8. Dashboard + Slack
  if (config.dashboardEnabled) {
    startDashboardServer(
      config, svc.store, svc.runManager, globalRefs.observer, svc.conversationStore, svc.pipelineStore, svc.learningStore,
      setupStore,
      async () => {
        await setupStore.applyToEnv();
        logInfo("Setup wizard completed — restarting to apply new configuration");
        // Defer restart to let the HTTP response reach the client
        setTimeout(() => shutdown("WIZARD_COMPLETE"), 1000);
      },
      svc.evalStore,
      svc.agentProfileStore,
      svc.controlPlaneStore,
      svc.runnerArtifactStore,
      svc.dashboardWorkItemsSource,
      db,
    );
  }

  const slackConfigured = Boolean(config.slackBotToken && config.slackAppToken && config.slackSigningSecret);
  if (slackConfigured) {
    await startSlackApp(config, svc.runManager, globalRefs.observer, svc.memoryProvider, svc.githubService, svc.conversationStore, {
      recordReviewOutcome: async (input) => {
        const actor = input.authorUserId
          ? await new WorkItemIdentityStore(db).getUserBySlackUserId(input.authorUserId)
          : undefined;
        return svc.workItemService.recordReviewOutcome({
          ...input,
          authorUserId: actor?.id,
          source: "slack",
        });
      },
    });
  } else {
    logInfo("Slack tokens not configured — running in dashboard-only mode");
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  logError("Gooseherd failed to start", { error: message });
  process.exit(1);
});

// ── Shutdown + signals ──

async function shutdown(signal: string): Promise<void> {
  logInfo(`Shutting down (${signal})`);
  try {
    globalRefs.supervisor?.stop();
  } catch { /* swallow */ }
  try {
    const { observer: obs } = globalRefs;
    if (obs) await obs.stop();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    logError("Error during observer shutdown", { error: msg });
  }
  await closeDatabase();
  process.exit(0);
}

const globalRefs: {
  observer?: ObserverDaemon;
  supervisor?: RunSupervisor;
  rulesWatcher?: FSWatcher;
  config?: AppConfig;
} = {};

process.on("SIGINT", () => { shutdown("SIGINT"); });
process.on("SIGTERM", () => { shutdown("SIGTERM"); });

// SIGHUP → config hot-reload
process.on("SIGHUP", () => {
  logInfo("SIGHUP received — reloading configuration");
  try {
    dotenv.config({ override: true });
    const newConfig = loadConfig();
    if (globalRefs.config && hasSandboxRuntimeHotReloadChange(globalRefs.config, newConfig)) {
      logWarn("Sandbox runtime config changes require restart; ignoring hot reload", {
        currentRuntime: globalRefs.config.sandboxRuntime,
        nextRuntime: newConfig.sandboxRuntime
      });
      return;
    }
    if (globalRefs.observer) {
      globalRefs.observer.reload(newConfig).catch((err) => {
        const msg = err instanceof Error ? err.message : "unknown";
        logError("Config hot-reload failed for observer", { error: msg });
      });
    }
    globalRefs.config = newConfig;
    logInfo("Configuration reloaded successfully");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    logError("Config hot-reload failed", { error: msg });
  }
});
