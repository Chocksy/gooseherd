import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parseAllDocuments } from "yaml";

const rootDir = process.cwd();

async function loadYaml(filePath: string): Promise<unknown[]> {
  const absolutePath = path.join(rootDir, filePath);
  const contents = await readFile(absolutePath, "utf8");
  return parseAllDocuments(contents)
    .map((document) => document.toJSON())
    .filter((value) => value != null);
}

function requireObject(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

test("local namespace manifest declares the gooseherd namespace", async () => {
  const [namespace] = await loadYaml("kubernetes/local/namespace.yaml");
  const manifest = requireObject(namespace);

  assert.equal(manifest.kind, "Namespace");
  assert.deepEqual(manifest.metadata, { name: "gooseherd" });
});

test("local postgres manifest defines deployment and service in the gooseherd namespace", async () => {
  const documents = await loadYaml("kubernetes/local/postgres.yaml");
  assert.equal(documents.length, 2);

  const deployment = requireObject(documents[0]);
  const service = requireObject(documents[1]);

  assert.equal(deployment.kind, "Deployment");
  assert.equal(requireObject(deployment.metadata).name, "postgres");
  assert.equal(requireObject(deployment.metadata).namespace, "gooseherd");
  assert.equal(service.kind, "Service");
  assert.equal(requireObject(service.metadata).name, "postgres");
  assert.equal(requireObject(service.metadata).namespace, "gooseherd");
});

test("local gooseherd work manifest defines a pvc in the gooseherd namespace", async () => {
  const [claim] = await loadYaml("kubernetes/local/gooseherd-work-pvc.yaml");
  const manifest = requireObject(claim);
  const spec = requireObject(manifest.spec);
  const resources = requireObject(spec.resources);
  const requests = requireObject(resources.requests);

  assert.equal(manifest.kind, "PersistentVolumeClaim");
  assert.equal(requireObject(manifest.metadata).name, "gooseherd-work");
  assert.equal(requireObject(manifest.metadata).namespace, "gooseherd");
  assert.equal(Array.isArray(spec.accessModes), true);
  assert.equal((spec.accessModes as Array<unknown>).includes("ReadWriteOnce"), true);
  assert.equal(requests.storage, "10Gi");
});

test("local gooseherd configmap forces kubernetes runtime with cluster DNS callback URL", async () => {
  const [configMap] = await loadYaml("kubernetes/local/gooseherd-configmap.yaml");
  const manifest = requireObject(configMap);
  const data = requireObject(manifest.data);

  assert.equal(manifest.kind, "ConfigMap");
  assert.equal(requireObject(manifest.metadata).name, "gooseherd-config");
  assert.equal(data["SANDBOX_RUNTIME"], "kubernetes");
  assert.equal(data["KUBERNETES_NAMESPACE"], "gooseherd");
  assert.equal(data["KUBERNETES_INTERNAL_BASE_URL"], "http://gooseherd.gooseherd.svc.cluster.local:8787");
  assert.equal(data["KUBERNETES_RUNNER_ENV_SECRET"], "gooseherd-env");
  assert.equal(data["KUBERNETES_RUNNER_ENV_CONFIGMAP"], "gooseherd-config");
  assert.equal(data["WORK_ROOT"], "/app/.work");
  assert.equal(data["DATA_DIR"], "/app/data");
  assert.equal(data["DASHBOARD_HOST"], "0.0.0.0");
});

test("local gooseherd secret example documents the expected secret shape", async () => {
  const [secret] = await loadYaml("kubernetes/local/gooseherd-secret.example.yaml");
  const manifest = requireObject(secret);

  assert.equal(manifest.kind, "Secret");
  assert.equal(requireObject(manifest.metadata).name, "gooseherd-env");
  assert.equal(requireObject(manifest.metadata).namespace, "gooseherd");
});

test("local RBAC manifest grants Gooseherd the resource verbs required by the kubernetes backend", async () => {
  const documents = await loadYaml("kubernetes/local/gooseherd-rbac.yaml");
  assert.equal(documents.length, 3);

  const serviceAccount = requireObject(documents[0]);
  const role = requireObject(documents[1]);
  const roleBinding = requireObject(documents[2]);

  assert.equal(serviceAccount.kind, "ServiceAccount");
  assert.equal(role.kind, "Role");
  assert.equal(roleBinding.kind, "RoleBinding");

  const rules = requireObject(role).rules as Array<Record<string, unknown>>;
  assert.equal(Array.isArray(rules), true);
  assert.equal(
    rules.some((rule) =>
      Array.isArray(rule.resources)
      && rule.resources.includes("jobs")
      && Array.isArray(rule.verbs)
      && rule.verbs.includes("create")
      && rule.verbs.includes("delete")),
    true,
  );
  assert.equal(
    rules.some((rule) =>
      Array.isArray(rule.resources)
      && rule.resources.includes("pods/log")
      && Array.isArray(rule.verbs)
      && rule.verbs.includes("get")),
    true,
  );
  assert.equal(
    rules.some((rule) =>
      Array.isArray(rule.resources)
      && rule.resources.includes("secrets")
      && Array.isArray(rule.verbs)
      && rule.verbs.includes("get")),
    false,
  );
});

test("local gooseherd deployment mounts work/data volumes and uses config plus secret env sources", async () => {
  const [deployment] = await loadYaml("kubernetes/local/gooseherd-deployment.yaml");
  const manifest = requireObject(deployment);
  const template = requireObject(requireObject(requireObject(manifest.spec).template).spec);
  const container = requireObject((template.containers as Array<unknown>)[0]);

  assert.equal(manifest.kind, "Deployment");
  assert.equal(requireObject(manifest.metadata).name, "gooseherd");
  assert.equal(template.serviceAccountName, "gooseherd");
  assert.equal(container.image, "gooseherd/app:dev");

  const envFrom = container.envFrom as Array<Record<string, unknown>>;
  assert.deepEqual(envFrom, [
    { secretRef: { name: "gooseherd-env" } },
    { configMapRef: { name: "gooseherd-config" } },
  ]);

  const volumeMounts = container.volumeMounts as Array<Record<string, unknown>>;
  assert.equal(volumeMounts.some((mount) => mount.mountPath === "/app/.work"), true);
  assert.equal(volumeMounts.some((mount) => mount.mountPath === "/app/data"), true);

  const volumes = template.volumes as Array<Record<string, unknown>>;
  assert.deepEqual(
    volumes.find((volume) => volume.name === "work"),
    {
      name: "work",
      persistentVolumeClaim: {
        claimName: "gooseherd-work",
      },
    },
  );
  assert.deepEqual(
    volumes.find((volume) => volume.name === "data"),
    {
      name: "data",
      emptyDir: {},
    },
  );
});

test("local manifests include a restrictive runner NetworkPolicy", async () => {
  const [policy] = await loadYaml("kubernetes/local/gooseherd-runner-network-policy.yaml");
  const manifest = requireObject(policy);
  const spec = requireObject(manifest.spec);
  const egress = spec.egress as Array<Record<string, unknown>>;

  assert.equal(manifest.kind, "NetworkPolicy");
  assert.equal(requireObject(manifest.metadata).name, "gooseherd-runner-egress");
  assert.deepEqual(spec.policyTypes, ["Egress"]);
  assert.equal(Array.isArray(egress), true);
  assert.equal(egress.length, 1);
});

test("local gooseherd service exposes dashboard and webhook ports", async () => {
  const [service] = await loadYaml("kubernetes/local/gooseherd-service.yaml");
  const manifest = requireObject(service);
  const ports = requireObject(manifest.spec).ports as Array<Record<string, unknown>>;

  assert.equal(manifest.kind, "Service");
  assert.equal(requireObject(manifest.metadata).name, "gooseherd");
  assert.equal(ports.some((port) => port.port === 8787), true);
  assert.equal(ports.some((port) => port.port === 9090), true);
});
