import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../src/config.js";
import { orgRoleAssignments, teamMembers, teams, users } from "../src/db/schema.js";
import { createTestDb } from "./helpers/test-db.js";
import { WorkItemStore } from "../src/work-items/store.js";
import { ReviewRequestStore } from "../src/work-items/review-request-store.js";
import { WorkItemIdentityStore } from "../src/work-items/identity-store.js";
import {
  postWorkItemReviewNotifications,
  resolveReviewRequestDestinations,
} from "../src/work-items/slack-actions.js";

function makeConfig(): AppConfig {
  return {
    appName: "Huble",
    appSlug: "huble",
    slackCommandName: "huble",
    slackAllowedChannels: [],
    repoAllowlist: [],
    runnerConcurrency: 1,
    workRoot: "/tmp",
    dataDir: "/tmp",
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
    dashboardPort: 8787,
    dashboardPublicUrl: "https://huble.example.com",
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

async function seedIdentityFixture() {
  const testDb = await createTestDb();
  const ownerTeamId = randomUUID();
  const createdByUserId = randomUUID();
  const directReviewerId = randomUUID();
  const qaReviewerId = randomUUID();
  const ctoReviewerId = randomUUID();

  await testDb.db.insert(users).values([
    { id: createdByUserId, slackUserId: "U_PM", displayName: "PM" },
    { id: directReviewerId, slackUserId: "U_DEV", displayName: "Direct Reviewer" },
    { id: qaReviewerId, slackUserId: "U_QA", displayName: "QA Reviewer" },
    { id: ctoReviewerId, slackUserId: "U_CTO", displayName: "CTO Reviewer" },
  ]);

  await testDb.db.insert(teams).values([
    { id: ownerTeamId, name: "growth", slackChannelId: "C_GROWTH" },
    { id: randomUUID(), name: "platform", slackChannelId: "C_PLATFORM" },
  ]);

  await testDb.db.insert(teamMembers).values([
    { teamId: ownerTeamId, userId: directReviewerId, functionalRoles: ["engineer"] },
    { teamId: ownerTeamId, userId: qaReviewerId, functionalRoles: ["qa"] },
  ]);

  await testDb.db.insert(orgRoleAssignments).values([
    { userId: ctoReviewerId, orgRole: "cto" },
  ]);

  const workItemStore = new WorkItemStore(testDb.db);
  const reviewRequestStore = new ReviewRequestStore(testDb.db);

  const workItem = await workItemStore.createWorkItem({
    workflow: "feature_delivery",
    state: "engineering_review",
    title: "Add workflow delivery",
    summary: "Need review routing",
    ownerTeamId,
    homeChannelId: "C_HOME",
    homeThreadTs: "1740000000.111",
    jiraIssueKey: "HBL-700",
    createdByUserId,
  });

  return {
    cleanup: testDb.cleanup,
    db: testDb.db,
    workItem,
    reviewRequestStore,
    identityStore: new WorkItemIdentityStore(testDb.db),
    users: { createdByUserId, directReviewerId, qaReviewerId, ctoReviewerId },
    ownerTeamId,
  };
}

test("resolveReviewRequestDestinations handles user/team/team_role/org_role targets", async () => {
  const fixture = await seedIdentityFixture();

  try {
    const directReview = await fixture.reviewRequestStore.createReviewRequest({
      workItemId: fixture.workItem.id,
      reviewRound: 1,
      type: "review",
      targetType: "user",
      targetRef: { userId: fixture.users.directReviewerId },
      status: "pending",
      title: "Direct review",
      requestedByUserId: fixture.users.createdByUserId,
    });

    const teamReview = await fixture.reviewRequestStore.createReviewRequest({
      workItemId: fixture.workItem.id,
      reviewRound: 1,
      type: "review",
      targetType: "team",
      targetRef: { teamId: fixture.ownerTeamId },
      status: "pending",
      title: "Team review",
      requestedByUserId: fixture.users.createdByUserId,
    });

    const qaReview = await fixture.reviewRequestStore.createReviewRequest({
      workItemId: fixture.workItem.id,
      reviewRound: 1,
      type: "review",
      targetType: "team_role",
      targetRef: { role: "qa" },
      status: "pending",
      title: "QA review",
      requestedByUserId: fixture.users.createdByUserId,
    });

    const ctoReview = await fixture.reviewRequestStore.createReviewRequest({
      workItemId: fixture.workItem.id,
      reviewRound: 1,
      type: "review",
      targetType: "org_role",
      targetRef: { orgRole: "cto" },
      status: "pending",
      title: "CTO review",
      requestedByUserId: fixture.users.createdByUserId,
    });

    assert.deepEqual(
      await resolveReviewRequestDestinations(fixture.identityStore, fixture.workItem, directReview),
      [{ kind: "dm", slackUserId: "U_DEV", label: "Direct Reviewer" }],
    );
    assert.deepEqual(
      await resolveReviewRequestDestinations(fixture.identityStore, fixture.workItem, teamReview),
      [{ kind: "channel", channelId: "C_GROWTH", label: "growth" }],
    );
    assert.deepEqual(
      await resolveReviewRequestDestinations(fixture.identityStore, fixture.workItem, qaReview),
      [{ kind: "dm", slackUserId: "U_QA", label: "QA Reviewer (qa)" }],
    );
    assert.deepEqual(
      await resolveReviewRequestDestinations(fixture.identityStore, fixture.workItem, ctoReview),
      [{ kind: "dm", slackUserId: "U_CTO", label: "CTO Reviewer (cto)" }],
    );
  } finally {
    await fixture.cleanup();
  }
});

test("postWorkItemReviewNotifications sends home-thread note and target-aware Slack delivery", async () => {
  const fixture = await seedIdentityFixture();
  const config = makeConfig();
  const posted: Array<{ channel: string; threadTs?: string; text: string }> = [];
  const opened: string[] = [];

  try {
    const reviewRequest = await fixture.reviewRequestStore.createReviewRequest({
      workItemId: fixture.workItem.id,
      reviewRound: 1,
      type: "review",
      targetType: "team_role",
      targetRef: { role: "qa" },
      status: "pending",
      title: "QA review",
      requestMessage: "Please validate QA readiness",
      focusPoints: ["seed", "e2e"],
      requestedByUserId: fixture.users.createdByUserId,
    });

    const fakeClient = {
      chat: {
        postMessage: async (payload: { channel: string; thread_ts?: string; text: string }) => {
          posted.push({ channel: payload.channel, threadTs: payload.thread_ts, text: payload.text });
          return {};
        },
      },
      conversations: {
        open: async ({ users: slackUserId }: { users: string }) => {
          opened.push(slackUserId);
          return { channel: { id: `D_${slackUserId}` } };
        },
      },
    };

    await postWorkItemReviewNotifications(fakeClient as never, config, fixture.identityStore, fixture.workItem, [reviewRequest]);

    assert.deepEqual(opened, ["U_QA"]);
    assert.equal(posted.length, 2);
    assert.deepEqual(posted[0], {
      channel: "C_HOME",
      threadTs: "1740000000.111",
      text: "Review requested for HBL-700: QA review",
    });
    assert.deepEqual(posted[1], {
      channel: "D_U_QA",
      threadTs: undefined,
      text: "Review requested for HBL-700: QA review",
    });
  } finally {
    await fixture.cleanup();
  }
});
