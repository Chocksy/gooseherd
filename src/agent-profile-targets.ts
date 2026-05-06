import { loadPipelineFromString } from "./pipeline/pipeline-loader.js";
import type { PipelineConfig } from "./pipeline/types.js";
import type { StoredPipeline } from "./pipeline/pipeline-store.js";
import type { RunIntentKind } from "./runs/run-intent.js";
import {
  FEATURE_DELIVERY_BRANCH_SYNC_PIPELINE_ID,
  FEATURE_DELIVERY_CI_FIX_PIPELINE_ID,
  FEATURE_DELIVERY_READY_FOR_MERGE_PIPELINE_ID,
  FEATURE_DELIVERY_REVIEW_FEEDBACK_PIPELINE_ID,
  FEATURE_DELIVERY_SELF_REVIEW_PIPELINE_ID,
  FEATURE_DELIVERY_TRIAGE_CI_PIPELINE_ID,
  GENERIC_PIPELINE_ID,
} from "./pipeline/builtin-pipelines.js";

export const AGENT_PROFILE_CAPABILITIES = ["cli_agent", "llm_text", "llm_json", "llm_vision"] as const;
export type AgentProfileCapability = typeof AGENT_PROFILE_CAPABILITIES[number];

export const AGENT_PROFILE_POLICY_MODES = [
  "single",
  "fallback_chain",
  // Persisted as forward-compatible modes; execution currently gates to IMPLEMENTED_AGENT_PROFILE_POLICY_MODES.
  "sequential",
  "parallel_review",
  "parallel_review_then_apply",
  "vote",
] as const;
export type AgentProfilePolicyMode = typeof AGENT_PROFILE_POLICY_MODES[number];

export const IMPLEMENTED_AGENT_PROFILE_POLICY_MODES: AgentProfilePolicyMode[] = ["single", "fallback_chain"];

export const AGENT_PROFILE_TARGET_SCOPES = [
  "pipeline",
  "pipeline_action",
  "pipeline_node",
  "intent",
  "intent_action",
  "intent_node",
  "global_action",
] as const;
export type AgentProfileTargetScope = typeof AGENT_PROFILE_TARGET_SCOPES[number];

export interface AgentProfileTarget {
  scope: AgentProfileTargetScope;
  pipelineId?: string;
  intentKind?: RunIntentKind | string;
  action?: string;
  nodeId?: string;
  purpose?: string;
}

export interface RuntimeAgentProfileTarget {
  pipelineName?: string;
  pipelineId?: string;
  intentKind?: RunIntentKind | string;
  nodeId?: string;
  nodeAction?: string;
  purpose?: string;
}

export interface AgentProfileActionCatalogEntry {
  id: string;
  label: string;
  group: string;
  routable: boolean;
  requires: AgentProfileCapability[];
}

export interface AgentProfileIntentCatalogEntry {
  id: RunIntentKind | string;
  label: string;
  pipelineId?: string;
}

export interface AgentProfileTargetPreset {
  id: string;
  label: string;
  description?: string;
  target: AgentProfileTarget;
}

export interface AgentProfileTargetCatalog {
  targetScopes: Array<{ id: AgentProfileTargetScope; label: string; advanced?: boolean }>;
  policyModes: Array<{ id: AgentProfilePolicyMode; label: string; implemented: boolean; description?: string }>;
  intents: AgentProfileIntentCatalogEntry[];
  pipelines: Array<{
    id: string;
    label: string;
    description?: string;
    isBuiltIn: boolean;
    nodes: Array<{
      id: string;
      action: string;
      label: string;
      routable: boolean;
      requires: AgentProfileCapability[];
    }>;
  }>;
  actions: AgentProfileActionCatalogEntry[];
  presets: AgentProfileTargetPreset[];
}

const UNKNOWN_ACTION: AgentProfileActionCatalogEntry = {
  id: "unknown",
  label: "Unknown action",
  group: "Other",
  routable: false,
  requires: [],
};

