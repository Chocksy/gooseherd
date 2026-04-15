import assert from "node:assert/strict";
import { describe, test, afterEach } from "node:test";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../src/config.js";
import { DashboardAuthSessionStore } from "../src/dashboard/auth-session-store.js";
import { startDashboardServer, type DashboardWorkItemsSource } from "../src/dashboard-server.js";
import { RunStore } from "../src/store.js";
import { createTestDb } from "./helpers/test-db.js";
import { teamMembers, teams, users } from "../src/db/schema.js";
import { WorkItemStore } from "../src/work-items/store.js";
import { ReviewRequestStore } from "../src/work-items/review-request-store.js";
import { WorkItemEventsStore } from "../src/work-items/events-store.js";
import { WorkItemService } from "../src/work-items/service.js";

function systemActor(userId: string) {
  return {
    principalType: "user" as const,
    userId,
    authMethod: "system" as const,
  };
}

let nextPort = 30500 + Math.floor(Math.random() * 1000);
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
  } as AppConfig;
}

function createMockRunDatabase() {
  const query = {
    where() { return this; },
    orderBy() { return this; },
    limit() { return Promise.resolve([]); },
  };

  return {
    select() {
      return {
        from() {
          return query;
        },
      };
    },
  };
}

async function request(
  port: number,
  method: string,
  pathname: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method,
        headers: bodyStr
          ? {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(bodyStr),
            ...(headers ?? {}),
          }
          : headers,
      },
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

async function waitForServer(port: number, maxMs = 3000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await request(port, "GET", "/healthz");
      if (res.status === 200) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Server did not start in time");
}

describe("Dashboard Work Item API routes", () => {
  const servers: http.Server[] = [];
  const tmpDirs: string[] = [];
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const server of servers) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    servers.length = 0;

    for (const cleanup of cleanups) {
      await cleanup();
    }
    cleanups.length = 0;

    for (const dir of tmpDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tmpDirs.length = 0;
  });

  async function startServer(
    workItemsSource?: DashboardWorkItemsSource,
    db?: Awaited<ReturnType<typeof createTestDb>>["db"],
  ): Promise<number> {
    const port = getPort();
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gooseherd-dash-work-items-"));
    tmpDirs.push(tmpDir);
    const config = makeConfig(port, tmpDir);
    const runStore = new RunStore(createMockRunDatabase() as never);
    await runStore.init();
    const server = startDashboardServer(
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
      undefined,
      undefined,
      workItemsSource,
      db,
    );
    servers.push(server);
    await waitForServer(port);
    return port;
  }

