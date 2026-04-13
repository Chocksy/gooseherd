import assert from "node:assert/strict";
import { afterEach, describe, mock, test } from "node:test";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import type { AppConfig } from "../src/config.js";
import { startDashboardServer } from "../src/dashboard-server.js";
import { createTestDb } from "./helpers/test-db.js";

let nextPort = 32500 + Math.floor(Math.random() * 1000);
function getPort(): number {
  return nextPort++;
}

function makeConfig(port: number, dataDir: string): AppConfig {
  return {
    appName: "test",
    appSlug: "test",
    slackCommandName: "/goose",
    slackAllowedChannels: [],
    slackClientId: "111.222",
    slackClientSecret: "slack-secret",
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
    dashboardToken: "admin-secret",
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
    scopeJudgeMinPassScore: 1,
    orchestratorModel: "test",
    orchestratorTimeoutMs: 30000,
    orchestratorWallClockTimeoutMs: 60000,
    autonomousSchedulerEnabled: false,
    autonomousSchedulerMaxDeferred: 100,
    autonomousSchedulerIntervalMs: 300_000,
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
    featureDeliveryResetEngineeringReviewOnNewCommits: false,
    featureDeliveryResetQaReviewOnNewCommits: false,
    workItemGithubAdoptionLabels: ["ai_flow"],
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
    databaseUrl: "postgres://gooseherd:gooseherd@postgres:5432/gooseherd_test",
    slackBotToken: "xoxb-test",
  } as AppConfig;
}

function startAuthTestServer(config: AppConfig, db: Awaited<ReturnType<typeof createTestDb>>["db"]) {
  return startDashboardServer(
    config,
    {} as any,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    db,
  );
}

async function request(
  port: number,
  method: string,
  pathname: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      method,
      path: pathname,
      headers: {
        ...(body ? {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": Buffer.byteLength(body).toString(),
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
    if (body) req.write(body);
    req.end();
  });
}

async function waitForServer(port: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      const res = await request(port, "GET", "/healthz");
      if (res.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server on ${String(port)} did not become ready`);
}

afterEach(async () => {
  mock.restoreAll();
});

describe("dashboard auth routes", () => {
  test("login page renders admin and slack options", async (t) => {
    const testDb = await createTestDb();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "dashboard-auth-"));
    const port = getPort();
    const server = startAuthTestServer(makeConfig(port, dataDir), testDb.db);
    t.after(async () => {
      server.close();
      await rm(dataDir, { recursive: true, force: true });
      await testDb.cleanup();
    });
    await waitForServer(port);

    const res = await request(port, "GET", "/login");
    assert.equal(res.status, 200);
    assert.match(res.text, /Admin login/);
    assert.match(res.text, /Sign in with Slack/);
    assert.match(res.text, /Sign up with Slack/);
  });

  test("admin login creates db-backed session and logout clears it", async (t) => {
    const testDb = await createTestDb();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "dashboard-auth-"));
    const port = getPort();
    const server = startAuthTestServer(makeConfig(port, dataDir), testDb.db);
    t.after(async () => {
      server.close();
      await rm(dataDir, { recursive: true, force: true });
      await testDb.cleanup();
    });
    await waitForServer(port);

    const loginRes = await request(port, "POST", "/login", "token=admin-secret");
    assert.equal(loginRes.status, 302);
    const cookie = (loginRes.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "";
    assert.match(cookie, /gooseherd-session=/);

    const pageRes = await request(port, "GET", "/", undefined, { cookie });
    assert.equal(pageRes.status, 200);

    const logoutRes = await request(port, "POST", "/logout", undefined, { cookie });
    assert.equal(logoutRes.status, 302);
    assert.equal(logoutRes.headers.location, "/login");
  });

  test("slack sign up creates user and session when mapped team exists", async (t) => {
    const testDb = await createTestDb();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "dashboard-auth-"));
    const port = getPort();
    await testDb.db.insert((await import("../src/db/schema.js")).teams).values({
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      name: "devops",
      slackChannelId: "C_DEVOPS",
      slackUserGroupId: "S_DEVOPS",
      slackUserGroupHandle: "devops",
    });

    mock.method(globalThis, "fetch", async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("openid.connect.token")) {
        const payload = {
          nonce: "",
          "https://slack.com/user_id": "U_NEW",
          name: "New User",
        };
        // nonce will be replaced after parsing redirect state
        throw new Error(`Unexpected token call payload request: ${JSON.stringify(payload)}`);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const server = startAuthTestServer(makeConfig(port, dataDir), testDb.db);
    t.after(async () => {
      server.close();
      await rm(dataDir, { recursive: true, force: true });
      await testDb.cleanup();
    });
    await waitForServer(port);

    const signupRes = await request(port, "GET", "/auth/slack/signup");
    assert.equal(signupRes.status, 302);
    const location = signupRes.headers.location ?? "";
    assert.match(location, /openid\/connect\/authorize/);
    const state = new URL(location).searchParams.get("state");
    const nonce = new URL(location).searchParams.get("nonce");
    assert.ok(state);
    assert.ok(nonce);

    mock.restoreAll();
    mock.method(globalThis, "fetch", async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("openid.connect.token")) {
        const payload = {
          nonce,
          "https://slack.com/user_id": "U_NEW",
          name: "New User",
        };
        const token = `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;
        return new Response(JSON.stringify({ ok: true, access_token: "xoxp-new", id_token: token }), { status: 200 });
      }
      if (url.includes("openid.connect.userInfo")) {
        return new Response(JSON.stringify({
          ok: true,
          "https://slack.com/user_id": "U_NEW",
          name: "New User",
        }), { status: 200 });
      }
      if (url.includes("usergroups.users.list") && url.includes("S_DEVOPS")) {
        return new Response(JSON.stringify({ ok: true, users: ["U_NEW"] }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const callbackRes = await request(port, "GET", `/auth/slack/callback?code=test-code&state=${state}`);
    assert.equal(callbackRes.status, 302);
    assert.equal(callbackRes.headers.location, "/");
    assert.match(callbackRes.headers["set-cookie"]?.[0] ?? "", /gooseherd-session=/);
  });

  test("slack sign in rejects unknown user", async (t) => {
    const testDb = await createTestDb();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "dashboard-auth-"));
    const port = getPort();
    const server = startAuthTestServer(makeConfig(port, dataDir), testDb.db);
    t.after(async () => {
      server.close();
      await rm(dataDir, { recursive: true, force: true });
      await testDb.cleanup();
    });
    await waitForServer(port);

    const signinRes = await request(port, "GET", "/auth/slack/signin");
    const location = signinRes.headers.location ?? "";
    const state = new URL(location).searchParams.get("state");
    const nonce = new URL(location).searchParams.get("nonce");
    assert.ok(state);

    mock.method(globalThis, "fetch", async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("openid.connect.token")) {
        const payload = {
          nonce,
          "https://slack.com/user_id": "U_UNKNOWN",
          name: "Unknown User",
        };
        const token = `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;
        return new Response(JSON.stringify({ ok: true, access_token: "xoxp-unknown", id_token: token }), { status: 200 });
      }
      if (url.includes("openid.connect.userInfo")) {
        return new Response(JSON.stringify({
          ok: true,
          "https://slack.com/user_id": "U_UNKNOWN",
          name: "Unknown User",
        }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const callbackRes = await request(port, "GET", `/auth/slack/callback?code=test-code&state=${state}`);
    assert.equal(callbackRes.status, 302);
    assert.match(callbackRes.headers.location ?? "", /not%20registered/);
  });
});
