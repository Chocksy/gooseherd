import type { IncomingMessage, ServerResponse } from "node:http";
import type { URL } from "node:url";
import type { AppConfig } from "../../config.js";
import { resolveGitHubAuthMode } from "../../config.js";
import { dashboardHtml } from "../html.js";
import { buildDashboardCapabilities } from "../capabilities.js";
import { buildDashboardSettingsPayload } from "../settings-payload.js";
import type { DashboardActorPrincipal } from "../actor-principal.js";
import type { RunStore } from "../../store.js";
import type { AgentProfileStore } from "../../db/agent-profile-store.js";
import type { ModelPriceStore } from "../../db/model-price-store.js";
import type { AgentProfileInput, AgentProvider } from "../../agent-profile.js";
import {
  getAvailableProviders,
  renderAgentProfileTemplate,
  sanitizeAgentProfileInput,
  validateAgentProfile,
} from "../../agent-profile.js";
import type { GitHubService } from "../../github.js";
import type { UserDirectoryService } from "../../user-directory/service.js";
import { readBody, requireDashboardAdminActor, sendJson, sendText } from "./shared.js";

const GITHUB_REPOSITORIES_CACHE_TTL_MS = 60_000;

export interface CachedGitHubRepositories {
  fetchedAt: number;
  repositories: Array<{
    defaultBranch?: string;
    fullName: string;
    htmlUrl?: string;
    private: boolean;
  }>;
}

export interface SettingsRoutesDeps {
  actorPrincipal?: DashboardActorPrincipal;
  agentProfileStore?: AgentProfileStore;
  config: AppConfig;
  githubRepositoriesCache?: CachedGitHubRepositories;
  githubService?: GitHubService;
  modelPriceStore?: ModelPriceStore;
  requestUrl: URL;
  setGitHubRepositoriesCache(cache: CachedGitHubRepositories | undefined): void;
  store: RunStore;
  userDirectory?: UserDirectoryService;
}

export function parseModelPriceUpdate(
  value: { inputPerM?: unknown; outputPerM?: unknown },
): { inputPerM: number; outputPerM: number } | null {
  if (
    typeof value.inputPerM === "string" && value.inputPerM.trim() === ""
    || typeof value.outputPerM === "string" && value.outputPerM.trim() === ""
  ) {
    return null;
  }

  const inputPerM = Number(value.inputPerM);
  const outputPerM = Number(value.outputPerM);
  if (!Number.isFinite(inputPerM) || inputPerM < 0 || !Number.isFinite(outputPerM) || outputPerM < 0) {
    return null;
  }

  return { inputPerM, outputPerM };
}

