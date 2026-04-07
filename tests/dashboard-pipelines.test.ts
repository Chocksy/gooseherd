/**
 * Tests for dashboard pipeline CRUD API routes.
 * Tests GET/POST/PUT/DELETE /api/pipelines and /api/pipelines/validate.
 */

import assert from "node:assert/strict";
import { describe, test, afterEach } from "node:test";
import http from "node:http";
import type { AppConfig } from "../src/config.js";
import { RunStore } from "../src/store.js";
import { startDashboardServer } from "../src/dashboard-server.js";
import type { PipelineStore, StoredPipeline } from "../src/pipeline/pipeline-store.js";
import type { PipelineConfig } from "../src/pipeline/types.js";
import { GitHubService } from "../src/github.js";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ── Helpers ──

let nextPort = 29300 + Math.floor(Math.random() * 1000);
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

const SAMPLE_STORED: StoredPipeline = {
  id: "default",
  name: "Default Pipeline",
  description: "The default pipeline",
  yaml: "version: 1\nname: Default Pipeline\nnodes:\n  - id: step1\n    type: deterministic\n    action: run",
  isBuiltIn: true,
  nodeCount: 1,
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
};

const SAMPLE_STORED_2: StoredPipeline = {
  id: "custom",
  name: "Custom Pipeline",
  yaml: "version: 1\nname: Custom Pipeline\nnodes:\n  - id: s1\n    type: deterministic\n    action: run",
  isBuiltIn: false,
  nodeCount: 1,
  createdAt: "2025-02-01T00:00:00.000Z",
  updatedAt: "2025-02-01T00:00:00.000Z",
};

