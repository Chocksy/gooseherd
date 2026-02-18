import dotenv from "dotenv";
dotenv.config({ override: true });
import { loadConfig } from "./config.js";
import { RunStore } from "./store.js";
import { RunExecutor } from "./executor.js";
import { GitHubService } from "./github.js";
import { logError, logInfo } from "./logger.js";
import { CemsProvider } from "./memory/cems-provider.js";
import { RunLifecycleHooks } from "./hooks/run-lifecycle.js";

function parseArgs(args: string[]): { repoSlug: string; baseBranch?: string; task: string } {
  if (args.length < 2) {
    throw new Error(
      "Usage: npm run local:trigger -- <owner/repo[@base-branch]> \"task text\""
    );
  }

  const target = args[0] as string;
  const task = args.slice(1).join(" ").trim();
  if (!task) {
    throw new Error("Task is required.");
  }

  const [repoSlug, baseBranch] = target.split("@");
  if (!repoSlug || !repoSlug.includes("/")) {
    throw new Error("Repo must be in owner/repo format.");
  }

  return {
    repoSlug,
    baseBranch: baseBranch?.trim() || undefined,
    task
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { repoSlug, baseBranch, task } = parseArgs(process.argv.slice(2));

  const store = new RunStore(config.dataDir);
  await store.init();

  const run = await store.createRun(
    {
      repoSlug,
      task,
      baseBranch: baseBranch ?? config.defaultBaseBranch,
      requestedBy: "local-trigger",
      channelId: "local",
      threadTs: "local"
    },
    config.branchPrefix
  );

  const githubService = config.githubToken ? new GitHubService(config.githubToken) : undefined;
  const memoryProvider = config.cemsEnabled && config.cemsApiUrl && config.cemsApiKey
    ? new CemsProvider({ apiUrl: config.cemsApiUrl, apiKey: config.cemsApiKey })
    : undefined;
  const hooks = new RunLifecycleHooks(memoryProvider);
  const executor = new RunExecutor(config, githubService, hooks);

  await store.updateRun(run.id, {
    status: "running",
    phase: "cloning",
    startedAt: new Date().toISOString()
  });

  logInfo("Starting local trigger run", {
    runId: run.id,
    repoSlug: run.repoSlug,
    baseBranch: run.baseBranch,
    dryRun: config.dryRun
  });

  try {
    const result = await executor.execute(run, async (phase) => {
      const status = phase === "validating" ? "validating" : phase === "pushing" ? "pushing" : "running";
      await store.updateRun(run.id, { status, phase });
    });

    await store.updateRun(run.id, {
      status: "completed",
      phase: "completed",
      finishedAt: new Date().toISOString(),
      logsPath: result.logsPath,
      commitSha: result.commitSha,
      changedFiles: result.changedFiles,
      prUrl: result.prUrl
    });

    logInfo("Local trigger completed", {
      runId: run.id,
      logsPath: result.logsPath,
      commitSha: result.commitSha,
      changedFiles: result.changedFiles.length,
      prUrl: result.prUrl ?? null
    });
    process.stdout.write(`${run.id}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await store.updateRun(run.id, {
      status: "failed",
      phase: "failed",
      finishedAt: new Date().toISOString(),
      error: message
    });
    logError("Local trigger failed", { runId: run.id, error: message });
    process.exit(1);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  logError("Failed to start local trigger", { error: message });
  process.exit(1);
});
