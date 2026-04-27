import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

// Test the config loading indirectly by verifying type shapes
// (loadConfig() reads process.env directly, so we test the helper logic)

test("MCP extensions: parseList splits comma-separated values", () => {
  function parseList(value?: string): string[] {
    if (!value || value.trim() === "") return [];
    return value.split(",").map(e => e.trim()).filter(Boolean);
  }

  assert.deepEqual(parseList("npx @a/ext,npx @b/ext"), ["npx @a/ext", "npx @b/ext"]);
  assert.deepEqual(parseList("npx @a/ext"), ["npx @a/ext"]);
  assert.deepEqual(parseList(undefined), []);
  assert.deepEqual(parseList(""), []);
  assert.deepEqual(parseList(" , "), []);
});

test("Dashboard public URL: defaults to localhost when not set", () => {
  const host = "127.0.0.1";
  const port = 8787;
  const publicUrl = undefined;

  const resolved = publicUrl ?? `http://${host}:${String(port)}`;
  assert.equal(resolved, "http://127.0.0.1:8787");
});

test("Dashboard public URL: uses public URL when set", () => {
  const host = "127.0.0.1";
  const port = 8787;
  const publicUrl = "https://dash.goose-herd.com";

  const resolved = publicUrl ?? `http://${host}:${String(port)}`;
  assert.equal(resolved, "https://dash.goose-herd.com");
});

test("DRY_RUN: default is false", () => {
  function parseBoolean(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
  }

  assert.equal(parseBoolean(undefined, false), false);
  assert.equal(parseBoolean("true", false), true);
  assert.equal(parseBoolean("false", false), false);
});

test("DEFAULT_LLM_MODEL: feature models fall back to default", () => {
  // Simulates the fallback chain: FEATURE_MODEL → DEFAULT_LLM_MODEL → hardcoded default
  function resolveModel(featureModel?: string, defaultModel?: string): string {
    return featureModel?.trim() || defaultModel?.trim() || "anthropic/claude-sonnet-4-6";
  }

  // Feature-specific override wins
  assert.equal(resolveModel("openai/gpt-4.1-mini", "anthropic/claude-haiku-4-5"), "openai/gpt-4.1-mini");
  // Falls back to default model
  assert.equal(resolveModel(undefined, "anthropic/claude-haiku-4-5"), "anthropic/claude-haiku-4-5");
  // Falls back to hardcoded default
  assert.equal(resolveModel(undefined, undefined), "anthropic/claude-sonnet-4-6");
  // Empty strings fall through
  assert.equal(resolveModel("", ""), "anthropic/claude-sonnet-4-6");
});

test("SANDBOX_RUNTIME: loadConfig preserves explicit runtime mode", () => {
  const originalEnv = process.env;
  try {
    process.env = {
      ...originalEnv,
      SANDBOX_RUNTIME: "docker",
      SANDBOX_ENABLED: "false"
    };
    const config = loadConfig();
    assert.equal(config.sandboxRuntime, "docker");
    assert.equal(config.sandboxEnabled, true);
    assert.equal(config.sandboxRuntimeExplicit, true);

    process.env = {
      ...originalEnv,
      SANDBOX_RUNTIME: "docker"
    };
    const configWithoutLegacy = loadConfig();
    assert.equal(configWithoutLegacy.sandboxRuntime, "docker");
    assert.equal(configWithoutLegacy.sandboxEnabled, true);
    assert.equal(configWithoutLegacy.sandboxRuntimeExplicit, true);
  } finally {
    process.env = originalEnv;
  }
});

test("SANDBOX_RUNTIME: loadConfig lets explicit local override legacy enabled", () => {
  const originalEnv = process.env;
  try {
    process.env = {
      ...originalEnv,
      SANDBOX_RUNTIME: "local",
      SANDBOX_ENABLED: "true"
    };
    const config = loadConfig();
    assert.equal(config.sandboxRuntime, "local");
    assert.equal(config.sandboxEnabled, false);
    assert.equal(config.sandboxRuntimeExplicit, true);
  } finally {
    process.env = originalEnv;
  }
});

test("SANDBOX_RUNTIME: loadConfig preserves kubernetes without enabling sandbox", () => {
  const originalEnv = process.env;
  try {
    process.env = {
      ...originalEnv,
      SANDBOX_RUNTIME: "kubernetes"
    };
    const config = loadConfig();
    assert.equal(config.sandboxRuntime, "kubernetes");
    assert.equal(config.sandboxEnabled, false);
    assert.equal(config.sandboxRuntimeExplicit, true);
  } finally {
    process.env = originalEnv;
  }
});