export async function handleSettingsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: SettingsRoutesDeps,
): Promise<boolean> {
  const {
    actorPrincipal,
    agentProfileStore,
    config,
    githubRepositoriesCache,
    githubService,
    modelPriceStore,
    requestUrl,
    setGitHubRepositoriesCache,
    store,
    userDirectory,
  } = deps;

  if (req.method === "GET" && pathname === "/") {
    sendText(res, 200, dashboardHtml(config), "text/html");
    return true;
  }

  if (req.method === "GET" && pathname === "/api/settings") {
    const githubAuthMode = resolveGitHubAuthMode(config);
    const stats = await computeRunStats(store);
    const modelPriceSummary = modelPriceStore ? (await modelPriceStore.list()).stats : undefined;
    const profiles = agentProfileStore ? (await agentProfileStore.list()).map((profile) => decorateAgentProfile(profile)) : [];
    const capabilities = buildDashboardCapabilities(config, actorPrincipal);
    const configOverrides = {
      githubFromEnv: parseOverrideFlag(process.env.GITHUB_CONFIG_OVERRIDE_FROM_ENV),
      slackFromEnv: parseOverrideFlag(process.env.SLACK_CONFIG_OVERRIDE_FROM_ENV),
      llmFromEnv: parseOverrideFlag(process.env.LLM_CONFIG_OVERRIDE_FROM_ENV),
    };
    const configPayload = buildDashboardSettingsPayload(
      config,
      capabilities,
      githubAuthMode,
      configOverrides,
      profiles,
    );

    sendJson(res, 200, {
      config: {
        ...configPayload,
        features: {
          observer: configPayload.capabilities.observer,
          browserVerify: configPayload.capabilities.browserVerify,
          scopeJudge: configPayload.capabilities.scopeJudge,
          ciWait: configPayload.capabilities.ciWait,
          dryRun: configPayload.capabilities.dryRun,
        },
        modelPrices: modelPriceSummary,
      },
      stats,
    });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/model-prices") {
    if (!modelPriceStore) {
      sendJson(res, 501, { error: "Model price store is unavailable" });
      return true;
    }
    sendJson(res, 200, await modelPriceStore.list());
    return true;
  }

  if (req.method === "POST" && pathname === "/api/model-prices/recalculate-incomplete") {
    if (!modelPriceStore) {
      sendJson(res, 501, { error: "Model price store is unavailable" });
      return true;
    }
    try {
      requireDashboardAdminActor(actorPrincipal);
    } catch (error) {
      sendJson(res, 403, { error: error instanceof Error ? error.message : "Forbidden" });
      return true;
    }
    sendJson(res, 200, await modelPriceStore.recalculateIncompleteRuns());
    return true;
  }

  const modelPriceMatch = pathname.match(/^\/api\/model-prices\/(.+)$/);
  if (req.method === "PUT" && modelPriceMatch) {
    if (!modelPriceStore) {
      sendJson(res, 501, { error: "Model price store is unavailable" });
      return true;
    }
    try {
      requireDashboardAdminActor(actorPrincipal);
    } catch (error) {
      sendJson(res, 403, { error: error instanceof Error ? error.message : "Forbidden" });
      return true;
    }
    const raw = await readBody(req);
    if (raw === null) {
      sendJson(res, 413, { error: "Request body too large" });
      return true;
    }
    let parsed: { inputPerM?: unknown; outputPerM?: unknown } = {};
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return true;
    }
    const update = parseModelPriceUpdate(parsed);
    if (!update) {
      sendJson(res, 422, { error: "inputPerM and outputPerM must be non-negative numbers" });
      return true;
    }
    const model = decodeURIComponent(modelPriceMatch[1]!);
    const updatedBy = actorPrincipal?.principalType === "admin_session" ? actorPrincipal.sessionId : undefined;
    sendJson(res, 200, { price: await modelPriceStore.save(model, update.inputPerM, update.outputPerM, updatedBy) });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/users") {
    if (!userDirectory) {
      sendJson(res, 501, { error: "User directory is unavailable" });
      return true;
    }
    try {
      requireDashboardAdminActor(actorPrincipal);
    } catch (error) {
      sendJson(res, 403, { error: error instanceof Error ? error.message : "Forbidden" });
      return true;
    }
    const listedUsers = await userDirectory.listUsers();
    sendJson(res, 200, { users: listedUsers });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/users") {
    if (!userDirectory) {
      sendJson(res, 501, { error: "User directory is unavailable" });
      return true;
    }
    try {
      requireDashboardAdminActor(actorPrincipal);
    } catch (error) {
      sendJson(res, 403, { error: error instanceof Error ? error.message : "Forbidden" });
      return true;
    }
    const raw = await readBody(req);
    if (raw === null) {
      sendJson(res, 413, { error: "Request body too large" });
      return true;
    }
    let parsed: {
      displayName?: string;
      githubLogin?: string | null;
      isActive?: boolean;
      jiraAccountId?: string | null;
      slackUserId?: string | null;
    } = {};
    try {
      parsed = raw ? JSON.parse(raw) as typeof parsed : {};
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return true;
    }
    try {
      const user = await userDirectory.createUser(parsed);
      sendJson(res, 201, { user });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : "Failed to create user" });
    }
    return true;
  }

  const usersMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
  if (req.method === "PATCH" && usersMatch) {
    if (!userDirectory) {
      sendJson(res, 501, { error: "User directory is unavailable" });
      return true;
    }
    try {
      requireDashboardAdminActor(actorPrincipal);
    } catch (error) {
      sendJson(res, 403, { error: error instanceof Error ? error.message : "Forbidden" });
      return true;
    }
    const raw = await readBody(req);
    if (raw === null) {
      sendJson(res, 413, { error: "Request body too large" });
      return true;
    }
    let parsed: {
      displayName?: string;
      githubLogin?: string | null;
      isActive?: boolean;
      jiraAccountId?: string | null;
      slackUserId?: string | null;
    } = {};
    try {
      parsed = raw ? JSON.parse(raw) as typeof parsed : {};
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return true;
    }
    try {
      const user = await userDirectory.updateUser(usersMatch[1]!, parsed);
      sendJson(res, 200, { user });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update user";
      sendJson(res, /User not found:/i.test(message) ? 404 : 400, { error: message });
    }
    return true;
  }

  if (req.method === "GET" && pathname === "/api/agent-providers") {
    sendJson(res, 200, { providers: getAvailableProviders(config) });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/agent-models") {
    const provider = requestUrl.searchParams.get("provider") as AgentProvider | null;
    if (!provider) {
      sendJson(res, 400, { error: "provider is required" });
      return true;
    }
    try {
      const models = await loadProviderModels(config, provider);
      sendJson(res, 200, { provider, models });
    } catch (error) {
      sendJson(res, 502, { error: error instanceof Error ? error.message : "Failed to load models", models: [] });
    }
    return true;
  }

  if (req.method === "POST" && pathname === "/api/agent-profiles/preview") {
    const raw = await readBody(req);
    if (raw === null) {
      sendJson(res, 413, { error: "Request body too large" });
      return true;
    }
    let parsed: AgentProfileInput;
    try {
      parsed = JSON.parse(raw) as AgentProfileInput;
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return true;
    }
    const profile = sanitizeAgentProfileInput(parsed);
    const validation = validateAgentProfile(profile, config);
    sendJson(res, 200, {
      ok: validation.ok,
      errors: validation.errors,
      commandTemplate: renderAgentProfileTemplate(profile),
    });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/agent-profiles") {
    if (!agentProfileStore) {
      sendJson(res, 501, { error: "Agent profiles are unavailable" });
      return true;
    }
    sendJson(res, 200, { profiles: (await agentProfileStore.list()).map((profile) => decorateAgentProfile(profile)) });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/agent-profiles") {
    if (!agentProfileStore) {
      sendJson(res, 501, { error: "Agent profiles are unavailable" });
      return true;
    }
    const raw = await readBody(req);
    if (raw === null) {
      sendJson(res, 413, { error: "Request body too large" });
      return true;
    }
    let parsed: AgentProfileInput;
    try {
      parsed = JSON.parse(raw) as AgentProfileInput;
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return true;
    }
    try {
      const profile = await agentProfileStore.save(parsed);
      await syncActiveAgentProfileConfig(config, agentProfileStore);
      sendJson(res, 201, { ok: true, profile: decorateAgentProfile(profile) });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : "Failed to save agent profile" });
    }
    return true;
  }

  if (req.method === "GET" && pathname === "/api/github/repositories") {
    if (!githubService) {
      sendJson(res, 501, { error: "GitHub integration is not configured" });
      return true;
    }

    const refresh = requestUrl.searchParams.get("refresh") === "1";
    const now = Date.now();
    const cachedRepositories = githubRepositoriesCache;
    const cacheFresh = cachedRepositories && (now - cachedRepositories.fetchedAt) < GITHUB_REPOSITORIES_CACHE_TTL_MS;

    if (!refresh && cacheFresh) {
      sendJson(res, 200, {
        repositories: cachedRepositories.repositories,
        cached: true,
        fetchedAt: new Date(cachedRepositories.fetchedAt).toISOString(),
      });
      return true;
    }

    try {
      const repositories = await githubService.listAccessibleRepos();
      setGitHubRepositoriesCache({ repositories, fetchedAt: now });
      sendJson(res, 200, {
        repositories,
        cached: false,
        fetchedAt: new Date(now).toISOString(),
      });
    } catch (error) {
      const { logError } = await import("../../logger.js");
      logError("dashboard: failed to list github repositories", {
        error: error instanceof Error ? error.message : String(error),
      });

      if (githubRepositoriesCache) {
        sendJson(res, 200, {
          repositories: githubRepositoriesCache.repositories,
          cached: true,
          stale: true,
          fetchedAt: new Date(githubRepositoriesCache.fetchedAt).toISOString(),
        });
        return true;
      }

      sendJson(res, 502, { error: "Failed to load repositories from GitHub" });
    }
    return true;
  }

  if (req.method === "GET" && pathname === "/api/stats") {
    const stats = await computeRunStats(store);
    sendJson(res, 200, stats);
    return true;
  }

  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "api" && parts[1] === "agent-profiles" && parts[2]) {
    if (!agentProfileStore) {
      sendJson(res, 501, { error: "Agent profiles are unavailable" });
      return true;
    }
    const profileId = decodeURIComponent(parts[2]);

    if (parts.length === 3 && req.method === "PUT") {
      const raw = await readBody(req);
      if (raw === null) {
        sendJson(res, 413, { error: "Request body too large" });
        return true;
      }
      let parsed: AgentProfileInput;
      try {
        parsed = JSON.parse(raw) as AgentProfileInput;
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" });
        return true;
      }
      try {
        const profile = await agentProfileStore.save(parsed, profileId);
        await syncActiveAgentProfileConfig(config, agentProfileStore);
        sendJson(res, 200, { ok: true, profile: decorateAgentProfile(profile) });
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : "Failed to update agent profile" });
      }
      return true;
    }

    if (parts.length === 3 && req.method === "DELETE") {
      const deleted = await agentProfileStore.delete(profileId);
      await syncActiveAgentProfileConfig(config, agentProfileStore);
      sendJson(res, deleted ? 200 : 404, deleted ? { ok: true } : { error: "Profile not found or cannot be deleted" });
      return true;
    }

    if (parts.length === 4 && parts[3] === "activate" && req.method === "POST") {
      const profile = await agentProfileStore.setActive(profileId);
      if (!profile) {
        sendJson(res, 404, { error: "Profile not found" });
        return true;
      }
      await syncActiveAgentProfileConfig(config, agentProfileStore);
      sendJson(res, 200, { ok: true, profile: decorateAgentProfile(profile) });
      return true;
    }
  }

  return false;
}

