import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const rootDir = process.cwd();

test("package.json exposes local minikube helper scripts", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(rootDir, "package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };

  assert.equal(packageJson.scripts?.["k8s:build-app"], "bash scripts/kubernetes/build-app-image.sh");
  assert.equal(packageJson.scripts?.["k8s:local-up"], "bash scripts/kubernetes/local-up.sh");
  assert.equal(packageJson.scripts?.["k8s:local-down"], "bash scripts/kubernetes/local-down.sh");
  assert.equal(packageJson.scripts?.["k8s:local-status"], "bash scripts/kubernetes/local-status.sh");
});

for (const relativePath of [
  "scripts/kubernetes/build-app-image.sh",
  "scripts/kubernetes/build-runner-image.sh",
  "scripts/kubernetes/local-up.sh",
  "scripts/kubernetes/local-down.sh",
  "scripts/kubernetes/local-status.sh",
]) {
  test(`${relativePath} has valid bash syntax`, async () => {
    await execFileAsync("bash", ["-n", path.join(rootDir, relativePath)]);
  });
}

test("build-app-image.sh streams the host build into minikube when needed", async () => {
  const contents = await readFile(path.join(rootDir, "scripts/kubernetes/build-app-image.sh"), "utf8");

  assert.match(contents, /\[image\] building .* on the host docker daemon/);
  assert.match(contents, /docker image inspect --format '\{\{\.Id\}\}' "\$\{IMAGE_TAG\}"/);
  assert.match(contents, /docker exec "\$\{MINIKUBE_PROFILE\}" docker image inspect --format '\{\{\.Id\}\}' "\$\{IMAGE_TAG\}"/);
  assert.match(contents, /\[image\] \$\{IMAGE_TAG\} already present in \$\{MINIKUBE_PROFILE\}/);
  assert.match(contents, /docker save "\$\{IMAGE_TAG\}" \| docker exec -i "\$\{MINIKUBE_PROFILE\}" docker load/);
  assert.doesNotMatch(contents, /docker save -o/);
  assert.doesNotMatch(contents, /docker load -i/);
  assert.doesNotMatch(contents, /minikube image load "\$\{IMAGE_TAG\}"/);
  assert.doesNotMatch(contents, /docker-env/);
});

test("build-runner-image.sh keeps the host build and loads it into minikube", async () => {
  const contents = await readFile(path.join(rootDir, "scripts/kubernetes/build-runner-image.sh"), "utf8");

  assert.match(contents, /\[image\] building .* on the host docker daemon/);
  assert.match(contents, /docker image inspect --format '\{\{\.Id\}\}' "\$\{IMAGE_TAG\}"/);
  assert.match(contents, /docker exec "\$\{MINIKUBE_PROFILE\}" docker image inspect --format '\{\{\.Id\}\}' "\$\{IMAGE_TAG\}"/);
  assert.match(contents, /\[image\] \$\{IMAGE_TAG\} already present in \$\{MINIKUBE_PROFILE\}/);
  assert.match(contents, /docker save "\$\{IMAGE_TAG\}" \| docker exec -i "\$\{MINIKUBE_PROFILE\}" docker load/);
  assert.doesNotMatch(contents, /docker save -o/);
  assert.doesNotMatch(contents, /minikube image load "\$\{IMAGE_TAG\}"/);
  assert.doesNotMatch(contents, /docker-env/);
});

test("local-up.sh bootstraps dashboard setup through a temporary port-forward", async () => {
  const contents = await readFile(path.join(rootDir, "scripts/kubernetes/local-up.sh"), "utf8");

  assert.match(contents, /GOOSEHERD_LOCAL_DASHBOARD_PORT/);
  assert.match(contents, /GOOSEHERD_LOCAL_DASHBOARD_PASSWORD/);
  assert.match(contents, /port-forward svc\/gooseherd "\$\{LOCAL_DASHBOARD_PORT\}:8787"/);
  assert.match(contents, /\/api\/setup\/status/);
  assert.match(contents, /\/api\/setup\/password/);
  assert.match(contents, /\/api\/setup\/complete/);
  assert.match(contents, /\[local-up\] dashboard password: \$\{LOCAL_DASHBOARD_PASSWORD\}/);
});
