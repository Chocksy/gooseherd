import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRunJobSpec,
  buildRunTokenSecretManifest,
  defaultJobName,
  defaultSecretName,
} from "../src/runtime/kubernetes/job-spec.js";

test("buildRunTokenSecretManifest stores RUN_TOKEN in a namespaced secret", () => {
  const manifest = buildRunTokenSecretManifest({
    runId: "12345678-1234-5678-9abc-def012345678",
    namespace: "default",
    runToken: "secret-token",
  });

  assert.equal(manifest.kind, "Secret");
  assert.equal(manifest.metadata.name, defaultSecretName("12345678-1234-5678-9abc-def012345678"));
  assert.equal(manifest.metadata.namespace, "default");
  assert.equal(manifest.stringData.RUN_TOKEN, "secret-token");
});

test("default kubernetes resource names stay RFC1123-safe for hyphenated run ids", () => {
  assert.equal(defaultSecretName("run-k8s-backend-1"), "gooseherd-run-token-run-k8s");
  assert.equal(defaultJobName("run-k8s-backend-1"), "gooseherd-run-run-k8s");
});

test("buildRunJobSpec uses one Job per run with emptyDir workspace and runner env wiring", () => {
  const runId = "12345678-1234-5678-9abc-def012345678";
  const secretName = defaultSecretName(runId);
  const spec = buildRunJobSpec({
    runId,
    namespace: "default",
    image: "gooseherd/k8s-runner:dev",
    secretName,
    internalBaseUrl: "http://host.minikube.internal:8787",
    pipelineFile: "pipelines/kubernetes-smoke.yml",
    dryRun: false,
    runnerEnvSecretName: "gooseherd-env",
    runnerEnvConfigMapName: "gooseherd-config",
  });

  assert.equal(spec.kind, "Job");
  assert.equal(spec.metadata.name, defaultJobName(runId));
  assert.equal(spec.spec.backoffLimit, 0);
  assert.equal(spec.spec.template.spec.volumes[0]?.emptyDir != null, true);
  assert.equal(spec.spec.template.spec.containers[0]?.image, "gooseherd/k8s-runner:dev");
  assert.deepEqual(spec.spec.template.spec.containers[0]?.envFrom, [
    { secretRef: { name: "gooseherd-env" } },
    { configMapRef: { name: "gooseherd-config" } },
  ]);
  assert.deepEqual(spec.spec.template.spec.containers[0]?.securityContext, {
    allowPrivilegeEscalation: false,
    capabilities: {
      drop: ["ALL"],
    },
    readOnlyRootFilesystem: false,
    runAsNonRoot: true,
    runAsUser: 1000,
  });
  assert.deepEqual(spec.spec.template.spec.containers[0]?.resources, {
    requests: {
      cpu: "250m",
      memory: "512Mi",
    },
    limits: {
      cpu: "1",
      memory: "1Gi",
    },
  });

  const env = spec.spec.template.spec.containers[0]?.env ?? [];
  assert.equal(env.some((entry) => entry.name === "RUN_ID"), true);
  assert.equal(env.some((entry) => entry.name === "GOOSEHERD_INTERNAL_BASE_URL"), true);
  assert.equal(env.some((entry) => entry.name === "PIPELINE_FILE"), true);
  assert.deepEqual(
    env.find((entry) => entry.name === "PIPELINE_FILE"),
    {
      name: "PIPELINE_FILE",
      value: "pipelines/kubernetes-smoke.yml",
    },
  );
  assert.deepEqual(
    env.find((entry) => entry.name === "RUN_TOKEN"),
    {
      name: "RUN_TOKEN",
      valueFrom: {
        secretKeyRef: {
          name: secretName,
          key: "RUN_TOKEN",
        },
      },
    },
  );
  assert.deepEqual(
    env.find((entry) => entry.name === "GOOSEHERD_RUNNER_PROTOCOL_VERSION"),
    {
      name: "GOOSEHERD_RUNNER_PROTOCOL_VERSION",
      value: "1",
    },
  );
  assert.deepEqual(
    env.find((entry) => entry.name === "DRY_RUN"),
    {
      name: "DRY_RUN",
      value: "false",
    },
  );
  assert.deepEqual(
    env.find((entry) => entry.name === "CI_WAIT_ENABLED"),
    {
      name: "CI_WAIT_ENABLED",
      value: "false",
    },
  );
});
