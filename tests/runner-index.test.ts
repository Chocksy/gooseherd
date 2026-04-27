import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

interface CapturedEvent {
  eventType: string;
  sequence: number;
}

interface CapturedCompletion {
  status: string;
  artifactState: string;
  reason?: string;
}

function createRunnerEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const {
    SANDBOX_RUNTIME: _sandboxRuntime,
    SANDBOX_ENABLED: _sandboxEnabled,
    WORK_ROOT: _workRoot,
    PIPELINE_FILE: _pipelineFile,
    DRY_RUN: _dryRun,
    ...baseEnv
  } = process.env;

  return {
    ...baseEnv,
    ...overrides,
  };
}

function jsonResponse(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", String(Buffer.byteLength(body)));
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) as unknown : {};
}

test("runner bootstrap fetches payload, emits run.started, completes with success, and exits 0", async () => {
  const runId = "run-task5";
  const token = "runner-token";
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "gooseherd-runner-test-"));
  const pipelinePath = path.join(tmpRoot, "runner-test-pipeline.yml");
  await writeFile(
    pipelinePath,
    [
      "version: 1",
      "name: runner-test",
      "nodes:",
      "  - id: notify",
      "    type: deterministic",
      "    action: notify",
    ].join("\n"),
    "utf8",
  );

  let payloadFetches = 0;
  const events: CapturedEvent[] = [];
  const completions: CapturedCompletion[] = [];

  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);

    if (req.method === "GET" && req.url === `/internal/runs/${runId}/payload`) {
      payloadFetches += 1;
      jsonResponse(res, 200, {
        runId,
        payloadRef: "payload/run-task5",
        payloadJson: {
          run: {
            id: runId,
            runtime: "kubernetes",
            repoSlug: "org/repo",
            task: "runner bootstrap integration test",
            baseBranch: "main",
            branchName: "goose/test-runner",
            requestedBy: "U123",
            channelId: "runner",
            threadTs: "runner-thread",
            createdAt: new Date("2026-04-10T00:00:00.000Z").toISOString(),
          },
        },
        runtime: "kubernetes",
        createdAt: new Date("2026-04-10T00:00:00.000Z").toISOString(),
        updatedAt: new Date("2026-04-10T00:00:00.000Z").toISOString(),
      });
      return;
    }

    if (req.method === "GET" && req.url === `/internal/runs/${runId}/cancellation`) {
      jsonResponse(res, 200, { cancelRequested: false });
      return;
    }

    if (req.method === "POST" && req.url === `/internal/runs/${runId}/events`) {
      const body = await readJsonBody(req) as { eventType: string; sequence: number };
      events.push({ eventType: body.eventType, sequence: body.sequence });
      jsonResponse(res, 202, { accepted: true });
      return;
    }

    if (req.method === "POST" && req.url === `/internal/runs/${runId}/complete`) {
      const body = await readJsonBody(req) as { status: string; artifactState: string };
      completions.push({ status: body.status, artifactState: body.artifactState });
      jsonResponse(res, 202, { accepted: true });
      return;
    }

    jsonResponse(res, 404, { error: "not found" });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/runner/index.ts"],
    {
      cwd: process.cwd(),
      env: createRunnerEnv({
        RUN_ID: runId,
        RUN_TOKEN: token,
        GOOSEHERD_INTERNAL_BASE_URL: baseUrl,
        PIPELINE_FILE: pipelinePath,
        WORK_ROOT: tmpRoot,
        DRY_RUN: "1",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

  const runLogPath = path.join(tmpRoot, runId, "run.log");
  await access(runLogPath);
  const runLog = await readFile(runLogPath, "utf8");

  assert.equal(signal, null);
  assert.equal(code, 0, stderr);
  assert.equal(payloadFetches, 1);
  assert.equal(events.some((event) => event.eventType === "run.started"), true);
  assert.equal(completions.length, 1);
  assert.equal(completions[0]?.status, "success");
  assert.equal(completions[0]?.artifactState, "complete");
  assert.match(runLog, /pipeline started/i);

  await rm(tmpRoot, { recursive: true, force: true });
});

test("runner bootstrap survives transient payload fetch failures before starting the pipeline", async () => {
  const runId = "run-payload-retry";
  const token = "runner-token";
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "gooseherd-runner-payload-retry-"));
  const pipelinePath = path.join(tmpRoot, "runner-payload-retry-test-pipeline.yml");
  await writeFile(
    pipelinePath,
    [
      "version: 1",
      "name: runner-payload-retry-test",
      "nodes:",
      "  - id: notify",
      "    type: deterministic",
      "    action: notify",
    ].join("\n"),
    "utf8",
  );

  let payloadFetches = 0;
  const events: CapturedEvent[] = [];
  const completions: CapturedCompletion[] = [];

  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);

    if (req.method === "GET" && req.url === `/internal/runs/${runId}/payload`) {
      payloadFetches += 1;
      if (payloadFetches <= 5) {
        jsonResponse(res, 503, { error: "temporary startup outage" });
        return;
      }

      jsonResponse(res, 200, {
        runId,
        payloadRef: "payload/run-payload-retry",
        payloadJson: {
          run: {
            id: runId,
            runtime: "kubernetes",
            repoSlug: "org/repo",
            task: "runner payload retry integration test",
            baseBranch: "main",
            branchName: "goose/test-payload-retry",
            requestedBy: "U123",
            channelId: "runner",
            threadTs: "runner-thread",
            createdAt: new Date("2026-04-10T00:00:00.000Z").toISOString(),
          },
        },
        runtime: "kubernetes",
        createdAt: new Date("2026-04-10T00:00:00.000Z").toISOString(),
        updatedAt: new Date("2026-04-10T00:00:00.000Z").toISOString(),
      });
      return;
    }

    if (req.method === "GET" && req.url === `/internal/runs/${runId}/cancellation`) {
      jsonResponse(res, 200, { cancelRequested: false });
      return;
    }

    if (req.method === "POST" && req.url === `/internal/runs/${runId}/events`) {
      const body = await readJsonBody(req) as { eventType: string; sequence: number };
      events.push({ eventType: body.eventType, sequence: body.sequence });
      jsonResponse(res, 202, { accepted: true });
      return;
    }

    if (req.method === "POST" && req.url === `/internal/runs/${runId}/complete`) {
      const body = await readJsonBody(req) as { status: string; artifactState: string };
      completions.push({ status: body.status, artifactState: body.artifactState });
      jsonResponse(res, 202, { accepted: true });
      return;
    }

    jsonResponse(res, 404, { error: "not found" });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/runner/index.ts"],
    {
      cwd: process.cwd(),
      env: createRunnerEnv({
        RUN_ID: runId,
        RUN_TOKEN: token,
        GOOSEHERD_INTERNAL_BASE_URL: baseUrl,
        PIPELINE_FILE: pipelinePath,
        WORK_ROOT: tmpRoot,
        DRY_RUN: "1",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

  assert.equal(signal, null);
  assert.equal(code, 0, stderr);
  assert.equal(payloadFetches, 6);
  assert.equal(events.some((event) => event.eventType === "run.started"), true);
  assert.equal(completions.length, 1);
  assert.equal(completions[0]?.status, "success");

  await rm(tmpRoot, { recursive: true, force: true });
});

test("runner observes cancellation, emits cancellation event, and exits non-zero", async () => {
  const runId = "run-cancel";
  const token = "runner-token";
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "gooseherd-runner-cancel-test-"));
  const pipelinePath = path.join(tmpRoot, "runner-cancel-test-pipeline.yml");
  await writeFile(
    pipelinePath,
    [
      "version: 1",
      "name: runner-cancel-test",
      "nodes:",
      "  - id: wait_01",
      "    type: deterministic",
      "    action: run",
      "    config:",
      "      command: \"sleep 0.1\"",
      "  - id: wait_02",
      "    type: deterministic",
      "    action: run",
      "    config:",
      "      command: \"sleep 0.1\"",
      "  - id: wait_03",
      "    type: deterministic",
      "    action: run",
      "    config:",
      "      command: \"sleep 0.1\"",
      "  - id: wait_04",
      "    type: deterministic",
      "    action: run",
      "    config:",
      "      command: \"sleep 0.1\"",
    ].join("\n"),
    "utf8",
  );

  const events: CapturedEvent[] = [];
  const completions: CapturedCompletion[] = [];
  let cancellationChecks = 0;

  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);

    if (req.method === "GET" && req.url === `/internal/runs/${runId}/payload`) {
      jsonResponse(res, 200, {
        runId,
        payloadRef: "payload/run-cancel",
        payloadJson: {
          run: {
            id: runId,
            runtime: "kubernetes",
            repoSlug: "org/repo",
            task: "runner cancellation integration test",
            baseBranch: "main",
            branchName: "goose/test-cancel",
            requestedBy: "U123",
            channelId: "runner",
            threadTs: "runner-thread",
            createdAt: new Date("2026-04-10T00:00:00.000Z").toISOString(),
          },
        },
        runtime: "kubernetes",
        createdAt: new Date("2026-04-10T00:00:00.000Z").toISOString(),
        updatedAt: new Date("2026-04-10T00:00:00.000Z").toISOString(),
      });
      return;
    }

    if (req.method === "GET" && req.url === `/internal/runs/${runId}/cancellation`) {
      cancellationChecks += 1;
      jsonResponse(res, 200, { cancelRequested: cancellationChecks >= 2 });
      return;
    }

    if (req.method === "POST" && req.url === `/internal/runs/${runId}/events`) {
      const body = await readJsonBody(req) as { eventType: string; sequence: number };
      events.push({ eventType: body.eventType, sequence: body.sequence });
      jsonResponse(res, 202, { accepted: true });
      return;
    }

    if (req.method === "POST" && req.url === `/internal/runs/${runId}/complete`) {
      const body = await readJsonBody(req) as { status: string; artifactState: string; reason?: string };
      completions.push({ status: body.status, artifactState: body.artifactState, reason: body.reason });
      jsonResponse(res, 202, { accepted: true });
      return;
    }

    jsonResponse(res, 404, { error: "not found" });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/runner/index.ts"],
    {
      cwd: process.cwd(),
      env: createRunnerEnv({
        RUN_ID: runId,
        RUN_TOKEN: token,
        GOOSEHERD_INTERNAL_BASE_URL: baseUrl,
        PIPELINE_FILE: pipelinePath,
        WORK_ROOT: tmpRoot,
        DRY_RUN: "1",
        RUNNER_CANCELLATION_POLL_MS: "25",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

  assert.equal(signal, null);
  assert.equal(code, 1, stderr);
  assert.equal(cancellationChecks >= 2, true);
  assert.equal(events.some((event) => event.eventType === "run.cancellation_observed"), true);
  assert.equal(completions.length, 1);
  assert.equal(completions[0]?.status, "failed");
  assert.equal(completions[0]?.reason, "Run cancelled");

  await rm(tmpRoot, { recursive: true, force: true });
});

test("runner keeps a successful run successful when cancellation polling has a transient 500", async () => {
  const runId = "run-cancel-transient";
  const token = "runner-token";
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "gooseherd-runner-transient-cancel-test-"));
  const pipelinePath = path.join(tmpRoot, "runner-transient-cancel-test-pipeline.yml");
  await writeFile(
    pipelinePath,
    [
      "version: 1",
      "name: runner-transient-cancel-test",
      "nodes:",
      "  - id: notify",
      "    type: deterministic",
      "    action: notify",
    ].join("\n"),
    "utf8",
  );

  const completions: CapturedCompletion[] = [];
  let cancellationChecks = 0;

  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);

    if (req.method === "GET" && req.url === `/internal/runs/${runId}/payload`) {
      jsonResponse(res, 200, {
        runId,
        payloadRef: "payload/run-cancel-transient",
        payloadJson: {
          run: {
            id: runId,
            runtime: "kubernetes",
            repoSlug: "org/repo",
            task: "runner transient cancellation integration test",
            baseBranch: "main",
            branchName: "goose/test-cancel-transient",
            requestedBy: "U123",
            channelId: "runner",
            threadTs: "runner-thread",
            createdAt: new Date("2026-04-10T00:00:00.000Z").toISOString(),
          },
        },
        runtime: "kubernetes",
        createdAt: new Date("2026-04-10T00:00:00.000Z").toISOString(),
        updatedAt: new Date("2026-04-10T00:00:00.000Z").toISOString(),
      });
      return;
    }

    if (req.method === "GET" && req.url === `/internal/runs/${runId}/cancellation`) {
      cancellationChecks += 1;
      if (cancellationChecks === 1) {
        jsonResponse(res, 500, { error: "temporary upstream failure" });
        return;
      }
      jsonResponse(res, 200, { cancelRequested: false });
      return;
    }

    if (req.method === "POST" && req.url === `/internal/runs/${runId}/events`) {
      jsonResponse(res, 202, { accepted: true });
      return;
    }

    if (req.method === "POST" && req.url === `/internal/runs/${runId}/complete`) {
      const body = await readJsonBody(req) as { status: string; artifactState: string; reason?: string };
      completions.push({ status: body.status, artifactState: body.artifactState, reason: body.reason });
      jsonResponse(res, 202, { accepted: true });
      return;
    }

    jsonResponse(res, 404, { error: "not found" });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/runner/index.ts"],
    {
      cwd: process.cwd(),
      env: createRunnerEnv({
        RUN_ID: runId,
        RUN_TOKEN: token,
        GOOSEHERD_INTERNAL_BASE_URL: baseUrl,
        PIPELINE_FILE: pipelinePath,
        WORK_ROOT: tmpRoot,
        DRY_RUN: "1",
        RUNNER_CANCELLATION_POLL_MS: "25",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

  assert.equal(signal, null);
  assert.equal(code, 0, stderr);
  assert.equal(cancellationChecks >= 1, true);
  assert.equal(completions.length, 1);
  assert.equal(completions[0]?.status, "success");

  await rm(tmpRoot, { recursive: true, force: true });
});
