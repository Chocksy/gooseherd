import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExecutionResult, RunRecord } from "../types.js";
import type { RunExecutionBackend, RunExecutionContext } from "./backend.js";
import type { ControlPlaneStore } from "./control-plane-store.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { RunCompletionRecord } from "./control-plane-types.js";
import type { AppConfig } from "../config.js";
import type { RunStore } from "../store.js";
import {
  buildRunJobSpec,
  buildRunTokenSecretManifest,
  defaultJobName,
  defaultSecretName,
} from "./kubernetes/job-spec.js";
import { KubernetesResourceClient } from "./kubernetes/resource-client.js";
import type { TerminalFact } from "./terminal-fact.js";
import { sleep } from "../utils/sleep.js";
import { normalizeBaseUrl } from "./url.js";
import { redactSecretToken, renderManifestYaml } from "./kubernetes/manifest-yaml.js";
import { readKubernetesTerminalFact } from "./kubernetes/runtime-facts.js";
import { buildRunnerConfigPayload } from "./runner-config-payload.js";

interface KubernetesExecutionBackendDeps {
  controlPlaneStore: Pick<ControlPlaneStore, "createRunEnvelope" | "issueRunToken" | "getLatestCompletion" | "revokeRunToken">;
  artifactStore: Pick<ArtifactStore, "allocateTargets">;
  runStore: Pick<RunStore, "getRun">;
  workRoot: string;
  runnerImage: string;
  internalBaseUrl: string;
  dryRun: boolean;
  runnerEnvSecretName?: string;
  runnerEnvConfigMapName?: string;
  namespace?: string;
  runnerConfigSource?: Pick<AppConfig, "agentCommandTemplate" | "agentFollowUpTemplate" | "activeAgentProfile">;
  resourceClient?: Pick<KubernetesResourceClient, "applySecret" | "applyJob" | "readJob" | "listPodsForJob" | "readJobLogs" | "deleteJob" | "deletePodsForJob" | "deleteSecret">;
  pollIntervalMs?: number;
  waitTimeoutMs?: number;
}

export class KubernetesExecutionBackend implements RunExecutionBackend<"kubernetes"> {
  readonly runtime = "kubernetes" as const;
  private readonly namespace: string;
  private readonly pollIntervalMs: number;
  private readonly waitTimeoutMs: number;
  private resourceClientInstance: Pick<KubernetesResourceClient, "applySecret" | "applyJob" | "readJob" | "listPodsForJob" | "readJobLogs" | "deleteJob" | "deletePodsForJob" | "deleteSecret"> | undefined;

  constructor(private readonly deps: KubernetesExecutionBackendDeps) {
    this.namespace = deps.namespace ?? "default";
    this.pollIntervalMs = Math.max(250, deps.pollIntervalMs ?? 2_000);
    this.waitTimeoutMs = Math.max(5_000, deps.waitTimeoutMs ?? 10 * 60 * 1_000);
    this.resourceClientInstance = deps.resourceClient;
  }

  async execute(run: RunRecord & { runtime: "kubernetes" }, ctx: RunExecutionContext): Promise<ExecutionResult> {
    await ctx.onPhase("agent");
    await ctx.onDetail?.("Launching Kubernetes job.");

    const runDir = path.resolve(this.deps.workRoot, run.id);
    await mkdir(runDir, { recursive: true });
    const manifestPath = path.join(runDir, "kubernetes-job.yaml");
    const logsPath = path.join(runDir, "run.log");

    const persistedRun = await this.deps.runStore.getRun(run.id);
    const payload = persistedRun
      ? {
          ...persistedRun,
          ...run,
          prefetchContext: run.prefetchContext,
          autoReviewSourceSubstate: run.autoReviewSourceSubstate,
        }
      : run;
    await this.deps.controlPlaneStore.createRunEnvelope({
      runId: run.id,
      payloadRef: `payload/${run.id}`,
      payloadJson: {
        run: payload,
        prefetch: payload.prefetchContext,
        autoReviewSourceSubstate: payload.autoReviewSourceSubstate,
        ...(this.deps.runnerConfigSource ? { runnerConfig: buildRunnerConfigPayload(this.deps.runnerConfigSource) } : {}),
      },
      runtime: "kubernetes",
    });
    await this.deps.artifactStore.allocateTargets(run.id);

    const token = await this.deps.controlPlaneStore.issueRunToken(run.id, this.waitTimeoutMs * 2);
    const secretName = defaultSecretName(run.id);
    const jobName = defaultJobName(run.id);
    const secret = buildRunTokenSecretManifest({
      runId: run.id,
      namespace: this.namespace,
      secretName,
      runToken: token.token,
    });
    const job = buildRunJobSpec({
      runId: run.id,
      namespace: this.namespace,
      image: this.deps.runnerImage,
      secretName,
      internalBaseUrl: normalizeBaseUrl(this.deps.internalBaseUrl),
      pipelineFile: ctx.pipelineFile ?? "pipelines/pipeline.yml",
      dryRun: this.deps.dryRun,
      runnerEnvSecretName: this.deps.runnerEnvSecretName,
      runnerEnvConfigMapName: this.deps.runnerEnvConfigMapName,
      jobName,
    });
    await writeFile(manifestPath, renderManifestYaml(redactSecretToken(secret), job), "utf8");

    try {
      await this.resourceClient.applySecret(secret);
      await this.resourceClient.applyJob(job);
      const runtimeFact = await this.waitForTerminalFact(jobName, ctx.abortSignal, ctx.onDetail);
      await this.captureLogs(jobName, logsPath);
      const completion = await this.deps.controlPlaneStore.getLatestCompletion(run.id);
      return this.translateOutcome(run, completion, runtimeFact);
    } finally {
      await this.cleanup(run.id, jobName, secretName).catch(() => {});
    }
  }

