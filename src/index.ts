import dotenv from "dotenv";
dotenv.config({ override: true });
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

function checkAgentDefault(config: { agentCommandTemplate: string }): void {
  if (!config.agentCommandTemplate.includes("dummy-agent")) return;

  try {
    execSync("which goose", { stdio: "pipe" });
    logWarn("Using dummy agent but goose is on PATH. Set AGENT_COMMAND_TEMPLATE to use the real agent.");
  } catch {
    logWarn("No AGENT_COMMAND_TEMPLATE set and goose not found on PATH. Using dummy agent — runs will not produce real code changes.");
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
      logError("SANDBOX_HOST_WORK_PATH is required when SANDBOX_ENABLED=true");
      process.exit(1);
    }
    containerManager = new ContainerManager();
    const dockerOk = await containerManager.ping();
    if (!dockerOk) {
      logError("Docker daemon not reachable. SANDBOX_ENABLED=true requires Docker socket at /var/run/docker.sock");
      process.exit(1);
    }
    const orphans = await containerManager.cleanupOrphans();
    if (orphans > 0) {
      logInfo("Cleaned up orphaned sandbox containers", { count: orphans });
    }
    setSandboxManager(containerManager, config.workRoot);
    logInfo("Sandbox mode enabled", { image: config.sandboxImage, hostWorkPath: config.sandboxHostWorkPath });
  }

  const pipelineEngine = new PipelineEngine(config, githubService, hooks, containerManager);
  logInfo("Pipeline engine ready", { pipelineFile: config.pipelineFile });

  // Slack Web API client is created internally by Bolt, but RunManager needs a client.
  // We instantiate a temporary manager with a lightweight client via dynamic import below.
  const { WebClient } = await import("@slack/web-api");
  const webClient = new WebClient(config.slackBotToken);

  const runManager = new RunManager(config, store, pipelineEngine, webClient, hooks);
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
    startDashboardServer(config, store, runManager, globalRefs.observer);
  }

  await startSlackApp(config, runManager, globalRefs.observer);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  logError("Gooseherd failed to start", { error: message });
  process.exit(1);
});

async function shutdown(signal: string): Promise<void> {
  logInfo(`Shutting down (${signal})`);
  // Flush observer state before exit
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
const globalRefs: { observer?: ObserverDaemon; rulesWatcher?: FSWatcher } = {};

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
