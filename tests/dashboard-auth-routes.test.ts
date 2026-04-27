import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, describe, mock, test } from "node:test";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import type { AppConfig } from "../src/config.js";
import { DashboardAuthSessionStore } from "../src/dashboard/auth-session-store.js";
import type { DashboardWorkItemsSource } from "../src/dashboard/contracts.js";
import { startDashboardServer } from "../src/dashboard-server.js";
import { createTestDb } from "./helpers/test-db.js";
import { users } from "../src/db/schema.js";
import type { WorkItemEventRecord, WorkItemRecord } from "../src/work-items/types.js";

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
    workItemGithubAdoptionLabels: ["ai:assist"],
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

function startAuthTestServer(
  config: AppConfig,
  db: Awaited<ReturnType<typeof createTestDb>>["db"],
  workItemsSource?: DashboardWorkItemsSource,
  observer?: any,
) {
  return startDashboardServer(
    config,
    {} as any,
    undefined,
    observer,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    workItemsSource,
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

function signGitHubWebhook(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function requestJson(
  port: number,
  method: string,
  pathname: string,
  body?: Record<string, unknown>,
  headers?: Record<string, string>,
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
    if (bodyText) req.write(bodyText);
    req.end();
  });
}

function makeWorkItem(overrides: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {
    id: overrides.id ?? "work-item-1",
    workflow: overrides.workflow ?? "product_discovery",
    state: overrides.state ?? "backlog",
    substate: overrides.substate,
    flags: overrides.flags ?? [],
    title: overrides.title ?? "Discovery item",
    summary: overrides.summary ?? "Summary",
    ownerTeamId: overrides.ownerTeamId ?? "team-1",
    homeChannelId: overrides.homeChannelId ?? "C_TEAM",
    homeThreadTs: overrides.homeThreadTs ?? "1740000000.000001",
    originChannelId: overrides.originChannelId,
    originThreadTs: overrides.originThreadTs,
    jiraIssueKey: overrides.jiraIssueKey,
    githubPrNumber: overrides.githubPrNumber,
    githubPrUrl: overrides.githubPrUrl,
    sourceWorkItemId: overrides.sourceWorkItemId,
    createdByUserId: overrides.createdByUserId ?? "user-123",
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
    completedAt: overrides.completedAt,
  };
}

function makeDashboardWorkItemsSource(overrides: Partial<DashboardWorkItemsSource> = {}): DashboardWorkItemsSource {
  return {
    listWorkItems: async () => [],
    getWorkItem: async () => undefined,
    listRunsForWorkItem: async () => [],
    listReviewRequestsForWorkItem: async () => [],
    listReviewRequestComments: async () => [],
    listEventsForWorkItem: async (): Promise<WorkItemEventRecord[]> => [],
    createDiscoveryWorkItem: async () => makeWorkItem(),
    createReviewRequests: async () => [],
    respondToReviewRequest: async () => makeWorkItem({ state: "waiting_for_pm_confirmation" }),
    confirmDiscovery: async () => makeWorkItem({ state: "done" }),
    stopProcessing: async () => ({
      workItem: makeWorkItem(),
      stoppedRunIds: [],
      alreadyIdleRunIds: [],
      failedRunIds: [],
    }),
    guardedOverrideState: async () => makeWorkItem({ state: "cancelled" }),
    ...overrides,
  };
}

async function createUserSessionCookie(
  db: Awaited<ReturnType<typeof createTestDb>>["db"],
  userId: string,
): Promise<string> {
  await db.insert(users).values({
    id: userId,
    slackUserId: `U_${userId.replace(/[^A-Za-z0-9]/g, "").slice(0, 16) || "TEST"}`,
    displayName: `User ${userId}`,
  });
  const session = await new DashboardAuthSessionStore(db).createSession({
    principalType: "user",
    authMethod: "slack",
    userId,
    ttlMs: 60_000,
  });
  return `gooseherd-session=${session.token}`;
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

  test("webhook routes are served on dashboard port without dashboard auth", async (t) => {
    const testDb = await createTestDb();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "dashboard-auth-"));
    const port = getPort();
    const config = makeConfig(port, dataDir);
    config.observerGithubWebhookSecret = "github-secret";
    const observer = {
      getStateSnapshot: async () => ({ enabled: true }),
      getRecentEvents: () => [],
      getRules: () => [],
      handleWebhookHttpRequest: async (_req: http.IncomingMessage, res: http.ServerResponse) => {
        res.statusCode = 202;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ accepted: true }));
        return true;
      },
    };
    const server = startAuthTestServer(config, testDb.db, undefined, observer);
    t.after(async () => {
      server.close();
      await rm(dataDir, { recursive: true, force: true });
      await testDb.cleanup();
    });
    await waitForServer(port);

    const payload = JSON.stringify({ action: "completed" });
    const res = await requestJson(port, "POST", "/webhooks/github", { action: "completed" }, {
      "x-github-event": "check_suite",
      "x-github-delivery": "delivery-1",
      "x-hub-signature-256": signGitHubWebhook(payload, "github-secret"),
    });

    assert.equal(res.status, 202);
    assert.deepEqual(JSON.parse(res.text), { accepted: true });
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

  test("slack sign up creates user and session even when no mapped team exists", async (t) => {
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

    const signupRes = await request(port, "GET", "/auth/slack/signup");
    assert.equal(signupRes.status, 302);
    const location = signupRes.headers.location ?? "";
    const state = new URL(location).searchParams.get("state");
    const nonce = new URL(location).searchParams.get("nonce");
    assert.ok(state);
    assert.ok(nonce);

    mock.method(globalThis, "fetch", async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("openid.connect.token")) {
        const payload = {
          nonce,
          "https://slack.com/user_id": "U_TEAMLESS",
          name: "Teamless User",
        };
        const token = `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;
        return new Response(JSON.stringify({ ok: true, access_token: "xoxp-teamless", id_token: token }), { status: 200 });
      }
      if (url.includes("openid.connect.userInfo")) {
        return new Response(JSON.stringify({
          ok: true,
          "https://slack.com/user_id": "U_TEAMLESS",
          name: "Teamless User",
        }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const callbackRes = await request(port, "GET", `/auth/slack/callback?code=test-code&state=${state}`);
    assert.equal(callbackRes.status, 302);
    assert.equal(callbackRes.headers.location, "/");
    assert.match(callbackRes.headers["set-cookie"]?.[0] ?? "", /gooseherd-session=/);

    const createdUsers = await testDb.db.select().from(users).where((await import("drizzle-orm")).eq(users.slackUserId, "U_TEAMLESS"));
    assert.equal(createdUsers.length, 1);
    assert.equal(createdUsers[0]?.displayName, "Teamless User");
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
    assert.match(callbackRes.headers["set-cookie"]?.[0] ?? "", /SameSite=Lax/);
  });

  test("slack sign in succeeds for an existing user without team memberships", async (t) => {
    const testDb = await createTestDb();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "dashboard-auth-"));
    const port = getPort();
    await testDb.db.insert(users).values({
      id: "22222222-2222-4222-8222-222222222222",
      displayName: "Existing Teamless User",
      slackUserId: "U_EXISTING_TEAMLESS",
      isActive: true,
    });
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
    assert.ok(nonce);

    mock.method(globalThis, "fetch", async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("openid.connect.token")) {
        const payload = {
          nonce,
          "https://slack.com/user_id": "U_EXISTING_TEAMLESS",
          name: "Existing Teamless User",
        };
        const token = `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;
        return new Response(JSON.stringify({ ok: true, access_token: "xoxp-existing-teamless", id_token: token }), { status: 200 });
      }
      if (url.includes("openid.connect.userInfo")) {
        return new Response(JSON.stringify({
          ok: true,
          "https://slack.com/user_id": "U_EXISTING_TEAMLESS",
          name: "Existing Teamless User",
        }), { status: 200 });
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

  test("admin password session may override state using the session-derived admin principal", async (t) => {
    const testDb = await createTestDb();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "dashboard-auth-"));
    const port = getPort();
    let seenActor: { principalType: string; authMethod: string; sessionId?: string } | undefined;
    const workItemsSource = makeDashboardWorkItemsSource({
      guardedOverrideState: async ({ actor }) => {
        seenActor = actor;
        return makeWorkItem({ state: "cancelled" });
      },
    });
    const server = startAuthTestServer(makeConfig(port, dataDir), testDb.db, workItemsSource);
    t.after(async () => {
      server.close();
      await rm(dataDir, { recursive: true, force: true });
      await testDb.cleanup();
    });
    await waitForServer(port);

    const loginRes = await request(port, "POST", "/login", "token=admin-secret");
    const cookie = (loginRes.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "";
    const res = await requestJson(port, "POST", "/api/work-items/work-item-1/override-state", {
      state: "cancelled",
      reason: "manual override",
    }, { cookie });

    assert.equal(res.status, 200);
    assert.deepEqual(seenActor && {
      principalType: seenActor.principalType,
      authMethod: seenActor.authMethod,
      hasSessionId: typeof seenActor.sessionId === "string" && seenActor.sessionId.length > 0,
    }, {
      principalType: "admin_session",
      authMethod: "admin_password",
      hasSessionId: true,
    });
  });

  test("admin password session cannot create discovery items", async (t) => {
    const testDb = await createTestDb();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "dashboard-auth-"));
    const port = getPort();
    const createDiscoveryWorkItem = mock.fn(async () => makeWorkItem());
    const workItemsSource = makeDashboardWorkItemsSource({ createDiscoveryWorkItem });
    const server = startAuthTestServer(makeConfig(port, dataDir), testDb.db, workItemsSource);
    t.after(async () => {
      server.close();
      await rm(dataDir, { recursive: true, force: true });
      await testDb.cleanup();
    });
    await waitForServer(port);

    const loginRes = await request(port, "POST", "/login", "token=admin-secret");
    const cookie = (loginRes.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "";
    const res = await requestJson(port, "POST", "/api/work-items/discovery", {
      title: "Discovery item",
      createdByUserId: "forged-user",
    }, { cookie });

    assert.equal(res.status, 403);
    assert.equal(createDiscoveryWorkItem.mock.callCount(), 0);
  });

  test("admin password session cannot respond to review requests as a workflow participant", async (t) => {
    const testDb = await createTestDb();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "dashboard-auth-"));
    const port = getPort();
    const respondToReviewRequest = mock.fn(async () => makeWorkItem());
    const workItemsSource = makeDashboardWorkItemsSource({ respondToReviewRequest });
    const server = startAuthTestServer(makeConfig(port, dataDir), testDb.db, workItemsSource);
    t.after(async () => {
      server.close();
      await rm(dataDir, { recursive: true, force: true });
      await testDb.cleanup();
    });
    await waitForServer(port);

    const loginRes = await request(port, "POST", "/login", "token=admin-secret");
    const cookie = (loginRes.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "";
    const res = await requestJson(port, "POST", "/api/review-requests/review-1/respond", {
      outcome: "approved",
      authorUserId: "forged-user",
    }, { cookie });

    assert.equal(res.status, 403);
    assert.equal(respondToReviewRequest.mock.callCount(), 0);
  });

  test("users page redirects anonymous requests to login and renders for admin password session", async (t) => {
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

    const anonymousRes = await request(port, "GET", "/users");
    assert.equal(anonymousRes.status, 302);
    assert.equal(anonymousRes.headers.location, "/login");

    const loginRes = await request(port, "POST", "/login", "token=admin-secret");
    const cookie = (loginRes.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "";
    const adminRes = await request(port, "GET", "/users", undefined, { cookie });

    assert.equal(adminRes.status, 200);
    assert.match(adminRes.text, /Users/);
    assert.match(adminRes.text, /New User/);
  });

  test("user session cannot access admin-only users endpoints", async (t) => {
    const testDb = await createTestDb();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "dashboard-auth-"));
    const port = getPort();
    const userId = "33333333-3333-4333-8333-333333333333";
    await testDb.db.insert(users).values({
      id: "44444444-4444-4444-8444-444444444444",
      displayName: "Existing Person",
      slackUserId: "U_EXISTING",
    });
    const server = startAuthTestServer(makeConfig(port, dataDir), testDb.db);
    t.after(async () => {
      server.close();
      await rm(dataDir, { recursive: true, force: true });
      await testDb.cleanup();
    });
    await waitForServer(port);

    const cookie = await createUserSessionCookie(testDb.db, userId);
    const listRes = await requestJson(port, "GET", "/api/users", undefined, { cookie });
    const createRes = await requestJson(port, "POST", "/api/users", {
      displayName: "Should Fail",
    }, { cookie });
    const patchRes = await requestJson(port, "PATCH", "/api/users/44444444-4444-4444-8444-444444444444", {
      displayName: "Still Fails",
    }, { cookie });

    assert.equal(listRes.status, 403);
    assert.equal(createRes.status, 403);
    assert.equal(patchRes.status, 403);
  });

  test("admin password session can list, create, and update users through admin-only endpoints", async (t) => {
    const testDb = await createTestDb();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "dashboard-auth-"));
    const port = getPort();
    await testDb.db.insert(users).values({
      id: "55555555-5555-4555-8555-555555555555",
      displayName: "Alpha User",
      slackUserId: "U_ALPHA",
      githubLogin: "alpha-gh",
    });
    const server = startAuthTestServer(makeConfig(port, dataDir), testDb.db);
    t.after(async () => {
      server.close();
      await rm(dataDir, { recursive: true, force: true });
      await testDb.cleanup();
    });
    await waitForServer(port);

    const loginRes = await request(port, "POST", "/login", "token=admin-secret");
    const cookie = (loginRes.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "";

    const listRes = await requestJson(port, "GET", "/api/users", undefined, { cookie });
    assert.equal(listRes.status, 200);
    assert.equal(JSON.parse(listRes.text).users[0].displayName, "Alpha User");

    const createRes = await requestJson(port, "POST", "/api/users", {
      displayName: "Beta User",
      slackUserId: "U_BETA",
      githubLogin: "beta-gh",
      jiraAccountId: "JIRA_BETA",
      isActive: true,
    }, { cookie });
    assert.equal(createRes.status, 201);
    const createdUser = JSON.parse(createRes.text).user;
    assert.equal(createdUser.githubLogin, "beta-gh");

    const patchRes = await requestJson(port, "PATCH", `/api/users/${createdUser.id}`, {
      displayName: "Beta User Updated",
      slackUserId: "",
      githubLogin: "beta-gh-updated",
      jiraAccountId: "",
      isActive: false,
    }, { cookie });
    assert.equal(patchRes.status, 200);
    const updatedUser = JSON.parse(patchRes.text).user;
    assert.equal(updatedUser.displayName, "Beta User Updated");
    assert.equal(updatedUser.slackUserId, null);
    assert.equal(updatedUser.githubLogin, "beta-gh-updated");
    assert.equal(updatedUser.jiraAccountId, null);
    assert.equal(updatedUser.isActive, false);
  });

  test("user session may create discovery items through the session-derived identity", async (t) => {
    const testDb = await createTestDb();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "dashboard-auth-"));
    const port = getPort();
    const userId = "11111111-1111-4111-8111-111111111111";
    let seenActorUserId: string | undefined;
    const workItemsSource = makeDashboardWorkItemsSource({
      createDiscoveryWorkItem: async ({ actor }) => {
        seenActorUserId = actor.userId;
        return makeWorkItem({ createdByUserId: actor.userId });
      },
    });
    const server = startAuthTestServer(makeConfig(port, dataDir), testDb.db, workItemsSource);
    t.after(async () => {
      server.close();
      await rm(dataDir, { recursive: true, force: true });
      await testDb.cleanup();
    });
    await waitForServer(port);

    const cookie = await createUserSessionCookie(testDb.db, userId);
    const res = await requestJson(port, "POST", "/api/work-items/discovery", {
      title: "Discovery item",
      createdByUserId: "forged-user",
    }, { cookie });

    assert.equal(res.status, 201);
    assert.equal(seenActorUserId, userId);
  });

  test("user session may respond to review requests through the session-derived identity", async (t) => {
    const testDb = await createTestDb();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "dashboard-auth-"));
    const port = getPort();
    const userId = "22222222-2222-4222-8222-222222222222";
    let seenActorUserId: string | undefined;
    const workItemsSource = makeDashboardWorkItemsSource({
      respondToReviewRequest: async ({ actor }) => {
        seenActorUserId = actor.userId;
        return makeWorkItem({ state: "waiting_for_pm_confirmation" });
      },
    });
    const server = startAuthTestServer(makeConfig(port, dataDir), testDb.db, workItemsSource);
    t.after(async () => {
      server.close();
      await rm(dataDir, { recursive: true, force: true });
      await testDb.cleanup();
    });
    await waitForServer(port);

    const cookie = await createUserSessionCookie(testDb.db, userId);
    const res = await requestJson(port, "POST", "/api/review-requests/review-1/respond", {
      outcome: "approved",
      authorUserId: "forged-user",
    }, { cookie });

    assert.equal(res.status, 200);
    assert.equal(seenActorUserId, userId);
  });
});