  private get resourceClient(): Pick<KubernetesResourceClient, "applySecret" | "applyJob" | "readJob" | "listPodsForJob" | "readJobLogs" | "deleteJob" | "deletePodsForJob" | "deleteSecret"> {
    this.resourceClientInstance ??= KubernetesResourceClient.fromDefaultConfig();
    return this.resourceClientInstance;
  }

  private async waitForTerminalFact(
    jobName: string,
    abortSignal?: AbortSignal,
    onDetail?: (detail: string) => Promise<void>,
  ): Promise<TerminalFact> {
    const deadline = Date.now() + this.waitTimeoutMs;

    while (Date.now() < deadline) {
      if (abortSignal?.aborted) {
        throw new Error("Run cancelled");
      }

      const fact = await this.readRuntimeFact(jobName);
      if (fact !== "running") {
        return fact;
      }

      await onDetail?.(`Waiting for Kubernetes job ${jobName} to reach terminal state.`);
      await sleep(this.pollIntervalMs);
    }

    throw new Error(`Timed out waiting for Kubernetes job ${jobName}`);
  }

  private async readRuntimeFact(jobName: string): Promise<TerminalFact> {
    return readKubernetesTerminalFact(this.resourceClient, jobName, this.namespace);
  }

  private translateOutcome(
    run: RunRecord,
    completion: RunCompletionRecord | null,
    runtimeFact: TerminalFact,
  ): ExecutionResult {
    if (completion?.payload.status === "success" && runtimeFact === "succeeded") {
      return {
        branchName: run.branchName,
        logsPath: run.logsPath ?? path.resolve(this.deps.workRoot, run.id, "run.log"),
        commitSha: completion.payload.commitSha ?? "",
        changedFiles: completion.payload.changedFiles ?? [],
        internalArtifacts: completion.payload.internalArtifacts,
        prUrl: completion.payload.prUrl,
        tokenUsage: completion.payload.tokenUsage,
        title: completion.payload.title,
      };
    }

    if (completion?.payload.status === "failed") {
      throw new Error(completion.payload.reason ?? "Kubernetes runner reported failed completion");
    }

    if (runtimeFact === "failed") {
      throw new Error("completion missing after terminal runtime state");
    }

    if (runtimeFact === "missing") {
      throw new Error("Kubernetes job disappeared before completion");
    }

    throw new Error("Kubernetes runtime did not produce a terminal success result");
  }

  private async cleanup(runId: string, jobName: string, secretName: string): Promise<void> {
    await this.resourceClient.deleteJob(jobName, this.namespace);
    await this.resourceClient.deletePodsForJob(jobName, this.namespace);
    await this.resourceClient.deleteSecret(secretName, this.namespace);
    await this.deps.controlPlaneStore.revokeRunToken(runId);
  }

  private async captureLogs(jobName: string, logsPath: string): Promise<void> {
    try {
      const logs = await this.resourceClient.readJobLogs(jobName, this.namespace);
      await writeFile(logsPath, logs, "utf8");
    } catch {
      // Leave logsPath absent when the runner never reached a readable logging state.
    }
  }
}