async function computeRunStats(store: RunStore) {
  const allRuns = await store.listRuns({ limit: 500 });
  const totalRuns = allRuns.length;
  const completedRuns = allRuns.filter((run) => run.status === "completed").length;
  const failedRuns = allRuns.filter((run) => run.status === "failed").length;
  const successRate = totalRuns > 0 ? Math.round((completedRuns / (completedRuns + failedRuns || 1)) * 100) : 0;
  const totalCostUsd = allRuns.reduce((sum, run) => sum + (run.tokenUsage?.costUsd ?? 0), 0);
  const avgCostUsd = totalRuns > 0 ? totalCostUsd / totalRuns : 0;
  const oneDayAgo = Date.now() - 86400_000;
  const runsLast24h = allRuns.filter((run) => new Date(run.createdAt).getTime() > oneDayAgo).length;
  return { totalRuns, completedRuns, failedRuns, successRate, totalCostUsd, avgCostUsd, runsLast24h };
}

async function syncActiveAgentProfileConfig(config: AppConfig, agentProfileStore: AgentProfileStore): Promise<void> {
  const fallbackTemplate = config.baseAgentCommandTemplate ?? config.agentCommandTemplate;
  const active = await agentProfileStore.getActive();
  if (!active) {
    config.agentCommandTemplate = fallbackTemplate;
    config.activeAgentProfile = {
      id: "env-template",
      name: "Raw AGENT_COMMAND_TEMPLATE",
      runtime: "custom",
      commandTemplate: fallbackTemplate,
      source: "env",
    };
    return;
  }

  const commandTemplate = await agentProfileStore.getEffectiveCommandTemplate(fallbackTemplate);
  config.agentCommandTemplate = commandTemplate;
  config.activeAgentProfile = {
    id: active.id,
    name: active.name,
    runtime: active.runtime,
    provider: active.provider,
    model: active.model,
    commandTemplate,
    source: "profile",
  };
}

