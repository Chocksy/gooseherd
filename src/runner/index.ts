import dotenv from "dotenv";
dotenv.config({ override: true });

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
  run: RunRecord,
  _payload: RunEnvelope,
  emit: RunnerEventEmitter,
) {
  return services.pipelineEngine.execute(
    run,
    async (phase) => {
      await emit("run.phase_changed", { phase });
    },
    services.config.pipelineFile,
    async (detail) => {
      await emit("run.progress", { detail });
    },
    run.skipNodes,
    run.enableNodes,
  );
}

export async function main(): Promise<void> {
  const client = buildRunnerClientFromEnv();
  const services = buildRunnerServices();
  await runPipelineRunner(client, (run, payload, emit) => executeSharedPipeline(services, run, payload, emit));
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
