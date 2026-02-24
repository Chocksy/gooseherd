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
import { logError, logInfo, logWarn } from "./logger.js";

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

  const githubService = config.githubToken ? new GitHubService(config.githubToken) : undefined;
  const memoryProvider = config.cemsEnabled && config.cemsApiUrl && config.cemsApiKey
    ? new CemsProvider({ apiUrl: config.cemsApiUrl, apiKey: config.cemsApiKey, teamId: config.cemsTeamId })
    : undefined;
  const hooks = new RunLifecycleHooks(memoryProvider);
  if (memoryProvider) {
    logInfo("Memory integration enabled", { provider: memoryProvider.name, url: config.cemsApiUrl });
  }
  const pipelineEngine = new PipelineEngine(config, githubService, hooks);
  logInfo("Pipeline engine ready", { pipelineFile: config.pipelineFile });

  // Slack Web API client is created internally by Bolt, but RunManager needs a client.
  // We instantiate a temporary manager with a lightweight client via dynamic import below.
  const { WebClient } = await import("@slack/web-api");
  const webClient = new WebClient(config.slackBotToken);

  const runManager = new RunManager(config, store, pipelineEngine, webClient, hooks);
  if (recoveredRuns.length > 0) {
    for (const run of recoveredRuns) {
      runManager.requeueExistingRun(run.id);
    }
    logInfo("Auto-requeued recovered runs", { count: recoveredRuns.length });
  }

  if (config.dashboardEnabled) {
    startDashboardServer(config, store, runManager);
  }

  const cleaner = new WorkspaceCleaner(config, store);
  cleaner.start();

  if (config.observerEnabled) {
    const observer = new ObserverDaemon(config, runManager, webClient);
    await observer.start();
    globalRefs.observer = observer;
    logInfo("Observer system enabled");
  }

  await startSlackApp(config, runManager);
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

// Global refs for shutdown access
const globalRefs: { observer?: ObserverDaemon } = {};

process.on("SIGINT", () => { shutdown("SIGINT"); });
process.on("SIGTERM", () => { shutdown("SIGTERM"); });
