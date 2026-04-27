import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { eq } from "drizzle-orm";
import type { AppConfig } from "../src/config.js";
import { startDashboardServer } from "../src/dashboard-server.js";
import { runArtifacts, runCompletions, runEvents, runs } from "../src/db/schema.js";
import { ControlPlaneStore } from "../src/runtime/control-plane-store.js";
import { FileArtifactStore } from "../src/runtime/file-artifact-store.js";
import { RunStore } from "../src/store.js";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../src/db/index.js";
import type { ArtifactStore } from "../src/runtime/artifact-store.js";

let nextPort = 30700 + Math.floor(Math.random() * 1000);
function getPort(): number {
  return nextPort++;
}

function makeConfig(port: number, dataDir: string): AppConfig {
  return {
    appName: "test",
    appSlug: "test",
    slackCommandName: "/goose",
    slackAllowedChannels: [],
    repoAllowlist: [],
    runnerConcurrency: 1,
    workRoot: dataDir,
    dataDir,
    dryRun: false,
    branchPrefix: "goose/",
    defaultBaseBranch: "main",
    gitAuthorName: "Test",
    gitAuthorEmail: "test@test.com",
    agentCommandTemplate: "echo dummy-agent",
    validationCommand: "true",
    lintFixCommand: "true",
    localTestCommand: "true",
    maxValidationRounds: 3,
    agentTimeoutSeconds: 300,
    slackProgressHeartbeatSeconds: 30,
    dashboardEnabled: true,
    dashboardHost: "127.0.0.1",
    dashboardPort: port,
    maxTaskChars: 10000,
    workspaceCleanupEnabled: false,
    workspaceMaxAgeHours: 24,
    workspaceCleanupIntervalMinutes: 60,
    cemsEnabled: false,
    mcpExtensions: [],
    piAgentExtensions: [],
    pipelineFile: "pipelines/default.yml",
    observerEnabled: false,
    observerAlertChannelId: "",
    observerMaxRunsPerDay: 10,
    observerMaxRunsPerRepoPerDay: 5,
    observerCooldownMinutes: 10,
    observerRulesFile: "observer-rules.yml",
    observerRepoMap: new Map(),
    observerSlackWatchedChannels: [],
    observerSlackBotAllowlist: [],
    observerSentryPollIntervalSeconds: 300,
    observerWebhookPort: 0,
    observerWebhookSecrets: {},
    observerGithubPollIntervalSeconds: 300,
    observerGithubWatchedRepos: [],
    defaultLlmModel: "test",
    planTaskModel: "test",
    scopeJudgeEnabled: false,
    scopeJudgeModel: "test",
    scopeJudgeMinPassScore: 0.7,
    orchestratorModel: "test",
    orchestratorTimeoutMs: 30000,
    orchestratorWallClockTimeoutMs: 60000,
    observerSmartTriageEnabled: false,
    observerSmartTriageModel: "test",
    observerSmartTriageTimeoutMs: 30000,
    browserVerifyEnabled: false,
    screenshotEnabled: false,
    browserVerifyModel: "test",
    browserVerifyMaxSteps: 10,
    browserVerifyExecTimeoutMs: 60000,
    ciWaitEnabled: false,
    ciPollIntervalSeconds: 30,
    ciPatienceTimeoutSeconds: 120,
    ciMaxWaitSeconds: 600,
    ciCheckFilter: [],
    ciMaxFixRounds: 3,
    teamChannelMap: new Map(),
    sandboxRuntime: "local",
    sandboxRuntimeExplicit: false,
    sandboxEnabled: false,
    sandboxImage: "node:20-slim",
    sandboxHostWorkPath: "",
    sandboxCpus: 1,
    sandboxMemoryMb: 512,
    supervisorEnabled: false,
    supervisorRunTimeoutSeconds: 3600,
    supervisorNodeStaleSeconds: 600,
    supervisorWatchdogIntervalSeconds: 30,
    supervisorMaxAutoRetries: 2,
    supervisorRetryCooldownSeconds: 60,
    supervisorMaxRetriesPerDay: 5,
    autonomousSchedulerEnabled: false,
    autonomousSchedulerMaxDeferred: 100,
    autonomousSchedulerIntervalMs: 300_000,
  } as AppConfig;
}

