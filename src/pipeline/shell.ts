import { writeFile } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ContainerManager } from "../sandbox/container-manager.js";

// ── Sandbox integration ──

let _containerManager: ContainerManager | undefined;
let _workRoot = "";

interface SandboxContext {
  containerId: string;
  runId: string;
}

/**
 * AsyncLocalStorage for the current sandbox context.
 * Each pipeline execution runs inside its own async context, so concurrent
 * runs never interfere with each other.
 */
const sandboxStorage = new AsyncLocalStorage<SandboxContext>();

/** Called once at startup when sandbox mode is enabled. */
export function setSandboxManager(manager: ContainerManager, workRoot: string): void {
  _containerManager = manager;
  _workRoot = workRoot;
}

/**
 * Run `fn` in an async context where shell commands automatically route
 * through the given sandbox container. Concurrency-safe via AsyncLocalStorage.
 */
export function runInSandboxContext<T>(containerId: string, runId: string, fn: () => Promise<T>): Promise<T> {
  return sandboxStorage.run({ containerId, runId }, fn);
}

/** Resolve effective sandboxId: explicit option > async context > undefined */
function resolveSandbox(optionSandboxId?: string): string | undefined {
  return optionSandboxId ?? sandboxStorage.getStore()?.containerId;
}

/**
 * Map a process-visible path to the container-side path.
 *
 * The sandbox bind mount maps `hostWorkPath/{runId} → /work`, so the mapping
 * computes the path relative to `workRoot/{runId}` (the run directory), then
 * joins it under `/work`.
 *
 * When not in sandbox context, returns the original path unchanged.
 * This allows node handlers to call it unconditionally on paths they embed
 * in command strings — it's a no-op outside sandbox mode.
 *
 * Examples (in sandbox context with runId="abc123"):
 *   .work/abc123/repo       → /work/repo
 *   .work/abc123/task.md    → /work/task.md
 *   /absolute/other/path    → /work  (fallback for paths outside run dir)
 */
export function mapToContainerPath(processPath: string): string {
  const ctx = sandboxStorage.getStore();
  if (!ctx) return processPath;

  const runDir = path.resolve(_workRoot, ctx.runId);
  const resolvedPath = path.resolve(processPath);
  const rel = path.relative(runDir, resolvedPath);
  if (rel.startsWith("..")) {
    // Not under the run directory — map to /work root
    // This handles implement.ts using cwd: path.resolve(".")
    return "/work";
  }
  return path.posix.join("/work", rel.split(path.sep).join("/"));
}

// ── Utilities ──

export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function renderTemplate(template: string, values: Record<string, string>): string {
  let output = template;
  for (const [key, value] of Object.entries(values)) {
    output = output.replaceAll(`{{${key}}}`, shellEscape(value));
  }
  return output;
}

export function buildMcpFlags(extensions: string[]): string {
  return extensions
    .filter(ext => ext.trim())
    .map(ext => `--with-extension ${shellEscape(ext)}`)
    .join(" ");
}

export async function appendLog(logFile: string, content: string): Promise<void> {
  await writeFile(logFile, content, { flag: "a" });
}

