import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AppConfig } from "../src/config.js";
import {
  buildAgentProfileTargetCatalog,
  buildCandidateTargetKeys,
  targetKeyFromTarget,
} from "../src/agent-profile-targets.js";
import {
  resolveAgentCommandTemplate,
  resolveLLMProfileSelection,
  type AgentProfilePolicySnapshot,
  type AgentProfileSnapshot,
} from "../src/agent-profile-resolver.js";
import type { StoredPipeline } from "../src/pipeline/pipeline-store.js";

function makeRoutingConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    agentCommandTemplate: "fallback-agent @{{prompt_file}}",
    openrouterApiKey: "or-key",
    openrouterProviderPreferences: undefined,
    ...overrides,
  } as AppConfig;
}

function policy(targetKey: string, profileId: string): AgentProfilePolicySnapshot {
  return {
    id: `policy-${profileId}`,
    scope: "intent_action",
    targetKey,
    mode: "single",
    enabled: true,
    members: [{ profileId, ordinal: 0, enabled: true }],
  };
}

describe("agent profile routing", () => {
  test("generates stable target keys from structured targets", () => {
    assert.equal(
      targetKeyFromTarget({ scope: "intent_action", intentKind: "feature_delivery.self_review", action: "implement" }),
      "intent:feature_delivery.self_review|action:implement",
    );
    assert.equal(targetKeyFromTarget({ scope: "pipeline", pipelineId: "ci-fix" }), "pipeline:ci-fix");
  });

  test("orders runtime target candidates from specific to broad", () => {
    const keys = buildCandidateTargetKeys({
      pipelineName: "ci-fix",
      pipelineId: "ci-fix",
      intentKind: "feature_delivery.repair_ci",
      nodeId: "fix_ci_loop_1",
      nodeAction: "fix_ci",
    });

    assert.deepEqual(keys.slice(0, 4), [
      "pipeline:ci-fix|node:fix_ci_loop_1",
      "intent:feature_delivery.repair_ci|node:fix_ci_loop_1",
      "pipeline:ci-fix|action:fix_ci",
      "intent:feature_delivery.repair_ci|action:fix_ci",
    ]);
    assert.ok(keys.includes("action:fix_ci"));
  });

  test("keeps purpose as a refinement of each specificity level", () => {
    const keys = buildCandidateTargetKeys({
      pipelineId: "ci-fix",
      intentKind: "feature_delivery.repair_ci",
      nodeId: "fix_ci_loop_1",
      nodeAction: "fix_ci",
      purpose: "escalation",
    });

    assert.deepEqual(keys.slice(0, 6), [
      "pipeline:ci-fix|node:fix_ci_loop_1|purpose:escalation",
      "pipeline:ci-fix|node:fix_ci_loop_1",
      "intent:feature_delivery.repair_ci|node:fix_ci_loop_1|purpose:escalation",
      "intent:feature_delivery.repair_ci|node:fix_ci_loop_1",
      "pipeline:ci-fix|action:fix_ci|purpose:escalation",
      "pipeline:ci-fix|action:fix_ci",
    ]);
  });

  test("selects CLI agent profile policy before default profile", () => {
    const profiles: AgentProfileSnapshot[] = [
      {
        id: "top",
        name: "Top model",
        runtime: "custom",
        commandTemplate: "top-agent @{{prompt_file}}",
      },
    ];
    const config = makeRoutingConfig({
      activeAgentProfile: {
        id: "default",
        name: "Default fallback",
        runtime: "custom",
        commandTemplate: "default-agent @{{prompt_file}}",
        source: "profile",
      },
      agentProfileCatalog: profiles,
      agentProfilePolicies: [policy("intent:feature_delivery.self_review|action:implement", "top")],
    });

    const resolved = resolveAgentCommandTemplate(config, {
      pipelineName: "feature-delivery-self-review",
      intentKind: "feature_delivery.self_review",
      nodeId: "implement",
      nodeAction: "implement",
    });

    assert.equal(resolved.template, "top-agent @{{prompt_file}}");
    assert.equal(resolved.selection.source, "policy");
    assert.equal(resolved.selection.profile?.id, "top");
  });

  test("falls through disabled policies, disabled members, missing profiles, and incompatible capabilities", () => {
    const profiles: AgentProfileSnapshot[] = [
      {
        id: "disabled-member",
        name: "Disabled member",
        runtime: "custom",
        commandTemplate: "disabled @{{prompt_file}}",
      },
      {
        id: "incompatible",
        name: "Incompatible direct LLM",
        runtime: "custom",
      },
      {
        id: "selected",
        name: "Selected",
        runtime: "custom",
        commandTemplate: "selected @{{prompt_file}}",
      },
    ];
    const config = makeRoutingConfig({
      activeAgentProfile: {
        id: "default",
        name: "Default fallback",
        runtime: "custom",
        commandTemplate: "default-agent @{{prompt_file}}",
        source: "profile",
      },
      agentProfileCatalog: profiles,
      agentProfilePolicies: [
        { ...policy("pipeline:ci-fix|node:fix_ci_loop_1", "selected"), enabled: false },
        policy("pipeline:ci-fix|action:fix_ci", "missing"),
        {
          ...policy("intent:feature_delivery.repair_ci|node:fix_ci_loop_1", "disabled-member"),
          members: [{ profileId: "disabled-member", ordinal: 0, enabled: false }],
        },
        policy("intent:feature_delivery.repair_ci|action:fix_ci", "incompatible"),
        policy("action:fix_ci", "selected"),
      ],
    });

    const resolved = resolveAgentCommandTemplate(config, {
      pipelineId: "ci-fix",
      intentKind: "feature_delivery.repair_ci",
      nodeId: "fix_ci_loop_1",
      nodeAction: "fix_ci",
    });

    assert.equal(resolved.template, "selected @{{prompt_file}}");
    assert.equal(resolved.selection.targetKey, "action:fix_ci");
  });

  test("ignores non-routable runtime actions even if a stale policy exists", () => {
    const config = makeRoutingConfig({
      activeAgentProfile: {
        id: "default",
        name: "Default fallback",
        runtime: "custom",
        commandTemplate: "default-agent @{{prompt_file}}",
        source: "profile",
      },
      agentProfileCatalog: [
        {
          id: "clone-profile",
          name: "Clone profile",
          runtime: "custom",
          commandTemplate: "clone-agent @{{prompt_file}}",
        },
      ],
      agentProfilePolicies: [policy("action:clone", "clone-profile")],
    });

    const resolved = resolveAgentCommandTemplate(config, {
      pipelineId: "ci-fix",
      nodeId: "clone",
      nodeAction: "clone",
    });

    assert.equal(resolved.template, "default-agent @{{prompt_file}}");
    assert.equal(resolved.selection.source, "default");
  });

  test("falls back to default CLI profile when no policy matches", () => {
    const config = makeRoutingConfig({
      activeAgentProfile: {
        id: "default",
        name: "Default fallback",
        runtime: "custom",
        commandTemplate: "default-agent @{{prompt_file}}",
        source: "profile",
      },
      agentProfileCatalog: [],
      agentProfilePolicies: [],
    });

    const resolved = resolveAgentCommandTemplate(config, {
      pipelineName: "pipeline",
      intentKind: "generic_task",
      nodeId: "implement",
      nodeAction: "implement",
    });

    assert.equal(resolved.template, "default-agent @{{prompt_file}}");
    assert.equal(resolved.selection.source, "default");
  });

  test("routes direct LLM nodes through OpenRouter profile policies", () => {
    const config = makeRoutingConfig({
      agentProfileCatalog: [
        {
          id: "judge",
          name: "Judge model",
          runtime: "pi",
          provider: "openrouter",
          model: "openrouter/openai/gpt-4.1-mini",
          commandTemplate: "pi @{{prompt_file}}",
        },
      ],
      agentProfilePolicies: [policy("action:scope_judge", "judge")],
    });

    const resolved = resolveLLMProfileSelection(
      config,
      { nodeId: "scope_judge", nodeAction: "scope_judge" },
      "llm_json",
      "z-ai/glm-5",
      15_000,
    );

    assert.ok(resolved);
    assert.equal(resolved.source, "policy");
    assert.equal(resolved.model, "openai/gpt-4.1-mini");
    assert.equal(resolved.llmConfig.defaultModel, "openai/gpt-4.1-mini");
  });

  test("builds UI catalog from stored pipeline YAML without raw target strings", () => {
    const pipelines: StoredPipeline[] = [
      {
        id: "ci-fix",
        name: "CI Fix",
        description: "Fix failing CI",
        isBuiltIn: true,
        nodeCount: 2,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        yaml: [
          "version: 1",
          "name: CI Fix",
          "nodes:",
          "  - id: clone",
          "    type: deterministic",
          "    action: clone",
          "  - id: fix_ci_loop_1",
          "    type: agentic",
          "    action: fix_ci",
        ].join("\n"),
      },
    ];

    const catalog = buildAgentProfileTargetCatalog(pipelines);
    const ci = catalog.pipelines.find((entry) => entry.id === "ci-fix");
    assert.ok(ci);
    assert.equal(ci.nodes.find((node) => node.id === "clone")?.routable, false);
    assert.equal(ci.nodes.find((node) => node.id === "fix_ci_loop_1")?.routable, true);
    assert.ok(catalog.presets.some((preset) => preset.id === "code_review_self_review_implementation"));
  });
});
