import assert from "node:assert/strict";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import test from "node:test";
import { RunnerControlPlaneClient } from "../src/runner/control-plane-client.js";
import type { RunEnvelope, RunnerCompletionPayload, RunnerEventPayload } from "../src/runtime/control-plane-types.js";

const sampleEvent: RunnerEventPayload = {
  eventId: "event-1",
  eventType: "run.progress",
  timestamp: new Date("2026-04-10T00:00:00.000Z").toISOString(),
  sequence: 1,
  payload: { step: "testing" },
};

const sampleCompletion: RunnerCompletionPayload = {
  idempotencyKey: "completion-1",
  status: "failed",
  artifactState: "failed",
  reason: "boom",
};

const samplePayload: RunEnvelope = {
  runId: "run-1",
  payloadRef: "payload-1",
  payloadJson: { task: "smoke" },
  runtime: "kubernetes",
  createdAt: new Date("2026-04-10T00:00:00.000Z").toISOString(),
  updatedAt: new Date("2026-04-10T00:00:00.000Z").toISOString(),
};

const sampleArtifacts = {
  targets: {
    "run.log": {
      class: "log",
      path: "run.log",
      uploadUrl: "https://artifacts.example.com/run.log",
    },
  },
};

function jsonResponse(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", String(Buffer.byteLength(body)));
  res.end(body);
}

function emptyJsonResponse(res: ServerResponse, status: number): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end();
}

function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const sockets = new Set<Socket>();
    const server = http.createServer((req, res) => {
      void handler(req, res);
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to allocate test server port"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            for (const socket of sockets) socket.destroy();
            server.close((err) => (err ? closeReject(err) : closeResolve()));
          }),
      });
    });
  });
}

test("runner client retries 5xx on event append and stops on 401", async () => {
  const statuses = [503, 401];
  let attempts = 0;
  const server = await startServer((req, res) => {
    attempts += 1;
    const status = statuses[attempts - 1] ?? 500;
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/internal/runs/run-1/events");
    if (status === 401) {
      jsonResponse(res, 401, { error: "Unauthorized" });
      return;
    }
    jsonResponse(res, status, { error: "try again" });
  });

  const client = new RunnerControlPlaneClient({
    baseUrl: server.baseUrl,
    runId: "run-1",
    token: "secret",
  });

  try {
    await assert.rejects(
      () => client.appendEvent(sampleEvent, { maxAttempts: 2 }),
      /401|403/,
    );
    assert.equal(attempts, 2);
  } finally {
    await server.close();
  }
});

test("runner client retries 5xx on completion and eventually succeeds", async () => {
  const statuses = [502, 202];
  let attempts = 0;
  const server = await startServer((_req, res) => {
    attempts += 1;
    const status = statuses[attempts - 1] ?? 500;
    if (status === 202) {
      jsonResponse(res, 202, { accepted: true });
      return;
    }
    jsonResponse(res, status, { error: "server error" });
  });

  const client = new RunnerControlPlaneClient({
    baseUrl: server.baseUrl,
    runId: "run-2",
    token: "secret",
  });

  try {
    await client.complete(sampleCompletion, { maxAttempts: 3 });
    assert.equal(attempts, 2);
  } finally {
    await server.close();
  }
});

test("runner client treats 422 as terminal and does not retry", async () => {
  let attempts = 0;
  const server = await startServer((_req, res) => {
    attempts += 1;
    jsonResponse(res, 422, { error: "Invalid payload" });
  });

  const client = new RunnerControlPlaneClient({
    baseUrl: server.baseUrl,
    runId: "run-3",
    token: "secret",
  });

  try {
    await assert.rejects(
      () => client.appendEvent(sampleEvent, { maxAttempts: 5 }),
      /422/,
    );
    assert.equal(attempts, 1);
  } finally {
    await server.close();
  }
});

test("runner client retries request timeout once and then succeeds", async () => {
  let attempts = 0;
  const server = await startServer((_req, res) => {
    attempts += 1;
    if (attempts === 1) return;
    jsonResponse(res, 202, { accepted: true });
  });

  const client = new RunnerControlPlaneClient({
    baseUrl: server.baseUrl,
    runId: "run-timeout",
    token: "secret",
    requestTimeoutMs: 25,
  });

  try {
    await client.complete(sampleCompletion, { maxAttempts: 2 });
    assert.equal(attempts, 2);
  } finally {
    await server.close();
  }
});

test("runner client retries HTTP 408 and then succeeds", async () => {
  let attempts = 0;
  const server = await startServer((_req, res) => {
    attempts += 1;
    if (attempts === 1) {
      jsonResponse(res, 408, { error: "timeout" });
      return;
    }
    jsonResponse(res, 202, { accepted: true });
  });

  const client = new RunnerControlPlaneClient({
    baseUrl: server.baseUrl,
    runId: "run-408",
    token: "secret",
  });

  try {
    await client.appendEvent(sampleEvent, { maxAttempts: 2 });
    assert.equal(attempts, 2);
  } finally {
    await server.close();
  }
});

