import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunnerCompletionPayload, RunnerEventPayload, RunnerTokenUsagePayload } from "./control-plane-types.js";
import { ControlPlaneConflictError, type ControlPlaneStore } from "./control-plane-store.js";
import { authenticateRunnerRequest } from "./control-plane-auth.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { RunStore } from "../store.js";
import { isRecord } from "../utils/type-guards.js";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ARTIFACT_UPLOAD_BYTES = 50 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readBodyBuffer(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let resolved = false;

    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
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
        resolve(Buffer.concat(chunks));
      }
    });

    req.on("error", (error) => {
      if (!resolved) {
        resolved = true;
        reject(error);
      }
    });
  });
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const body = await readBodyBuffer(req, MAX_BODY_BYTES);
  return body === null ? null : body.toString("utf8");
}

type ControlPlaneAction = "payload" | "artifacts" | "artifact_upload" | "cancellation" | "events" | "complete" | "token_usage";

function parseRoute(pathname: string): { runId: string; action: ControlPlaneAction; artifactKey?: string } | undefined {
  try {
    const artifactMatch = /^\/internal\/runs\/([^/]+)\/artifacts\/(.+)$/.exec(pathname);
    if (artifactMatch) {
      return {
        runId: decodeURIComponent(artifactMatch[1] ?? ""),
        action: "artifact_upload",
        artifactKey: decodeURIComponent(artifactMatch[2] ?? ""),
      };
    }

    const match = /^\/internal\/runs\/([^/]+)\/(payload|artifacts|cancellation|events|complete|token-usage)$/.exec(pathname);
    if (!match) return undefined;
    const action = match[2] === "token-usage" ? "token_usage" : match[2];
    return { runId: decodeURIComponent(match[1] ?? ""), action: action as ControlPlaneAction };
  } catch {
    return undefined;
  }
}

function validateRunnerEventPayload(value: unknown): value is RunnerEventPayload {
  if (!isRecord(value)) return false;
  if (typeof value.eventId !== "string" || value.eventId.trim() === "") return false;
  if (typeof value.eventType !== "string" || value.eventType.trim() === "") return false;
  if (typeof value.timestamp !== "string" || Number.isNaN(Date.parse(value.timestamp))) return false;
  if (typeof value.sequence !== "number" || !Number.isInteger(value.sequence)) return false;
  if (value.payload !== undefined && !isRecord(value.payload)) return false;
  return true;
}

function validateRunnerCompletionPayload(value: unknown): value is RunnerCompletionPayload {
  if (!isRecord(value)) return false;
  if (typeof value.idempotencyKey !== "string" || value.idempotencyKey.trim() === "") return false;
  if (value.status !== "success" && value.status !== "failed") return false;
  if (value.artifactState !== "complete" && value.artifactState !== "partial" && value.artifactState !== "failed") return false;
  return true;
}

function validateRunnerTokenUsagePayload(value: unknown): value is RunnerTokenUsagePayload {
  if (!isRecord(value)) return false;
  if (typeof value.model !== "string" || value.model.trim() === "") return false;
  if (typeof value.input !== "number" || value.input < 0) return false;
  if (typeof value.output !== "number" || value.output < 0) return false;
  if (value.source !== undefined && value.source !== "quality_gate" && value.source !== "agent") return false;
  if (value.costUsd !== undefined && (typeof value.costUsd !== "number" || value.costUsd < 0)) return false;
  return true;
}

export async function routeControlPlaneRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  controlPlaneStore: ControlPlaneStore,
  artifactStore: ArtifactStore,
  runStore?: Pick<RunStore, "addTokenUsage">,
): Promise<boolean> {
  const route = parseRoute(pathname);
  if (!route) return false;

  const { runId, action, artifactKey } = route;
  const authed = await authenticateRunnerRequest(req, controlPlaneStore, runId);
  if (!authed) {
    sendJson(res, 401, { error: "Unauthorized" });
    return true;
  }

  if (req.method === "GET" && action === "payload") {
    const payload = await controlPlaneStore.getPayload(runId);
    if (!payload) {
      sendJson(res, 404, { error: "Run payload not found" });
      return true;
    }
    sendJson(res, 200, payload);
    return true;
  }

  if (req.method === "GET" && action === "artifacts") {
    const payload = await controlPlaneStore.getPayload(runId);
    if (!payload) {
      sendJson(res, 404, { error: "Run payload not found" });
      return true;
    }
    sendJson(res, 200, await artifactStore.allocateTargets(runId));
    return true;
  }

  if ((req.method === "POST" || req.method === "PUT") && action === "artifact_upload") {
    if (!artifactKey || artifactKey.includes("\\") || artifactKey.includes("..") || artifactKey.startsWith(".") || artifactKey.startsWith("/")) {
      sendJson(res, 400, { error: "Invalid artifact key" });
      return true;
    }

    const artifact = await controlPlaneStore.getArtifact(runId, artifactKey);
    const artifactPath = typeof artifact?.metadata?.path === "string"
      ? artifact.metadata.path
      : undefined;
    if (!artifact || !artifactPath) {
      sendJson(res, 404, { error: "Artifact target not found" });
      return true;
    }

    const body = await readBodyBuffer(req, MAX_ARTIFACT_UPLOAD_BYTES);
    if (body === null) {
      sendJson(res, 413, { error: "Artifact body too large" });
      return true;
    }

    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, body);
    await controlPlaneStore.markArtifactUploaded(runId, artifactKey, {
      sizeBytes: body.length,
      contentType: typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "application/octet-stream",
      uploadedAt: new Date().toISOString(),
    });
    sendJson(res, 202, { accepted: true });
    return true;
  }

  if (req.method === "GET" && action === "cancellation") {
    sendJson(res, 200, await controlPlaneStore.getCancellationState(runId));
    return true;
  }

  if (req.method === "POST" && (action === "events" || action === "complete" || action === "token_usage")) {
    const rawBody = await readBody(req);
    if (rawBody === null) {
      sendJson(res, 413, { error: "Request body too large" });
      return true;
    }

    let parsedBody: unknown;
    try {
      parsedBody = rawBody === "" ? {} : JSON.parse(rawBody);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return true;
    }

    if (action === "events") {
      if (!validateRunnerEventPayload(parsedBody)) {
        sendJson(res, 422, { error: "Invalid runner event payload" });
        return true;
      }
      await controlPlaneStore.appendEvent(runId, parsedBody);
      sendJson(res, 202, { accepted: true });
      return true;
    }

    if (action === "token_usage") {
      if (!runStore) {
        sendJson(res, 501, { error: "Token usage recording is unavailable" });
        return true;
      }
      if (!validateRunnerTokenUsagePayload(parsedBody)) {
        sendJson(res, 422, { error: "Invalid token usage payload" });
        return true;
      }
      await runStore.addTokenUsage(runId, parsedBody);
      sendJson(res, 202, { accepted: true });
      return true;
    }

    if (!validateRunnerCompletionPayload(parsedBody)) {
      sendJson(res, 422, { error: "Invalid runner completion payload" });
      return true;
    }

    let result;
    try {
      result = await controlPlaneStore.recordCompletion(runId, parsedBody);
    } catch (error) {
      if (error instanceof ControlPlaneConflictError) {
        sendJson(res, 409, { error: error.message });
        return true;
      }
      throw error;
    }
    sendJson(res, 202, { accepted: true, completionId: result.id });
    return true;
  }

  sendJson(res, 405, { error: "Method not allowed" });
  return true;
}
