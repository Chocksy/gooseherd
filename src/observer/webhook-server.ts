/**
 * Webhook Receiver — separate HTTP server for external webhooks.
 *
 * Runs on OBSERVER_WEBHOOK_PORT, separate from the dashboard.
 * Routes:
 *   POST /webhooks/github  — GitHub webhook events (HMAC-verified)
 *   POST /webhooks/sentry  — Sentry webhook events (HMAC-verified)
 *   GET  /health            — Health check
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { logError, logInfo } from "../logger.js";
import { verifyGitHubSignature, parseGitHubWebhook, type GitHubWebhookHeaders } from "./sources/github-webhook-adapter.js";
import { verifySentrySignature, parseSentryWebhook, type SentryWebhookHeaders } from "./sources/sentry-webhook-adapter.js";
import type { TriggerEvent } from "./types.js";

/** Max request body size: 1 MB */
const MAX_BODY_BYTES = 1024 * 1024;

export interface WebhookServerConfig {
  port: number;
  githubWebhookSecret?: string;
  sentryWebhookSecret?: string;
  /** Slack channel for Sentry alert notifications */
  sentryAlertChannelId?: string;
  /** Per-source webhook secrets for custom adapters: { source: secret } */
  adapterSecrets?: Record<string, string>;
}

export type OnEventCallback = (event: TriggerEvent) => void;
export type OnGitHubWebhookPayloadCallback = (
  headers: GitHubWebhookHeaders,
  payload: Record<string, unknown>
) => Promise<void> | void;
export type OnAdapterPayloadCallback = (
  source: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>
) => Promise<boolean> | boolean;

/**
 * Start the webhook receiver HTTP server.
 *
 * Returns a handle with stop() for graceful shutdown.
 */
export function startWebhookServer(
  config: WebhookServerConfig,
  onEvent: OnEventCallback,
  hooks?: {
    onGitHubWebhookPayload?: OnGitHubWebhookPayloadCallback;
    onAdapterPayload?: OnAdapterPayloadCallback;
  }
): { server: Server; stop: () => Promise<void> } {
  const server = createServer((req, res) => {
    handleRequest(req, res, config, onEvent, hooks).catch((err) => {
      const msg = err instanceof Error ? err.message : "unknown";
      logError("Webhook request error", { error: msg });
      sendJson(res, 500, { error: "Internal server error" });
    });
  });

  server.listen(config.port, () => {
    logInfo("Webhook server listening", { port: config.port });
  });

  const stop = (): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  };

  return { server, stop };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: WebhookServerConfig,
  onEvent: OnEventCallback,
  hooks?: {
    onGitHubWebhookPayload?: OnGitHubWebhookPayloadCallback;
    onAdapterPayload?: OnAdapterPayloadCallback;
  }
): Promise<void> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  // Health check
  if (url === "/health" && method === "GET") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  // GitHub webhook
  if (url === "/webhooks/github" && method === "POST") {
    await handleGitHubWebhook(req, res, config, onEvent, hooks?.onGitHubWebhookPayload);
    return;
  }

  // Sentry webhook
  if (url === "/webhooks/sentry" && method === "POST") {
    await handleSentryWebhook(req, res, config, onEvent);
    return;
  }

  // Generic adapter webhook: /webhooks/{source}
  const adapterMatch = url.match(/^\/webhooks\/([a-z0-9_-]+)$/);
  if (adapterMatch && method === "POST") {
    await handleAdapterWebhook(req, res, config, onEvent, adapterMatch[1]!, hooks?.onAdapterPayload);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function handleGitHubWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  config: WebhookServerConfig,
  onEvent: OnEventCallback,
  onGitHubWebhookPayload?: OnGitHubWebhookPayloadCallback
): Promise<void> {
  // Read body with size limit
  const body = await readBody(req);
  if (body === null) {
    sendJson(res, 413, { error: "Request body too large" });
    return;
  }

  // Verify HMAC signature (required — webhook server should not run without a secret)
  if (!config.githubWebhookSecret) {
    sendJson(res, 500, { error: "Webhook secret not configured" });
    return;
  }
  const signature = req.headers["x-hub-signature-256"] as string | undefined;
  if (!verifyGitHubSignature(body, signature, config.githubWebhookSecret)) {
    sendJson(res, 401, { error: "Invalid signature" });
    return;
  }

  // Parse payload
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { error: "Invalid JSON" });
    return;
  }

  const headers: GitHubWebhookHeaders = {
    "x-github-event": req.headers["x-github-event"] as string | undefined,
    "x-hub-signature-256": req.headers["x-hub-signature-256"] as string | undefined,
    "x-github-delivery": req.headers["x-github-delivery"] as string | undefined
  };

  if (onGitHubWebhookPayload) {
    await onGitHubWebhookPayload(headers, payload);
  }

  const event = parseGitHubWebhook(headers, payload);

  if (event) {
    onEvent(event);
    sendJson(res, 200, { accepted: true, eventId: event.id });
  } else {
    // Valid webhook but not an actionable event type
    sendJson(res, 200, { accepted: false, reason: "event type not actionable" });
  }
}

