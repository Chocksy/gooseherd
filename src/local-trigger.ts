import dotenv from "dotenv";
dotenv.config({ override: true });
import { loadConfig } from "./config.js";
import { initDatabase } from "./db/index.js";
import { RunStore, mapPhaseToRunStatus } from "./store.js";
import { GitHubService } from "./github.js";
import { PipelineEngine } from "./pipeline/index.js";
import { logError, logInfo, logWarn } from "./logger.js";
import { CemsProvider } from "./memory/cems-provider.js";
import { RunLifecycleHooks } from "./hooks/run-lifecycle.js";
import { ContainerManager } from "./sandbox/container-manager.js";
import { setSandboxManager } from "./pipeline/shell.js";
import { preflightSandboxRuntime } from "./runtime/runtime-mode.js";
import { DockerExecutionBackend } from "./runtime/docker-backend.js";
import { LocalExecutionBackend } from "./runtime/local-backend.js";
import { getRuntimeBackend, type RuntimeRegistry } from "./runtime/backend.js";
import { ControlPlaneStore } from "./runtime/control-plane-store.js";
import { FileArtifactStore } from "./runtime/file-artifact-store.js";
import {
  resolveKubernetesInternalBaseUrl,
  resolveKubernetesNamespace,
  resolveKubernetesRunnerEnvConfigMapName,
  resolveKubernetesRunnerEnvSecretName,
  resolveKubernetesRunnerImage,
} from "./runtime/kubernetes-env.js";

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
    await containerManager.cleanupOrphans();
    setSandboxManager(containerManager, config.workRoot);
    logInfo("Sandbox mode enabled", { image: config.sandboxImage });
  }

  const db = await initDatabase(config.databaseUrl);
  const store = new RunStore(db);
  await store.init();

  const run = await store.createRun(
    {
      repoSlug,
      task,
      baseBranch: baseBranch ?? config.defaultBaseBranch,
      requestedBy: "local-trigger",
      channelId: "local",
      threadTs: "local",
      runtime: config.sandboxRuntime
    },
    config.branchPrefix
  );

  const githubService = GitHubService.create(config);
  const memoryProvider = config.cemsEnabled && config.cemsApiUrl && config.cemsApiKey
    ? new CemsProvider({ apiUrl: config.cemsApiUrl, apiKey: config.cemsApiKey })
    : undefined;
  const hooks = new RunLifecycleHooks(memoryProvider);

  const pipelineEngine = new PipelineEngine(config, githubService, hooks, containerManager);
  const controlPlaneStore = new ControlPlaneStore(db);
  const artifactStore = new FileArtifactStore(
    config.workRoot,
    config.dashboardPublicUrl ?? `http://${config.dashboardHost}:${String(config.dashboardPort)}`,
    controlPlaneStore,
  );
  const kubernetesBackend = config.sandboxRuntime === "kubernetes"
    ? new (await import("./runtime/kubernetes-backend.js")).KubernetesExecutionBackend({
        controlPlaneStore,
        artifactStore,
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

  await store.updateRun(run.id, {
    status: "running",
    phase: "cloning",
    startedAt: new Date().toISOString()
  });

  logInfo("Starting local trigger run", {
    runId: run.id,
    repoSlug: run.repoSlug,
    baseBranch: run.baseBranch,
    dryRun: config.dryRun,
    pipeline: config.pipelineFile
  });

  try {
    const backend = getRuntimeBackend(runtimeRegistry, run.runtime);
    const result = await backend.execute(run, {
      onPhase: async (phase) => {
        const status = mapPhaseToRunStatus(phase);
        await store.updateRun(run.id, { status, phase });
      },
      pipelineFile: config.pipelineFile
    });

    await store.updateRun(run.id, {
      status: "completed",
      phase: "completed",
      finishedAt: new Date().toISOString(),
      logsPath: result.logsPath,
      commitSha: result.commitSha,
      changedFiles: result.changedFiles,
      prUrl: result.prUrl,
      prNumber: result.prNumber,
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
