import assert from "node:assert/strict";
import test from "node:test";
import type { AppConfig } from "../src/config.js";
import { dashboardHtml } from "../src/dashboard/html.js";

function makeConfig(): AppConfig {
  return {
    appName: "Huble",
    appSlug: "huble",
    slackCommandName: "/goose",
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

test("dashboard HTML includes work item board controls and data fetch hooks", () => {
  const html = dashboardHtml(makeConfig());

  assert.match(html, /Board/);
  assert.match(html, /id="view-switch"/);
  assert.match(html, /id="board-workflow"/);
  assert.match(html, /id="board-columns"/);
  assert.match(html, /\/api\/work-items\?workflow=/);
  assert.match(html, /id="board-detail"/);
  assert.match(html, /id="board-detail-reviews"/);
  assert.match(html, /id="board-detail-events"/);
  assert.match(html, /review-requests\/' \+ encodeURIComponent\(request\.id\) \+ '\/comments/);
  assert.match(html, /id="board-stop-processing"/);
  assert.match(html, /id="board-override-state"/);
  assert.match(html, /id="board-confirm-approve"/);
  assert.match(html, /id="board-confirm-rework"/);
  assert.match(html, /\/api\/review-requests\//);
  assert.match(html, /confirm-discovery/);
  assert.match(html, /Jira issue key is required before discovery can be approved/);
  assert.match(html, /No review requests loaded\./);
  assert.match(html, /stop-processing/);
  assert.match(html, /override-state/);
});
