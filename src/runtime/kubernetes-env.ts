import type { AppConfig } from "../config.js";
import type { KubernetesImagePullPolicy } from "./kubernetes/job-spec.js";

export const DEFAULT_KUBERNETES_RUNNER_IMAGE = "gooseherd/k8s-runner:dev";
export const DEFAULT_KUBERNETES_NAMESPACE = "default";
export const DEFAULT_KUBERNETES_RUNNER_ENV_SECRET = "gooseherd-env";
export const DEFAULT_KUBERNETES_RUNNER_ENV_CONFIGMAP = "gooseherd-config";
export const DEFAULT_KUBERNETES_RUN_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
export const DEFAULT_KUBERNETES_RUNNER_IMAGE_PULL_POLICY: KubernetesImagePullPolicy = "IfNotPresent";

export function resolveKubernetesRunnerImage(): string {
  return process.env.KUBERNETES_RUNNER_IMAGE?.trim() || DEFAULT_KUBERNETES_RUNNER_IMAGE;
}

export function resolveKubernetesNamespace(): string {
  return process.env.KUBERNETES_NAMESPACE?.trim() || DEFAULT_KUBERNETES_NAMESPACE;
}

export function resolveKubernetesRunnerEnvSecretName(): string {
  return process.env.KUBERNETES_RUNNER_ENV_SECRET?.trim() || DEFAULT_KUBERNETES_RUNNER_ENV_SECRET;
}

export function resolveKubernetesRunnerEnvConfigMapName(): string {
  return process.env.KUBERNETES_RUNNER_ENV_CONFIGMAP?.trim() || DEFAULT_KUBERNETES_RUNNER_ENV_CONFIGMAP;
}

export function resolveKubernetesInternalBaseUrl(
  config: Pick<AppConfig, "dashboardPublicUrl" | "dashboardPort">,
): string {
  const explicit = process.env.KUBERNETES_INTERNAL_BASE_URL?.trim();
  if (explicit) {
    return explicit;
  }

  if (config.dashboardPublicUrl && !/localhost|127\.0\.0\.1/.test(config.dashboardPublicUrl)) {
    return config.dashboardPublicUrl;
  }

  return `http://host.minikube.internal:${String(config.dashboardPort)}`;
}

export function resolveKubernetesRunnerImagePullPolicy(): KubernetesImagePullPolicy {
  return process.env.KUBERNETES_RUNNER_IMAGE_PULL_POLICY?.trim() === "Always"
    ? "Always"
    : DEFAULT_KUBERNETES_RUNNER_IMAGE_PULL_POLICY;
}

export function resolveKubernetesRunWaitTimeoutMs(): number {
  const raw = process.env.KUBERNETES_RUN_WAIT_TIMEOUT_SECONDS?.trim();
  if (!raw || !/^[1-9]\d*$/.test(raw)) return DEFAULT_KUBERNETES_RUN_WAIT_TIMEOUT_MS;
  return Number.parseInt(raw, 10) * 1_000;
}
