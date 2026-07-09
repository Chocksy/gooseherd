import { RUNNER_PROTOCOL_VERSION } from "../protocol-version.js";

/** Pull policy for the runner pod image. `Always` re-pulls rebuilt `:latest` tags. */
export type KubernetesImagePullPolicy = "IfNotPresent" | "Always";

export interface KubernetesRunnerSecretInput {
  runId: string;
  namespace: string;
  secretName?: string;
  runToken: string;
}

export interface KubernetesRunnerJobInput {
  runId: string;
  namespace: string;
  image: string;
  secretName: string;
  internalBaseUrl: string;
  pipelineFile: string;
  dryRun: boolean;
  runnerEnvSecretName?: string;
  runnerEnvConfigMapName?: string;
  jobName?: string;
  /** Additional plain-value env vars merged into the runner container. */
  extraEnv?: Record<string, string>;
  /**
   * Per-run CPU/memory override. When set, the value is applied as both
   * request and limit (Guaranteed QoS) so the runner pod gets reserved
   * capacity and is the last to be evicted under node pressure. Either
   * dimension may be omitted to fall back to the sandbox default.
   */
  resources?: {
    cpu?: string;
    memory?: string;
  };
  /**
   * V8 old-space heap cap in MB for the runner Node.js process. When set,
   * `NODE_OPTIONS=--max-old-space-size=<value>` is added to the runner
   * pod's env so Node leaves headroom for sibling processes (e.g. Ruby
   * test runners) sharing the container memory budget.
   */
  nodeHeapMb?: string;
  /** Runner container image pull policy. Defaults to `IfNotPresent`. */
  imagePullPolicy?: KubernetesImagePullPolicy;
}

export interface SecretManifest {
  apiVersion: "v1";
  kind: "Secret";
  metadata: {
    name: string;
    namespace: string;
    labels: Record<string, string>;
  };
  type: "Opaque";
  stringData: {
    RUN_TOKEN: string;
  };
}

export interface JobManifest {
  apiVersion: "batch/v1";
  kind: "Job";
  metadata: {
    name: string;
    namespace: string;
    labels: Record<string, string>;
  };
  spec: {
    backoffLimit: 0;
    ttlSecondsAfterFinished: 300;
    template: {
      metadata: {
        labels: Record<string, string>;
      };
      spec: {
        restartPolicy: "Never";
        volumes: Array<{ name: "work"; emptyDir: { sizeLimit: string } }>;
        containers: Array<{
          name: "runner";
          image: string;
          imagePullPolicy: KubernetesImagePullPolicy;
          volumeMounts: Array<{ name: "work"; mountPath: "/work" }>;
          envFrom?: Array<
            | { secretRef: { name: string } }
            | { configMapRef: { name: string } }
          >;
          securityContext: {
            allowPrivilegeEscalation: false;
            capabilities: {
              drop: ["ALL"];
            };
            readOnlyRootFilesystem: false;
            runAsNonRoot: true;
            runAsUser: 1000;
          };
          resources: {
            requests: {
              cpu: string;
              memory: string;
            };
            limits: {
              cpu: string;
              memory: string;
            };
          };
          env: Array<
            | { name: string; value: string }
            | { name: string; valueFrom: { secretKeyRef: { name: string; key: "RUN_TOKEN" } } }
          >;
        }>;
      };
    };
  };
}

function shortRunId(runId: string): string {
  const normalized = runId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const shortened = normalized.slice(0, 8).replace(/-+$/g, "");
  return shortened || "run";
}

export function defaultJobName(runId: string): string {
  return `gooseherd-run-${shortRunId(runId)}`;
}

export function defaultSecretName(runId: string): string {
  return `gooseherd-run-token-${shortRunId(runId)}`;
}

export const defaultSmokeJobName = defaultJobName;
export const defaultSmokeSecretName = defaultSecretName;

export function buildRunTokenSecretManifest(input: KubernetesRunnerSecretInput): SecretManifest {
  const secretName = input.secretName ?? defaultSecretName(input.runId);

  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: secretName,
      namespace: input.namespace,
      labels: {
        "app.kubernetes.io/name": "gooseherd-runner",
        "gooseherd.run/id": input.runId,
      },
    },
    type: "Opaque",
    stringData: {
      RUN_TOKEN: input.runToken,
    },
  };
}