async function insertRun(db: Database, runId: string): Promise<void> {
  await db.insert(runs).values({
    id: runId,
    runtime: "kubernetes",
    status: "running",
    phase: "queued",
    repoSlug: "owner/repo",
    task: "control-plane router test",
    baseBranch: "main",
    branchName: "goose/control-plane-router-test",
    requestedBy: "U1",
    channelId: "C1",
    threadTs: runId,
  });
}

async function request(
  port: number,
  method: string,
  requestPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const bodyStr = typeof body === "string"
      ? body
      : Buffer.isBuffer(body)
        ? body
        : body
          ? JSON.stringify(body)
          : undefined;
    const requestHeaders = {
      ...headers,
      ...(bodyStr
        ? {
            ...(!headers["content-type"] ? { "content-type": "application/json" } : {}),
            "content-length": String(Buffer.byteLength(bodyStr)),
          }
        : {}),
    };
    const req = http.request(
      { hostname: "127.0.0.1", port, path: requestPath, method, headers: requestHeaders },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(text) as Record<string, unknown>;
          } catch {
            data = { raw: text };
          }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function authedRequest(
  port: number,
  token: string,
  method: string,
  requestPath: string,
  body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return request(port, method, requestPath, body, { authorization: `Bearer ${token}` });
}

async function waitForServer(port: number, maxMs = 3000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await request(port, "GET", "/healthz");
      if (res.status === 200) return;
    } catch {
      // Not started yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Server did not start in time");
}

async function startTestServer(
  db: Database,
  controlPlaneStore: ControlPlaneStore,
  runnerArtifactStore?: ArtifactStore,
): Promise<number> {
  const port = getPort();
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gooseherd-control-plane-"));
  const dataDir = path.join(tmpDir, "data");
  await mkdir(dataDir, { recursive: true });
  const config = makeConfig(port, dataDir);
  const resolvedRunnerArtifactStore = runnerArtifactStore
    ?? new FileArtifactStore(
      config.workRoot,
      `http://${config.dashboardHost}:${String(config.dashboardPort)}`,
      controlPlaneStore,
    );
  const runStore = new RunStore(db);
  await runStore.init();
  startDashboardServer(
    config,
    runStore,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    controlPlaneStore,
    resolvedRunnerArtifactStore,
  );
  await waitForServer(port);
  return port;
}

test("GET /internal/runs/:runId/payload requires a valid bearer token", async () => {
  const { db, cleanup } = await createTestDb();
  const controlPlaneStore = new ControlPlaneStore(db);
  const runId = "11111111-1111-1111-1111-111111111111";
  await insertRun(db, runId);
  await controlPlaneStore.createRunEnvelope({
    runId,
    payloadRef: `payload/${runId}`,
    payloadJson: { task: "fix bug" },
    runtime: "kubernetes",
  });

  const port = await startTestServer(db, controlPlaneStore);
  const res = await request(port, "GET", `/internal/runs/${runId}/payload`);

  assert.equal(res.status, 401);
  await cleanup();
});

test("GET /internal/runs/:runId/payload returns 404 when payload is missing", async () => {
  const { db, cleanup } = await createTestDb();
  const controlPlaneStore = new ControlPlaneStore(db);
  const runId = "22222222-2222-2222-2222-222222222222";
  await insertRun(db, runId);
  const { token } = await controlPlaneStore.issueRunToken(runId);

  const port = await startTestServer(db, controlPlaneStore);
  const res = await authedRequest(port, token, "GET", `/internal/runs/${runId}/payload`);

  assert.equal(res.status, 404);
  await cleanup();
});

test("GET /internal/runs/:runId/artifacts returns 404 when payload is missing", async () => {
  const { db, cleanup } = await createTestDb();
  const controlPlaneStore = new ControlPlaneStore(db);
  const runId = "33333333-3333-3333-3333-333333333333";
  await insertRun(db, runId);
  const { token } = await controlPlaneStore.issueRunToken(runId);
  let allocateCalls = 0;

  const port = await startTestServer(db, controlPlaneStore, {
    allocateTargets: async (runId: string) => {
      allocateCalls += 1;
      return { runId, targets: [] };
    },
  });
  const res = await authedRequest(port, token, "GET", `/internal/runs/${runId}/artifacts`);

  assert.equal(res.status, 404);
  assert.equal(allocateCalls, 0);
  await cleanup();
});

test("GET /internal/runs/:runId/artifacts returns stable upload targets", async () => {
  const { db, cleanup } = await createTestDb();
  const controlPlaneStore = new ControlPlaneStore(db);
  const runId = "44444444-4444-4444-4444-444444444444";
  await insertRun(db, runId);
  await controlPlaneStore.createRunEnvelope({
    runId,
    payloadRef: `payload/${runId}`,
    payloadJson: { task: "fix bug" },
    runtime: "kubernetes",
  });
  const { token } = await controlPlaneStore.issueRunToken(runId);

  const port = await startTestServer(db, controlPlaneStore);
  const first = await authedRequest(port, token, "GET", `/internal/runs/${runId}/artifacts`);
  const second = await authedRequest(port, token, "GET", `/internal/runs/${runId}/artifacts`);

  assert.deepEqual(first.data.targets, second.data.targets);
  const targets = first.data.targets as Record<string, { class: string; uploadUrl: string }>;
  assert.equal(targets.log.class, "raw_run_log");
  assert.equal(targets["agent-stdout.log"]?.class, "debug_log");
  assert.equal(targets["agent-stderr.log"]?.class, "debug_log");
  assert.equal(targets["auto-review-summary.json"]?.class, "internal_artifact");
  assert.equal(targets["auto-review-summary.json"]?.uploadUrl, `/internal/runs/${runId}/artifacts/auto-review-summary.json`);
  await cleanup();
});

test("POST /internal/runs/:runId/artifacts/run.log stores uploaded bytes and marks artifact complete", async () => {
  const { db, cleanup } = await createTestDb();
  const controlPlaneStore = new ControlPlaneStore(db);
  const runId = "44444444-4444-4444-4444-555555555555";
  await insertRun(db, runId);
  await controlPlaneStore.createRunEnvelope({
    runId,
    payloadRef: `payload/${runId}`,
    payloadJson: { task: "upload run log" },
    runtime: "kubernetes",
  });
  const { token } = await controlPlaneStore.issueRunToken(runId);

  const port = await startTestServer(db, controlPlaneStore);
  const artifactsRes = await authedRequest(port, token, "GET", `/internal/runs/${runId}/artifacts`);
  const uploadUrl = (artifactsRes.data.targets as Record<string, { uploadUrl: string }>).log.uploadUrl;
  const uploadPath = new URL(uploadUrl, `http://127.0.0.1:${String(port)}`).pathname;

  const uploadRes = await request(
    port,
    "POST",
    uploadPath,
    "runner log body\n",
    {
      authorization: `Bearer ${token}`,
      "content-type": "text/plain",
    },
  );

  assert.equal(uploadRes.status, 202);

  const artifactRows = await db.select().from(runArtifacts).where(eq(runArtifacts.runId, runId));
  const logArtifact = artifactRows.find((row) => row.artifactKey === "run.log");
  assert.equal(logArtifact?.status, "complete");

  const artifactPath = String((logArtifact?.metadata as { path?: string })?.path ?? "");
  assert.match(await (await import("node:fs/promises")).readFile(artifactPath, "utf8"), /runner log body/);
  await cleanup();
});

test("POST /internal/runs/:runId/events deduplicates repeated eventId", async () => {
  const { db, cleanup } = await createTestDb();
  const controlPlaneStore = new ControlPlaneStore(db);
  const runId = "55555555-5555-5555-5555-555555555555";
  await insertRun(db, runId);
  await controlPlaneStore.createRunEnvelope({
    runId,
    payloadRef: `payload/${runId}`,
    payloadJson: { task: "fix bug" },
    runtime: "kubernetes",
  });
  const { token } = await controlPlaneStore.issueRunToken(runId);

  const port = await startTestServer(db, controlPlaneStore);
  const eventBody = {
    eventId: "evt-1",
    eventType: "run.phase_changed",
    timestamp: new Date().toISOString(),
    sequence: 1,
    payload: { phase: "running" },
  };

  const first = await authedRequest(port, token, "POST", `/internal/runs/${runId}/events`, eventBody);
  const second = await authedRequest(port, token, "POST", `/internal/runs/${runId}/events`, eventBody);
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);

  const eventRows = await db.select().from(runEvents).where(eq(runEvents.runId, runId));
  assert.equal(eventRows.length, 1);
  await cleanup();
});

