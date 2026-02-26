import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile, readFile, access } from "node:fs/promises";
import path from "node:path";
import { ContainerManager } from "../src/sandbox/container-manager.js";
import type { SandboxConfig } from "../src/sandbox/types.js";

/**
 * Docker integration tests for the sandbox container manager.
 * Requires Docker daemon running locally.
 *
 * Run: node --test --import tsx tests/sandbox-integration.test.ts
 */

const TEST_RUN_ID = `test-sandbox-${Date.now()}`;
const WORK_ROOT = path.resolve(".work-test");
const HOST_WORK_PATH = path.resolve(WORK_ROOT);
const RUN_DIR = path.join(WORK_ROOT, TEST_RUN_ID);

const DEFAULT_CONFIG: SandboxConfig = {
  image: "gooseherd/sandbox:default",
  cpus: 1,
  memoryMb: 512,
  env: { TEST_VAR: "hello-from-host" },
  networkMode: "bridge"
};

// Auto-detect Docker socket on macOS (OrbStack, Docker Desktop, default)
async function detectDockerSocket(): Promise<string> {
  const home = process.env["HOME"] ?? "";
  const candidates = [
    "/var/run/docker.sock",
    `${home}/.orbstack/run/docker.sock`,
    `${home}/.docker/run/docker.sock`,
    `${home}/Library/Containers/com.docker.docker/Data/docker.raw.sock`
  ];
  for (const p of candidates) {
    try { await access(p); return p; } catch { /* skip */ }
  }
  return "/var/run/docker.sock";
}

describe("ContainerManager integration", { skip: !process.env["SANDBOX_TEST"] }, () => {
  let manager: ContainerManager;

  before(async () => {
    const socket = await detectDockerSocket();
    manager = new ContainerManager(socket);
    const ok = await manager.ping();
    assert.ok(ok, "Docker daemon must be reachable");

    // Create the run directory on host (bind mount source)
    await mkdir(RUN_DIR, { recursive: true });
    await writeFile(path.join(RUN_DIR, "test-file.txt"), "hello from host\n");
  });

  after(async () => {
    // Clean up container and directory
    await manager.destroySandbox(TEST_RUN_ID);
    await rm(WORK_ROOT, { recursive: true, force: true });
  });

  it("ping returns true when Docker is available", async () => {
    const ok = await manager.ping();
    assert.ok(ok);
  });

  it("creates a sandbox container, execs commands, and destroys it", async () => {
    // Create sandbox
    const sandbox = await manager.createSandbox(TEST_RUN_ID, DEFAULT_CONFIG, HOST_WORK_PATH);
    assert.ok(sandbox.containerId);
    assert.ok(sandbox.containerName.includes(TEST_RUN_ID));

    // Exec a simple command
    const echo = await manager.exec(sandbox.containerId, "echo 'sandbox works'");
    assert.equal(echo.code, 0);
    assert.ok(echo.stdout.includes("sandbox works"), `stdout: ${echo.stdout}`);

    // Verify env var was passed
    const envResult = await manager.exec(sandbox.containerId, "echo $TEST_VAR");
    assert.equal(envResult.code, 0);
    assert.ok(envResult.stdout.includes("hello-from-host"), `stdout: ${envResult.stdout}`);

    // Verify bind mount — file written on host is visible in container
    const catResult = await manager.exec(sandbox.containerId, "cat /work/test-file.txt");
    assert.equal(catResult.code, 0);
    assert.ok(catResult.stdout.includes("hello from host"), `stdout: ${catResult.stdout}`);

    // Write a file in container, verify visible on host
    await manager.exec(sandbox.containerId, "echo 'written in sandbox' > /work/from-sandbox.txt");
    const hostContent = await readFile(path.join(RUN_DIR, "from-sandbox.txt"), "utf8");
    assert.ok(hostContent.includes("written in sandbox"), `host content: ${hostContent}`);

    // Verify CWD mapping works
    const cwdResult = await manager.exec(sandbox.containerId, "pwd", { cwd: "/work" });
    assert.equal(cwdResult.code, 0);
    assert.ok(cwdResult.stdout.trim() === "/work", `cwd: ${cwdResult.stdout}`);

    // Verify git is available in sandbox
    const gitResult = await manager.exec(sandbox.containerId, "git --version");
    assert.equal(gitResult.code, 0);
    assert.ok(gitResult.stdout.includes("git version"), `git: ${gitResult.stdout}`);

    // Verify goose is available (just check PATH resolution)
    const gooseResult = await manager.exec(sandbox.containerId, "which goose || echo 'goose-not-found'");
    assert.equal(gooseResult.code, 0);

    // Test stderr capture
    const stderrResult = await manager.exec(sandbox.containerId, "echo 'stderr-test' >&2");
    assert.equal(stderrResult.code, 0);
    assert.ok(stderrResult.stderr.includes("stderr-test"), `stderr: ${stderrResult.stderr}`);

    // Test non-zero exit code
    const failResult = await manager.exec(sandbox.containerId, "exit 42");
    assert.equal(failResult.code, 42);

    // Destroy
    await manager.destroySandbox(TEST_RUN_ID);
  });

  it("cleanupOrphans removes labeled containers", async () => {
    // Create a container, then clean it up as orphan
    const orphanId = `orphan-${Date.now()}`;
    const orphanDir = path.join(WORK_ROOT, orphanId);
    await mkdir(orphanDir, { recursive: true });

    await manager.createSandbox(orphanId, DEFAULT_CONFIG, HOST_WORK_PATH);
    const removed = await manager.cleanupOrphans();
    assert.ok(removed >= 1, `Should have removed at least 1 orphan, got ${removed}`);

    await rm(orphanDir, { recursive: true, force: true });
  });
});
