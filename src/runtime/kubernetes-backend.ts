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
import { isRecord } from "../utils/type-guards.js";
import { isRunCheckpointType, normalizeRunCheckpointEmittedAt } from "../runs/run-checkpoints.js";

interface KubernetesExecutionBackendDeps {
  controlPlaneStore: Pick<ControlPlaneStore, "createRunEnvelope" | "issueRunToken" | "getLatestCompletion" | "revokeRunToken" | "listEventsAfterSequence">;
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
  completionWaitMs?: number;
}

export class KubernetesExecutionBackend implements RunExecutionBackend<"kubernetes"> {
  readonly runtime = "kubernetes" as const;
  private readonly namespace: string;
  private readonly pollIntervalMs: number;
  private readonly waitTimeoutMs: number;
  private readonly completionWaitMs: number;
  private resourceClientInstance: Pick<KubernetesResourceClient, "applySecret" | "applyJob" | "readJob" | "listPodsForJob" | "readJobLogs" | "deleteJob" | "deletePodsForJob" | "deleteSecret"> | undefined;

  constructor(private readonly deps: KubernetesExecutionBackendDeps) {
    this.namespace = deps.namespace ?? "default";
    this.pollIntervalMs = Math.max(250, deps.pollIntervalMs ?? 2_000);
    this.waitTimeoutMs = Math.max(5_000, deps.waitTimeoutMs ?? 10 * 60 * 1_000);
    this.completionWaitMs = Math.max(this.pollIntervalMs, deps.completionWaitMs ?? 30_000);
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
        intent: payload.intent,
        intentKind: payload.intentKind,
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
    let lastDrainedEventSequence = 0;

    try {
      await this.resourceClient.applySecret(secret);
      await this.resourceClient.applyJob(job);
      lastDrainedEventSequence = await this.drainRunnerEvents(run.id, ctx, lastDrainedEventSequence);
      const runtimeFact = await this.waitForTerminalFact(run.id, jobName, ctx, lastDrainedEventSequence);
      lastDrainedEventSequence = runtimeFact.lastDrainedEventSequence;
      lastDrainedEventSequence = await this.drainRunnerEvents(run.id, ctx, lastDrainedEventSequence);
      const completion = await this.waitForCompletion(run.id, runtimeFact.fact, ctx, lastDrainedEventSequence);
      lastDrainedEventSequence = completion.lastDrainedEventSequence;
      await this.drainRunnerEvents(run.id, ctx, lastDrainedEventSequence);
      const runtimeLogs = await this.captureLogs(jobName, logsPath);
      return this.translateOutcome(run, completion.completion, runtimeFact.fact, runtimeLogs);
    } finally {
      await this.cleanup(run.id, jobName, secretName).catch(() => {});
    }
  }

  private get resourceClient(): Pick<KubernetesResourceClient, "applySecret" | "applyJob" | "readJob" | "listPodsForJob" | "readJobLogs" | "deleteJob" | "deletePodsForJob" | "deleteSecret"> {
    this.resourceClientInstance ??= KubernetesResourceClient.fromDefaultConfig();
    return this.resourceClientInstance;
  }

  private async waitForTerminalFact(
    runId: string,
    jobName: string,
    ctx: RunExecutionContext,
    lastDrainedEventSequence: number,
  ): Promise<{ fact: TerminalFact; lastDrainedEventSequence: number }> {
    const deadline = Date.now() + this.waitTimeoutMs;

    while (Date.now() < deadline) {
      if (ctx.abortSignal?.aborted) {
        throw new Error("Run cancelled");
      }

      lastDrainedEventSequence = await this.drainRunnerEvents(runId, ctx, lastDrainedEventSequence);
      const fact = await this.readRuntimeFact(jobName);
      if (fact !== "running") {
        return { fact, lastDrainedEventSequence };
      }

      await ctx.onDetail?.(`Waiting for Kubernetes job ${jobName} to reach terminal state.`);
      await sleep(this.pollIntervalMs);
    }

    throw new Error(`Timed out waiting for Kubernetes job ${jobName}`);
  }

  private async readRuntimeFact(jobName: string): Promise<TerminalFact> {
    return readKubernetesTerminalFact(this.resourceClient, jobName, this.namespace);
  }