test("POST /internal/runs/:runId/events returns 422 for invalid payload shape", async () => {
  const { db, cleanup } = await createTestDb();
  const controlPlaneStore = new ControlPlaneStore(db);
  const runId = "66666666-6666-6666-6666-666666666666";
  await insertRun(db, runId);
  await controlPlaneStore.createRunEnvelope({
    runId,
    payloadRef: `payload/${runId}`,
    payloadJson: { task: "fix bug" },
    runtime: "kubernetes",
  });
  const { token } = await controlPlaneStore.issueRunToken(runId);

  const port = await startTestServer(db, controlPlaneStore);
  const res = await authedRequest(port, token, "POST", `/internal/runs/${runId}/events`, {
    eventType: "run.phase_changed",
    timestamp: new Date().toISOString(),
    sequence: 1,
  });

  assert.equal(res.status, 422);
  await cleanup();
});

test("POST /internal/runs/:runId/complete returns 422 for invalid payload shape", async () => {
  const { db, cleanup } = await createTestDb();
  const controlPlaneStore = new ControlPlaneStore(db);
  const runId = "77777777-7777-7777-7777-777777777777";
  await insertRun(db, runId);
  await controlPlaneStore.createRunEnvelope({
    runId,
    payloadRef: `payload/${runId}`,
    payloadJson: { task: "fix bug" },
    runtime: "kubernetes",
  });
  const { token } = await controlPlaneStore.issueRunToken(runId);

  const port = await startTestServer(db, controlPlaneStore);
  const res = await authedRequest(port, token, "POST", `/internal/runs/${runId}/complete`, {
    status: "success",
    artifactState: "complete",
  });

  assert.equal(res.status, 422);
  await cleanup();
});