const DEFAULT_CPU_REQUEST = "250m";
const DEFAULT_CPU_LIMIT = "1";
const DEFAULT_MEMORY_REQUEST = "512Mi";
const DEFAULT_MEMORY_LIMIT = "1Gi";

export function buildRunJobSpec(input: KubernetesRunnerJobInput): JobManifest {
  const jobName = input.jobName ?? defaultJobName(input.runId);
  const envFrom = [
    input.runnerEnvSecretName ? { secretRef: { name: input.runnerEnvSecretName } } : undefined,
    input.runnerEnvConfigMapName ? { configMapRef: { name: input.runnerEnvConfigMapName } } : undefined,
  ].filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

  const cpuOverride = input.resources?.cpu;
  const memoryOverride = input.resources?.memory;
  const resources = {
    requests: {
      cpu: cpuOverride ?? DEFAULT_CPU_REQUEST,
      memory: memoryOverride ?? DEFAULT_MEMORY_REQUEST,
    },
    limits: {
      cpu: cpuOverride ?? DEFAULT_CPU_LIMIT,
      memory: memoryOverride ?? DEFAULT_MEMORY_LIMIT,
    },
  };

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: jobName,
      namespace: input.namespace,
      labels: {
        "app.kubernetes.io/name": "gooseherd-runner",
        "gooseherd.run/id": input.runId,
      },
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 300,
      template: {
        metadata: {
          labels: {
            "app.kubernetes.io/name": "gooseherd-runner",
            "gooseherd.run/id": input.runId,
          },
        },
        spec: {
          restartPolicy: "Never",
          volumes: [{ name: "work", emptyDir: { sizeLimit: "1.5Gi" } }],
          containers: [
            {
              name: "runner",
              image: input.image,
              imagePullPolicy: input.imagePullPolicy ?? "IfNotPresent",
              volumeMounts: [{ name: "work", mountPath: "/work" }],
              ...(envFrom.length > 0 ? { envFrom } : {}),
              securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: {
                  drop: ["ALL"],
                },
                readOnlyRootFilesystem: false,
                runAsNonRoot: true,
                runAsUser: 1000,
              },
              resources,
              env: [
                { name: "RUN_ID", value: input.runId },
                {
                  name: "RUN_TOKEN",
                  valueFrom: {
                    secretKeyRef: {
                      name: input.secretName,
                      key: "RUN_TOKEN",
                    },
                  },
                },
                { name: "GOOSEHERD_INTERNAL_BASE_URL", value: input.internalBaseUrl },
                { name: "WORK_ROOT", value: "/work" },
                { name: "PIPELINE_FILE", value: input.pipelineFile },
                { name: "GOOSEHERD_RUNNER_PROTOCOL_VERSION", value: RUNNER_PROTOCOL_VERSION },
                // DRY_RUN is pinned here as an explicit container `env` entry, which
                // Kubernetes resolves with higher precedence than any `envFrom`
                // secret/configmap. A stray DRY_RUN=true in the runner-env configmap
                // therefore CANNOT silently put a production run into dry-run mode —
                // the value is whatever the server decided (see kubernetes-backend.ts,
                // which pins false for the production server and only honors an
                // explicitly requested dry-run from local-trigger/eval launches).
                { name: "DRY_RUN", value: String(input.dryRun) },
                { name: "DASHBOARD_ENABLED", value: "false" },
                { name: "OBSERVER_ENABLED", value: "false" },
                { name: "SUPERVISOR_ENABLED", value: "false" },
                { name: "CI_WAIT_ENABLED", value: "false" },
                ...(input.nodeHeapMb
                  ? [{ name: "NODE_OPTIONS", value: `--max-old-space-size=${input.nodeHeapMb}` }]
                  : []),
                ...Object.entries(input.extraEnv ?? {}).map(([name, value]) => ({ name, value })),
              ],
            },
          ],
        },
      },
    },
  };
}