  private async waitForCompletion(
    runId: string,
    runtimeFact: TerminalFact,
    ctx: RunExecutionContext,
    lastDrainedEventSequence: number,
  ): Promise<{ completion: RunCompletionRecord | null; lastDrainedEventSequence: number }> {
    lastDrainedEventSequence = await this.drainRunnerEvents(runId, ctx, lastDrainedEventSequence);
    const initialCompletion = await this.deps.controlPlaneStore.getLatestCompletion(runId);
    if (initialCompletion || runtimeFact === "running") {
      return { completion: initialCompletion, lastDrainedEventSequence };
    }

    const deadline = Date.now() + this.completionWaitMs;
    while (Date.now() < deadline) {
      if (ctx.abortSignal?.aborted) {
        throw new Error("Run cancelled");
      }

      await ctx.onDetail?.(`Waiting for Kubernetes completion callback for run ${runId}.`);
      await sleep(this.pollIntervalMs);
      lastDrainedEventSequence = await this.drainRunnerEvents(runId, ctx, lastDrainedEventSequence);

      const completion = await this.deps.controlPlaneStore.getLatestCompletion(runId);
      if (completion) {
        return { completion, lastDrainedEventSequence };
      }
    }

    return { completion: null, lastDrainedEventSequence };
  }

  private async drainRunnerEvents(runId: string, ctx: RunExecutionContext, afterSequence: number): Promise<number> {
    let lastDrainedEventSequence = afterSequence;
    const events = await this.deps.controlPlaneStore.listEventsAfterSequence(runId, afterSequence);
    for (const event of events) {
      lastDrainedEventSequence = Math.max(lastDrainedEventSequence, event.sequence);
      if (event.eventType === "run.phase_changed") {
        const phase = event.payload.phase;
        if (typeof phase === "string") {
          await ctx.onPhase(phase as Parameters<RunExecutionContext["onPhase"]>[0]);
        }
      } else if (event.eventType === "run.checkpoint") {
        const { checkpointKey, checkpointType, payload, emittedAt } = event.payload;
        const checkpointEmittedAt = normalizeRunCheckpointEmittedAt(emittedAt, event.timestamp);
        if (typeof checkpointKey === "string" && typeof checkpointType === "string" && isRunCheckpointType(checkpointType)) {
          await ctx.onCheckpoint?.({
            checkpointKey,
            checkpointType,
            payload: isRecord(payload) ? payload : undefined,
            emittedAt: checkpointEmittedAt,
          });
        }
      } else if (event.eventType === "run.progress") {
        const detail = event.payload.detail;
        if (typeof detail === "string") {
          await ctx.onDetail?.(detail);
        }
      }
    }
    return lastDrainedEventSequence;
  }

  private translateOutcome(
    run: RunRecord,
    completion: RunCompletionRecord | null,
    runtimeFact: TerminalFact,
    runtimeLogs?: string,
  ): ExecutionResult {
    if (completion?.payload.status === "success" && runtimeFact === "failed") {
      throw new Error("success completion contradicted by runtime state");
    }

    if (completion?.payload.status === "success" && (runtimeFact === "succeeded" || runtimeFact === "missing")) {
      return {
        branchName: run.branchName,
        logsPath: run.logsPath ?? path.resolve(this.deps.workRoot, run.id, "run.log"),
        commitSha: completion.payload.commitSha ?? "",
        changedFiles: completion.payload.changedFiles ?? [],
        internalArtifacts: completion.payload.internalArtifacts,
        prUrl: completion.payload.prUrl,
        prNumber: completion.payload.prNumber,
        tokenUsage: completion.payload.tokenUsage,
        title: completion.payload.title,
      };
    }

    if (completion?.payload.status === "failed") {
      throw new Error(completion.payload.reason ?? "Kubernetes runner reported failed completion");
    }

    if (runtimeFact === "succeeded" || runtimeFact === "failed") {
      throw new Error(this.buildMissingCompletionMessage(runtimeLogs));
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

  private async captureLogs(jobName: string, logsPath: string): Promise<string | undefined> {
    try {
      const logs = await this.resourceClient.readJobLogs(jobName, this.namespace);
      await writeFile(logsPath, logs, "utf8");
      return logs;
    } catch {
      // Leave logsPath absent when the runner never reached a readable logging state.
      return undefined;
    }
  }

  private buildMissingCompletionMessage(runtimeLogs?: string): string {
    const diagnostic = this.extractLogDiagnostic(runtimeLogs);
    return diagnostic
      ? `completion missing after terminal runtime state: ${diagnostic}`
      : "completion missing after terminal runtime state";
  }

  private extractLogDiagnostic(runtimeLogs?: string): string | undefined {
    if (!runtimeLogs) {
      return undefined;
    }

    const lines = runtimeLogs
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "");

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line) continue;

      const singleQuotedMatch = /Runner failed\s*\{\s*error:\s*'([^']+)'\s*\}/.exec(line);
      if (singleQuotedMatch?.[1]) {
        return singleQuotedMatch[1];
      }

      const doubleQuotedMatch = /Runner failed\s*\{\s*error:\s*"([^"]+)"\s*\}/.exec(line);
      if (doubleQuotedMatch?.[1]) {
        return doubleQuotedMatch[1];
      }

      if (/error|failed|retry budget exhausted/i.test(line)) {
        return line.replace(/^\[ERROR\]\s*/, "").slice(0, 200);
      }
    }

    return undefined;
  }
}
