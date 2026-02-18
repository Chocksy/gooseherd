import dotenv from "dotenv";
dotenv.config({ override: true });
import { loadConfig } from "./config.js";
import { RunStore } from "./store.js";
import { GitHubService } from "./github.js";
import { RunExecutor } from "./executor.js";
import { CemsProvider } from "./memory/cems-provider.js";
import { RunLifecycleHooks } from "./hooks/run-lifecycle.js";
import { RunManager } from "./run-manager.js";
import { startSlackApp } from "./slack-app.js";
import { startDashboardServer } from "./dashboard-server.js";
import { logError, logInfo } from "./logger.js";

async function main(): Promise<void> {
  const config = loadConfig();

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
    ? new CemsProvider({ apiUrl: config.cemsApiUrl, apiKey: config.cemsApiKey })
    : undefined;
  const hooks = new RunLifecycleHooks(memoryProvider);
  if (memoryProvider) {
    logInfo("Memory integration enabled", { provider: memoryProvider.name, url: config.cemsApiUrl });
  }
  const executor = new RunExecutor(config, githubService, hooks);

  // Slack Web API client is created internally by Bolt, but RunManager needs a client.
  // We instantiate a temporary manager with a lightweight client via dynamic import below.
  const { WebClient } = await import("@slack/web-api");
  const webClient = new WebClient(config.slackBotToken);

  const runManager = new RunManager(config, store, executor, webClient, hooks);
  if (recoveredRuns.length > 0) {
    for (const run of recoveredRuns) {
      runManager.requeueExistingRun(run.id);
    }
    logInfo("Auto-requeued recovered runs", { count: recoveredRuns.length });
  }

  if (config.dashboardEnabled) {
    startDashboardServer(config, store, runManager);
  }

  await startSlackApp(config, runManager);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  logError("Gooseherd failed to start", { error: message });
  process.exit(1);
});

process.on("SIGINT", () => {
  logInfo("Shutting down (SIGINT)");
  process.exit(0);
});

process.on("SIGTERM", () => {
  logInfo("Shutting down (SIGTERM)");
  process.exit(0);
});
