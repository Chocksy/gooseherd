import type { AppConfig } from "../config.js";

export const DEFAULT_KUBERNETES_RUNNER_IMAGE = "gooseherd/k8s-runner:dev";
export const DEFAULT_KUBERNETES_NAMESPACE = "default";
export const DEFAULT_KUBERNETES_RUNNER_ENV_SECRET = "gooseherd-env";
export const DEFAULT_KUBERNETES_RUNNER_ENV_CONFIGMAP = "gooseherd-config";

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