test("POST /internal/runs/:runId/complete returns 409 for conflicting completion idempotency key", async () => {
  const { db, cleanup } = await createTestDb();
  const controlPlaneStore = new ControlPlaneStore(db);
  const runId = "88888888-8888-8888-8888-888888888888";
  await insertRun(db, runId);
  await controlPlaneStore.createRunEnvelope({
    runId,
    payloadRef: `payload/${runId}`,
    payloadJson: { task: "fix bug" },
    runtime: "kubernetes",
  });
  const { token } = await controlPlaneStore.issueRunToken(runId);

  const port = await startTestServer(db, controlPlaneStore);
  const first = await authedRequest(port, token, "POST", `/internal/runs/${runId}/complete`, {
    idempotencyKey: "complete-1",
    status: "success",
    artifactState: "complete",
  });
  const second = await authedRequest(port, token, "POST", `/internal/runs/${runId}/complete`, {
    idempotencyKey: "complete-2",
    status: "success",
    artifactState: "complete",
  });

  assert.equal(first.status, 202);
  assert.equal(second.status, 409);
  const completionRows = await db.select().from(runCompletions).where(eq(runCompletions.runId, runId));
  assert.equal(completionRows.length, 1);
  assert.equal(completionRows[0]?.idempotencyKey, "complete-1");
  await cleanup();
});
