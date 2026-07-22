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
  resolveKubernetesRunnerImagePullPolicy,
  resolveKubernetesRunWaitTimeoutMs,
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

function withWaitTimeoutEnv<T>(value: string | undefined, fn: () => T): T {
  const original = process.env.KUBERNETES_RUN_WAIT_TIMEOUT_SECONDS;
  try {
    if (value === undefined) {
      delete process.env.KUBERNETES_RUN_WAIT_TIMEOUT_SECONDS;
    } else {
      process.env.KUBERNETES_RUN_WAIT_TIMEOUT_SECONDS = value;
    }
    return fn();
  } finally {
    if (original === undefined) {
      delete process.env.KUBERNETES_RUN_WAIT_TIMEOUT_SECONDS;
    } else {
      process.env.KUBERNETES_RUN_WAIT_TIMEOUT_SECONDS = original;
    }
  }
}

test("resolveKubernetesRunWaitTimeoutMs: defaults to 600s when env unset", () => {
  withWaitTimeoutEnv(undefined, () => {
    assert.equal(resolveKubernetesRunWaitTimeoutMs(), 600_000);
  });
});

test("resolveKubernetesRunWaitTimeoutMs: reads value from env in seconds", () => {
  withWaitTimeoutEnv("1800", () => {
    assert.equal(resolveKubernetesRunWaitTimeoutMs(), 1_800_000);
  });
});

test("resolveKubernetesRunWaitTimeoutMs: rejects non-positive, non-numeric, and lossy values", () => {
  for (const bad of ["", "  ", "0", "-30", "abc", "NaN", "600.5", "600abc", "undefined", "1e3"]) {
    withWaitTimeoutEnv(bad, () => {
      assert.equal(
        resolveKubernetesRunWaitTimeoutMs(),
        600_000,
        `value=${JSON.stringify(bad)} should fall back to default`,
      );
    });
  }
});

function withPullPolicyEnv<T>(value: string | undefined, fn: () => T): T {
  const original = process.env.KUBERNETES_RUNNER_IMAGE_PULL_POLICY;
  try {
    if (value === undefined) {
      delete process.env.KUBERNETES_RUNNER_IMAGE_PULL_POLICY;
    } else {
      process.env.KUBERNETES_RUNNER_IMAGE_PULL_POLICY = value;
    }
    return fn();
  } finally {
    if (original === undefined) {
      delete process.env.KUBERNETES_RUNNER_IMAGE_PULL_POLICY;
    } else {
      process.env.KUBERNETES_RUNNER_IMAGE_PULL_POLICY = original;
    }
  }
}

test("resolveKubernetesRunnerImagePullPolicy: defaults to IfNotPresent when unset or blank", () => {
  for (const value of [undefined, "", "  "]) {
    withPullPolicyEnv(value, () => {
      assert.equal(resolveKubernetesRunnerImagePullPolicy(), "IfNotPresent");
    });
  }
});

test("resolveKubernetesRunnerImagePullPolicy: accepts Always case-insensitively", () => {
  for (const value of ["Always", "always", "ALWAYS", " Always "]) {
    withPullPolicyEnv(value, () => {
      assert.equal(
        resolveKubernetesRunnerImagePullPolicy(),
        "Always",
        `value=${JSON.stringify(value)} should resolve to Always`,
      );
    });
  }
});

test("resolveKubernetesRunnerImagePullPolicy: accepts IfNotPresent case-insensitively", () => {
  for (const value of ["IfNotPresent", "ifnotpresent", "IFNOTPRESENT"]) {
    withPullPolicyEnv(value, () => {
      assert.equal(resolveKubernetesRunnerImagePullPolicy(), "IfNotPresent");
    });
  }
});

test("resolveKubernetesRunnerImagePullPolicy: falls back to IfNotPresent on unrecognized values", () => {
  for (const value of ["Never", "Alwayss", "true", "1"]) {
    withPullPolicyEnv(value, () => {
      assert.equal(
        resolveKubernetesRunnerImagePullPolicy(),
        "IfNotPresent",
        `value=${JSON.stringify(value)} should fall back to default`,
      );
    });
  }
});