function createMockPipelineStore(pipelines: StoredPipeline[] = [SAMPLE_STORED, SAMPLE_STORED_2]): PipelineStore {
  const store = [...pipelines];

  return {
    list() { return [...store]; },
    get(id: string) { return store.find(p => p.id === id); },
    async save(id: string, yaml: string) {
      const existing = store.find(p => p.id === id);
      if (existing?.isBuiltIn) throw new Error(`Cannot overwrite built-in pipeline '${id}'`);
      const saved: StoredPipeline = {
        id,
        name: "Saved " + id,
        yaml,
        isBuiltIn: false,
        nodeCount: 1,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      if (existing) {
        const idx = store.indexOf(existing);
        store[idx] = saved;
      } else {
        store.push(saved);
      }
      return saved;
    },
    async delete(id: string) {
      const idx = store.findIndex(p => p.id === id);
      if (idx === -1) return false;
      if (store[idx]!.isBuiltIn) return false;
      store.splice(idx, 1);
      return true;
    },
    validate(yaml: string) {
      if (!yaml || yaml.includes("INVALID")) throw new Error("Invalid pipeline YAML");
      return { version: 1, name: "Validated", nodes: [{ id: "s1", type: "deterministic", action: "run" }] } as unknown as PipelineConfig;
    },
  } as unknown as PipelineStore;
}

async function request(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers: bodyStr ? { "content-type": "application/json", "content-length": Buffer.byteLength(bodyStr) } : {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data: Record<string, unknown>;
          try { data = JSON.parse(text); } catch { data = { raw: text }; }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Wait for server to be ready
async function waitForServer(port: number, maxMs = 3000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await request(port, "GET", "/healthz");
      if (res.status === 200) return;
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("Server did not start in time");
}

// ── Tests ──

describe("Dashboard Pipeline API routes", () => {
  const servers: http.Server[] = [];
  const tmpDirs: string[] = [];
  const originalCreateGitHubService = GitHubService.create;

  afterEach(async () => {
    GitHubService.create = originalCreateGitHubService;
    for (const dir of tmpDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tmpDirs.length = 0;
  });

  async function startServer(pipelineStore?: PipelineStore): Promise<number> {
    const port = getPort();
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gooseherd-dash-pipe-"));
    tmpDirs.push(tmpDir);
    const dataDir = path.join(tmpDir, "data");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dataDir, { recursive: true });
    const config = makeConfig(port, dataDir);
    const store = new RunStore(dataDir);
    await store.init();
    startDashboardServer(config, store, undefined, undefined, undefined, pipelineStore);
    await waitForServer(port);
    return port;
  }

  test("GET /api/pipelines returns 501 when pipeline store not available", async () => {
    const port = await startServer(undefined);
    const res = await request(port, "GET", "/api/pipelines");
    assert.equal(res.status, 501);
    assert.equal(res.data.error, "Pipeline store not available");
  });

  test("GET /api/pipelines lists all pipelines", async () => {
    const mockStore = createMockPipelineStore();
    const port = await startServer(mockStore);
    const res = await request(port, "GET", "/api/pipelines");
    assert.equal(res.status, 200);
    const pipelines = res.data.pipelines as StoredPipeline[];
    assert.equal(pipelines.length, 2);
    assert.equal(pipelines[0]?.id, "default");
    assert.equal(pipelines[1]?.id, "custom");
  });

  test("GET /api/github/repositories returns 501 when GitHub integration is unavailable", async () => {
    GitHubService.create = () => undefined;
    const port = await startServer();
    const res = await request(port, "GET", "/api/github/repositories");
    assert.equal(res.status, 501);
    assert.equal(res.data.error, "GitHub integration is not configured");
  });

  test("GET /api/github/repositories lists accessible repositories", async () => {
    GitHubService.create = () => ({
      listAccessibleRepos: async () => [
        {
          fullName: "acme/private-repo",
          private: true,
          defaultBranch: "main",
          htmlUrl: "https://github.com/acme/private-repo",
        },
        {
          fullName: "acme/public-repo",
          private: false,
          defaultBranch: "develop",
          htmlUrl: "https://github.com/acme/public-repo",
        },
      ],
    }) as GitHubService;

    const port = await startServer();
    const res = await request(port, "GET", "/api/github/repositories");
    assert.equal(res.status, 200);
    assert.equal((res.data.repositories as Array<{ fullName: string }>).length, 2);
    assert.equal((res.data.repositories as Array<{ fullName: string }>)[0]?.fullName, "acme/private-repo");
    assert.equal(res.data.cached, false);
  });

  test("GET /api/pipelines/:id returns a single pipeline", async () => {
    const mockStore = createMockPipelineStore();
    const port = await startServer(mockStore);
    const res = await request(port, "GET", "/api/pipelines/default");
    assert.equal(res.status, 200);
    const pipeline = res.data.pipeline as StoredPipeline;
    assert.equal(pipeline.id, "default");
    assert.equal(pipeline.name, "Default Pipeline");
  });

  test("GET /api/pipelines/:id returns 404 for unknown pipeline", async () => {
    const mockStore = createMockPipelineStore();
    const port = await startServer(mockStore);
    const res = await request(port, "GET", "/api/pipelines/nonexistent");
    assert.equal(res.status, 404);
    assert.ok((res.data.error as string).includes("not found"));
  });

  test("POST /api/pipelines creates a new pipeline", async () => {
    const mockStore = createMockPipelineStore();
    const port = await startServer(mockStore);
    const res = await request(port, "POST", "/api/pipelines", {
      id: "new-pipe",
      yaml: "version: 1\nname: New\nnodes: []",
    });
    assert.equal(res.status, 201);
    const pipeline = res.data.pipeline as StoredPipeline;
    assert.equal(pipeline.id, "new-pipe");

    // Verify it shows up in list
    const list = await request(port, "GET", "/api/pipelines");
    assert.equal((list.data.pipelines as StoredPipeline[]).length, 3);
  });

  test("POST /api/pipelines returns 400 for missing fields", async () => {
    const mockStore = createMockPipelineStore();
    const port = await startServer(mockStore);

    const noId = await request(port, "POST", "/api/pipelines", { yaml: "test" });
    assert.equal(noId.status, 400);
    assert.ok((noId.data.error as string).includes("id and yaml are required"));

    const noYaml = await request(port, "POST", "/api/pipelines", { id: "test" });
    assert.equal(noYaml.status, 400);
    assert.ok((noYaml.data.error as string).includes("id and yaml are required"));
  });

  test("POST /api/pipelines returns 400 for invalid JSON", async () => {
    const mockStore = createMockPipelineStore();
    const port = await startServer(mockStore);
    const res = await request(port, "POST", "/api/pipelines");
    // Sending empty body
    assert.equal(res.status, 400);
  });

  test("POST /api/pipelines returns 400 when saving built-in pipeline", async () => {
    const mockStore = createMockPipelineStore();
    const port = await startServer(mockStore);
    const res = await request(port, "POST", "/api/pipelines", {
      id: "default",
      yaml: "version: 1\nname: Override\nnodes: []",
    });
    assert.equal(res.status, 400);
    assert.ok((res.data.error as string).includes("built-in"));
  });

  test("PUT /api/pipelines/:id updates an existing pipeline", async () => {
    const mockStore = createMockPipelineStore();
    const port = await startServer(mockStore);
    const res = await request(port, "PUT", "/api/pipelines/custom", {
      yaml: "version: 1\nname: Updated Custom\nnodes: []",
    });
    assert.equal(res.status, 200);
    const pipeline = res.data.pipeline as StoredPipeline;
    assert.equal(pipeline.id, "custom");
  });

  test("PUT /api/pipelines/:id returns 400 for missing yaml", async () => {
    const mockStore = createMockPipelineStore();
    const port = await startServer(mockStore);
    const res = await request(port, "PUT", "/api/pipelines/custom", {});
    assert.equal(res.status, 400);
    assert.ok((res.data.error as string).includes("yaml is required"));
  });

  test("DELETE /api/pipelines/:id deletes a non-built-in pipeline", async () => {
    const mockStore = createMockPipelineStore();
    const port = await startServer(mockStore);
    const res = await request(port, "DELETE", "/api/pipelines/custom");
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);

    // Verify it's gone
    const list = await request(port, "GET", "/api/pipelines");
    assert.equal((list.data.pipelines as StoredPipeline[]).length, 1);
  });

  test("DELETE /api/pipelines/:id returns 400 for built-in pipeline", async () => {
    const mockStore = createMockPipelineStore();
    const port = await startServer(mockStore);
    const res = await request(port, "DELETE", "/api/pipelines/default");
    assert.equal(res.status, 400);
    assert.ok((res.data.error as string).includes("Cannot delete"));
  });

  test("DELETE /api/pipelines/:id returns 400 for unknown pipeline", async () => {
    const mockStore = createMockPipelineStore();
    const port = await startServer(mockStore);
    const res = await request(port, "DELETE", "/api/pipelines/nonexistent");
    assert.equal(res.status, 400);
  });

  test("POST /api/pipelines/validate returns valid for good YAML", async () => {
    const mockStore = createMockPipelineStore();
    const port = await startServer(mockStore);
    const res = await request(port, "POST", "/api/pipelines/validate", {
      yaml: "version: 1\nname: Good\nnodes:\n  - id: s1\n    type: deterministic\n    action: run",
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.valid, true);
    assert.equal(res.data.name, "Validated");
    assert.equal(res.data.nodeCount, 1);
  });

  test("POST /api/pipelines/validate returns invalid for bad YAML", async () => {
    const mockStore = createMockPipelineStore();
    const port = await startServer(mockStore);
    const res = await request(port, "POST", "/api/pipelines/validate", {
      yaml: "INVALID content",
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.valid, false);
    assert.ok(res.data.error);
  });

  test("POST /api/pipelines/validate returns 400 for missing yaml", async () => {
    const mockStore = createMockPipelineStore();
    const port = await startServer(mockStore);
    const res = await request(port, "POST", "/api/pipelines/validate", {});
    assert.equal(res.status, 400);
    assert.ok((res.data.error as string).includes("yaml is required"));
  });

  test("POST /api/pipelines/validate returns 501 without pipeline store", async () => {
    const port = await startServer(undefined);
    const res = await request(port, "POST", "/api/pipelines/validate", { yaml: "test" });
    assert.equal(res.status, 501);
  });

  test("pipeline routes return 501 for all methods when store unavailable", async () => {
    const port = await startServer(undefined);

    const get = await request(port, "GET", "/api/pipelines/test");
    assert.equal(get.status, 501);

    const put = await request(port, "PUT", "/api/pipelines/test", { yaml: "test" });
    assert.equal(put.status, 501);

    const del = await request(port, "DELETE", "/api/pipelines/test");
    assert.equal(del.status, 501);

    const post = await request(port, "POST", "/api/pipelines", { id: "t", yaml: "y" });
    assert.equal(post.status, 501);
  });
});
