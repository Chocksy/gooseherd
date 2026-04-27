import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { KubernetesExecutionBackend } from "../src/runtime/kubernetes-backend.js";
import type { RunCompletionRecord } from "../src/runtime/control-plane-types.js";
import type { RunRecord } from "../src/types.js";
import { KubernetesResourceClient, type KubernetesResourceClient as KubernetesResourceClientType } from "../src/runtime/kubernetes/resource-client.js";

function makeRun(overrides?: Partial<RunRecord>): RunRecord {
  return {
    id: "run-k8s-backend-1",
    repoSlug: "org/repo",
    task: "verify kubernetes backend",
    baseBranch: "main",
    branchName: "gooseherd/run-k8s-backend-1",
    requestedBy: "U123",
    channelId: "local",
    threadTs: "local",
    status: "running",
    runtime: "kubernetes",
    createdAt: new Date("2026-04-10T00:00:00.000Z").toISOString(),
    ...overrides,
  };
}

function makeCompletion(overrides?: Partial<RunCompletionRecord["payload"]>): RunCompletionRecord {
  return {
    id: 1,
    runId: "run-k8s-backend-1",
    idempotencyKey: "completion-1",
    createdAt: new Date("2026-04-10T00:00:01.000Z").toISOString(),
    payload: {
      idempotencyKey: "completion-1",
      status: "success",
      artifactState: "complete",
      commitSha: "abc12345",
      changedFiles: ["src/index.ts"],
      ...overrides,
    },
  };
}