test("SANDBOX_RUNTIME: loadConfig throws for invalid explicit value", () => {
  const originalEnv = process.env;
  try {
    process.env = {
      ...originalEnv,
      SANDBOX_RUNTIME: "invalid"
    };
    assert.throws(() => loadConfig(), /Invalid SANDBOX_RUNTIME value: invalid/);
  } finally {
    process.env = originalEnv;
  }
});

test("SANDBOX_RUNTIME: loadConfig throws for blank explicit value", () => {
  const originalEnv = process.env;
  try {
    process.env = {
      ...originalEnv,
      SANDBOX_RUNTIME: "   "
    };
    assert.throws(() => loadConfig(), /Invalid SANDBOX_RUNTIME value:/);
  } finally {
    process.env = originalEnv;
  }
});

test("work item review reset flags default to false", () => {
  const originalEnv = process.env;
  try {
    process.env = {
      ...originalEnv,
      FEATURE_DELIVERY_RESET_ENGINEERING_REVIEW_ON_NEW_COMMITS: undefined,
      FEATURE_DELIVERY_RESET_QA_REVIEW_ON_NEW_COMMITS: undefined,
      FEATURE_DELIVERY_SKIP_PRODUCT_REVIEW: undefined,
    };
    const config = loadConfig();
    assert.equal(config.featureDeliveryResetEngineeringReviewOnNewCommits, false);
    assert.equal(config.featureDeliveryResetQaReviewOnNewCommits, false);
    assert.equal(config.featureDeliverySkipProductReview, false);
  } finally {
    process.env = originalEnv;
  }
});

test("work item review reset flags respect env overrides", () => {
  const originalEnv = process.env;
  try {
    process.env = {
      ...originalEnv,
      FEATURE_DELIVERY_RESET_ENGINEERING_REVIEW_ON_NEW_COMMITS: "true",
      FEATURE_DELIVERY_RESET_QA_REVIEW_ON_NEW_COMMITS: "yes",
      FEATURE_DELIVERY_SKIP_PRODUCT_REVIEW: "true",
    };
    const config = loadConfig();
    assert.equal(config.featureDeliveryResetEngineeringReviewOnNewCommits, true);
    assert.equal(config.featureDeliveryResetQaReviewOnNewCommits, true);
    assert.equal(config.featureDeliverySkipProductReview, true);
  } finally {
    process.env = originalEnv;
  }
});

test("loadConfig does not expose removed QA preparation skip flag", () => {
  const config = loadConfig();
  const removedKey = "featureDelivery" + "SkipQaPreparation";
  assert.equal(removedKey in config, false);
});

test("branch sync max behind commits accepts zero", () => {
  const originalEnv = process.env;
  try {
    process.env = {
      ...originalEnv,
      AUTO_REVIEW_BRANCH_SYNC_MAX_BEHIND_COMMITS: "0",
    };
    const config = loadConfig();
    assert.equal(config.autoReviewBranchSyncMaxBehindCommits, 0);
  } finally {
    process.env = originalEnv;
  }
});

test("branch sync max behind commits rejects trailing garbage", () => {
  const originalEnv = process.env;
  try {
    process.env = {
      ...originalEnv,
      AUTO_REVIEW_BRANCH_SYNC_MAX_BEHIND_COMMITS: "0abc",
    };
    const config = loadConfig();
    assert.equal(config.autoReviewBranchSyncMaxBehindCommits, 5);
  } finally {
    process.env = originalEnv;
  }
});

test("work item GitHub adoption labels default to ai:assist", () => {
  const originalEnv = process.env;
  try {
    process.env = {
      ...originalEnv,
      WORK_ITEM_GITHUB_ADOPTION_LABELS: undefined,
    };
    const config = loadConfig();
    assert.deepEqual(config.workItemGithubAdoptionLabels, ["ai:assist"]);
  } finally {
    process.env = originalEnv;
  }
});

