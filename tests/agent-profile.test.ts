import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildBuiltinAgentProfiles, getAvailableProviders, renderAgentProfileTemplate, validateAgentProfile } from "../src/agent-profile.js";
import type { AppConfig } from "../src/config.js";

function makeConfig(): AppConfig {
  return {
    appName: "test",
    appSlug: "test",
    slackCommandName: "/goose",
    slackAllowedChannels: [],
    repoAllowlist: [],
    runnerConcurrency: 1,
    workRoot: ".work",
    dataDir: "data",
    dryRun: false,
    branchPrefix: "goose/",
    defaultBaseBranch: "main",
    gitAuthorName: "Test",
    gitAuthorEmail: "test@example.com",
    agentCommandTemplate: "echo test",
    validationCommand: "",
    lintFixCommand: "",
    localTestCommand: "",
    maxValidationRounds: 2,
    agentTimeoutSeconds: 600,
    slackProgressHeartbeatSeconds: 20,
    dashboardEnabled: true,
    dashboardHost: "127.0.0.1",
    dashboardPort: 8787,
    maxTaskChars: 4000,
    workspaceCleanupEnabled: false,
    workspaceMaxAgeHours: 24,
    workspaceCleanupIntervalMinutes: 30,
    cemsEnabled: false,
    mcpExtensions: [],
    piAgentExtensions: [],
    pipelineFile: "pipelines/pipeline.yml",
    observerEnabled: false,
    observerAlertChannelId: "",
    observerMaxRunsPerDay: 10,
    observerMaxRunsPerRepoPerDay: 5,
    observerCooldownMinutes: 10,
    observerRulesFile: "observer-rules/default.yml",
    observerRepoMap: new Map(),
    observerSlackWatchedChannels: [],
    observerSlackBotAllowlist: [],
    observerSentryPollIntervalSeconds: 300,
    observerWebhookPort: 9090,
    observerWebhookSecrets: {},
    observerGithubPollIntervalSeconds: 300,
    observerGithubWatchedRepos: [],
    openrouterApiKey: "or-key",
    anthropicApiKey: "anth-key",
    openaiApiKey: "oa-key",
    defaultLlmModel: "anthropic/claude-sonnet-4-6",
    planTaskModel: "anthropic/claude-sonnet-4-6",
    scopeJudgeEnabled: false,
    scopeJudgeModel: "anthropic/claude-sonnet-4-6",
    scopeJudgeMinPassScore: 60,
    orchestratorModel: "openai/gpt-4.1-mini",
    orchestratorTimeoutMs: 180000,
    orchestratorWallClockTimeoutMs: 480000,
    autonomousSchedulerEnabled: false,
    autonomousSchedulerMaxDeferred: 100,
    autonomousSchedulerIntervalMs: 300000,
    observerSmartTriageEnabled: false,
    observerSmartTriageModel: "anthropic/claude-sonnet-4-6",
    observerSmartTriageTimeoutMs: 10000,
    browserVerifyEnabled: false,
    screenshotEnabled: false,
    browserVerifyModel: "anthropic/claude-sonnet-4-6",
    browserVerifyMaxSteps: 15,
    browserVerifyExecTimeoutMs: 300000,
    browserVerifyEmailDomains: [],
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
    databaseUrl: "postgres://example/test",
  };
}

describe("agent profile helpers", () => {
  test("returns configured providers", () => {
    const providers = getAvailableProviders(makeConfig());
    assert.equal(providers.filter((provider) => provider.configured).length, 3);
  });

  test("validates structured profiles against configured providers", () => {
    const result = validateAgentProfile({
      name: "Pi OpenAI",
      runtime: "pi",
      provider: "openai",
      model: "openai/gpt-4.1-mini",
      tools: ["read", "write"],
    }, makeConfig());
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
  });

  test("renders pi command template with placeholders", () => {
    const command = renderAgentProfileTemplate({
      name: "Pi OpenAI",
      runtime: "pi",
      provider: "openai",
      model: "openai/gpt-4.1-mini",
      tools: ["read", "write"],
    });
    assert.ok(command.includes("cd {{repo_dir}} && pi -p @{{prompt_file}}"));
    assert.ok(command.includes("--model 'openai/gpt-4.1-mini'"));
    assert.ok(command.includes("--tools 'read,write'"));
  });

  test("renders custom command template unchanged", () => {
    const command = renderAgentProfileTemplate({
      name: "Custom",
      runtime: "custom",
      customCommandTemplate: "cd {{repo_dir}} && custom-agent @{{prompt_file}}",
    });
    assert.equal(command, "cd {{repo_dir}} && custom-agent @{{prompt_file}}");
  });

  test("does not render unsupported --tools flag for codex", () => {
    const command = renderAgentProfileTemplate({
      name: "Codex",
      runtime: "codex",
      provider: "openai",
      model: "gpt-5.4",
      tools: ["read", "write", "edit", "bash"],
    });
    assert.ok(command.includes("codex exec --full-auto --model 'gpt-5.4'"));
    assert.ok(!command.includes("--tools"));
  });

  test("rejects codex profiles with openrouter provider", () => {
    const result = validateAgentProfile({
      name: "Codex OpenRouter",
      runtime: "codex",
      provider: "openrouter",
      model: "openai/gpt-5.4",
    }, makeConfig());
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes("Runtime codex does not support provider openrouter"));
  });

  test("builds builtin profiles from configured api keys", () => {
    const builtins = buildBuiltinAgentProfiles(makeConfig());
    assert.ok(builtins.some((profile) => profile.name === "Pi + OpenAI"));
    assert.ok(builtins.some((profile) => profile.name === "Codex + OpenAI"));
    assert.ok(builtins.some((profile) => profile.name === "Claude + Anthropic"));
    assert.ok(!builtins.some((profile) => profile.name === "Codex + OpenRouter"));
  });
});
