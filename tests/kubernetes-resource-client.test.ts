import assert from "node:assert/strict";
import test from "node:test";
import {
  KubernetesResourceClient,
  type KubernetesBatchApi,
  type KubernetesCoreApi,
  type KubernetesPodLogReader,
} from "../src/runtime/kubernetes/resource-client.js";
import { buildRunJobSpec, buildRunTokenSecretManifest } from "../src/runtime/kubernetes/job-spec.js";

test("resource client applies manifests and scopes calls by namespace", async () => {
  const calls: Array<{ method: string; param: Record<string, unknown> }> = [];
  const client = new KubernetesResourceClient({
    batchApi: {
      createNamespacedJob: async (param) => {
        calls.push({ method: "createNamespacedJob", param });
        return {};
      },
      readNamespacedJob: async () => null,
      deleteNamespacedJob: async () => undefined,
    } satisfies KubernetesBatchApi,
    coreApi: {
      createNamespacedSecret: async (param) => {
        calls.push({ method: "createNamespacedSecret", param });
        return {};
      },
      listNamespacedPod: async () => ({ items: [] }),
      deleteCollectionNamespacedPod: async () => undefined,
      deleteNamespacedSecret: async () => undefined,
    } satisfies KubernetesCoreApi,
    podLogReader: {
      readNamespacedPodLog: async () => "",
    } satisfies KubernetesPodLogReader,
  });

  const secret = buildRunTokenSecretManifest({
    runId: "run-1",
    namespace: "gooseherd",
    runToken: "secret-token",
  });
  const job = buildRunJobSpec({
    runId: "run-1",
    namespace: "gooseherd",
    image: "gooseherd/k8s-runner:dev",
    secretName: secret.metadata.name,
    internalBaseUrl: "http://gooseherd.gooseherd.svc.cluster.local:8787",
    pipelineFile: "pipelines/kubernetes-smoke.yml",
    dryRun: true,
  });

  await client.applySecret(secret);
  await client.applyJob(job);

  assert.deepEqual(
    calls.map(({ method, param }) => ({ method, namespace: param.namespace, bodyName: (param.body as { metadata?: { name?: string } })?.metadata?.name })),
    [
      { method: "createNamespacedSecret", namespace: "gooseherd", bodyName: secret.metadata.name },
      { method: "createNamespacedJob", namespace: "gooseherd", bodyName: job.metadata.name },
    ],
  );
});

test("resource client returns null for missing jobs and deletes pods via label selector", async () => {
  const calls: Array<{ method: string; param: Record<string, unknown> }> = [];
  const missing = Object.assign(new Error("Not Found"), { statusCode: 404 });

  const client = new KubernetesResourceClient({
    batchApi: {
      createNamespacedJob: async () => ({}),
      readNamespacedJob: async () => {
        throw missing;
      },
      deleteNamespacedJob: async (param) => {
        calls.push({ method: "deleteNamespacedJob", param });
      },
    } satisfies KubernetesBatchApi,
    coreApi: {
      createNamespacedSecret: async () => ({}),
      listNamespacedPod: async () => ({ items: [] }),
      deleteCollectionNamespacedPod: async (param) => {
        calls.push({ method: "deleteCollectionNamespacedPod", param });
      },
      deleteNamespacedSecret: async (param) => {
        calls.push({ method: "deleteNamespacedSecret", param });
      },
    } satisfies KubernetesCoreApi,
    podLogReader: {
      readNamespacedPodLog: async () => "",
    } satisfies KubernetesPodLogReader,
  });

  const job = await client.readJob("gooseherd-smoke-run-1", "gooseherd");
  assert.equal(job, null);

  await client.deleteJob("gooseherd-smoke-run-1", "gooseherd");
  await client.deletePodsForJob("gooseherd-smoke-run-1", "gooseherd");
  await client.deleteSecret("gooseherd-run-token-run-1", "gooseherd");

  assert.deepEqual(
    calls,
    [
      { method: "deleteNamespacedJob", param: { name: "gooseherd-smoke-run-1", namespace: "gooseherd" } },
      {
        method: "deleteCollectionNamespacedPod",
        param: {
          namespace: "gooseherd",
          labelSelector: "job-name=gooseherd-smoke-run-1",
          propagationPolicy: "Background",
        },
      },
      { method: "deleteNamespacedSecret", param: { name: "gooseherd-run-token-run-1", namespace: "gooseherd" } },
    ],
  );
});

test("resource client returns null for ApiException-style missing jobs with code 404 and string body", async () => {
  const missing = Object.assign(new Error("HTTP-Code: 404"), {
    code: 404,
    body: "{\"kind\":\"Status\",\"code\":404,\"reason\":\"NotFound\"}\n",
    headers: {},
  });

  const client = new KubernetesResourceClient({
    batchApi: {
      createNamespacedJob: async () => ({}),
      readNamespacedJob: async () => {
        throw missing;
      },
      deleteNamespacedJob: async () => undefined,
    } satisfies KubernetesBatchApi,
    coreApi: {
      createNamespacedSecret: async () => ({}),
      listNamespacedPod: async () => ({ items: [] }),
      deleteCollectionNamespacedPod: async () => undefined,
      deleteNamespacedSecret: async () => undefined,
    } satisfies KubernetesCoreApi,
    podLogReader: {
      readNamespacedPodLog: async () => "",
    } satisfies KubernetesPodLogReader,
  });

  const job = await client.readJob("gooseherd-smoke-run-1", "gooseherd");
  assert.equal(job, null);
});

test("resource client lists pods for a job and reads logs from the first pod", async () => {
  const calls: Array<{ method: string; param: Record<string, unknown> }> = [];

  const client = new KubernetesResourceClient({
    batchApi: {
      createNamespacedJob: async () => ({}),
      readNamespacedJob: async () => null,
      deleteNamespacedJob: async () => undefined,
    } satisfies KubernetesBatchApi,
    coreApi: {
      createNamespacedSecret: async () => ({}),
      listNamespacedPod: async (param) => {
        calls.push({ method: "listNamespacedPod", param });
        return {
          items: [
            {
              metadata: { name: "gooseherd-smoke-run-1-abc" },
              status: { phase: "Succeeded" },
            },
          ],
        };
      },
      deleteCollectionNamespacedPod: async () => undefined,
      deleteNamespacedSecret: async () => undefined,
    } satisfies KubernetesCoreApi,
    podLogReader: {
      readNamespacedPodLog: async (param) => {
        calls.push({ method: "readNamespacedPodLog", param });
        return "runner completed\n";
      },
    } satisfies KubernetesPodLogReader,
  });

  const pods = await client.listPodsForJob("gooseherd-smoke-run-1", "gooseherd");
  const logs = await client.readJobLogs("gooseherd-smoke-run-1", "gooseherd", 1024);

  assert.equal(pods.length, 1);
  assert.equal(logs, "runner completed\n");
  assert.deepEqual(calls, [
    {
      method: "listNamespacedPod",
      param: {
        namespace: "gooseherd",
        labelSelector: "job-name=gooseherd-smoke-run-1",
      },
    },
    {
      method: "listNamespacedPod",
      param: {
        namespace: "gooseherd",
        labelSelector: "job-name=gooseherd-smoke-run-1",
      },
    },
    {
      method: "readNamespacedPodLog",
      param: {
        name: "gooseherd-smoke-run-1-abc",
        namespace: "gooseherd",
        limitBytes: 1024,
      },
    },
  ]);
});
