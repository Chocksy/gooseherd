import Docker from "dockerode";
import { accessSync } from "node:fs";
import { PassThrough } from "node:stream";
import type { SandboxConfig, SandboxHandle, SandboxExecResult } from "./types.js";
import { logInfo, logError } from "../logger.js";

const LABEL_KEY = "gooseherd.sandbox";
const LABEL_VALUE = "true";

/**
 * Auto-detect Docker socket path.
 * Checks DOCKER_HOST env var first, then common socket locations (macOS/Linux).
 */
function resolveDockerSocket(): string {
  const envHost = process.env["DOCKER_HOST"];
  if (envHost?.startsWith("unix://")) return envHost.slice(7);

  const home = process.env["HOME"] ?? "";
  const candidates = [
    "/var/run/docker.sock",
    `${home}/.orbstack/run/docker.sock`,
    `${home}/.docker/run/docker.sock`,
    `${home}/Library/Containers/com.docker.docker/Data/docker.raw.sock`
  ];

  for (const p of candidates) {
    try { accessSync(p); return p; } catch { /* skip */ }
  }
  return "/var/run/docker.sock";
}

export class ContainerManager {
  private docker: Docker;

  constructor(socketPath?: string) {
    const resolved = socketPath ?? resolveDockerSocket();
    this.docker = new Docker({ socketPath: resolved });
  }

  /**
   * Create and start a sandbox container for a run.
   * The container runs `sleep infinity` and accepts exec commands.
   */
  async createSandbox(
    runId: string,
    config: SandboxConfig,
    hostWorkPath: string
  ): Promise<SandboxHandle> {
    const containerName = `gooseherd-sandbox-${runId}`;
    const hostRunPath = `${hostWorkPath}/${runId}`;

    logInfo("sandbox: creating container", { containerName, image: config.image });

    const container = await this.docker.createContainer({
      name: containerName,
      Image: config.image,
      Cmd: ["sleep", "infinity"],
      WorkingDir: "/work",
      Env: Object.entries(config.env).map(([k, v]) => `${k}=${v}`),
      Labels: {
        [LABEL_KEY]: LABEL_VALUE,
        "gooseherd.runId": runId
      },
      HostConfig: {
        Binds: [`${hostRunPath}:/work`],
        NetworkMode: config.networkMode,
        NanoCpus: config.cpus * 1e9,
        Memory: config.memoryMb * 1024 * 1024
      }
    });

    try {
      await container.start();
    } catch (startErr) {
      // Clean up the created-but-not-started container
      await container.remove({ force: true }).catch(() => {});
      throw startErr;
    }

    const info = await container.inspect();
    const containerId = info.Id;

    logInfo("sandbox: container started", { containerName, containerId: containerId.slice(0, 12) });

    return { containerId, containerName };
  }

  /**
   * Execute a command inside a running sandbox container.
   */
  async exec(
    containerId: string,
    command: string,
    opts: { cwd?: string; login?: boolean; timeoutMs?: number; onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void } = {}
  ): Promise<SandboxExecResult> {
    const container = this.docker.getContainer(containerId);

    // Build the shell invocation (quote cwd to prevent injection)
    const bashFlag = opts.login ? "-lc" : "-c";
    const cdPrefix = opts.cwd ? `cd '${opts.cwd.replace(/'/g, "'\\''")}' && ` : "";
    const fullCommand = `${cdPrefix}${command}`;

    const exec = await container.exec({
      Cmd: ["bash", bashFlag, fullCommand],
      AttachStdout: true,
      AttachStderr: true
    });

    return new Promise<SandboxExecResult>((resolve, reject) => {
      let settled = false;
      let timeoutHandle: NodeJS.Timeout | undefined;

      exec.start({ hijack: true, stdin: false }, (err: Error | null, rawStream: NodeJS.ReadableStream | undefined) => {
        if (err || !rawStream) {
          reject(err ?? new Error("No stream returned from exec"));
          return;
        }

        let stdout = "";
        let stderr = "";

        // Use dockerode's built-in demuxer which correctly handles
        // cross-chunk frame splitting in the Docker multiplexed protocol.
        const stdoutStream = new PassThrough();
        const stderrStream = new PassThrough();

        stdoutStream.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          stdout += text;
          opts.onStdout?.(text);
        });
        stderrStream.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          stderr += text;
          opts.onStderr?.(text);
        });

        this.docker.modem.demuxStream(rawStream, stdoutStream, stderrStream);

        rawStream.on("end", async () => {
          if (settled) return;
          settled = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);

          try {
            const inspectResult = await exec.inspect();
            resolve({ code: inspectResult.ExitCode ?? 1, stdout, stderr });
          } catch {
            resolve({ code: 1, stdout, stderr });
          }
        });

        rawStream.on("error", (streamErr: Error) => {
          if (settled) return;
          settled = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          reject(streamErr);
        });

        // Timeout handling
        if (opts.timeoutMs && opts.timeoutMs > 0) {
          timeoutHandle = setTimeout(async () => {
            if (settled) return;
            settled = true;
            if ("destroy" in rawStream && typeof rawStream.destroy === "function") {
              (rawStream as NodeJS.ReadableStream & { destroy: () => void }).destroy();
            }
            // Best-effort kill of processes inside the container
            try {
              const killExec = await container.exec({ Cmd: ["kill", "-9", "-1"] });
              await killExec.start({});
            } catch { /* container may already be gone */ }
            resolve({ code: 137, stdout, stderr: stderr + "\n[timeout] command exceeded limit, killed\n" });
          }, opts.timeoutMs);
        }
      });
    });
  }

  /**
   * Stop and remove a sandbox container.
   * Ignores errors if the container is already gone.
   */
  async destroySandbox(runId: string): Promise<void> {
    const containerName = `gooseherd-sandbox-${runId}`;
    try {
      const container = this.docker.getContainer(containerName);
      await container.stop({ t: 5 }).catch(() => {});
      await container.remove({ force: true });
      logInfo("sandbox: container destroyed", { containerName });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("no such container") && !message.includes("Not Found")) {
        logError("sandbox: failed to destroy container", { containerName, error: message });
      }
    }
  }

  /**
   * Remove all orphaned sandbox containers (from crashes/restarts).
   * Called on startup.
   */
  async cleanupOrphans(): Promise<number> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${LABEL_KEY}=${LABEL_VALUE}`] }
    });

    let removed = 0;
    for (const info of containers) {
      try {
        const container = this.docker.getContainer(info.Id);
        await container.stop({ t: 2 }).catch(() => {});
        await container.remove({ force: true });
        removed++;
        logInfo("sandbox: cleaned up orphan", { name: info.Names?.[0], id: info.Id.slice(0, 12) });
      } catch {
        // Ignore — container may have been removed between list and remove
      }
    }

    if (removed > 0) {
      logInfo("sandbox: orphan cleanup complete", { removed });
    }
    return removed;
  }

  /**
   * Check if Docker daemon is reachable.
   */
  async ping(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }
}
