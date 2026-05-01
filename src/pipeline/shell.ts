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

/** Returns true when running inside a sandbox context (commands route through Docker). */
export function isInSandbox(): boolean {
  return resolveSandbox() !== undefined;
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

/**
 * Render a command template. Values in `values` are shell-escaped.
 * Values in `rawValues` are substituted as-is (for pre-formatted flag strings).
 */
export function renderTemplate(
  template: string,
  values: Record<string, string>,
  rawValues?: Record<string, string>
): string {
  let output = template;
  for (const [key, value] of Object.entries(values)) {
    output = output.replaceAll(`{{${key}}}`, shellEscape(value));
  }
  if (rawValues) {
    for (const [key, value] of Object.entries(rawValues)) {
      output = output.replaceAll(`{{${key}}}`, value);
    }
  }
  return output;
}

export function buildMcpFlags(extensions: string[]): string {
  return extensions
    .filter(ext => ext.trim())
    .map(ext => `--with-extension ${shellEscape(ext)}`)
    .join(" ");
}

export function buildPiExtensionFlags(extensions: string[]): string {
  return extensions
    .filter(ext => ext.trim())
    .map(ext => `-e ${shellEscape(ext)}`)
    .join(" ");
}

/**
 * Per-runId line buffer for stdout mirroring. Agent stdout/stderr arrives in
 * arbitrary chunks, so we accumulate a partial trailing line and emit only
 * complete `\n`-terminated lines as `[run:<id>] <line>` to keep Loki/Grafana
 * parsing clean.
 */
const runLogMirrorBuffers = new Map<string, string>();

function shouldMirrorRunLog(): boolean {
  return process.env.RUN_LOG_MIRROR_STDOUT === "true";
}

function deriveRunIdFromLogFile(logFile: string): string {
  // Convention: <workRoot>/<runId>/run.log — see pipeline-engine.ts.
  return path.basename(path.dirname(logFile));
}

function mirrorRunLogChunk(runId: string, content: string): void {
  if (!content || !runId) return;
  const sanitized = sanitizeForLogs(content);
  const combined = (runLogMirrorBuffers.get(runId) ?? "") + sanitized;
  const lines = combined.split("\n");
  const tail = lines.pop() ?? "";
  for (const line of lines) {
    process.stdout.write(`[run:${runId}] ${line}\n`);
  }
  if (tail) {
    runLogMirrorBuffers.set(runId, tail);
  } else {
    runLogMirrorBuffers.delete(runId);
  }
}

/**
 * Flush any buffered partial line for the given run. Call at end-of-run so
 * trailing content without a final `\n` still reaches stdout.
 */
export function flushRunLogMirror(runId: string): void {
  const tail = runLogMirrorBuffers.get(runId);
  if (tail) {
    process.stdout.write(`[run:${runId}] ${tail}\n`);
    runLogMirrorBuffers.delete(runId);
  }
}

export async function appendLog(logFile: string, content: string): Promise<void> {
  await writeFile(logFile, content, { flag: "a" });
  if (shouldMirrorRunLog()) {
    mirrorRunLogChunk(deriveRunIdFromLogFile(logFile), content);
  }
}

export function sanitizeForLogs(input: string): string {
  let output = input;
  // GitHub access tokens in URLs
  output = output.replace(/x-access-token:[^@'\s]+@/g, "x-access-token:***@");
  // GitHub PATs (ghp_, gho_, ghu_, ghs_, ghr_)
  output = output.replace(/\b(gh[pousr]_[A-Za-z0-9_]+)\b/g, "***");
  // Anthropic API keys (sk-ant-api...)
  output = output.replace(/\bsk-ant-[A-Za-z0-9_-]+\b/g, "***");
  // OpenAI API keys (sk-proj-..., sk-...)
  output = output.replace(/\bsk-proj-[A-Za-z0-9_-]+\b/g, "***");
  output = output.replace(/\bsk-[A-Za-z0-9]{20,}\b/g, "***");
  // Slack tokens (xoxb-, xoxp-, xoxa-, xoxo-, xoxs-, xoxr-)
  output = output.replace(/\bxox[bpaosr]-[A-Za-z0-9-]+\b/g, "***");
  // Generic long bearer/api tokens (catch-all for OpenRouter and others)
  output = output.replace(/\b(Bearer\s+)[A-Za-z0-9_-]{30,}\b/g, "$1***");
  return output;
}

/** Shared sleep utility for polling loops. */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
      },
      stdio: ["ignore", "pipe", "pipe"]
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
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
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

  // Local spawn path
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    let settled = false;
    const bashFlags = options.login ? "-lc" : "-c";
    const child = spawn("bash", [bashFlags, command], {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    const killChild = (reason: string) => {
      if (settled) return;
      appendLog(options.logFile, `\n[${reason}]\n`).catch(() => {});
      child.kill("SIGTERM");
      setTimeout(() => { if (!settled) child.kill("SIGKILL"); }, 5000);
    };

    let timeoutHandle: NodeJS.Timeout | undefined;
    if (options.timeoutMs && options.timeoutMs > 0) {
      const timeoutMs = options.timeoutMs;
      timeoutHandle = setTimeout(() => {
        killChild(`timeout: command exceeded ${String(Math.floor(timeoutMs / 1000))}s, terminating`);
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
