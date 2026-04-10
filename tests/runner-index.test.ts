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
      env: {
        ...process.env,
        RUN_ID: runId,
        RUN_TOKEN: token,
        GOOSEHERD_INTERNAL_BASE_URL: baseUrl,
        PIPELINE_FILE: pipelinePath,
        WORK_ROOT: tmpRoot,
        DRY_RUN: "1",
      },
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