async function handleSentryWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  config: WebhookServerConfig,
  onEvent: OnEventCallback
): Promise<void> {
  const body = await readBody(req);
  if (body === null) {
    sendJson(res, 413, { error: "Request body too large" });
    return;
  }

  if (!config.sentryWebhookSecret) {
    sendJson(res, 500, { error: "Sentry webhook secret not configured" });
    return;
  }

  const signature = req.headers["sentry-hook-signature"] as string | undefined;
  if (!verifySentrySignature(body, signature, config.sentryWebhookSecret)) {
    sendJson(res, 401, { error: "Invalid signature" });
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { error: "Invalid JSON" });
    return;
  }

  const headers: SentryWebhookHeaders = {
    "sentry-hook-resource": req.headers["sentry-hook-resource"] as string | undefined,
    "sentry-hook-timestamp": req.headers["sentry-hook-timestamp"] as string | undefined,
    "sentry-hook-signature": req.headers["sentry-hook-signature"] as string | undefined
  };

  const event = parseSentryWebhook(headers, payload, config.sentryAlertChannelId ?? "");

  if (event) {
    onEvent(event);
    sendJson(res, 200, { accepted: true, eventId: event.id });
  } else {
    sendJson(res, 200, { accepted: false, reason: "event type not actionable" });
  }
}

async function handleAdapterWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  config: WebhookServerConfig,
  onEvent: OnEventCallback,
  source: string,
  onAdapterPayload?: OnAdapterPayloadCallback,
): Promise<void> {
  const { getAdapter } = await import("./sources/adapter-registry.js");
  const adapter = getAdapter(source);
  if (!adapter) {
    sendJson(res, 404, { error: `No adapter registered for source: ${source}` });
    return;
  }

  const body = await readBody(req);
  if (body === null) {
    sendJson(res, 413, { error: "Request body too large" });
    return;
  }

  // Look up secret for this source
  const secret = config.adapterSecrets?.[source];
  if (secret) {
    const headers = flattenHeaders(req.headers);
    if (!adapter.verifySignature(body, headers, secret)) {
      sendJson(res, 401, { error: "Invalid signature" });
      return;
    }
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON" });
    return;
  }

  const headers = flattenHeaders(req.headers);
  const handled = await onAdapterPayload?.(source, headers, payload as Record<string, unknown>) ?? false;
  const event = adapter.parseEvent(headers, payload);

  if (event) {
    onEvent(event);
    sendJson(res, 200, { accepted: true, eventId: event.id });
  } else if (handled) {
    sendJson(res, 200, { accepted: true, handled: true });
  } else {
    sendJson(res, 200, { accepted: false, reason: "event type not actionable" });
  }
}

/** Flatten IncomingHttpHeaders to Record<string, string> */
function flattenHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      flat[key] = value;
    } else if (Array.isArray(value)) {
      flat[key] = value[0] ?? "";
    }
  }
  return flat;
}

function readBody(req: IncomingMessage): Promise<string | null> {
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
      chunks.push(chunk);
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

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
