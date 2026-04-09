import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { shellEscape } from "./pipeline/shell.js";

export const AGENT_PROFILE_RUNTIMES = ["pi", "codex", "claude", "custom"] as const;
export const AGENT_PROFILE_PROVIDERS = ["openai", "openrouter", "anthropic"] as const;

export type AgentRuntime = typeof AGENT_PROFILE_RUNTIMES[number];
export type AgentProvider = typeof AGENT_PROFILE_PROVIDERS[number];

export interface AgentProfile {
  id: string;
  name: string;
  description?: string;
  runtime: AgentRuntime;
  provider?: AgentProvider;
  model?: string;
  tools: string[];
  mode?: string;
  extensions: string[];
  extraArgs?: string;
  isBuiltin: boolean;
  isActive: boolean;
  customCommandTemplate?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentProfileInput {
  name: string;
  description?: string;
  runtime: AgentRuntime;
  provider?: AgentProvider;
  model?: string;
  tools?: string[];
  mode?: string;
  extensions?: string[];
  extraArgs?: string;
  isBuiltin?: boolean;
  isActive?: boolean;
  customCommandTemplate?: string;
}

export interface AgentProfileValidationResult {
  ok: boolean;
  errors: string[];
}

export interface ProviderOption {
  id: AgentProvider;
  label: string;
  configured: boolean;
  envVar: string;
}

const DEFAULT_PI_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"];
const DEFAULT_CODEX_TOOLS = ["read", "write", "edit", "bash"];
const DEFAULT_CLAUDE_TOOLS = ["Read", "Edit", "Write", "Bash", "Grep", "Glob"];

const RUNTIME_PROVIDER_SUPPORT: Record<AgentRuntime, AgentProvider[]> = {
  pi: ["openai", "openrouter", "anthropic"],
  codex: ["openai"],
  claude: ["anthropic", "openrouter"],
  custom: ["openai", "openrouter", "anthropic"],
};

function trimOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

export function getAvailableProviders(config: AppConfig): ProviderOption[] {
  return [
    { id: "openai", label: "OpenAI", configured: Boolean(config.openaiApiKey), envVar: "OPENAI_API_KEY" },
    { id: "openrouter", label: "OpenRouter", configured: Boolean(config.openrouterApiKey), envVar: "OPENROUTER_API_KEY" },
    { id: "anthropic", label: "Anthropic", configured: Boolean(config.anthropicApiKey), envVar: "ANTHROPIC_API_KEY" },
  ];
}

export function isProviderConfigured(config: AppConfig, provider: AgentProvider): boolean {
  return getAvailableProviders(config).some((entry) => entry.id === provider && entry.configured);
}

export function sanitizeAgentProfileInput(input: AgentProfileInput): AgentProfileInput {
  return {
    name: String(input.name ?? "").trim(),
    description: trimOrUndefined(input.description),
    runtime: input.runtime,
    provider: input.provider,
    model: trimOrUndefined(input.model),
    tools: uniqueStrings(input.tools),
    mode: trimOrUndefined(input.mode),
    extensions: uniqueStrings(input.extensions),
    extraArgs: trimOrUndefined(input.extraArgs),
    isBuiltin: Boolean(input.isBuiltin),
    isActive: Boolean(input.isActive),
    customCommandTemplate: trimOrUndefined(input.customCommandTemplate),
  };
}

export function validateAgentProfile(input: AgentProfileInput, config: AppConfig): AgentProfileValidationResult {
  const profile = sanitizeAgentProfileInput(input);
  const errors: string[] = [];

  if (!AGENT_PROFILE_RUNTIMES.includes(profile.runtime)) {
    errors.push("Runtime is required");
  }
  if (!profile.name) {
    errors.push("Name is required");
  }

  if (profile.runtime === "custom") {
    if (!profile.customCommandTemplate) {
      errors.push("Custom command template is required for custom profiles");
    }
    return { ok: errors.length === 0, errors };
  }

  if (!profile.provider) {
    errors.push("Provider is required");
  } else {
    if (!RUNTIME_PROVIDER_SUPPORT[profile.runtime].includes(profile.provider)) {
      errors.push(`Runtime ${profile.runtime} does not support provider ${profile.provider}`);
    }
    if (!isProviderConfigured(config, profile.provider)) {
      errors.push(`Provider ${profile.provider} is not configured in the current environment`);
    }
  }

  if (!profile.model) {
    errors.push("Model is required");
  }

  return { ok: errors.length === 0, errors };
}

export function renderAgentProfileTemplate(profile: AgentProfileInput): string {
  const clean = sanitizeAgentProfileInput(profile);
  if (clean.runtime === "custom") {
    return clean.customCommandTemplate ?? "";
  }

  const tools = clean.tools ?? [];
  const extensions = clean.extensions ?? [];
  const extraArgs = clean.extraArgs ? ` ${clean.extraArgs}` : "";
  const mode = clean.mode ? ` ${clean.mode}` : "";

  if (clean.runtime === "pi") {
    const toolArg = tools.length > 0 ? ` --tools ${shellEscape(tools.join(","))}` : "";
    const extensionArg = extensions.length > 0
      ? ` ${extensions.map((extension) => `-e ${shellEscape(extension)}`).join(" ")}`
      : " {{pi_extensions}}";
    return `cd {{repo_dir}} && pi -p @{{prompt_file}} --model ${shellEscape(clean.model ?? "")} --no-session --mode json${toolArg}${mode}${extensionArg}${extraArgs} {{mcp_flags}}`.trim();
  }

  if (clean.runtime === "codex") {
    const modelArg = clean.model ? ` --model ${shellEscape(clean.model)}` : "";
    return `cd {{repo_dir}} && codex exec --full-auto${modelArg} "$(cat {{prompt_file}})"${extraArgs}`.trim();
  }

  const allowedTools = tools.length > 0 ? tools.join(",") : DEFAULT_CLAUDE_TOOLS.join(",");
  const modelArg = clean.model ? ` --model ${shellEscape(clean.model)}` : "";
  return `cd {{repo_dir}} && claude -p "$(cat {{prompt_file}})" --allowedTools ${shellEscape(allowedTools)}${modelArg}${extraArgs}`.trim();
}

export function resolveProfileCommandTemplate(profile: AgentProfileInput | undefined, fallbackTemplate: string): string {
  if (!profile) return fallbackTemplate;
  const rendered = renderAgentProfileTemplate(profile);
  return rendered || fallbackTemplate;
}

export function buildBuiltinAgentProfiles(config: AppConfig): AgentProfileInput[] {
  const profiles: AgentProfileInput[] = [];
  if (config.openaiApiKey) {
    profiles.push({
      name: "Pi + OpenAI",
      description: "Pi agent with OpenAI-backed model selection.",
      runtime: "pi",
      provider: "openai",
      model: "openai/gpt-4.1-mini",
      tools: DEFAULT_PI_TOOLS,
      isBuiltin: true,
    });
  }
  if (config.openrouterApiKey) {
    profiles.push({
      name: "Pi + OpenRouter",
      description: "Pi agent via OpenRouter for broad model access.",
      runtime: "pi",
      provider: "openrouter",
      model: "openrouter/openai/gpt-4.1-mini",
      tools: DEFAULT_PI_TOOLS,
      isBuiltin: true,
    });
  }
  if (config.openaiApiKey) {
    profiles.push({
      name: "Codex + OpenAI",
      description: "Codex one-shot execution against the OpenAI Responses API.",
      runtime: "codex",
      provider: "openai",
      model: "gpt-5.4",
      tools: DEFAULT_CODEX_TOOLS,
      isBuiltin: true,
    });
  }
  if (config.anthropicApiKey) {
    profiles.push({
      name: "Claude + Anthropic",
      description: "Claude CLI with Anthropic-hosted Claude models.",
      runtime: "claude",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      tools: DEFAULT_CLAUDE_TOOLS,
      isBuiltin: true,
    });
  }
  return profiles;
}

export function createAgentProfileRecord(input: AgentProfileInput): AgentProfile {
  const clean = sanitizeAgentProfileInput(input);
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name: clean.name,
    description: clean.description,
    runtime: clean.runtime,
    provider: clean.provider,
    model: clean.model,
    tools: clean.tools ?? [],
    mode: clean.mode,
    extensions: clean.extensions ?? [],
    extraArgs: clean.extraArgs,
    isBuiltin: Boolean(clean.isBuiltin),
    isActive: Boolean(clean.isActive),
    customCommandTemplate: clean.customCommandTemplate,
    createdAt: now,
    updatedAt: now,
  };
}