test("kubernetes backend launches job, waits for success, redacts manifest token, and cleans up resources", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "gooseherd-k8s-backend-"));
  const resourceCalls: string[] = [];
  let jobReads = 0;
  let revokedRunId: string | undefined;
  let createdEnvelope: { payloadJson: Record<string, unknown> } | undefined;
  const prefetchContext: NonNullable<RunRecord["prefetchContext"]> = {
    meta: {
      fetchedAt: "2026-04-17T00:00:00.000Z",
      sources: ["github_pr"],
    },
    workItem: {
      id: "work-item-1",
      title: "Work item",
      workflow: "feature_delivery",
      githubPrUrl: "https://github.com/org/repo/pull/42",
      githubPrNumber: 42,
    },
    github: {
      pr: {
        number: 42,
        url: "https://github.com/org/repo/pull/42",
        title: "Prefetched PR",
        body: "body",
        state: "open",
      },
      discussionComments: [],
      reviews: [],
      reviewComments: [],
      ci: {
        headSha: "abc123",
        conclusion: "success",
      },
    },
  };

  const resourceClient: Pick<KubernetesResourceClientType, "applySecret" | "applyJob" | "readJob" | "listPodsForJob" | "readJobLogs" | "deleteJob" | "deletePodsForJob" | "deleteSecret"> = {
    applySecret: async () => {
      resourceCalls.push("applySecret");
    },
    applyJob: async () => {
      resourceCalls.push("applyJob");
    },
    readJob: async () => {
      resourceCalls.push("readJob");
      jobReads += 1;
      return jobReads === 1 ? { status: {} } : { status: { conditions: [{ type: "Complete", status: "True" }] } };
    },
    listPodsForJob: async () => {
      resourceCalls.push("listPodsForJob");
      return [];
    },
    readJobLogs: async () => {
      resourceCalls.push("readJobLogs");
      return "runner completed\n";
    },
    deleteJob: async () => {
      resourceCalls.push("deleteJob");
    },
    deletePodsForJob: async () => {
      resourceCalls.push("deletePodsForJob");
    },
    deleteSecret: async () => {
      resourceCalls.push("deleteSecret");
    },
  };

  const backend = new KubernetesExecutionBackend({
    controlPlaneStore: {
      createRunEnvelope: async (input) => {
        createdEnvelope = input;
        return undefined;
      },
      issueRunToken: async () => ({ token: "issued-token" }),
      getLatestCompletion: async () => makeCompletion({ prNumber: 42 } as never),
      revokeRunToken: async (runId: string) => {
        revokedRunId = runId;
      },
      listEventsAfterSequence: async () => [],
    },
    artifactStore: {
      allocateTargets: async () => ({
        targets: {
          "run.log": {
            class: "log",
            path: "run.log",
            uploadUrl: "https://artifacts.example.test/run.log",
          },
        },
      }),
    },
    runStore: {
      getRun: async () => undefined,
    },
    workRoot: tmpRoot,
    runnerImage: "gooseherd/k8s-runner:dev",
    internalBaseUrl: "http://host.minikube.internal:8787/",
    dryRun: false,
    runnerEnvSecretName: "gooseherd-env",
    runnerEnvConfigMapName: "gooseherd-config",
    namespace: "default",
    runnerConfigSource: {
      agentCommandTemplate: "profile command",
      agentFollowUpTemplate: "profile follow-up",
      activeAgentProfile: {
        id: "profile-1",
        name: "Codex",
        runtime: "codex",
        provider: "openai",
        model: "gpt-5.4",
        commandTemplate: "profile command",
        source: "profile",
      },
    } as never,
    resourceClient,
    pollIntervalMs: 1,
    waitTimeoutMs: 5_000,
    completionWaitMs: 600,
  });

  try {
    const result = await backend.execute(makeRun({
      prefetchContext,
      autoReviewSourceSubstate: "pr_adopted",
      intent: {
        version: 1,
        kind: "feature_delivery.self_review",
        source: "work_item",
        workItemId: "11111111-1111-1111-1111-111111111111",
        repo: "org/repo",
        prNumber: 42,
        prUrl: "https://github.com/org/repo/pull/42",
        sourceSubstate: "pr_adopted",
      },
      intentKind: "feature_delivery.self_review",
    }), {
      onPhase: async () => undefined,
      pipelineFile: "pipelines/kubernetes-smoke.yml",
    });

    assert.equal(result.commitSha, "abc12345");
    assert.deepEqual(result.changedFiles, ["src/index.ts"]);
    assert.equal((result as { prNumber?: number }).prNumber, 42);
    assert.equal(result.logsPath, path.resolve(tmpRoot, "run-k8s-backend-1", "run.log"));
    assert.equal(await readFile(result.logsPath, "utf8"), "runner completed\n");

    const manifestPath = path.resolve(tmpRoot, "run-k8s-backend-1", "kubernetes-job.yaml");
    const manifest = await readFile(manifestPath, "utf8");
    assert.match(manifest, /host\.minikube\.internal:8787/);
    assert.match(manifest, /pipelines\/kubernetes-smoke\.yml/);
    assert.match(manifest, /gooseherd-env/);
    assert.match(manifest, /gooseherd-config/);
    assert.match(manifest, /name: DRY_RUN[\s\S]*value: "false"/);
    assert.doesNotMatch(manifest, /issued-token/);
    assert.match(manifest, /REDACTED/);
    assert.equal(revokedRunId, "run-k8s-backend-1");
    assert.deepEqual(createdEnvelope?.payloadJson.prefetch, prefetchContext);
    assert.equal(createdEnvelope?.payloadJson.autoReviewSourceSubstate, "pr_adopted");
    assert.equal((createdEnvelope?.payloadJson.intent as { kind?: string } | undefined)?.kind, "feature_delivery.self_review");
    assert.equal(createdEnvelope?.payloadJson.intentKind, "feature_delivery.self_review");
    assert.deepEqual(createdEnvelope?.payloadJson.runnerConfig, {
      agentCommandTemplate: "profile command",
      agentFollowUpTemplate: "profile follow-up",
      activeAgentProfile: {
        id: "profile-1",
        name: "Codex",
        runtime: "codex",
        provider: "openai",
        model: "gpt-5.4",
        commandTemplate: "profile command",
        source: "profile",
      },
    });

    assert.deepEqual(resourceCalls, [
      "applySecret",
      "applyJob",
      "readJob",
      "listPodsForJob",
      "readJob",
      "readJobLogs",
      "deleteJob",
      "deletePodsForJob",
      "deleteSecret",
    ]);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("kubernetes backend fails when runtime becomes terminal without completion", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "gooseherd-k8s-backend-fail-"));

  let completionReads = 0;
  const resourceClient: Pick<KubernetesResourceClientType, "applySecret" | "applyJob" | "readJob" | "listPodsForJob" | "readJobLogs" | "deleteJob" | "deletePodsForJob" | "deleteSecret"> = {
    applySecret: async () => undefined,
    applyJob: async () => undefined,
    readJob: async () => ({ status: { conditions: [{ type: "Failed", status: "True" }] } }),
    listPodsForJob: async () => [],
    readJobLogs: async () => "[ERROR] Runner failed { error: 'retry budget exhausted for payload: fetch failed' }\n",
    deleteJob: async () => undefined,
    deletePodsForJob: async () => undefined,
    deleteSecret: async () => undefined,
  };

  const backend = new KubernetesExecutionBackend({
    controlPlaneStore: {
      createRunEnvelope: async () => undefined,
      issueRunToken: async () => ({ token: "issued-token" }),
      getLatestCompletion: async () => {
        completionReads += 1;
        return null;
      },
      revokeRunToken: async () => undefined,
      listEventsAfterSequence: async () => [],
    },
    artifactStore: {
      allocateTargets: async () => ({ targets: {} }),
    },
    runStore: {
      getRun: async () => undefined,
    },
    workRoot: tmpRoot,
    runnerImage: "gooseherd/k8s-runner:dev",
    internalBaseUrl: "http://host.minikube.internal:8787",
    dryRun: false,
    resourceClient,
    pollIntervalMs: 1,
    waitTimeoutMs: 5_000,
    completionWaitMs: 600,
  });

  try {
    await assert.rejects(
      () =>
        backend.execute(makeRun({ id: "run-k8s-backend-2" }), {
          onPhase: async () => undefined,
          pipelineFile: "pipelines/kubernetes-smoke.yml",
        }),
      /completion missing after terminal runtime state: retry budget exhausted for payload: fetch failed/,
    );
    assert.equal(completionReads > 1, true);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("kubernetes backend waits for a late success completion after terminal runtime state", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "gooseherd-k8s-backend-late-completion-"));

  let completionReads = 0;
  let revokedRunId: string | undefined;
  const resourceClient: Pick<KubernetesResourceClientType, "applySecret" | "applyJob" | "readJob" | "listPodsForJob" | "readJobLogs" | "deleteJob" | "deletePodsForJob" | "deleteSecret"> = {
    applySecret: async () => undefined,
    applyJob: async () => undefined,
    readJob: async () => ({ status: { conditions: [{ type: "Complete", status: "True" }] } }),
    listPodsForJob: async () => [],
    readJobLogs: async () => "runner completed\n",
    deleteJob: async () => undefined,
    deletePodsForJob: async () => undefined,
    deleteSecret: async () => undefined,
  };

  const backend = new KubernetesExecutionBackend({
    controlPlaneStore: {
      createRunEnvelope: async () => undefined,
      issueRunToken: async () => ({ token: "issued-token" }),
      getLatestCompletion: async () => {
        completionReads += 1;
        return completionReads >= 3 ? makeCompletion() : null;
      },
      revokeRunToken: async (runId: string) => {
        revokedRunId = runId;
      },
      listEventsAfterSequence: async () => [],
    },
    artifactStore: {
      allocateTargets: async () => ({ targets: {} }),
    },
    runStore: {
      getRun: async () => undefined,
    },
    workRoot: tmpRoot,
    runnerImage: "gooseherd/k8s-runner:dev",
    internalBaseUrl: "http://host.minikube.internal:8787",
    dryRun: false,
    resourceClient,
    pollIntervalMs: 1,
    waitTimeoutMs: 5_000,
  });

  try {
    const result = await backend.execute(makeRun({ id: "run-k8s-backend-3" }), {
      onPhase: async () => undefined,
      pipelineFile: "pipelines/kubernetes-smoke.yml",
    });

    assert.equal(result.commitSha, "abc12345");
    assert.deepEqual(result.changedFiles, ["src/index.ts"]);
    assert.equal(completionReads, 3);
    assert.equal(revokedRunId, "run-k8s-backend-3");
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("kubernetes backend does not load kubeconfig until it needs a real resource client", async () => {
  const original = KubernetesResourceClient.fromDefaultConfig;
  Object.assign(KubernetesResourceClient, {
    fromDefaultConfig: () => {
      throw new Error("constructor should not eagerly read kubeconfig");
    },
  });

  try {
    const backend = new KubernetesExecutionBackend({
      controlPlaneStore: {
        createRunEnvelope: async () => undefined,
        issueRunToken: async () => ({ token: "issued-token" }),
        getLatestCompletion: async () => makeCompletion(),
        revokeRunToken: async () => undefined,
        listEventsAfterSequence: async () => [],
      },
      artifactStore: {
        allocateTargets: async () => ({ targets: {} }),
      },
      runStore: {
        getRun: async () => undefined,
      },
      workRoot: "/tmp/gooseherd-k8s-backend",
      runnerImage: "gooseherd/k8s-runner:dev",
      internalBaseUrl: "http://host.minikube.internal:8787",
      dryRun: true,
    });

    assert.equal(backend.runtime, "kubernetes");
  } finally {
    Object.assign(KubernetesResourceClient, { fromDefaultConfig: original });
  }
});

test("kubernetes backend falls back to event timestamp when runner checkpoint emittedAt is invalid", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "gooseherd-k8s-backend-checkpoint-"));
  const phaseChanges: string[] = [];
  const checkpoints: Array<{ checkpointKey: string; emittedAt?: string }> = [];

  const backend = new KubernetesExecutionBackend({
    controlPlaneStore: {
      createRunEnvelope: async () => undefined,
      issueRunToken: async () => ({ token: "issued-token" }),
      getLatestCompletion: async () => makeCompletion(),
      revokeRunToken: async () => undefined,
      listEventsAfterSequence: async (_runId, afterSequence) => afterSequence === 0
        ? [{
            runId: "run-k8s-backend-4",
            eventId: "evt-1",
            eventType: "run.checkpoint",
            timestamp: "2026-04-24T00:00:00.000Z",
            sequence: 1,
            payload: {
              checkpointKey: "external_ci_wait_started",
              checkpointType: "run.waiting_external_ci",
              emittedAt: "not-a-date",
              payload: { source: "runner" },
            },
          }]
        : [],
    },
    artifactStore: {
      allocateTargets: async () => ({ targets: {} }),
    },
    runStore: {
      getRun: async () => undefined,
    },
    workRoot: tmpRoot,
    runnerImage: "gooseherd/k8s-runner:dev",
    internalBaseUrl: "http://host.minikube.internal:8787",
    dryRun: false,
    resourceClient: {
      applySecret: async () => undefined,
      applyJob: async () => undefined,
      readJob: async () => ({ status: { conditions: [{ type: "Complete", status: "True" }] } }),
      listPodsForJob: async () => [],
      readJobLogs: async () => "runner completed\n",
      deleteJob: async () => undefined,
      deletePodsForJob: async () => undefined,
      deleteSecret: async () => undefined,
    },
    pollIntervalMs: 1,
    waitTimeoutMs: 5_000,
    completionWaitMs: 100,
  });

  try {
    await backend.execute(makeRun({ id: "run-k8s-backend-4" }), {
      onPhase: async (phase) => {
        phaseChanges.push(phase);
      },
      onCheckpoint: async (checkpoint) => {
        checkpoints.push(checkpoint);
      },
      pipelineFile: "pipelines/kubernetes-smoke.yml",
    });

    assert.ok(phaseChanges.includes("agent"));
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0]?.checkpointKey, "external_ci_wait_started");
    assert.equal(checkpoints[0]?.emittedAt, "2026-04-24T00:00:00.000Z");
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});
