import { RUNNER_PROTOCOL_VERSION } from "../protocol-version.js";

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
        volumes: Array<{ name: "work"; emptyDir: Record<string, never> }>;
        containers: Array<{
          name: "runner";
          image: string;
          imagePullPolicy: "IfNotPresent";
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
              cpu: "250m";
              memory: "512Mi";
            };
            limits: {
              cpu: "1";
              memory: "1Gi";
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

export function buildRunJobSpec(input: KubernetesRunnerJobInput): JobManifest {
  const jobName = input.jobName ?? defaultJobName(input.runId);
  const envFrom = [
    input.runnerEnvSecretName ? { secretRef: { name: input.runnerEnvSecretName } } : undefined,
    input.runnerEnvConfigMapName ? { configMapRef: { name: input.runnerEnvConfigMapName } } : undefined,
  ].filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

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
          volumes: [{ name: "work", emptyDir: {} }],
          containers: [
            {
              name: "runner",
              image: input.image,
              imagePullPolicy: "IfNotPresent",
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
              resources: {
                requests: {
                  cpu: "250m",
                  memory: "512Mi",
                },
                limits: {
                  cpu: "1",
                  memory: "1Gi",
                },
              },
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
                { name: "DRY_RUN", value: String(input.dryRun) },
                { name: "DASHBOARD_ENABLED", value: "false" },
                { name: "OBSERVER_ENABLED", value: "false" },
                { name: "SUPERVISOR_ENABLED", value: "false" },
                { name: "CI_WAIT_ENABLED", value: "false" },
                ...Object.entries(input.extraEnv ?? {}).map(([name, value]) => ({ name, value })),
              ],
            },
          ],
        },
      },
    },
  };
}
