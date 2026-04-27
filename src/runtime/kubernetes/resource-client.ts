import {
  BatchV1Api,
  CoreV1Api,
  KubeConfig,
  type V1Job,
  type V1Pod,
  type V1PodList,
  type V1Secret,
  type V1Status,
} from "@kubernetes/client-node";
import type { JobManifest, SecretManifest } from "./job-spec.js";

export interface KubernetesBatchApi {
  createNamespacedJob(param: { namespace: string; body: JobManifest }): Promise<unknown>;
  readNamespacedJob(param: { name: string; namespace: string }): Promise<V1Job | null>;
  deleteNamespacedJob(param: { name: string; namespace: string }): Promise<V1Status | void>;
}

export interface KubernetesCoreApi {
  createNamespacedSecret(param: { namespace: string; body: SecretManifest }): Promise<unknown>;
  listNamespacedPod(param: { namespace: string; labelSelector: string }): Promise<V1PodList>;
  deleteCollectionNamespacedPod(param: {
    namespace: string;
    labelSelector: string;
    propagationPolicy?: "Background" | "Foreground" | "Orphan";
  }): Promise<V1Status | void>;
  deleteNamespacedSecret(param: { name: string; namespace: string }): Promise<V1Status | void>;
}

export interface KubernetesPodLogReader {
  readNamespacedPodLog(param: { name: string; namespace: string; limitBytes?: number }): Promise<string>;
}

interface KubernetesResourceClientDeps {
  batchApi?: KubernetesBatchApi;
  coreApi?: KubernetesCoreApi;
  podLogReader?: KubernetesPodLogReader;
}

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    const statusCode = (error as { statusCode?: number; code?: number; body?: { code?: number } | string; response?: { statusCode?: number } })?.statusCode
      ?? (error as { code?: number })?.code
      ?? (typeof (error as { body?: { code?: number } | string })?.body === "object"
        ? ((error as { body?: { code?: number } | string }).body as { code?: number } | undefined)?.code
        : undefined)
      ?? (error as { response?: { statusCode?: number } })?.response?.statusCode;
    return statusCode === 404;
  }

  const withStatus = error as Error & { statusCode?: number; code?: number; body?: { code?: number } | string; response?: { statusCode?: number } };
  const bodyCode = typeof withStatus.body === "object" && withStatus.body !== null
    ? withStatus.body.code
    : undefined;
  return withStatus.statusCode === 404
    || withStatus.code === 404
    || bodyCode === 404
    || withStatus.response?.statusCode === 404;
}

class DefaultPodLogReader implements KubernetesPodLogReader {
  constructor(private readonly coreApi: CoreV1Api) {}

  async readNamespacedPodLog(param: { name: string; namespace: string; limitBytes?: number }): Promise<string> {
    const response = await this.coreApi.readNamespacedPodLog({
      name: param.name,
      namespace: param.namespace,
      limitBytes: param.limitBytes,
    });
    return typeof response === "string" ? response : String(response ?? "");
  }
}

export class KubernetesResourceClient {
  static fromDefaultConfig(): KubernetesResourceClient {
    const kubeConfig = new KubeConfig();
    kubeConfig.loadFromDefault();
    const coreApi = kubeConfig.makeApiClient(CoreV1Api);
    return new KubernetesResourceClient({
      batchApi: kubeConfig.makeApiClient(BatchV1Api),
      coreApi,
      podLogReader: new DefaultPodLogReader(coreApi),
    });
  }

  private readonly batchApi: KubernetesBatchApi;
  private readonly coreApi: KubernetesCoreApi;
  private readonly podLogReader: KubernetesPodLogReader;

  constructor(deps: KubernetesResourceClientDeps) {
    const fallback = (!deps.batchApi || !deps.coreApi || !deps.podLogReader)
      ? KubernetesResourceClient.fromDefaultConfig()
      : null;
    this.batchApi = deps.batchApi ?? fallback!.batchApi;
    this.coreApi = deps.coreApi ?? fallback!.coreApi;
    this.podLogReader = deps.podLogReader ?? fallback!.podLogReader;
  }

  async applySecret(secret: SecretManifest): Promise<void> {
    await this.coreApi.createNamespacedSecret({
      namespace: secret.metadata.namespace,
      body: secret,
    });
  }

  async applyJob(job: JobManifest): Promise<void> {
    await this.batchApi.createNamespacedJob({
      namespace: job.metadata.namespace,
      body: job,
    });
  }

  async readJob(name: string, namespace: string): Promise<V1Job | null> {
    try {
      return await this.batchApi.readNamespacedJob({ name, namespace });
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async listPodsForJob(jobName: string, namespace: string): Promise<V1Pod[]> {
    const response = await this.coreApi.listNamespacedPod({
      namespace,
      labelSelector: `job-name=${jobName}`,
    });
    return Array.isArray(response.items) ? response.items : [];
  }

  async readJobLogs(jobName: string, namespace: string, limitBytes = 5 * 1024 * 1024): Promise<string> {
    const pods = await this.listPodsForJob(jobName, namespace);
    const podName = pods[0]?.metadata?.name;
    if (!podName) {
      throw new Error(`No pod found for Kubernetes job ${jobName}`);
    }
    return this.podLogReader.readNamespacedPodLog({ name: podName, namespace, limitBytes });
  }

  async deleteJob(name: string, namespace: string): Promise<void> {
    await this.batchApi.deleteNamespacedJob({ name, namespace });
  }

  async deletePodsForJob(jobName: string, namespace: string): Promise<void> {
    await this.coreApi.deleteCollectionNamespacedPod({
      namespace,
      labelSelector: `job-name=${jobName}`,
      propagationPolicy: "Background",
    });
  }

  async deleteSecret(name: string, namespace: string): Promise<void> {
    await this.coreApi.deleteNamespacedSecret({ name, namespace });
  }
}

export type { V1Job, V1Pod, V1Secret };
