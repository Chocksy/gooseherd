import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

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

export async function runShell(
  command: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; logFile: string; timeoutMs?: number }
): Promise<void> {
  await appendLog(options.logFile, `\n$ ${sanitizeForLogs(command)}\n`);

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

export async function runShellCapture(
  command: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; logFile: string; timeoutMs?: number; login?: boolean }
): Promise<{ code: number; stdout: string; stderr: string }> {
  await appendLog(options.logFile, `\n$ ${sanitizeForLogs(command)}\n`);

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
