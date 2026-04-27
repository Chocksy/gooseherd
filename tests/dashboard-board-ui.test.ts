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
  assert.match(html, /id="board-detail-runs"/);
  assert.match(html, /id="board-detail-events"/);
  assert.match(html, /review-requests\/' \+ encodeURIComponent\(request\.id\) \+ '\/comments/);
  assert.match(html, /\/api\/work-items\/' \+ encodedId \+ '\/runs/);
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
  assert.match(html, /boardWorkflow: 'feature_delivery'/);
});

test("dashboard HTML uses view-aware polling with reduced board and observer cadence", () => {
  const html = dashboardHtml(makeConfig());

  assert.match(html, /var RUNS_POLL_INTERVAL_MS = 5000;/);
  assert.match(html, /var BOARD_POLL_INTERVAL_MS = 15000;/);
  assert.match(html, /var OBSERVER_POLL_INTERVAL_MS = 30000;/);
  assert.match(html, /if \(document\.hidden\) return;/);
  assert.match(html, /if \(state\.viewMode === 'board'\) \{/);
  assert.match(html, /await loadWorkItems\(\);/);
  assert.match(html, /await refreshObserver\(false\);/);
  assert.match(html, /await loadRuns\(\);/);
  assert.match(html, /await refreshSelected\(\);/);
});

test("dashboard HTML falls back to runs mode when work item APIs are unavailable", () => {
  const html = dashboardHtml(makeConfig());

  assert.match(html, /workItemsAvailable:/);
  assert.match(html, /error\.status === 501/);
  assert.match(html, /Work item APIs are unavailable/);
  assert.match(html, /state\.workItemsAvailable = false;/);
  assert.match(html, /state\.viewMode = 'runs';/);
});

test("dashboard HTML toggles selected work item cards off and clears permalink on repeat click", () => {
  const html = dashboardHtml(makeConfig());

  assert.match(html, /if \(state\.selectedWorkItemId === workItemId\) \{/);
  assert.match(html, /state\.selectedWorkItemId = null;/);
  assert.match(html, /window\.location\.hash = '';/);
  assert.match(html, /refreshSelectedWorkItem\(\);/);
});

test("dashboard work item detail links to GitHub PR when a PR URL is present", () => {
  const html = dashboardHtml(makeConfig());

  assert.match(html, /item\.githubPrUrl/);
  assert.match(html, /document\.createElement\('a'\)/);
  assert.match(html, /prLink\.href = item\.githubPrUrl;/);
  assert.match(html, /prLink\.target = '_blank';/);
  assert.match(html, /prLink\.rel = 'noreferrer noopener';/);
  assert.match(html, /PR #'\s*\+ item\.githubPrNumber/);
});