export function sanitizeForLogs(input: string): string {
  let output = input;
  output = output.replace(/x-access-token:[^@'\s]+@/g, "x-access-token:***@");
  output = output.replace(/\b(gh[pousr]_[A-Za-z0-9_]+)\b/g, "***");
  return output;
}

// ── Shell execution functions ──

export interface ShellOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logFile: string;
  timeoutMs?: number;
  /** When set, route execution through this sandbox container instead of local spawn. */
  sandboxId?: string;
}

export async function runShell(
  command: string,
  options: ShellOptions
): Promise<void> {
  await appendLog(options.logFile, `\n$ ${sanitizeForLogs(command)}\n`);

  const effectiveSandbox = resolveSandbox(options.sandboxId);
  if (effectiveSandbox) {
    if (!_containerManager) {
      throw new Error("Sandbox container ID is set but no ContainerManager is configured");
    }
    const containerCwd = options.cwd ? mapToContainerPath(options.cwd) : undefined;
    const logFile = options.logFile;
    const result = await _containerManager.exec(effectiveSandbox, command, {
      cwd: containerCwd,
      login: true,
      timeoutMs: options.timeoutMs,
      onStdout: (chunk) => { appendLog(logFile, chunk).catch(() => {}); },
      onStderr: (chunk) => { appendLog(logFile, chunk).catch(() => {}); }
    });

    if (result.code !== 0) {
      throw new Error(
        `Command failed with exit code ${String(result.code)}: ${sanitizeForLogs(command)}`
      );
    }
    return;
  }

  // Local spawn path (existing behavior)
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const child = spawn("bash", ["-lc", command], {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env
      }
    });

    let timeoutHandle: NodeJS.Timeout | undefined;
    if (options.timeoutMs && options.timeoutMs > 0) {
      const timeoutMs = options.timeoutMs;
      timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        appendLog(
          options.logFile,
          `\n[timeout] command exceeded ${String(Math.floor(timeoutMs / 1000))}s, terminating\n`
        ).catch(() => {});
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!settled) {
            child.kill("SIGKILL");
          }
        }, 5000);
      }, timeoutMs);
    }

    child.stdout.on("data", async (chunk) => {
      await appendLog(options.logFile, chunk.toString());
    });

    child.stderr.on("data", async (chunk) => {
      await appendLog(options.logFile, chunk.toString());
    });

    child.on("exit", (code) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (settled) {
        return;
      }
      settled = true;
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Command failed with exit code ${String(code)}: ${sanitizeForLogs(command)}`
        )
      );
    });

    child.on("error", (error) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
  });
}

/**
 * Run a shell command like runShell, but with an onStderr callback
 * for real-time progress reporting (e.g. git clone --progress).
 */
export async function runShellWithProgress(
  command: string,
  options: { cwd?: string; logFile: string; onStderr?: (chunk: string) => void; sandboxId?: string }
): Promise<void> {
  await appendLog(options.logFile, `\n$ ${sanitizeForLogs(command)}\n`);

  const effectiveSandbox = resolveSandbox(options.sandboxId);
  if (effectiveSandbox) {
    if (!_containerManager) {
      throw new Error("Sandbox container ID is set but no ContainerManager is configured");
    }
    const containerCwd = options.cwd ? mapToContainerPath(options.cwd) : undefined;
    const logFile = options.logFile;
    const result = await _containerManager.exec(effectiveSandbox, command, {
      cwd: containerCwd,
      login: true,
      onStdout: (chunk) => { appendLog(logFile, chunk).catch(() => {}); },
      onStderr: (chunk) => {
        appendLog(logFile, chunk).catch(() => {});
        options.onStderr?.(chunk);
      }
    });

    if (result.code !== 0) {
      throw new Error(`Command failed with exit code ${String(result.code)}: ${sanitizeForLogs(command)}`);
    }
    return;
  }

  // Local spawn path (existing behavior)
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const child = spawn("bash", ["-lc", command], {
      cwd: options.cwd,
      env: process.env
    });

    child.stdout.on("data", async (chunk) => {
      await appendLog(options.logFile, chunk.toString());
    });

    child.stderr.on("data", async (chunk) => {
      const text = chunk.toString();
      await appendLog(options.logFile, text);
      options.onStderr?.(text);
    });

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Command failed with exit code ${String(code)}: ${sanitizeForLogs(command)}`));
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

export interface ShellCaptureOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logFile: string;
  timeoutMs?: number;
  login?: boolean;
  sandboxId?: string;
}

export async function runShellCapture(
  command: string,
  options: ShellCaptureOptions
): Promise<{ code: number; stdout: string; stderr: string }> {
  await appendLog(options.logFile, `\n$ ${sanitizeForLogs(command)}\n`);

  const effectiveSandbox = resolveSandbox(options.sandboxId);
  if (effectiveSandbox) {
    if (!_containerManager) {
      throw new Error("Sandbox container ID is set but no ContainerManager is configured");
    }
    const containerCwd = options.cwd ? mapToContainerPath(options.cwd) : undefined;
    const logFile = options.logFile;
    const result = await _containerManager.exec(effectiveSandbox, command, {
      cwd: containerCwd,
      login: options.login,
      timeoutMs: options.timeoutMs,
      onStdout: (chunk) => { appendLog(logFile, chunk).catch(() => {}); },
      onStderr: (chunk) => { appendLog(logFile, chunk).catch(() => {}); }
    });

    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  }

  // Local spawn path (existing behavior)
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    let settled = false;
    const bashFlags = options.login ? "-lc" : "-c";
    const child = spawn("bash", [bashFlags, command], {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env
      }
    });

    let stdout = "";
    let stderr = "";

    let timeoutHandle: NodeJS.Timeout | undefined;
    if (options.timeoutMs && options.timeoutMs > 0) {
      const timeoutMs = options.timeoutMs;
      timeoutHandle = setTimeout(() => {
        if (settled) return;
        appendLog(
          options.logFile,
          `\n[timeout] command exceeded ${String(Math.floor(timeoutMs / 1000))}s, terminating\n`
        ).catch(() => {});
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!settled) child.kill("SIGKILL");
        }, 5000);
      }, timeoutMs);
    }

    child.stdout.on("data", async (chunk) => {
      const text = chunk.toString();
      stdout += text;
      await appendLog(options.logFile, text);
    });

    child.stderr.on("data", async (chunk) => {
      const text = chunk.toString();
      stderr += text;
      await appendLog(options.logFile, text);
    });

    child.on("exit", (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (settled) return;
      settled = true;
      resolve({ code: code ?? 1, stdout, stderr });
    });

    child.on("error", (error) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}