async function createWorkItemsSource(): Promise<DashboardWorkItemsSource & {
    db: Awaited<ReturnType<typeof createTestDb>>["db"];
    discoveryId: string;
    pmUserId: string;
    reviewerUserId: string;
    ownerTeamId: string;
    createAdminSessionCookie(): Promise<string>;
    createUserSessionCookie(userId: string): Promise<string>;
  }> {
    const testDb = await createTestDb();
    cleanups.push(testDb.cleanup);

    const pmUserId = randomUUID();
    const reviewerUserId = randomUUID();
    const ownerTeamId = randomUUID();

    await testDb.db.insert(users).values([
      { id: pmUserId, slackUserId: "U_PM", displayName: "PM" },
      { id: reviewerUserId, slackUserId: "U_REVIEW", displayName: "Reviewer" },
    ]);
    await testDb.db.insert(teams).values({
      id: ownerTeamId,
      name: "growth",
      slackChannelId: "C_GROWTH",
    });
    await testDb.db.insert(teamMembers).values([
      { teamId: ownerTeamId, userId: pmUserId, functionalRoles: ["pm"] },
      { teamId: ownerTeamId, userId: reviewerUserId, functionalRoles: ["engineer"] },
    ]);

    const service = new WorkItemService(testDb.db);
    const workItemStore = new WorkItemStore(testDb.db);
    const reviewRequestStore = new ReviewRequestStore(testDb.db);
    const eventsStore = new WorkItemEventsStore(testDb.db);

    const discovery = await service.createDiscoveryWorkItem({
      title: "Discovery item",
      summary: "Build a spec",
      ownerTeamId,
      homeChannelId: "C_GROWTH",
      homeThreadTs: "1740000000.900",
      createdByUserId: pmUserId,
    });
    await service.startDiscovery(discovery.id);
    await service.requestReview({
      workItemId: discovery.id,
      actor: systemActor(pmUserId),
      requests: [
        {
          type: "review",
          targetType: "user",
          targetRef: { userId: reviewerUserId },
          title: "Review discovery draft",
          requestMessage: "Please review",
          focusPoints: ["scope"],
        },
      ],
    });

    await service.createDeliveryFromJira({
      title: "Delivery item",
      summary: "Implement the feature",
      ownerTeamId,
      homeChannelId: "C_GROWTH",
      homeThreadTs: "1740000000.901",
      jiraIssueKey: "HBL-500",
      createdByUserId: pmUserId,
    });

    const sessionStore = new DashboardAuthSessionStore(testDb.db);

    return {
      db: testDb.db,
      discoveryId: discovery.id,
      pmUserId,
      reviewerUserId,
      ownerTeamId,
      createAdminSessionCookie: async () => {
        const session = await sessionStore.createSession({
          principalType: "admin",
          authMethod: "admin_password",
          ttlMs: 60_000,
        });
        return `gooseherd-session=${session.token}`;
      },
      createUserSessionCookie: async (userId: string) => {
        const session = await sessionStore.createSession({
          principalType: "user",
          authMethod: "slack",
          userId,
          ttlMs: 60_000,
        });
        return `gooseherd-session=${session.token}`;
      },
      listWorkItems: async (workflow?: string) => {
        const items = await workItemStore.listWorkItems();
        return workflow ? items.filter((item) => item.workflow === workflow) : items;
      },
      getWorkItem: (id: string) => workItemStore.getWorkItem(id),
      listReviewRequestsForWorkItem: (workItemId: string) => reviewRequestStore.listReviewRequestsForWorkItem(workItemId),
      listReviewRequestComments: (reviewRequestId: string) => reviewRequestStore.listComments(reviewRequestId),
      listEventsForWorkItem: (workItemId: string) => eventsStore.listForWorkItem(workItemId),
      createDiscoveryWorkItem: (input) => service.createDiscoveryWorkItem({
        ...input,
        createdByUserId: input.actor.userId,
      }),
      createReviewRequests: (input) => service.requestReview({
        workItemId: input.workItemId,
        actor: systemActor(input.actor.userId),
        requests: input.requests,
      }),
      respondToReviewRequest: (input) => service.recordReviewOutcome({
        reviewRequestId: input.reviewRequestId,
        actor: systemActor(input.actor.userId),
        outcome: input.outcome,
        comment: input.comment,
      }),
      confirmDiscovery: (input) => service.confirmDiscovery({
        workItemId: input.workItemId,
        approved: input.approved,
        actor: systemActor(input.actor.userId),
        jiraIssueKey: input.jiraIssueKey,
      }),
      stopProcessing: async ({ workItemId, actor }) => {
        void actor;
        return {
        workItem: (await workItemStore.getWorkItem(workItemId))!,
        stoppedRunIds: ["run-1"],
        alreadyIdleRunIds: [],
        failedRunIds: [],
        };
      },
      guardedOverrideState: async ({ actor }) => {
        void actor;
        throw new Error("Cannot override state while work item processing is active");
      },
    };
  }

  test("GET /api/work-items returns 501 when source is unavailable", async () => {
    const port = await startServer(undefined);
    const res = await request(port, "GET", "/api/work-items");
    assert.equal(res.status, 501);
  });

  test("GET /api/work-items lists work items filtered by workflow", async () => {
    const source = await createWorkItemsSource();
    const port = await startServer(source);

    const res = await request(port, "GET", "/api/work-items?workflow=product_discovery");
    assert.equal(res.status, 200);
    const items = res.data.workItems as Array<{ workflow: string }>;
    assert.equal(items.length, 1);
    assert.equal(items[0]?.workflow, "product_discovery");
  });

  test("GET /api/work-items/:id returns work item detail", async () => {
    const source = await createWorkItemsSource();
    const port = await startServer(source);

    const res = await request(port, "GET", `/api/work-items/${source.discoveryId}`);
    assert.equal(res.status, 200);
    assert.equal((res.data.workItem as { id: string }).id, source.discoveryId);
  });

  test("GET /api/work-items/:id/review-requests returns review requests", async () => {
    const source = await createWorkItemsSource();
    const port = await startServer(source);

    const res = await request(port, "GET", `/api/work-items/${source.discoveryId}/review-requests`);
    assert.equal(res.status, 200);
    const requests = res.data.reviewRequests as Array<{ workItemId: string }>;
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.workItemId, source.discoveryId);
  });

  test("GET /api/work-items/:id/review-requests/:reviewRequestId/comments returns review history", async () => {
    const source = await createWorkItemsSource();
    const port = await startServer(source, source.db);
    const cookie = await source.createUserSessionCookie(source.reviewerUserId);

    const reviewRequestsRes = await request(port, "GET", `/api/work-items/${source.discoveryId}/review-requests`);
    const reviewRequestId = (reviewRequestsRes.data.reviewRequests as Array<{ id: string }>)[0]?.id;
    assert.ok(reviewRequestId);

    const respondRes = await request(port, "POST", `/api/review-requests/${reviewRequestId}/respond`, {
      outcome: "approved",
      comment: "Looks ready to me.",
    }, { cookie });
    assert.equal(respondRes.status, 200);

    const commentsRes = await request(port, "GET", `/api/work-items/${source.discoveryId}/review-requests/${reviewRequestId}/comments`);
    assert.equal(commentsRes.status, 200);
    const comments = commentsRes.data.comments as Array<{ body: string }>;
    assert.ok(comments.some((comment) => comment.body === "Looks ready to me."));
  });

  test("GET /api/work-items/:id/events returns work item events", async () => {
    const source = await createWorkItemsSource();
    const port = await startServer(source);

    const res = await request(port, "GET", `/api/work-items/${source.discoveryId}/events`);
    assert.equal(res.status, 200);
    const events = res.data.events as Array<{ workItemId: string }>;
    assert.ok(events.length >= 2);
    assert.equal(events[0]?.workItemId, source.discoveryId);
  });

  test("POST /api/work-items/discovery creates a discovery item", async () => {
    const source = await createWorkItemsSource();
    const port = await startServer(source, source.db);
    const cookie = await source.createUserSessionCookie(source.pmUserId);

    const res = await request(port, "POST", "/api/work-items/discovery", {
      title: "New discovery item",
      summary: "Draft spec",
      ownerTeamId: source.ownerTeamId,
      homeChannelId: "C_DISCOVERY",
      homeThreadTs: "1740000001.100",
    }, { cookie });

    assert.equal(res.status, 201);
    assert.equal((res.data.workItem as { workflow: string }).workflow, "product_discovery");
  });

  test("POST /api/work-items/discovery derives the creator from the dashboard session", async () => {
    const source = await createWorkItemsSource();
    const port = await startServer(source, source.db);
    const cookie = await source.createUserSessionCookie(source.pmUserId);

    const res = await request(port, "POST", "/api/work-items/discovery", {
      title: "New discovery item",
      summary: "Draft spec",
      ownerTeamId: source.ownerTeamId,
      homeChannelId: "C_DISCOVERY",
      homeThreadTs: "1740000001.100",
      createdByUserId: source.reviewerUserId,
    }, { cookie });

    assert.equal(res.status, 201);
    assert.equal((res.data.workItem as { createdByUserId: string }).createdByUserId, source.pmUserId);
  });

  test("POST /api/work-items/:id/review-requests creates review requests", async () => {
    const source = await createWorkItemsSource();
    const port = await startServer(source, source.db);
    const cookie = await source.createUserSessionCookie(source.pmUserId);

    const res = await request(port, "POST", `/api/work-items/${source.discoveryId}/review-requests`, {
      requests: [
        {
          type: "review",
          targetType: "team",
          targetRef: { teamId: source.ownerTeamId },
          title: "Second review round",
          requestMessage: "Need more feedback",
          focusPoints: ["naming"],
        },
      ],
    }, { cookie });

    assert.equal(res.status, 201);
    const reviewRequests = res.data.reviewRequests as Array<{ workItemId: string }>;
    assert.equal(reviewRequests.length, 1);
    assert.equal(reviewRequests[0]?.workItemId, source.discoveryId);
  });

  test("POST /api/work-items/:id/review-requests ignores forged requester ids in the body", async () => {
    const source = await createWorkItemsSource();
    const port = await startServer(source, source.db);
    const cookie = await source.createUserSessionCookie(source.pmUserId);

    const res = await request(port, "POST", `/api/work-items/${source.discoveryId}/review-requests`, {
      requestedByUserId: source.reviewerUserId,
      requests: [
        {
          type: "review",
          targetType: "team",
          targetRef: { teamId: source.ownerTeamId },
          title: "Second review round",
        },
      ],
    }, { cookie });

    assert.equal(res.status, 201);
    const reviewRequests = res.data.reviewRequests as Array<{ requestedByUserId: string }>;
    assert.equal(reviewRequests[0]?.requestedByUserId, source.pmUserId);
  });

  test("POST /api/review-requests/:id/respond records review outcome", async () => {
    const source = await createWorkItemsSource();
    const port = await startServer(source, source.db);
    const cookie = await source.createUserSessionCookie(source.reviewerUserId);
    const existingRequests = await source.listReviewRequestsForWorkItem(source.discoveryId);

    const res = await request(port, "POST", `/api/review-requests/${existingRequests[0]!.id}/respond`, {
      outcome: "approved",
      comment: "Looks fine",
    }, { cookie });

    assert.equal(res.status, 200);
    assert.equal((res.data.workItem as { state: string }).state, "waiting_for_pm_confirmation");
  });

  test("POST /api/review-requests/:id/respond derives the reviewer from the dashboard session", async () => {
    const source = await createWorkItemsSource();
    const port = await startServer(source, source.db);
    const cookie = await source.createUserSessionCookie(source.reviewerUserId);
    const existingRequests = await source.listReviewRequestsForWorkItem(source.discoveryId);

    const res = await request(port, "POST", `/api/review-requests/${existingRequests[0]!.id}/respond`, {
      outcome: "approved",
      authorUserId: source.pmUserId,
      comment: "Looks fine",
    }, { cookie });

    assert.equal(res.status, 200);
    const comments = await source.listReviewRequestComments(existingRequests[0]!.id);
    assert.equal(comments.at(-1)?.authorUserId, source.reviewerUserId);
  });

  test("POST /api/work-items/:id/confirm-discovery finalizes PM decision", async () => {
    const source = await createWorkItemsSource();
    const port = await startServer(source, source.db);
    const reviewerCookie = await source.createUserSessionCookie(source.reviewerUserId);
    const pmCookie = await source.createUserSessionCookie(source.pmUserId);
    const existingRequests = await source.listReviewRequestsForWorkItem(source.discoveryId);
    const respondRes = await request(port, "POST", `/api/review-requests/${existingRequests[0]!.id}/respond`, {
      outcome: "approved",
      comment: "Ready for PM",
    }, { cookie: reviewerCookie });
    assert.equal(respondRes.status, 200);

    const res = await request(port, "POST", `/api/work-items/${source.discoveryId}/confirm-discovery`, {
      approved: true,
      jiraIssueKey: "HBL-501",
    }, { cookie: pmCookie });

    assert.equal(res.status, 200);
    assert.equal((res.data.workItem as { state: string }).state, "done");
  });

  test("POST /api/work-items/:id/confirm-discovery ignores forged actor ids in the body", async () => {
    const source = await createWorkItemsSource();
    const port = await startServer(source, source.db);
    const reviewerCookie = await source.createUserSessionCookie(source.reviewerUserId);
    const pmCookie = await source.createUserSessionCookie(source.pmUserId);
    const existingRequests = await source.listReviewRequestsForWorkItem(source.discoveryId);

    const respondRes = await request(port, "POST", `/api/review-requests/${existingRequests[0]!.id}/respond`, {
      outcome: "approved",
      comment: "Ready for PM",
    }, { cookie: reviewerCookie });
    assert.equal(respondRes.status, 200);

    const res = await request(port, "POST", `/api/work-items/${source.discoveryId}/confirm-discovery`, {
      approved: true,
      actorUserId: source.reviewerUserId,
      jiraIssueKey: "HBL-501",
    }, { cookie: pmCookie });

    assert.equal(res.status, 200);
    assert.equal((res.data.workItem as { state: string }).state, "done");
  });

  test("POST /api/work-items/:id/confirm-discovery requires a session-backed actor", async () => {
    const source = await createWorkItemsSource();
    const port = await startServer(source, source.db);

    const res = await request(port, "POST", `/api/work-items/${source.discoveryId}/confirm-discovery`, {
      approved: true,
      jiraIssueKey: "HBL-501",
    });

    assert.equal(res.status, 403);
    assert.match(String(res.data.error), /dashboard.*actor/i);
  });

  test("POST /api/work-items/:id/override-state rejects when guarded override is blocked", async () => {
    const source = await createWorkItemsSource();
    const port = await startServer(source, source.db);
    const cookie = await source.createAdminSessionCookie();

    const res = await request(port, "POST", `/api/work-items/${source.discoveryId}/override-state`, {
      state: "cancelled",
      reason: "stuck worker",
    }, { cookie });

    assert.equal(res.status, 409);
    assert.match(String(res.data.error), /processing is active/);
  });

  test("POST /api/work-items/:id/override-state requires a session-backed actor", async () => {
    const source = await createWorkItemsSource();
    const port = await startServer(source, source.db);

    const res = await request(port, "POST", `/api/work-items/${source.discoveryId}/override-state`, {
      state: "cancelled",
      reason: "stuck worker",
    });

    assert.equal(res.status, 403);
    assert.match(String(res.data.error), /dashboard.*actor/i);
  });

  test("POST /api/work-items/:id/stop-processing returns stop results", async () => {
    const source = await createWorkItemsSource();
    const port = await startServer(source, source.db);
    const cookie = await source.createUserSessionCookie(source.pmUserId);

    const res = await request(port, "POST", `/api/work-items/${source.discoveryId}/stop-processing`, {}, { cookie });

    assert.equal(res.status, 200);
    assert.deepEqual(res.data.stoppedRunIds, ["run-1"]);
  });

  test("POST /api/work-items/:id/stop-processing requires a session-backed actor", async () => {
    const source = await createWorkItemsSource();
    const port = await startServer(source, source.db);

    const res = await request(port, "POST", `/api/work-items/${source.discoveryId}/stop-processing`, {});

    assert.equal(res.status, 403);
    assert.match(String(res.data.error), /dashboard.*actor/i);
  });
});