export const AGENT_PROFILE_ACTION_CATALOG: Record<string, AgentProfileActionCatalogEntry> = {
  implement: {
    id: "implement",
    label: "Implementation",
    group: "Code-writing agents",
    routable: true,
    requires: ["cli_agent"],
  },
  fix_ci: {
    id: "fix_ci",
    label: "Fix CI",
    group: "Code-writing agents",
    routable: true,
    requires: ["cli_agent"],
  },
  triage_ci: {
    id: "triage_ci",
    label: "Triage CI failure",
    group: "Analysis agents",
    routable: true,
    requires: ["cli_agent"],
  },
  fix_validation: {
    id: "fix_validation",
    label: "Fix validation/local tests",
    group: "Code-writing agents",
    routable: true,
    requires: ["cli_agent"],
  },
  fix_browser: {
    id: "fix_browser",
    label: "Fix browser verification",
    group: "Code-writing agents",
    routable: true,
    requires: ["cli_agent"],
  },
  resolve_rebase_conflicts: {
    id: "resolve_rebase_conflicts",
    label: "Resolve rebase conflicts",
    group: "Code-writing agents",
    routable: true,
    requires: ["cli_agent"],
  },
  plan_task: {
    id: "plan_task",
    label: "Plan task",
    group: "Direct LLM",
    routable: true,
    requires: ["llm_text"],
  },
  generate_title: {
    id: "generate_title",
    label: "Generate title",
    group: "Direct LLM",
    routable: true,
    requires: ["llm_text"],
  },
  summarize_changes: {
    id: "summarize_changes",
    label: "Summarize changes",
    group: "Direct LLM",
    routable: true,
    requires: ["llm_text"],
  },
  scope_judge: {
    id: "scope_judge",
    label: "Scope judge",
    group: "Direct LLM / gates",
    routable: true,
    requires: ["llm_json"],
  },
  decide_next_step: {
    id: "decide_next_step",
    label: "Decide next recovery step",
    group: "Direct LLM / gates",
    routable: true,
    requires: ["llm_json"],
  },
  browser_verify: {
    id: "browser_verify",
    label: "Browser verification",
    group: "Direct LLM / browser",
    routable: true,
    requires: ["llm_vision"],
  },
  clone: { id: "clone", label: "Clone repository", group: "Deterministic", routable: false, requires: [] },
  hydrate_context: { id: "hydrate_context", label: "Hydrate context", group: "Deterministic", routable: false, requires: [] },
  classify_task: { id: "classify_task", label: "Classify task", group: "Deterministic", routable: false, requires: [] },
  lint_fix: { id: "lint_fix", label: "Lint fix", group: "Deterministic", routable: false, requires: [] },
  validate: { id: "validate", label: "Validate", group: "Deterministic", routable: false, requires: [] },
  local_test: { id: "local_test", label: "Local test", group: "Deterministic", routable: false, requires: [] },
  lightweight_checks: { id: "lightweight_checks", label: "Lightweight checks", group: "Deterministic", routable: false, requires: [] },
  diff_gate: { id: "diff_gate", label: "Diff gate", group: "Deterministic", routable: false, requires: [] },
  forbidden_files: { id: "forbidden_files", label: "Forbidden files gate", group: "Deterministic", routable: false, requires: [] },
  security_scan: { id: "security_scan", label: "Security scan", group: "Deterministic", routable: false, requires: [] },
  commit: { id: "commit", label: "Commit", group: "Deterministic", routable: false, requires: [] },
  push: { id: "push", label: "Push", group: "Deterministic", routable: false, requires: [] },
  create_pr: { id: "create_pr", label: "Create PR", group: "Deterministic", routable: false, requires: [] },
  wait_ci: { id: "wait_ci", label: "Wait for CI", group: "Async", routable: false, requires: [] },
  deploy_preview: { id: "deploy_preview", label: "Deploy preview", group: "Deterministic", routable: false, requires: [] },
  upload_screenshot: { id: "upload_screenshot", label: "Upload screenshot", group: "Deterministic", routable: false, requires: [] },
  notify: { id: "notify", label: "Notify", group: "Deterministic", routable: false, requires: [] },
  run: { id: "run", label: "Run shell command", group: "Deterministic", routable: false, requires: [] },
  setup_sandbox: { id: "setup_sandbox", label: "Setup sandbox", group: "Deterministic", routable: false, requires: [] },
  sync_base_branch: { id: "sync_base_branch", label: "Sync base branch", group: "Deterministic", routable: false, requires: [] },
  squash_ready_for_merge: { id: "squash_ready_for_merge", label: "Squash ready-for-merge branch", group: "Deterministic", routable: false, requires: [] },
};

