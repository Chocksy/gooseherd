import assert from "node:assert/strict";
import test from "node:test";
import type { AppConfig } from "../src/config.js";
import type { RunEnvelope } from "../src/runtime/control-plane-types.js";
import { applyRunnerConfigPayload, buildRunnerConfigPayload } from "../src/runtime/runner-config-payload.js";

function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    agentCommandTemplate: "env command",
    agentFollowUpTemplate: "env follow-up",
    activeAgentProfile: {
      id: "env-template",
      name: "Raw AGENT_COMMAND_TEMPLATE",
      runtime: "custom",
      commandTemplate: "env command",
      source: "env",
    },
    ...overrides,
  } as AppConfig;
}

function makePayload(payloadJson: Record<string, unknown>): RunEnvelope {
  return {
    runId: "run-runner-config-payload-1",
    payloadRef: "payload/run-runner-config-payload-1",
    payloadJson,
    runtime: "kubernetes",
    createdAt: new Date("2026-04-17T00:00:00.000Z").toISOString(),
    updatedAt: new Date("2026-04-17T00:00:00.000Z").toISOString(),
  };
}

test("buildRunnerConfigPayload snapshots effective agent settings", () => {
  const payload = buildRunnerConfigPayload(makeConfig({
    agentCommandTemplate: "profile command",
    agentFollowUpTemplate: "profile follow-up",
    activeAgentProfile: {
      id: "profile-1",
      name: "Codex",
      runtime: "codex",
      provider: "openai",
      model: "gpt-5.4",
      commandTemplate: "profile command",
      source: "profile",
    },
  }));

  assert.deepEqual(payload, {
    agentCommandTemplate: "profile command",
    agentFollowUpTemplate: "profile follow-up",
    activeAgentProfile: {
      id: "profile-1",
      name: "Codex",
      runtime: "codex",
      provider: "openai",
      model: "gpt-5.4",
      commandTemplate: "profile command",
      source: "profile",
    },
  });
});

test("applyRunnerConfigPayload overrides runner config from payload snapshot", () => {
  const config = makeConfig();

  applyRunnerConfigPayload(config, makePayload({
    runnerConfig: {
      agentCommandTemplate: "payload command",
      agentFollowUpTemplate: "payload follow-up",
      activeAgentProfile: {
        id: "profile-2",
        name: "Claude",
        runtime: "claude",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        commandTemplate: "payload command",
        source: "profile",
      },
    },
  }));

  assert.equal(config.agentCommandTemplate, "payload command");
  assert.equal(config.agentFollowUpTemplate, "payload follow-up");
  assert.deepEqual(config.activeAgentProfile, {
    id: "profile-2",
    name: "Claude",
    runtime: "claude",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    commandTemplate: "payload command",
    source: "profile",
  });
});

test("applyRunnerConfigPayload leaves env config untouched when snapshot is absent", () => {
  const config = makeConfig();

  applyRunnerConfigPayload(config, makePayload({ run: { id: "run-runner-config-payload-1" } }));

  assert.equal(config.agentCommandTemplate, "env command");
  assert.equal(config.agentFollowUpTemplate, "env follow-up");
  assert.deepEqual(config.activeAgentProfile, {
    id: "env-template",
    name: "Raw AGENT_COMMAND_TEMPLATE",
    runtime: "custom",
    commandTemplate: "env command",
    source: "env",
  });
});