test("runner client does not retry token usage posts", async () => {
  let attempts = 0;
  const server = await startServer((_req, res) => {
    attempts += 1;
    jsonResponse(res, 503, { error: "server error" });
  });

  const client = new RunnerControlPlaneClient({
    baseUrl: server.baseUrl,
    runId: "run-token-usage",
    token: "secret",
  });

  try {
    await assert.rejects(
      () => client.addTokenUsage({ model: "openai/gpt-4.1-mini", input: 10, output: 20 }, { maxAttempts: 5 }),
      /token-usage/,
    );
    assert.equal(attempts, 1);
  } finally {
    await server.close();
  }
});

test("runner client treats 404 as terminal and does not retry", async () => {
  let attempts = 0;
  const server = await startServer((_req, res) => {
    attempts += 1;
    jsonResponse(res, 404, { error: "not found" });
  });

  const client = new RunnerControlPlaneClient({
    baseUrl: server.baseUrl,
    runId: "run-404",
    token: "secret",
  });

  try {
    await assert.rejects(() => client.getPayload({ maxAttempts: 4 }), /404/);
    assert.equal(attempts, 1);
  } finally {
    await server.close();
  }
});

test("runner client treats 409 as terminal and does not retry", async () => {
  let attempts = 0;
  const server = await startServer((_req, res) => {
    attempts += 1;
    jsonResponse(res, 409, { error: "conflict" });
  });

  const client = new RunnerControlPlaneClient({
    baseUrl: server.baseUrl,
    runId: "run-409",
    token: "secret",
  });

  try {
    await assert.rejects(() => client.complete(sampleCompletion, { maxAttempts: 4 }), /409/);
    assert.equal(attempts, 1);
  } finally {
    await server.close();
  }
});

test("runner client parses payload response body on success", async () => {
  const server = await startServer((_req, res) => {
    jsonResponse(res, 200, samplePayload);
  });

  const client = new RunnerControlPlaneClient({
    baseUrl: server.baseUrl,
    runId: "run-payload",
    token: "secret",
  });

  try {
    const payload = await client.getPayload();
    assert.deepEqual(payload, samplePayload);
  } finally {
    await server.close();
  }
});

test("runner client fails fast when payload success body is empty", async () => {
  const server = await startServer((_req, res) => {
    emptyJsonResponse(res, 200);
  });

  const client = new RunnerControlPlaneClient({
    baseUrl: server.baseUrl,
    runId: "run-empty-payload",
    token: "secret",
  });

  try {
    await assert.rejects(() => client.getPayload({ maxAttempts: 1 }), /invalid success body/i);
  } finally {
    await server.close();
  }
});

test("runner client fails fast when cancellation success body is invalid", async () => {
  const server = await startServer((_req, res) => {
    jsonResponse(res, 200, { cancelRequested: "yes" });
  });

  const client = new RunnerControlPlaneClient({
    baseUrl: server.baseUrl,
    runId: "run-invalid-cancellation",
    token: "secret",
  });

  try {
    await assert.rejects(() => client.getCancellation({ maxAttempts: 1 }), /invalid success body/i);
  } finally {
    await server.close();
  }
});

test("runner client gets artifact upload targets", async () => {
  const server = await startServer((req, res) => {
    assert.equal(req.url, "/internal/runs/run-artifacts/artifacts");
    jsonResponse(res, 200, sampleArtifacts);
  });

  const client = new RunnerControlPlaneClient({
    baseUrl: server.baseUrl,
    runId: "run-artifacts",
    token: "secret",
  });

  try {
    const artifacts = await client.getArtifacts({ maxAttempts: 1 });
    assert.deepEqual(artifacts, sampleArtifacts);
  } finally {
    await server.close();
  }
});

test("runner client uploads binary artifact bodies", async () => {
  let requestBody = Buffer.alloc(0);
  const server = await startServer(async (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/internal/runs/run-upload/artifacts/run.log");
    assert.equal(req.headers.authorization, "Bearer secret");
    assert.equal(req.headers["content-type"], "text/plain");

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    requestBody = Buffer.concat(chunks);
    jsonResponse(res, 202, { accepted: true });
  });

  const client = new RunnerControlPlaneClient({
    baseUrl: server.baseUrl,
    runId: "run-upload",
    token: "secret",
  });

  try {
    await client.uploadArtifact(
      "/internal/runs/run-upload/artifacts/run.log",
      Buffer.from("artifact-body\n", "utf8"),
      "text/plain",
      { maxAttempts: 1 },
    );
    assert.equal(requestBody.toString("utf8"), "artifact-body\n");
  } finally {
    await server.close();
  }
});