export const AGENT_PROFILE_INTENT_CATALOG: AgentProfileIntentCatalogEntry[] = [
  { id: "generic_task", label: "Generic/manual task", pipelineId: GENERIC_PIPELINE_ID },
  { id: "feature_delivery.self_review", label: "Feature delivery: self-review", pipelineId: FEATURE_DELIVERY_SELF_REVIEW_PIPELINE_ID },
  { id: "feature_delivery.apply_review_feedback", label: "Feature delivery: apply reviewer feedback", pipelineId: FEATURE_DELIVERY_REVIEW_FEEDBACK_PIPELINE_ID },
  { id: "feature_delivery.repair_ci", label: "Feature delivery: repair CI", pipelineId: FEATURE_DELIVERY_CI_FIX_PIPELINE_ID },
  { id: "feature_delivery.triage_ci", label: "Feature delivery: triage CI", pipelineId: FEATURE_DELIVERY_TRIAGE_CI_PIPELINE_ID },
  { id: "feature_delivery.sync_branch", label: "Feature delivery: sync branch", pipelineId: FEATURE_DELIVERY_BRANCH_SYNC_PIPELINE_ID },
  { id: "feature_delivery.finalize_pr", label: "Feature delivery: ready for merge", pipelineId: FEATURE_DELIVERY_READY_FOR_MERGE_PIPELINE_ID },
];

export const AGENT_PROFILE_TARGET_PRESETS: AgentProfileTargetPreset[] = [
  {
    id: "code_review_self_review_implementation",
    label: "Code review: self-review implementation",
    description: "Use this profile when an existing feature-delivery PR is self-reviewed and patched.",
    target: { scope: "intent_action", intentKind: "feature_delivery.self_review", action: "implement" },
  },
  {
    id: "code_review_apply_feedback_implementation",
    label: "Code review: apply reviewer feedback",
    description: "Use this profile when reviewer feedback is applied to a feature-delivery PR.",
    target: { scope: "intent_action", intentKind: "feature_delivery.apply_review_feedback", action: "implement" },
  },
  {
    id: "ci_repair_workflow",
    label: "CI repair workflow",
    description: "Use this profile across the CI-fix workflow.",
    target: { scope: "pipeline", pipelineId: FEATURE_DELIVERY_CI_FIX_PIPELINE_ID },
  },
  {
    id: "ci_repair_agent",
    label: "CI repair agent step",
    description: "Use this profile only for CI-fixing agent steps.",
    target: { scope: "global_action", action: "fix_ci" },
  },
  {
    id: "title_generation",
    label: "Title generation",
    description: "Use this profile for short dashboard title generation.",
    target: { scope: "global_action", action: "generate_title" },
  },
  {
    id: "scope_judge",
    label: "Scope judge",
    description: "Use this profile for structured scope-judge decisions.",
    target: { scope: "global_action", action: "scope_judge" },
  },
  {
    id: "browser_verification",
    label: "Browser verification",
    description: "Use this profile for browser/vision verification.",
    target: { scope: "global_action", action: "browser_verify" },
  },
];

const TARGET_SCOPE_LABELS: Record<AgentProfileTargetScope, string> = {
  pipeline: "Whole workflow",
  pipeline_action: "Specific action in workflow",
  pipeline_node: "Specific node in workflow",
  intent: "Semantic run intent",
  intent_action: "Specific action in semantic intent",
  intent_node: "Specific node in semantic intent",
  global_action: "All actions of this type",
};

const POLICY_MODE_LABELS: Record<AgentProfilePolicyMode, { label: string; description?: string }> = {
  single: { label: "Single profile", description: "Use one profile for this target." },
  fallback_chain: { label: "Fallback chain", description: "Use profiles in order. Execution currently selects the first compatible profile; direct per-call retries can be layered on top later." },
  sequential: { label: "Sequential", description: "Future mode: run multiple profiles one after another." },
  parallel_review: { label: "Parallel review", description: "Future mode: multiple review-only profiles in parallel." },
  parallel_review_then_apply: { label: "Parallel review, then apply", description: "Future mode: multiple reviewers, one executor." },
  vote: { label: "Vote", description: "Future mode: multiple judge profiles vote on a decision." },
};

