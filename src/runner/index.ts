import dotenv from "dotenv";
dotenv.config();

import type { RunEnvelope } from "../runtime/control-plane-types.js";
import type { RunRecord } from "../types.js";
import { loadConfig, type AppConfig } from "../config.js";
import { GitHubService } from "../github.js";
import { PipelineEngine } from "../pipeline/index.js";
import { CemsProvider } from "../memory/cems-provider.js";
import { RunLifecycleHooks } from "../hooks/run-lifecycle.js";
import { logError, logInfo } from "../logger.js";
import { RunnerControlPlaneClient } from "./control-plane-client.js";
import { runPipelineRunner, type RunnerEventEmitter } from "./pipeline-runner.js";
import { applyRunnerConfigPayload } from "../runtime/runner-config-payload.js";

function getRequiredEnv(name: "GOOSEHERD_INTERNAL_BASE_URL" | "RUN_ID" | "RUN_TOKEN"): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function buildRunnerClientFromEnv(): RunnerControlPlaneClient {
  const baseUrl = getRequiredEnv("GOOSEHERD_INTERNAL_BASE_URL");
  const runId = getRequiredEnv("RUN_ID");
  const token = getRequiredEnv("RUN_TOKEN");
  return new RunnerControlPlaneClient({ baseUrl, runId, token });
}

interface RunnerServices {
  config: AppConfig;
  pipelineEngine: PipelineEngine;
}

function buildRunnerServices(): RunnerServices {
  const config = loadConfig();
  const githubService = GitHubService.create(config);
  const memoryProvider = config.cemsEnabled && config.cemsApiUrl && config.cemsApiKey
    ? new CemsProvider({ apiUrl: config.cemsApiUrl, apiKey: config.cemsApiKey, teamId: config.cemsTeamId })
    : undefined;
  const hooks = new RunLifecycleHooks(memoryProvider);
  const pipelineEngine = new PipelineEngine(config, githubService, hooks);
  return { config, pipelineEngine };
}

async function executeSharedPipeline(
  services: RunnerServices,
  client: RunnerControlPlaneClient,
  run: RunRecord,
  payload: RunEnvelope,
  emit: RunnerEventEmitter,
  abortSignal: AbortSignal,
) {
  applyRunnerConfigPayload(services.config, payload);
  return services.pipelineEngine.execute(
    run,
    async (phase) => {
      await emit("run.phase_changed", { phase });
    },
    services.config.pipelineFile,
    typeof payload.payloadJson.pipelineId === "string" ? payload.payloadJson.pipelineId : undefined,
    async (detail) => {
      await emit("run.progress", { detail });
    },
    run.skipNodes,
    run.enableNodes,
    abortSignal,
    async (entry) => {
      await client.addTokenUsage(entry);
    },
    async (checkpoint) => {
      await emit("run.checkpoint", checkpoint);
    },
  );
}

export async function main(): Promise<void> {
  logInfo("Runner: main starting", {
    runId: process.env.RUN_ID ?? "unknown",
    pid: process.pid,
    nodeVersion: process.version,
    mirrorStdout: process.env.RUN_LOG_MIRROR_STDOUT ?? "unset",
    pipelineFile: process.env.PIPELINE_FILE ?? "unset",
    internalBaseUrl: process.env.GOOSEHERD_INTERNAL_BASE_URL ?? "unset",
  });
  const client = buildRunnerClientFromEnv();
  logInfo("Runner: control-plane client built", { runId: process.env.RUN_ID ?? "unknown" });
  const services = buildRunnerServices();
  logInfo("Runner: services built, entering runPipelineRunner", { runId: process.env.RUN_ID ?? "unknown" });
  await runPipelineRunner(client, (run, payload, emit, abortSignal) =>
    executeSharedPipeline(services, client, run, payload, emit, abortSignal),
  );
  logInfo("Runner completed", { runId: process.env.RUN_ID ?? "unknown" });
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    logError("Runner failed", { error: message });
    process.exit(1);
  });
