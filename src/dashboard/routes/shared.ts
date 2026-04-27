import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isDashboardAdminPrincipal,
  type DashboardActorPrincipal,
} from "../actor-principal.js";

export function requireDashboardActor(principal: DashboardActorPrincipal | undefined): DashboardActorPrincipal {
  if (!principal) {
    throw new Error("Dashboard session actor is required");
  }
  return principal;
}

export function requireDashboardAdminActor(principal: DashboardActorPrincipal | undefined) {
  if (!isDashboardAdminPrincipal(principal)) {
    throw new Error("Admin dashboard session is required");
  }
  return principal;
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

export function sendText(res: ServerResponse, status: number, text: string, contentType = "text/plain"): void {
  res.statusCode = status;
  res.setHeader("content-type", `${contentType}; charset=utf-8`);
  res.end(text);
}

export function parseLimit(value: string | null): number {
  if (!value) {
    return 100;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    return 100;
  }
  return Math.min(parsed, 500);
}

const MAX_BODY_BYTES = 1024 * 1024;

export async function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let resolved = false;

    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy();
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    req.on("end", () => {
      if (!resolved) {
        resolved = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });

    req.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });
  });
}

export async function readLogTail(logPath: string, lineCount: number): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const content = await readFile(logPath, "utf8");
  const lines = content.split("\n");
  return lines.slice(-Math.max(1, lineCount)).join("\n");
}

export async function readLogFromOffset(logPath: string, offset: number): Promise<{ content: string; newOffset: number }> {
  const { open, stat } = await import("node:fs/promises");
  const fileStats = await stat(logPath);
  const fileSize = fileStats.size;

  if (offset >= fileSize) {
    return { content: "", newOffset: fileSize };
  }

  const fh = await open(logPath, "r");
  try {
    const readSize = fileSize - offset;
    const buffer = Buffer.alloc(readSize);
    await fh.read(buffer, 0, readSize, offset);
    return { content: buffer.toString("utf8"), newOffset: fileSize };
  } finally {
    await fh.close();
  }
}
