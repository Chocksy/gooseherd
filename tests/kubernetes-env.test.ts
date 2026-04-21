import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_KUBERNETES_NAMESPACE,
  DEFAULT_KUBERNETES_RUNNER_ENV_CONFIGMAP,
  DEFAULT_KUBERNETES_RUNNER_ENV_SECRET,
  DEFAULT_KUBERNETES_RUNNER_IMAGE,
  resolveKubernetesInternalBaseUrl,
  resolveKubernetesNamespace,
  resolveKubernetesRunnerEnvConfigMapName,
  resolveKubernetesRunnerEnvSecretName,
  resolveKubernetesRunnerImage,
} from "../src/runtime/kubernetes-env.js";

test("kubernetes env resolvers use explicit env overrides", () => {
  const originalEnv = process.env;
  try {
    process.env = {
      ...originalEnv,
      KUBERNETES_RUNNER_IMAGE: " registry.example.com/gooseherd/runner:v1 ",
      KUBERNETES_NAMESPACE: " gooseherd-prod ",
      KUBERNETES_RUNNER_ENV_SECRET: " gooseherd-runtime-secret ",
      KUBERNETES_RUNNER_ENV_CONFIGMAP: " gooseherd-runtime-config ",
      KUBERNETES_INTERNAL_BASE_URL: " https://gooseherd.internal.example.com ",
    };

    assert.equal(resolveKubernetesRunnerImage(), "registry.example.com/gooseherd/runner:v1");
    assert.equal(resolveKubernetesNamespace(), "gooseherd-prod");
    assert.equal(resolveKubernetesRunnerEnvSecretName(), "gooseherd-runtime-secret");
    assert.equal(resolveKubernetesRunnerEnvConfigMapName(), "gooseherd-runtime-config");
    assert.equal(
      resolveKubernetesInternalBaseUrl({ dashboardPublicUrl: undefined, dashboardPort: 8787 }),
      "https://gooseherd.internal.example.com",
    );
  } finally {
    process.env = originalEnv;
  }
});

test("kubernetes env resolvers fall back to code defaults", () => {
  const originalEnv = process.env;
  try {
    process.env = {
      ...originalEnv,
      KUBERNETES_RUNNER_IMAGE: "",
      KUBERNETES_NAMESPACE: "",
      KUBERNETES_RUNNER_ENV_SECRET: "",
      KUBERNETES_RUNNER_ENV_CONFIGMAP: "",
      KUBERNETES_INTERNAL_BASE_URL: "",
    };

    assert.equal(resolveKubernetesRunnerImage(), DEFAULT_KUBERNETES_RUNNER_IMAGE);
    assert.equal(resolveKubernetesNamespace(), DEFAULT_KUBERNETES_NAMESPACE);
    assert.equal(resolveKubernetesRunnerEnvSecretName(), DEFAULT_KUBERNETES_RUNNER_ENV_SECRET);
    assert.equal(resolveKubernetesRunnerEnvConfigMapName(), DEFAULT_KUBERNETES_RUNNER_ENV_CONFIGMAP);
  } finally {
    process.env = originalEnv;
  }
});

test("kubernetes internal base URL falls back to public URL before host.minikube.internal", () => {
  const originalEnv = process.env;
  try {
    process.env = {
      ...originalEnv,
      KUBERNETES_INTERNAL_BASE_URL: undefined,
    };

    assert.equal(
      resolveKubernetesInternalBaseUrl({
        dashboardPublicUrl: "https://gooseherd.example.com",
        dashboardPort: 8787,
      }),
      "https://gooseherd.example.com",
    );

    assert.equal(
      resolveKubernetesInternalBaseUrl({
        dashboardPublicUrl: "http://127.0.0.1:8787",
        dashboardPort: 8787,
      }),
      "http://host.minikube.internal:8787",
    );
  } finally {
    process.env = originalEnv;
  }
});
