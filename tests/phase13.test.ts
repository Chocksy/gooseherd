/**
 * Phase 13 tests — Setup Wizard, GitHub App Auth, Team Tagging
 */

import assert from "node:assert/strict";
import { describe, test, mock } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTestDb, type TestDb } from "./helpers/test-db.js";

// ══════════════════════════════════════════════════════════
// Setup Wizard Helpers
// ══════════════════════════════════════════════════════════

describe("setup wizard helpers", () => {
  let maskSecret: typeof import("../scripts/setup.js").maskSecret;
  let validateSlackToken: typeof import("../scripts/setup.js").validateSlackToken;
  let validateGithubToken: typeof import("../scripts/setup.js").validateGithubToken;
  let validateOpenRouterKey: typeof import("../scripts/setup.js").validateOpenRouterKey;
  let parseExistingEnv: typeof import("../scripts/setup.js").parseExistingEnv;
  let mergeEnvValues: typeof import("../scripts/setup.js").mergeEnvValues;
  let generateEnvContent: typeof import("../scripts/setup.js").generateEnvContent;
  let wizardHtml: typeof import("../src/dashboard/wizard-html.js").wizardHtml;
  let SetupStore: typeof import("../src/db/setup-store.js").SetupStore;

  test("load setup helpers", async () => {
    const mod = await import("../scripts/setup.js");
    maskSecret = mod.maskSecret;
    validateSlackToken = mod.validateSlackToken;
    validateGithubToken = mod.validateGithubToken;
    validateOpenRouterKey = mod.validateOpenRouterKey;
    parseExistingEnv = mod.parseExistingEnv;
    mergeEnvValues = mod.mergeEnvValues;
    generateEnvContent = mod.generateEnvContent;
    wizardHtml = (await import("../src/dashboard/wizard-html.js")).wizardHtml;
    SetupStore = (await import("../src/db/setup-store.js")).SetupStore;
  });

  // ── maskSecret ──

  test("maskSecret masks middle of token", () => {
    assert.equal(maskSecret("xoxb-1234567890-abcdefghij"), "xoxb...ghij");
  });

  test("maskSecret handles short tokens", () => {
    assert.equal(maskSecret("abc"), "****");
    assert.equal(maskSecret("12345678"), "****");
  });

  test("maskSecret handles long tokens", () => {
    const result = maskSecret("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef");
    assert.ok(result.startsWith("ghp_"), "Should show prefix");
    assert.ok(result.endsWith("cdef"), "Should show last 4 chars");
    assert.ok(result.includes("..."), "Should have ellipsis");
  });

  // ── validateSlackToken ──

  test("validateSlackToken accepts valid xoxb token", () => {
    assert.equal(validateSlackToken("xoxb-1234-5678-abcdef", "xoxb-"), undefined);
  });

  test("validateSlackToken rejects invalid prefix", () => {
    const result = validateSlackToken("invalid-token", "xoxb-");
    assert.ok(result !== undefined, "Should return error for invalid prefix");
    assert.ok(result!.includes("xoxb-"), "Error should mention expected prefix");
  });

  test("validateSlackToken rejects empty string", () => {
    const result = validateSlackToken("", "xoxb-");
    assert.equal(result, "Required");
  });

  test("validateSlackToken accepts valid xapp token", () => {
    assert.equal(validateSlackToken("xapp-1-A123-456-abcdef", "xapp-"), undefined);
  });

  test("wizardHtml includes Slack OpenID fields and serializes them in the Slack payload", () => {
    const html = wizardHtml("Gooseherd");
    assert.match(html, /id="slack-client-id"/);
    assert.match(html, /id="slack-client-secret"/);
    assert.match(html, /id="slack-auth-redirect-uri"/);
    assert.match(html, /placeholder="\/auth\/slack\/callback"/);
    assert.match(html, /clientId:\s*document\.getElementById\('slack-client-id'\)\.value \|\| undefined/);
    assert.match(html, /clientSecret:\s*document\.getElementById\('slack-client-secret'\)\.value \|\| undefined/);
    assert.match(html, /authRedirectUri:\s*document\.getElementById\('slack-auth-redirect-uri'\)\.value \|\| undefined/);
  });

  test("SetupStore.applyToEnv injects Slack OpenID values saved by the wizard", async () => {
    const keys = [
      "SLACK_BOT_TOKEN",
      "SLACK_APP_TOKEN",
      "SLACK_SIGNING_SECRET",
      "SLACK_COMMAND_NAME",
      "SLACK_CLIENT_ID",
      "SLACK_CLIENT_SECRET",
      "SLACK_AUTH_REDIRECT_URI",
    ] as const;
    const previous = new Map<string, string | undefined>(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];

    const testDb = await createTestDb();
    try {
      const store = new SetupStore(testDb.db);
      await store.setPassword("super-secret-password");
      await store.saveSlack({
        botToken: "xoxb-123",
        appToken: "xapp-456",
        signingSecret: "signing-secret",
        commandName: "gooseherd",
        clientId: "111.222",
        clientSecret: "client-secret",
        authRedirectUri: "/auth/slack/callback",
      });
      await store.markComplete();

      await store.applyToEnv();

      assert.equal(process.env.SLACK_BOT_TOKEN, "xoxb-123");
      assert.equal(process.env.SLACK_APP_TOKEN, "xapp-456");
      assert.equal(process.env.SLACK_SIGNING_SECRET, "signing-secret");
      assert.equal(process.env.SLACK_COMMAND_NAME, "gooseherd");
      assert.equal(process.env.SLACK_CLIENT_ID, "111.222");
      assert.equal(process.env.SLACK_CLIENT_SECRET, "client-secret");
      assert.equal(process.env.SLACK_AUTH_REDIRECT_URI, "/auth/slack/callback");
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await testDb.cleanup();
    }
  });

  test("SetupStore.getWizardState prefers ENV for sources and falls back to wizard values", async () => {
    const keys = [
      "GITHUB_DEFAULT_OWNER",
      "GITHUB_APP_ID",
      "OPENROUTER_API_KEY",
      "DEFAULT_LLM_MODEL",
      "SLACK_COMMAND_NAME",
      "SLACK_CLIENT_ID",
      "SLACK_CLIENT_SECRET",
      "SLACK_AUTH_REDIRECT_URI",
    ] as const;
    const previous = new Map<string, string | undefined>(keys.map((key) => [key, process.env[key]]));

    process.env.GITHUB_DEFAULT_OWNER = "env-org";
    process.env.GITHUB_APP_ID = "12345";
    process.env.OPENROUTER_API_KEY = "sk-or-env";
    process.env.DEFAULT_LLM_MODEL = "openrouter/auto";
    delete process.env.SLACK_COMMAND_NAME;
    process.env.SLACK_CLIENT_ID = "env-client-id";
    process.env.SLACK_CLIENT_SECRET = "env-client-secret";
    process.env.SLACK_AUTH_REDIRECT_URI = "https://env.example.com/auth/slack/callback";

    const testDb = await createTestDb();
    try {
      const store = new SetupStore(testDb.db);
      await store.setPassword("super-secret-password");
      await store.saveGitHub({
        authMode: "app",
        defaultOwner: "wizard-org",
        appId: "99999",
        installationId: "77777",
        privateKey: "wizard-private-key",
      });
      await store.saveLLM({
        provider: "anthropic",
        apiKey: "wizard-api-key",
        defaultModel: "claude-3-7-sonnet",
      });
      await store.saveSlack({
        botToken: "xoxb-123",
        appToken: "xapp-456",
        commandName: "wizard-goose",
        clientId: "wizard-client-id",
        clientSecret: "wizard-client-secret",
        authRedirectUri: "https://wizard.example.com/auth/slack/callback",
      });

      const state = await store.getWizardState();

      assert.equal(state.prefill.github.defaultOwner.value, "env-org");
      assert.equal(state.prefill.github.defaultOwner.source, "env");
      assert.equal(state.prefill.github.appId.value, "12345");
      assert.equal(state.prefill.github.appId.source, "env");
      assert.equal(state.prefill.github.installationId.value, "77777");
      assert.equal(state.prefill.github.installationId.source, "wizard");
      assert.equal(state.prefill.github.privateKey.source, "wizard");

      assert.equal(state.prefill.llm.provider.value, "openrouter");
      assert.equal(state.prefill.llm.provider.source, "env");
      assert.equal(state.prefill.llm.apiKey.source, "env");
      assert.equal(state.prefill.llm.defaultModel.value, "openrouter/auto");
      assert.equal(state.prefill.llm.defaultModel.source, "env");

      assert.equal(state.prefill.slack.commandName.value, "wizard-goose");
      assert.equal(state.prefill.slack.commandName.source, "wizard");
      assert.equal(state.prefill.slack.clientId.value, "env-client-id");
      assert.equal(state.prefill.slack.clientId.source, "env");
      assert.equal(state.prefill.slack.clientSecret.source, "env");
      assert.equal(state.prefill.slack.authRedirectUri.value, "https://env.example.com/auth/slack/callback");
      assert.equal(state.prefill.slack.authRedirectUri.source, "env");
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await testDb.cleanup();
    }
  });

  test("wizardHtml includes setup prefill hooks for source-aware values", () => {
    const html = wizardHtml("Gooseherd");
    assert.match(html, /id="gh-prefill-summary"/);
    assert.match(html, /id="llm-prefill-summary"/);
    assert.match(html, /id="slack-prefill-summary"/);
    assert.match(html, /function renderPrefillSummary/);
    assert.match(html, /function applySetupPrefill/);
    assert.match(html, /applySetupPrefill\(data\.prefill\)/);
  });

  test("wizardHtml promotes Skip buttons when the current step has its required fields", () => {
    const html = wizardHtml("Gooseherd");
    assert.match(html, /id="gh-skip-btn"/);
    assert.match(html, /id="llm-skip-btn"/);
    assert.match(html, /id="slack-skip-btn"/);
    assert.match(html, /function hasGithubRequiredFields\(\)/);
    assert.match(html, /function hasLlmRequiredFields\(\)/);
    assert.match(html, /function hasSlackRequiredFields\(\)/);
    assert.match(html, /function hasGithubReadyForSkip\(\)/);
    assert.match(html, /function hasLlmReadyForSkip\(\)/);
    assert.match(html, /function hasSlackReadyForSkip\(\)/);
    assert.match(html, /function syncSkipButtons\(\)/);
    assert.match(html, /const prefillState = \{/);
    assert.match(html, /token:\s*false/);
    assert.match(html, /apiKey:\s*false/);
    assert.match(html, /botToken:\s*false/);
    assert.match(html, /appToken:\s*false/);
    assert.match(html, /document\.getElementById\('gh-skip-btn'\)\?\.classList\.toggle\('ready', hasGithubReadyForSkip\(\) \|\| state\.github\)/);
    assert.match(html, /document\.getElementById\('llm-skip-btn'\)\?\.classList\.toggle\('ready', hasLlmReadyForSkip\(\) \|\| state\.llm\)/);
    assert.match(html, /document\.getElementById\('slack-skip-btn'\)\?\.classList\.toggle\('ready', hasSlackReadyForSkip\(\) \|\| state\.slack\)/);
    assert.match(html, /prefillState\.github\.token = hasPrefillValue\(prefill\.github\?\.token\)/);
    assert.match(html, /prefillState\.llm\.apiKey = hasPrefillValue\(prefill\.llm\?\.apiKey\)/);
    assert.match(html, /prefillState\.slack\.botToken = hasPrefillValue\(prefill\.slack\?\.botToken\)/);
    assert.match(html, /prefillState\.slack\.appToken = hasPrefillValue\(prefill\.slack\?\.appToken\)/);
  });

  test("wizardHtml gives ready Skip buttons a distinct visual treatment", () => {
    const html = wizardHtml("Gooseherd");
    assert.match(html, /\.btn-skip\.ready \{ background: rgba\(37, 99, 235, 0\.2\); color: #dbeafe; border-color: #3b82f6; box-shadow: inset 0 0 0 1px rgba\(96, 165, 250, 0\.25\); \}/);
    assert.match(html, /\.btn-skip\.ready:hover \{ background: rgba\(37, 99, 235, 0\.32\); \}/);
  });

  // ── validateGithubToken ──

  test("validateGithubToken accepts ghp_ prefix", () => {
    assert.equal(validateGithubToken("ghp_ABCdef123"), undefined);
  });

  test("validateGithubToken accepts ghs_ prefix", () => {
    assert.equal(validateGithubToken("ghs_ABCdef123"), undefined);
  });

  test("validateGithubToken accepts github_pat_ prefix", () => {
    assert.equal(validateGithubToken("github_pat_ABCdef123"), undefined);
  });

  test("validateGithubToken allows empty (optional)", () => {
    assert.equal(validateGithubToken(""), undefined);
  });

  test("validateGithubToken rejects invalid format", () => {
    const result = validateGithubToken("invalid-token-format");
    assert.ok(result !== undefined, "Should return error for invalid format");
  });

  // ── validateOpenRouterKey ──

  test("validateOpenRouterKey accepts sk-or- prefix", () => {
    assert.equal(validateOpenRouterKey("sk-or-v1-abcdef123456"), undefined);
  });

  test("validateOpenRouterKey allows empty (optional)", () => {
    assert.equal(validateOpenRouterKey(""), undefined);
  });

  test("validateOpenRouterKey rejects invalid format", () => {
    const result = validateOpenRouterKey("sk-other-prefix");
    assert.ok(result !== undefined);
  });

  // ── parseExistingEnv ──

  test("parseExistingEnv reads key=value pairs", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gh-test-env-"));
    const envPath = path.join(tmpDir, ".env");
    await writeFile(envPath, 'FOO=bar\nBAZ="quoted"\n# comment\nEMPTY=\n', "utf8");
    const result = parseExistingEnv(envPath);
    assert.equal(result["FOO"], "bar");
    assert.equal(result["BAZ"], "quoted");
    assert.equal(result["EMPTY"], "");
    assert.equal(result["#"], undefined);
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("parseExistingEnv returns empty for missing file", () => {
    const result = parseExistingEnv("/nonexistent/.env");
    assert.deepEqual(result, {});
  });

  // ── mergeEnvValues ──

  test("mergeEnvValues preserves existing and adds new", () => {
    const existing = { A: "1", B: "2" };
    const newValues = { B: "updated", C: "3" };
    const result = mergeEnvValues(existing, newValues);
    assert.equal(result["A"], "1");
    assert.equal(result["B"], "updated");
    assert.equal(result["C"], "3");
  });

  test("mergeEnvValues skips empty new values", () => {
    const existing = { A: "1" };
    const newValues = { A: "", B: "" };
    const result = mergeEnvValues(existing, newValues);
    assert.equal(result["A"], "1");
    assert.equal(result["B"], undefined);
  });

  // ── generateEnvContent ──

  test("generateEnvContent produces valid .env format", () => {
    const values = {
      APP_NAME: "TestApp",
      SLACK_BOT_TOKEN: "xoxb-test",
      GITHUB_TOKEN: "ghp_test"
    };
    const content = generateEnvContent(values);
    assert.ok(content.includes("APP_NAME=TestApp"), "Should contain APP_NAME");
    assert.ok(content.includes("SLACK_BOT_TOKEN=xoxb-test"), "Should contain Slack token");
    assert.ok(content.includes("GITHUB_TOKEN=ghp_test"), "Should contain GitHub token");
    assert.ok(content.includes("#"), "Should have section comments");
  });

  test("generateEnvContent uses empty string for undefined values", () => {
    const values = { APP_NAME: "TestApp" };
    const content = generateEnvContent(values);
    // Other keys should appear with empty values
    assert.ok(content.includes("SLACK_BOT_TOKEN="), "Should include Slack token key");
  });
});

// ══════════════════════════════════════════════════════════
// GitHub App Auth — Config + Factory
// ══════════════════════════════════════════════════════════

describe("GitHub App Auth", () => {
  let resolveGitHubAuthMode: typeof import("../src/config.js").resolveGitHubAuthMode;
  let GitHubService: typeof import("../src/github.js").GitHubService;
  let buildAuthenticatedGitUrl: typeof import("../src/github.js").buildAuthenticatedGitUrl;

  test("load modules", async () => {
    const configMod = await import("../src/config.js");
    resolveGitHubAuthMode = configMod.resolveGitHubAuthMode;
    const ghMod = await import("../src/github.js");
    GitHubService = ghMod.GitHubService;
    buildAuthenticatedGitUrl = ghMod.buildAuthenticatedGitUrl;
  });

  // ── resolveGitHubAuthMode ──

  test("resolveGitHubAuthMode returns 'none' when no auth", () => {
    const config = makeMinimalConfig({});
    assert.equal(resolveGitHubAuthMode(config), "none");
  });

  test("resolveGitHubAuthMode returns 'pat' with GITHUB_TOKEN", () => {
    const config = makeMinimalConfig({ githubToken: "ghp_test123" });
    assert.equal(resolveGitHubAuthMode(config), "pat");
  });

  test("resolveGitHubAuthMode returns 'app' with all App credentials", () => {
    const config = makeMinimalConfig({
      githubAppId: 12345,
      githubAppPrivateKey: "fake-pem-content",
      githubAppInstallationId: 67890
    });
    assert.equal(resolveGitHubAuthMode(config), "app");
  });

  test("resolveGitHubAuthMode returns 'pat' when App credentials incomplete", () => {
    const config = makeMinimalConfig({
      githubToken: "ghp_test",
      githubAppId: 12345
      // Missing privateKey and installationId
    });
    assert.equal(resolveGitHubAuthMode(config), "pat");
  });

  // ── GitHubService.create factory ──

  test("GitHubService.create returns undefined with no auth", () => {
    const config = makeMinimalConfig({});
    const service = GitHubService.create(config);
    assert.equal(service, undefined);
  });

  test("GitHubService.create returns service with PAT", () => {
    const config = makeMinimalConfig({ githubToken: "ghp_test123" });
    const service = GitHubService.create(config);
    assert.ok(service !== undefined, "Should return a GitHubService instance");
  });

  test("GitHubService.getToken returns PAT string in PAT mode", async () => {
    const config = makeMinimalConfig({ githubToken: "ghp_tokenvalue" });
    const service = GitHubService.create(config);
    assert.ok(service);
    const token = await service.getToken();
    assert.equal(token, "ghp_tokenvalue");
  });

  // ── buildAuthenticatedGitUrl ──

  test("buildAuthenticatedGitUrl constructs valid URL", () => {
    const url = buildAuthenticatedGitUrl("owner/repo", "test-token-123");
    assert.equal(url, "https://x-access-token:test-token-123@github.com/owner/repo.git");
  });

  test("buildAuthenticatedGitUrl encodes special chars in token", () => {
    const url = buildAuthenticatedGitUrl("owner/repo", "token with spaces & specials");
    assert.ok(url.includes("x-access-token:"), "Should have auth prefix");
    assert.ok(url.includes("github.com/owner/repo.git"), "Should have repo suffix");
    assert.ok(!url.includes(" "), "Should encode spaces");
  });
});

// ══════════════════════════════════════════════════════════
// Team Tagging
// ══════════════════════════════════════════════════════════

describe("team tagging", () => {
  let parseTeamChannelMap: typeof import("../src/config.js").parseTeamChannelMap;
  let resolveTeamFromChannel: typeof import("../src/config.js").resolveTeamFromChannel;
  let RunStore: typeof import("../src/store.js").RunStore;

  test("load modules", async () => {
    const configMod = await import("../src/config.js");
    parseTeamChannelMap = configMod.parseTeamChannelMap;
    resolveTeamFromChannel = configMod.resolveTeamFromChannel;
    const storeMod = await import("../src/store.js");
    RunStore = storeMod.RunStore;
  });

  // ── parseTeamChannelMap ──

  test("parseTeamChannelMap parses valid JSON", () => {
    const map = parseTeamChannelMap('{"platform":["C123","C456"],"product":["C789"]}');
    assert.equal(map.size, 2);
    assert.deepEqual(map.get("platform"), ["C123", "C456"]);
    assert.deepEqual(map.get("product"), ["C789"]);
  });

  test("parseTeamChannelMap returns empty map for undefined", () => {
    const map = parseTeamChannelMap(undefined);
    assert.equal(map.size, 0);
  });

  test("parseTeamChannelMap returns empty map for empty string", () => {
    const map = parseTeamChannelMap("");
    assert.equal(map.size, 0);
  });

  test("parseTeamChannelMap returns empty map for invalid JSON", () => {
    const map = parseTeamChannelMap("not-json");
    assert.equal(map.size, 0);
  });

  // ── resolveTeamFromChannel ──

  test("resolveTeamFromChannel finds team by channel ID", () => {
    const map = new Map<string, string[]>([
      ["platform", ["C123", "C456"]],
      ["product", ["C789"]]
    ]);
    assert.equal(resolveTeamFromChannel("C456", map), "platform");
    assert.equal(resolveTeamFromChannel("C789", map), "product");
  });

  test("resolveTeamFromChannel returns undefined for unknown channel", () => {
    const map = new Map<string, string[]>([
      ["platform", ["C123"]]
    ]);
    assert.equal(resolveTeamFromChannel("CUNKNOWN", map), undefined);
  });

  test("resolveTeamFromChannel handles empty map", () => {
    assert.equal(resolveTeamFromChannel("C123", new Map()), undefined);
  });

  // ── RunStore with teamId ──

  test("store.createRun saves teamId", async () => {
    const testDb = await createTestDb();
    const store = new RunStore(testDb.db);
    await store.init();

    const run = await store.createRun({
      repoSlug: "org/repo",
      task: "test task",
      baseBranch: "main",
      requestedBy: "U123",
      channelId: "C123",
      threadTs: "1234.5678",
      runtime: "local",
      teamId: "platform"
    }, "gooseherd");

    assert.equal(run.teamId, "platform");

    // Verify it persists on retrieval
    const fetched = await store.getRun(run.id);
    assert.equal(fetched?.teamId, "platform");

    await testDb.cleanup();
  });

  test("store.createRun works without teamId", async () => {
    const testDb = await createTestDb();
    const store = new RunStore(testDb.db);
    await store.init();

    const run = await store.createRun({
      repoSlug: "org/repo",
      task: "test task",
      baseBranch: "main",
      requestedBy: "U123",
      channelId: "C123",
      threadTs: "1234.5678",
      runtime: "local"
    }, "gooseherd");

    assert.equal(run.teamId, undefined);

    await testDb.cleanup();
  });

  test("store.listRuns filters by teamId", async () => {
    const testDb = await createTestDb();
    const store = new RunStore(testDb.db);
    await store.init();

    await store.createRun({
      repoSlug: "org/repo1",
      task: "task1",
      baseBranch: "main",
      requestedBy: "U1",
      channelId: "C1",
      threadTs: "1.1",
      runtime: "local",
      teamId: "platform"
    }, "gooseherd");

    await store.createRun({
      repoSlug: "org/repo2",
      task: "task2",
      baseBranch: "main",
      requestedBy: "U2",
      channelId: "C2",
      threadTs: "2.2",
      runtime: "local",
      teamId: "product"
    }, "gooseherd");

    await store.createRun({
      repoSlug: "org/repo3",
      task: "task3",
      baseBranch: "main",
      requestedBy: "U3",
      channelId: "C3",
      threadTs: "3.3",
      runtime: "local"
      // No teamId
    }, "gooseherd");

    // All runs
    const all = await store.listRuns();
    assert.equal(all.length, 3);

    // Filter by platform team
    const platformRuns = await store.listRuns({ teamId: "platform" });
    assert.equal(platformRuns.length, 1);
    assert.equal(platformRuns[0]?.repoSlug, "org/repo1");

    // Filter by product team
    const productRuns = await store.listRuns({ teamId: "product" });
    assert.equal(productRuns.length, 1);
    assert.equal(productRuns[0]?.repoSlug, "org/repo2");

    // Filter by nonexistent team
    const emptyRuns = await store.listRuns({ teamId: "nonexistent" });
    assert.equal(emptyRuns.length, 0);

    // Numeric limit still works
    const limited = await store.listRuns({ limit: 1 });
    assert.equal(limited.length, 1);

    // Old-style numeric call still works
    const oldStyle = await store.listRuns(2);
    assert.equal(oldStyle.length, 2);

    await testDb.cleanup();
  });
});

// ══════════════════════════════════════════════════════════
// Error Classification (updated messages)
// ══════════════════════════════════════════════════════════

describe("error classification with updated messages", () => {
  let classifyError: typeof import("../src/run-manager.js").classifyError;

  test("load classifyError", async () => {
    const mod = await import("../src/run-manager.js");
    classifyError = mod.classifyError;
  });

  test("clone error suggestion mentions both auth methods", () => {
    const result = classifyError("failed to clone org/repo");
    assert.ok(result.suggestion.includes("GITHUB_TOKEN"), "Should mention PAT");
    assert.ok(result.suggestion.includes("GitHub App"), "Should mention App auth");
  });

  test("PR error suggestion mentions both auth methods", () => {
    const result = classifyError("pull request creation failed");
    assert.ok(result.suggestion.includes("GITHUB_TOKEN"), "Should mention PAT");
    assert.ok(result.suggestion.includes("GitHub App"), "Should mention App auth");
  });
});

// ══════════════════════════════════════════════════════════
// ObserverDaemon tokenGetter wiring
// ══════════════════════════════════════════════════════════

describe("ObserverDaemon tokenGetter", () => {
  test("ObserverDaemon constructor accepts tokenGetter", async () => {
    // Just verify the type signature accepts the parameter without error
    const mod = await import("../src/observer/daemon.js");
    const ObserverDaemon = mod.ObserverDaemon;
    const testDb = await createTestDb();

    // Minimal mock objects to instantiate
    const mockConfig = makeMinimalConfig({}) as any;
    mockConfig.dataDir = os.tmpdir();
    const mockRunManager = {} as any;
    const mockWebClient = {} as any;
    const tokenGetter = async () => "fresh-token";

    // Should not throw — pass db as last argument
    const daemon = new ObserverDaemon(mockConfig, mockRunManager, mockWebClient, tokenGetter, undefined, testDb.db);
    assert.ok(daemon, "Daemon should instantiate with tokenGetter");

    await testDb.cleanup();
  });

  test("ObserverDaemon constructor works without tokenGetter", async () => {
    const mod = await import("../src/observer/daemon.js");
    const ObserverDaemon = mod.ObserverDaemon;
    const testDb = await createTestDb();

    const mockConfig = makeMinimalConfig({}) as any;
    mockConfig.dataDir = os.tmpdir();

    const daemon = new ObserverDaemon(mockConfig, {} as any, {} as any, undefined, undefined, testDb.db);
    assert.ok(daemon, "Daemon should instantiate without tokenGetter");

    await testDb.cleanup();
  });

  test("ObserverDaemon does not bind observerWebhookPort when dashboard server is enabled", async (t) => {
    const mod = await import("../src/observer/daemon.js");
    const ObserverDaemon = mod.ObserverDaemon;
    const testDb = await createTestDb();

    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", () => resolve()));
    const occupiedPort = (occupied.address() as { port: number }).port;

    const mockConfig = makeMinimalConfig({
      dashboardEnabled: true,
      observerGithubWebhookSecret: "github-secret",
      observerWebhookPort: occupiedPort,
    }) as any;
    mockConfig.dataDir = os.tmpdir();

    const daemon = new ObserverDaemon(mockConfig, { onRunTerminal: () => {} } as any, undefined, undefined, undefined, testDb.db);
    t.after(async () => {
      occupied.close();
      await daemon.stop();
      await testDb.cleanup();
    });

    await daemon.start();
  });
});

// ══════════════════════════════════════════════════════════
// Pipeline integration: push node with githubService guard
// ══════════════════════════════════════════════════════════

describe("push node githubService guard", () => {
  let pushNode: typeof import("../src/pipeline/nodes/push.js").pushNode;

  test("load pushNode", async () => {
    const mod = await import("../src/pipeline/nodes/push.js");
    pushNode = mod.pushNode;
  });

  test("push node succeeds in dry-run mode without githubService", async () => {
    const mockDeps = makeMockNodeDeps({ dryRun: true });
    const ctx = makeMockContextBag({ repoDir: "/tmp/fake" });
    const result = await pushNode({}, ctx, mockDeps);
    assert.equal(result.outcome, "success");
    assert.equal(result.outputs?.dryRun, true);
  });

  test("push node fails when githubService is missing and not dry-run", async () => {
    const mockDeps = makeMockNodeDeps({ dryRun: false, githubService: undefined });
    const ctx = makeMockContextBag({ repoDir: "/tmp/fake" });
    const result = await pushNode({}, ctx, mockDeps);
    assert.equal(result.outcome, "failure");
    assert.ok(result.error?.includes("GitHub authentication required"));
    assert.ok(result.error?.includes("GitHub App credentials"));
  });
});

// ══════════════════════════════════════════════════════════
// Pipeline integration: clone node with dynamic token
// ══════════════════════════════════════════════════════════

describe("clone node dynamic token", () => {
  let cloneNode: typeof import("../src/pipeline/nodes/clone.js").cloneNode;

  test("load cloneNode", async () => {
    const mod = await import("../src/pipeline/nodes/clone.js");
    cloneNode = mod.cloneNode;
  });

  test("clone node uses githubService.getToken for authenticated URL", async () => {
    // We don't want to actually clone, so we create deps that will fail on the
    // shell call but verify the token was requested
    let tokenCalled = false;
    const mockGithubService = {
      getToken: async () => {
        tokenCalled = true;
        return "ghs_freshtoken";
      }
    };

    const mockDeps = makeMockNodeDeps({
      dryRun: false,
      githubService: mockGithubService as any
    });

    const ctx = makeMockContextBag({});

    // This will fail during the git clone shell command (which is expected)
    // but we verify the token was fetched
    try {
      await cloneNode({}, ctx, mockDeps);
    } catch {
      // Expected failure — we don't have a real repo
    }

    assert.ok(tokenCalled, "Clone node should call githubService.getToken()");
  });
});

// ══════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════

function makeMinimalConfig(overrides: Record<string, unknown> = {}): import("../src/config.js").AppConfig {
  return {
    appName: "Gooseherd",
    appSlug: "gooseherd",
    slackBotToken: "xoxb-test",
    slackAppToken: "xapp-test",
    slackSigningSecret: "test-secret-at-least-20-chars-long",
    slackCommandName: "gooseherd",
    slackAllowedChannels: [],
    githubToken: undefined,
    githubDefaultOwner: "",
    githubAppId: undefined,
    githubAppPrivateKey: undefined,
    githubAppInstallationId: undefined,
    repoAllowlist: [],
    runnerConcurrency: 1,
    workRoot: os.tmpdir(),
    dataDir: os.tmpdir(),
    dryRun: true,
    branchPrefix: "gooseherd",
    defaultBaseBranch: "main",
    gitAuthorName: "Test Bot",
    gitAuthorEmail: "test@local",
    agentCommandTemplate: "echo test",
    agentFollowUpTemplate: undefined,
    validationCommand: "",
    lintFixCommand: "",
    maxValidationRounds: 0,
    agentTimeoutSeconds: 60,
    maxTaskChars: 4000,
    pipelineFile: "pipelines/pipeline.yml",
    slackProgressHeartbeatSeconds: 20,
    dashboardEnabled: false,
    dashboardHost: "127.0.0.1",
    dashboardPort: 8787,
    dashboardPublicUrl: undefined,
    dashboardToken: undefined,
    observerEnabled: false,
    observerAlertChannelId: "",
    observerMaxRunsPerDay: 50,
    observerMaxRunsPerRepoPerDay: 5,
    observerCooldownMinutes: 60,
    observerRulesFile: "observer-rules/default.yml",
    observerRepoMap: new Map(),
    sentryAuthToken: undefined,
    sentryOrgSlug: undefined,
    observerSentryPollIntervalSeconds: 300,
    observerGithubWebhookSecret: undefined,
    observerSentryWebhookSecret: undefined,
    observerWebhookPort: 9090,
    observerSmartTriageEnabled: false,
    observerSmartTriageModel: "claude-haiku-4-5-20251001",
    observerSmartTriageTimeoutMs: 10000,
    ciWaitEnabled: false,
    ciPollIntervalSeconds: 30,
    ciPatienceTimeoutSeconds: 300,
    ciMaxWaitSeconds: 1800,
    ciCheckFilter: [],
    ciMaxFixRounds: 2,
    openrouterApiKey: undefined,
    defaultLlmModel: "anthropic/claude-haiku-4-5",
    planTaskModel: "anthropic/claude-haiku-4-5",
    scopeJudgeEnabled: false,
    scopeJudgeModel: "anthropic/claude-haiku-4-5",
    scopeJudgeMinPassScore: 60,
    browserVerifyEnabled: false,
    reviewAppUrlPattern: "",
    screenshotEnabled: false,
    browserVerifyModel: "anthropic/claude-haiku-4-5",
    observerSlackWatchedChannels: [],
    observerSlackBotAllowlist: [],
    workspaceCleanupEnabled: false,
    workspaceMaxAgeHours: 24,
    workspaceCleanupIntervalMinutes: 30,
    cemsEnabled: false,
    cemsApiUrl: undefined,
    cemsApiKey: undefined,
    cemsTeamId: undefined,
    localTestCommand: "",
    mcpExtensions: [],
    observerGithubPollIntervalSeconds: 300,
    observerGithubWatchedRepos: [],
    teamChannelMap: new Map(),
    ...overrides
  } as import("../src/config.js").AppConfig;
}

function makeMockNodeDeps(overrides: {
  dryRun?: boolean;
  githubService?: unknown;
} = {}): import("../src/pipeline/types.js").NodeDeps {
  return {
    config: makeMinimalConfig({ dryRun: overrides.dryRun ?? true }),
    logFile: "/dev/null",
    workRoot: os.tmpdir(),
    run: {
      id: "test-run-id",
      status: "running" as const,
      phase: "pushing" as const,
      repoSlug: "org/repo",
      task: "test task",
      baseBranch: "main",
      branchName: "gooseherd/test",
      requestedBy: "U123",
      channelId: "C123",
      threadTs: "1234.5678",
      createdAt: new Date().toISOString()
    },
    onPhase: async () => {},
    githubService: overrides.githubService as any
  };
}

function makeMockContextBag(initial: Record<string, unknown> = {}): import("../src/pipeline/context-bag.js").ContextBag {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
    getRequired: <T>(key: string): T => {
      const val = store.get(key);
      if (val === undefined) throw new Error(`Missing required context key: ${key}`);
      return val as T;
    },
    set: (key: string, value: unknown) => { store.set(key, value); },
    has: (key: string) => store.has(key),
    keys: () => Array.from(store.keys()),
    toJSON: () => Object.fromEntries(store)
  };
}