async function loadProviderModels(config: AppConfig, provider: AgentProvider): Promise<string[]> {
  const unique = (values: string[]) => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));

  if (provider === "openai") {
    if (!config.openaiApiKey) throw new Error("OPENAI_API_KEY is not configured");
    const response = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${config.openaiApiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`OpenAI returned ${String(response.status)}`);
    const data = await response.json() as { data?: Array<{ id?: string }> };
    return unique((data.data ?? []).map((entry) => entry.id?.trim()).filter((entry): entry is string => Boolean(entry)));
  }

  if (provider === "anthropic") {
    if (!config.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is not configured");
    const response = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": config.anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Anthropic returned ${String(response.status)}`);
    const data = await response.json() as { data?: Array<{ id?: string }> };
    return unique((data.data ?? []).map((entry) => entry.id?.trim()).filter((entry): entry is string => Boolean(entry)));
  }

  if (!config.openrouterApiKey) throw new Error("OPENROUTER_API_KEY is not configured");
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${config.openrouterApiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`OpenRouter returned ${String(response.status)}`);
  const data = await response.json() as { data?: Array<{ id?: string }> };
  return unique((data.data ?? []).map((entry) => entry.id?.trim()).filter((entry): entry is string => Boolean(entry)));
}

function decorateAgentProfile(
  profile: AgentProfileInput & { id?: string; isActive?: boolean; isBuiltin?: boolean; createdAt?: string; updatedAt?: string },
): Record<string, unknown> {
  return {
    ...profile,
    commandTemplate: renderAgentProfileTemplate(profile),
  };
}

function parseOverrideFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}