const TARGET_IDENTIFIER_MAX_LENGTH = 128;
const TARGET_IDENTIFIER_PATTERN = /^[A-Za-z0-9_.:-]+$/;

export function actionCatalogEntry(action: string | undefined): AgentProfileActionCatalogEntry {
  if (!action) return UNKNOWN_ACTION;
  return AGENT_PROFILE_ACTION_CATALOG[action] ?? {
    id: action,
    label: prettifyIdentifier(action),
    group: "Custom actions",
    routable: false,
    requires: [],
  };
}

export function targetKeyFromTarget(target: AgentProfileTarget): string {
  const parts: string[] = [];
  switch (target.scope) {
    case "pipeline":
      requireField(target.pipelineId, "pipelineId", target.scope);
      parts.push(`pipeline:${target.pipelineId}`);
      break;
    case "pipeline_action":
      requireField(target.pipelineId, "pipelineId", target.scope);
      requireField(target.action, "action", target.scope);
      parts.push(`pipeline:${target.pipelineId}`, `action:${target.action}`);
      break;
    case "pipeline_node":
      requireField(target.pipelineId, "pipelineId", target.scope);
      requireField(target.nodeId, "nodeId", target.scope);
      parts.push(`pipeline:${target.pipelineId}`, `node:${target.nodeId}`);
      break;
    case "intent":
      requireField(target.intentKind, "intentKind", target.scope);
      parts.push(`intent:${target.intentKind}`);
      break;
    case "intent_action":
      requireField(target.intentKind, "intentKind", target.scope);
      requireField(target.action, "action", target.scope);
      parts.push(`intent:${target.intentKind}`, `action:${target.action}`);
      break;
    case "intent_node":
      requireField(target.intentKind, "intentKind", target.scope);
      requireField(target.nodeId, "nodeId", target.scope);
      parts.push(`intent:${target.intentKind}`, `node:${target.nodeId}`);
      break;
    case "global_action":
      requireField(target.action, "action", target.scope);
      parts.push(`action:${target.action}`);
      break;
    default:
      assertNever(target.scope);
  }
  if (target.purpose) {
    parts.push(`purpose:${target.purpose}`);
  }
  return parts.join("|");
}

export function buildCandidateTargetKeys(target: RuntimeAgentProfileTarget): string[] {
  const pipelineId = target.pipelineId ?? target.pipelineName;
  const action = target.nodeAction;
  const candidates = [
    pipelineId && target.nodeId ? `pipeline:${pipelineId}|node:${target.nodeId}` : undefined,
    target.intentKind && target.nodeId ? `intent:${target.intentKind}|node:${target.nodeId}` : undefined,
    pipelineId && action ? `pipeline:${pipelineId}|action:${action}` : undefined,
    target.intentKind && action ? `intent:${target.intentKind}|action:${action}` : undefined,
    pipelineId ? `pipeline:${pipelineId}` : undefined,
    target.intentKind ? `intent:${target.intentKind}` : undefined,
    target.nodeId ? `node:${target.nodeId}` : undefined,
    action ? `action:${action}` : undefined,
  ];

  const ordered: string[] = [];
  for (const key of candidates.filter((candidate): candidate is string => Boolean(candidate))) {
    if (target.purpose) {
      ordered.push(`${key}|purpose:${target.purpose}`);
    }
    ordered.push(key);
  }

  return [...new Set(ordered)];
}

export function targetRequiresCapabilities(target: Pick<AgentProfileTarget, "action" | "scope">): AgentProfileCapability[] {
  if (!target.action) {
    return ["cli_agent", "llm_text", "llm_json", "llm_vision"];
  }
  return actionCatalogEntry(target.action).requires;
}

export function runtimeTargetRequiresCapabilities(target: RuntimeAgentProfileTarget): AgentProfileCapability[] {
  return actionCatalogEntry(target.nodeAction).requires;
}

