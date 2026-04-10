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
import { startDashboardServer } from "./dashboard-server.js";
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
import { ControlPlaneStore } from "./runtime/control-plane-store.js";
import { FileArtifactStore } from "./runtime/file-artifact-store.js";
import type { RunnerArtifactStore } from "./runtime/control-plane-router.js";
import { RuntimeReconciler } from "./runtime/reconciler.js";
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
  runnerArtifactStore: RunnerArtifactStore;
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
  const runtimeRegistry: RuntimeRegistry = {
    local: new LocalExecutionBackend(pipelineEngine),
    docker: new DockerExecutionBackend(pipelineEngine),
    kubernetes: undefined
  };

  const learningStore = new LearningStore(db);
  await learningStore.load();

  const evalStore = new EvalStore(db);

  const { WebClient } = await import("@slack/web-api");
  const webClient = config.slackBotToken ? new WebClient(config.slackBotToken) : undefined;

  const controlPlaneStore = new ControlPlaneStore(db);
  const runtimeReconciler = new RuntimeReconciler(
    controlPlaneStore,
    {
      getTerminalFact: async (runId: string) => {
        const run = await store.getRun(runId);
        if (!run) return "missing";
        if (run.status === "completed") return "succeeded";
        if (run.status === "failed") return "failed";
        return "running";
      }
    },
    store
  );
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
  const publicBaseUrl = config.dashboardPublicUrl ?? `http://${config.dashboardHost}:${String(config.dashboardPort)}`;
  const runnerArtifactStore: RunnerArtifactStore = new FileArtifactStore(
    config.workRoot,
    publicBaseUrl,
    controlPlaneStore,
  );

  const conversationStore = new ConversationStore({ db });
  await conversationStore.load();
  conversationStore.startCleanupTimer();

  return {
    config, store, agentProfileStore, githubService, memoryProvider, hooks, containerManager,
    pipelineEngine, pipelineStore, learningStore, evalStore, webClient, runManager, conversationStore,
    controlPlaneStore, runnerArtifactStore,
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
  const recoveredRuns = await svc.store.recoverInProgressRuns(
    "Recovered after process restart. Auto-requeued."
  );
  if (recoveredRuns.length > 0) {
    logInfo("Recovered stale in-progress runs", { count: recoveredRuns.length });
    const runsToRequeue = recoveredRuns.filter((run) => run.channelId !== "local");
    for (const run of runsToRequeue) {
      svc.runManager.requeueExistingRun(run.id);
    }
    if (runsToRequeue.length > 0) {
      logInfo("Auto-requeued recovered runs", { count: runsToRequeue.length });
    }
    const skippedLocal = recoveredRuns.length - runsToRequeue.length;
    if (skippedLocal > 0) {
      logInfo("Skipped auto-requeue for local-trigger runs", { count: skippedLocal });
    }
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
    const observer = new ObserverDaemon(config, svc.runManager, svc.webClient, tokenGetter, svc.learningStore, db);
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
    );
  }

  const slackConfigured = Boolean(config.slackBotToken && config.slackAppToken && config.slackSigningSecret);
  if (slackConfigured) {
    await startSlackApp(config, svc.runManager, globalRefs.observer, svc.memoryProvider, svc.githubService, svc.conversationStore);
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
