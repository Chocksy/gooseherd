import dotenv from "dotenv";
dotenv.config({ override: true });
import path from "node:path";
import { loadConfig } from "./config.js";
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

function checkAgentDefault(config: { agentCommandTemplate: string }): void {
  if (!config.agentCommandTemplate.includes("dummy-agent")) return;

  try {
    execSync("which pi", { stdio: "pipe" });
    logWarn("Using dummy agent but pi is on PATH. Set AGENT_COMMAND_TEMPLATE to use the real agent.");
  } catch {
    logWarn("No AGENT_COMMAND_TEMPLATE set and pi not found on PATH. Using dummy agent.");
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  checkAgentDefault(config);

  const store = new RunStore(config.dataDir);
  await store.init();
  const recoveredRuns = await store.recoverInProgressRuns(
    "Recovered after process restart. Auto-requeued."
  );
  if (recoveredRuns.length > 0) {
    logInfo("Recovered stale in-progress runs", { count: recoveredRuns.length });
  }

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
  if (config.sandboxEnabled) {
    if (!config.sandboxHostWorkPath) {
      logWarn("SANDBOX_HOST_WORK_PATH is required when SANDBOX_ENABLED=true — sandbox disabled");
      config.sandboxEnabled = false;
    } else {
      containerManager = new ContainerManager();
      const dockerOk = await containerManager.ping();
      if (!dockerOk) {
        logWarn("Docker daemon not reachable — sandbox disabled. Mount the Docker socket or set SANDBOX_ENABLED=false");
        containerManager = undefined;
        config.sandboxEnabled = false;
      } else {
        const orphans = await containerManager.cleanupOrphans();
        if (orphans > 0) {
          logInfo("Cleaned up orphaned sandbox containers", { count: orphans });
        }
        setSandboxManager(containerManager, config.workRoot);
        logInfo("Sandbox mode enabled", { image: config.sandboxImage, hostWorkPath: config.sandboxHostWorkPath });
      }
    }
  }

  const pipelineEngine = new PipelineEngine(config, githubService, hooks, containerManager);
  logInfo("Pipeline engine ready", { pipelineFile: config.pipelineFile });

  // Slack Web API client — only created when Slack tokens are configured.
  const { WebClient } = await import("@slack/web-api");
  const webClient = config.slackBotToken ? new WebClient(config.slackBotToken) : undefined;

  const runManager = new RunManager(config, store, pipelineEngine, webClient, hooks);
  const conversationStore = new ConversationStore({
    persistDir: path.join(config.dataDir, "conversations")
  });
  await conversationStore.load();
  conversationStore.startCleanupTimer();
  if (recoveredRuns.length > 0) {
    const runsToRequeue = recoveredRuns.filter((run) => run.channelId !== "local");
    for (const run of runsToRequeue) {
      runManager.requeueExistingRun(run.id);
    }
    if (runsToRequeue.length > 0) {
      logInfo("Auto-requeued recovered runs", { count: runsToRequeue.length });
    }
    const skippedLocal = recoveredRuns.length - runsToRequeue.length;
    if (skippedLocal > 0) {
      logInfo("Skipped auto-requeue for local-trigger runs", { count: skippedLocal });
    }
  }

  const cleaner = new WorkspaceCleaner(config, store);
  cleaner.start();

  if (config.supervisorEnabled) {
    const supervisor = new RunSupervisor(config, runManager, pipelineEngine, store, webClient);
    supervisor.start();
    globalRefs.supervisor = supervisor;
    logInfo("Run supervisor enabled");
  }

  if (config.observerEnabled) {
    const tokenGetter = githubService ? () => githubService.getToken() : undefined;
    const observer = new ObserverDaemon(config, runManager, webClient, tokenGetter);
    await observer.start();
    globalRefs.observer = observer;
    logInfo("Observer system enabled");

    // Watch trigger rules file for changes (hot-reload without restart)
    try {
      let debounce: NodeJS.Timeout | undefined;
      globalRefs.rulesWatcher = watch(config.observerRulesFile, () => {
        // Debounce rapid writes (editors often write multiple times)
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

  if (config.dashboardEnabled) {
    startDashboardServer(config, store, runManager, globalRefs.observer, conversationStore);
  }

  const slackConfigured = Boolean(config.slackBotToken && config.slackAppToken && config.slackSigningSecret);
  if (slackConfigured) {
    await startSlackApp(config, runManager, globalRefs.observer, memoryProvider, githubService, conversationStore);
  } else {
    logInfo("Slack tokens not configured — running in dashboard-only mode");
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  logError("Gooseherd failed to start", { error: message });
  process.exit(1);
});

async function shutdown(signal: string): Promise<void> {
  logInfo(`Shutting down (${signal})`);
  // Stop supervisor + observer before exit
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
  process.exit(0);
}

// Global refs for shutdown access and hot-reload
const globalRefs: { observer?: ObserverDaemon; supervisor?: RunSupervisor; rulesWatcher?: FSWatcher } = {};

process.on("SIGINT", () => { shutdown("SIGINT"); });
process.on("SIGTERM", () => { shutdown("SIGTERM"); });

// SIGHUP → config hot-reload
process.on("SIGHUP", () => {
  logInfo("SIGHUP received — reloading configuration");
  try {
    dotenv.config({ override: true });
    const newConfig = loadConfig();
    if (globalRefs.observer) {
      globalRefs.observer.reload(newConfig).catch((err) => {
        const msg = err instanceof Error ? err.message : "unknown";
        logError("Config hot-reload failed for observer", { error: msg });
      });
    }
    logInfo("Configuration reloaded successfully");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    logError("Config hot-reload failed", { error: msg });
  }
});