export function validateAgentProfileTarget(target: AgentProfileTarget, catalog?: AgentProfileTargetCatalog): string[] {
  const errors: string[] = [];
  if (!AGENT_PROFILE_TARGET_SCOPES.includes(target.scope)) {
    errors.push("Unknown target scope");
    return errors;
  }

  try {
    targetKeyFromTarget(target);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Invalid target");
  }

  if (target.action) {
    const action = AGENT_PROFILE_ACTION_CATALOG[target.action];
    if (!action) {
      errors.push(`Unknown action: ${target.action}`);
    } else if (!action.routable) {
      errors.push(`Action is not agent-profile routable: ${target.action}`);
    }
  }

  for (const field of ["pipelineId", "intentKind", "nodeId", "purpose"] as const) {
    const value = target[field];
    if (!value) continue;
    if (value.length > TARGET_IDENTIFIER_MAX_LENGTH) {
      errors.push(`${field} must be ${String(TARGET_IDENTIFIER_MAX_LENGTH)} characters or less`);
    }
    if (!TARGET_IDENTIFIER_PATTERN.test(value)) {
      errors.push(`${field} contains unsupported characters`);
    }
  }

  if (catalog) {
    if (target.pipelineId && !catalog.pipelines.some((pipeline) => pipeline.id === target.pipelineId)) {
      errors.push(`Unknown pipeline: ${target.pipelineId}`);
    }
    if (target.intentKind && !catalog.intents.some((intent) => intent.id === target.intentKind)) {
      errors.push(`Unknown intent kind: ${target.intentKind}`);
    }
    if (target.action && !catalog.actions.some((action) => action.id === target.action)) {
      errors.push(`Unknown action: ${target.action}`);
    }
    if (target.nodeId && target.pipelineId) {
      const pipeline = catalog.pipelines.find((entry) => entry.id === target.pipelineId);
      if (pipeline && !pipeline.nodes.some((node) => node.id === target.nodeId)) {
        errors.push(`Node '${target.nodeId}' does not exist in pipeline '${target.pipelineId}'`);
      }
    }
  }

  return errors;
}

export function buildAgentProfileTargetCatalog(pipelines: StoredPipeline[] = []): AgentProfileTargetCatalog {
  return {
    targetScopes: AGENT_PROFILE_TARGET_SCOPES.map((id) => ({
      id,
      label: TARGET_SCOPE_LABELS[id],
      ...(id === "intent_node" || id === "pipeline_node" ? { advanced: true } : {}),
    })),
    policyModes: AGENT_PROFILE_POLICY_MODES.map((id) => ({
      id,
      label: POLICY_MODE_LABELS[id].label,
      implemented: IMPLEMENTED_AGENT_PROFILE_POLICY_MODES.includes(id),
      ...(POLICY_MODE_LABELS[id].description ? { description: POLICY_MODE_LABELS[id].description } : {}),
    })),
    intents: AGENT_PROFILE_INTENT_CATALOG,
    pipelines: pipelines.map(pipelineToCatalogEntry),
    actions: Object.values(AGENT_PROFILE_ACTION_CATALOG).sort((a, b) => `${a.group}:${a.label}`.localeCompare(`${b.group}:${b.label}`)),
    presets: AGENT_PROFILE_TARGET_PRESETS,
  };
}

function pipelineToCatalogEntry(pipeline: StoredPipeline): AgentProfileTargetCatalog["pipelines"][number] {
  let config: PipelineConfig | undefined;
  try {
    config = loadPipelineFromString(pipeline.yaml);
  } catch {
    config = undefined;
  }

  const nodes = (config?.nodes ?? []).map((node) => {
    const action = actionCatalogEntry(node.action);
    return {
      id: node.id,
      action: node.action,
      label: action.routable ? action.label : prettifyIdentifier(node.id),
      routable: action.routable,
      requires: action.requires,
    };
  });

  return {
    id: pipeline.id,
    label: config?.name ?? pipeline.name ?? prettifyIdentifier(pipeline.id),
    ...(pipeline.description ? { description: pipeline.description } : {}),
    isBuiltIn: pipeline.isBuiltIn,
    nodes,
  };
}

function prettifyIdentifier(value: string): string {
  return value
    .replace(/(?=[A-Z])/g, " ")
    .replace(/[_.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function requireField(value: unknown, fieldName: string, scope: AgentProfileTargetScope): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fieldName} is required for target scope ${scope}`);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported target scope: ${String(value)}`);
}
