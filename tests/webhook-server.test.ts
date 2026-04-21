import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";
import test from "node:test";
import { startWebhookServer } from "../src/observer/webhook-server.js";

let nextPort = 33600 + Math.floor(Math.random() * 1000);

function getPort(): number {
  return nextPort++;
}

function signGitHubWebhook(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function requestJson(
  port: number,
  method: string,
  pathname: string,
  body?: Record<string, unknown>,
  headers?: Record<string, string>,
  timeoutMs = 500,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const bodyText = body ? JSON.stringify(body) : undefined;
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      method,
      path: pathname,
      headers: {
        ...(bodyText ? {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(bodyText).toString(),
        } : {}),
        ...(headers ?? {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          text: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request timed out after ${String(timeoutMs)}ms`));
    });
    if (bodyText) req.write(bodyText);
    req.end();
  });
}

test("github webhook responds before waiting for async payload sync", async (t) => {
  const port = getPort();
  let releasePayloadSync: (() => void) | undefined;
  const payloadSyncBlocked = new Promise<void>((resolve) => {
    releasePayloadSync = resolve;
  });
  let markPayloadSyncStarted: (() => void) | undefined;
  const payloadSyncStarted = new Promise<void>((resolve) => {
    markPayloadSyncStarted = resolve;
  });

  const handle = startWebhookServer(
    {
      port,
      githubWebhookSecret: "github-secret",
    },
    () => {},
    {
      onGitHubWebhookPayload: async () => {
        markPayloadSyncStarted?.();
        await payloadSyncBlocked;
      },
    },
  );

  t.after(async () => {
    releasePayloadSync?.();
    await handle.stop();
  });

  await new Promise<void>((resolve) => {
    if (handle.server.listening) {
      resolve();
      return;
    }
    handle.server.once("listening", () => resolve());
  });

  const body = {
    action: "labeled",
    number: 6,
    repository: { full_name: "vsevolod/openai_bot" },
    pull_request: {
      number: 6,
      labels: [{ name: "QA passed" }],
    },
    label: { name: "QA passed" },
  };
  const bodyText = JSON.stringify(body);

  const response = await requestJson(
    port,
    "POST",
    "/webhooks/github",
    body,
    {
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-qa-passed",
      "x-hub-signature-256": signGitHubWebhook(bodyText, "github-secret"),
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.text), {
    accepted: false,
    reason: "event type not actionable",
  });

  await payloadSyncStarted;
  releasePayloadSync?.();
});