test("default team config defaults and env overrides", () => {
  const originalEnv = process.env;
  const removedSlackChannelLabelKey = ["defaultTeam", "SlackChannel", "Name"].join("");
  try {
    process.env = {
      ...originalEnv,
      DEFAULT_TEAM_NAME: undefined,
      DEFAULT_TEAM_SLACK_CHANNEL_ID: undefined,
    };
    const defaults = loadConfig();
    assert.equal(defaults.defaultTeamName, "default");
    assert.equal(defaults.defaultTeamSlackChannelId, undefined);
    assert.equal(removedSlackChannelLabelKey in defaults, false);

    process.env = {
      ...originalEnv,
      DEFAULT_TEAM_NAME: "growth",
      DEFAULT_TEAM_SLACK_CHANNEL_ID: "C_GROWTH",
    };
    const overridden = loadConfig();
    assert.equal(overridden.defaultTeamName, "growth");
    assert.equal(overridden.defaultTeamSlackChannelId, "C_GROWTH");
    assert.equal(removedSlackChannelLabelKey in overridden, false);
  } finally {
    process.env = originalEnv;
  }
});

test("work item GitHub adoption labels respect comma-separated env", () => {
  const originalEnv = process.env;
  try {
    process.env = {
      ...originalEnv,
      WORK_ITEM_GITHUB_ADOPTION_LABELS: "ai:assist, ai-delivery",
    };
    const config = loadConfig();
    assert.deepEqual(config.workItemGithubAdoptionLabels, ["ai:assist", "ai-delivery"]);
  } finally {
    process.env = originalEnv;
  }
});

test("Jira read access envs are exposed through config", () => {
  const originalEnv = process.env;
  try {
    process.env = {
      ...originalEnv,
      JIRA_BASE_URL: " https://example.atlassian.net ",
      JIRA_CLOUD_ID: " cloud-123 ",
      JIRA_USER: " jira-service-account@example.com ",
      JIRA_API_TOKEN: " jira-token ",
      JIRA_REQUEST_TIMEOUT_MS: "25000",
    };
    const config = loadConfig();
    assert.equal(config.jiraBaseUrl, "https://example.atlassian.net");
    assert.equal(config.jiraCloudId, "cloud-123");
    assert.equal(config.jiraUser, "jira-service-account@example.com");
    assert.equal(config.jiraApiToken, "jira-token");
    assert.equal(config.jiraRequestTimeoutMs, 25000);
  } finally {
    process.env = originalEnv;
  }
});

test("feature flags are normalized under config.features with defaults and env overrides", () => {
  const originalEnv = process.env;
  try {
    process.env = {
      ...originalEnv,
      OBSERVER_ENABLED: undefined,
      WORK_ITEMS_ENABLED: undefined,
      BROWSER_VERIFY_ENABLED: "true",
      CI_WAIT_ENABLED: undefined,
      SUPERVISOR_ENABLED: undefined,
      SESSIONS_ENABLED: "yes",
      EVAL_ENABLED: undefined,
      AUTONOMOUS_SCHEDULER_ENABLED: "1",
    };

    const config = loadConfig();
    assert.deepEqual(config.features, {
      observer: false,
      workItems: false,
      browserVerify: true,
      ciWait: false,
      supervisor: true,
      sessions: true,
      eval: false,
      autonomousScheduler: true,
    });
  } finally {
    process.env = originalEnv;
  }
});

test("AUTO_REVIEW_DEBUG_LOG_MODE defaults to failures and respects env override", () => {
  const originalEnv = process.env;
  try {
    process.env = {
      ...originalEnv,
      AUTO_REVIEW_DEBUG_LOG_MODE: undefined,
    };
    const defaults = loadConfig();
    assert.equal(defaults.autoReviewDebugLogMode, "failures");

    process.env = {
      ...originalEnv,
      AUTO_REVIEW_DEBUG_LOG_MODE: "always",
    };
    const overridden = loadConfig();
    assert.equal(overridden.autoReviewDebugLogMode, "always");
  } finally {
    process.env = originalEnv;
  }
});

test("Jira read access defaults stay unset without env vars", () => {
  const originalEnv = process.env;
  try {
    process.env = {
      ...originalEnv,
      JIRA_BASE_URL: undefined,
      JIRA_CLOUD_ID: undefined,
      JIRA_USER: undefined,
      JIRA_API_TOKEN: undefined,
      JIRA_REQUEST_TIMEOUT_MS: undefined,
    };
    const config = loadConfig();
    assert.equal(config.jiraBaseUrl, undefined);
    assert.equal(config.jiraCloudId, undefined);
    assert.equal(config.jiraUser, undefined);
    assert.equal(config.jiraApiToken, undefined);
    assert.equal(config.jiraRequestTimeoutMs, 10_000);
  } finally {
    process.env = originalEnv;
  }
});
