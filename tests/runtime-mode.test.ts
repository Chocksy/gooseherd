import assert from "node:assert/strict";
import test from "node:test";
import {
  assertImplementedSandboxRuntime,
  hasSandboxRuntimeHotReloadChange,
  preflightSandboxRuntime,
  resolveSandboxRuntime
} from "../src/runtime/runtime-mode.js";

test("resolveSandboxRuntime prefers SANDBOX_RUNTIME when present", () => {
  assert.equal(resolveSandboxRuntime({ SANDBOX_RUNTIME: " Docker " }), "docker");
  assert.equal(resolveSandboxRuntime({ SANDBOX_RUNTIME: "KuBeRnEtEs" }), "kubernetes");
});

test("resolveSandboxRuntime prefers explicit SANDBOX_RUNTIME over legacy SANDBOX_ENABLED", () => {
  assert.equal(
    resolveSandboxRuntime({ SANDBOX_RUNTIME: "local", SANDBOX_ENABLED: "true" }),
    "local"
  );
  assert.equal(
    resolveSandboxRuntime({ SANDBOX_RUNTIME: "docker", SANDBOX_ENABLED: "false" }),
    "docker"
  );
});

test("resolveSandboxRuntime throws on invalid SANDBOX_RUNTIME", () => {
  assert.throws(() => resolveSandboxRuntime({ SANDBOX_RUNTIME: "invalid" }), {
    name: "Error",
    message: "Invalid SANDBOX_RUNTIME value: invalid"
  });
});

test("resolveSandboxRuntime throws on whitespace-only SANDBOX_RUNTIME", () => {
  assert.throws(() => resolveSandboxRuntime({ SANDBOX_RUNTIME: "   " }), /Invalid SANDBOX_RUNTIME value:/);
});

test("resolveSandboxRuntime maps legacy SANDBOX_ENABLED=true to docker", () => {
  assert.equal(resolveSandboxRuntime({ SANDBOX_ENABLED: "true" }), "docker");
});

test("resolveSandboxRuntime maps legacy SANDBOX_ENABLED=false to local", () => {
  assert.equal(resolveSandboxRuntime({ SANDBOX_ENABLED: "false" }), "local");
});

test("assertImplementedSandboxRuntime allows implemented runtimes", () => {
  assert.doesNotThrow(() => assertImplementedSandboxRuntime("local"));
  assert.doesNotThrow(() => assertImplementedSandboxRuntime("docker"));
});

test("assertImplementedSandboxRuntime rejects kubernetes", () => {
  assert.throws(
    () => assertImplementedSandboxRuntime("kubernetes"),
    /SANDBOX_RUNTIME=kubernetes is not supported yet/
  );
});

test("preflightSandboxRuntime rejects unsupported kubernetes runtime", async () => {
  await assert.rejects(
    () => preflightSandboxRuntime({
      sandboxRuntime: "kubernetes",
      sandboxRuntimeExplicit: true,
      sandboxEnabled: false,
      sandboxHostWorkPath: ""
    }, {
      pingDocker: async () => true
    }),
    /SANDBOX_RUNTIME=kubernetes is not supported yet/
  );
});

test("preflightSandboxRuntime rejects explicit docker without host work path", async () => {
  await assert.rejects(
    () => preflightSandboxRuntime({
      sandboxRuntime: "docker",
      sandboxRuntimeExplicit: true,
      sandboxEnabled: true,
      sandboxHostWorkPath: ""
    }, {
      pingDocker: async () => true
    }),
    /SANDBOX_HOST_WORK_PATH is required when SANDBOX_RUNTIME=docker/
  );
});

test("preflightSandboxRuntime rejects explicit docker when docker is unreachable", async () => {
  await assert.rejects(
    () => preflightSandboxRuntime({
      sandboxRuntime: "docker",
      sandboxRuntimeExplicit: true,
      sandboxEnabled: true,
      sandboxHostWorkPath: "/tmp/work"
    }, {
      pingDocker: async () => false
    }),
    /Docker daemon not reachable for SANDBOX_RUNTIME=docker/
  );
});

test("preflightSandboxRuntime allows legacy docker fallback when host path is missing", async () => {
  await assert.deepEqual(
    await preflightSandboxRuntime({
      sandboxRuntime: "docker",
      sandboxRuntimeExplicit: false,
      sandboxEnabled: true,
      sandboxHostWorkPath: ""
    }, {
      pingDocker: async () => {
        assert.fail("pingDocker should not run when host path is missing");
      }
    }),
    { sandboxEnabled: false, fallbackReason: "missing_host_work_path" }
  );
});

test("hasSandboxRuntimeHotReloadChange detects sandbox runtime changes that require restart", () => {
  assert.equal(
    hasSandboxRuntimeHotReloadChange(
      {
        sandboxRuntime: "local",
        sandboxRuntimeExplicit: true,
        sandboxEnabled: false,
        sandboxHostWorkPath: "",
        sandboxImage: "gooseherd/sandbox:default",
        sandboxCpus: 2,
        sandboxMemoryMb: 4096
      },
      {
        sandboxRuntime: "docker",
        sandboxRuntimeExplicit: true,
        sandboxEnabled: true,
        sandboxHostWorkPath: "/tmp/work",
        sandboxImage: "gooseherd/sandbox:default",
        sandboxCpus: 2,
        sandboxMemoryMb: 4096
      }
    ),
    true
  );
});

test("hasSandboxRuntimeHotReloadChange ignores unchanged sandbox runtime config", () => {
  assert.equal(
    hasSandboxRuntimeHotReloadChange(
      {
        sandboxRuntime: "docker",
        sandboxRuntimeExplicit: true,
        sandboxEnabled: true,
        sandboxHostWorkPath: "/tmp/work",
        sandboxImage: "gooseherd/sandbox:default",
        sandboxCpus: 2,
        sandboxMemoryMb: 4096
      },
      {
        sandboxRuntime: "docker",
        sandboxRuntimeExplicit: true,
        sandboxEnabled: true,
        sandboxHostWorkPath: "/tmp/work",
        sandboxImage: "gooseherd/sandbox:default",
        sandboxCpus: 2,
        sandboxMemoryMb: 4096
      }
    ),
    false
  );
});
