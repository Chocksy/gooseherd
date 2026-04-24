import type { IncomingMessage, ServerResponse } from "node:http";
import type { URL } from "node:url";
import type { AppConfig } from "../../config.js";
import { GitHubService } from "../../github.js";
import type { SetupStore } from "../../db/setup-store.js";
import { wizardHtml } from "../wizard-html.js";
import { agentProfileListHtml } from "../agent-profile-list-html.js";
import { agentProfileWizardHtml } from "../agent-profile-wizard-html.js";
import { usersHtml } from "../users-html.js";
import { modelPricesHtml } from "../model-prices-html.js";
import type { DashboardActorPrincipal } from "../actor-principal.js";
import { buildDashboardSessionCookie, hashToken } from "../auth.js";
import { requireDashboardAdminActor, readBody, sendJson, sendText } from "./shared.js";
import { logError } from "../../logger.js";

export interface SetupRoutesDeps {
  actorPrincipal?: DashboardActorPrincipal;
  config: AppConfig;
  onSetupComplete?: () => Promise<void>;
  requestUrl: URL;
  setupComplete: boolean;
  setupStore?: SetupStore;
}

export async function handleSetupRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: SetupRoutesDeps,
): Promise<boolean> {
  const {
    actorPrincipal,
    config,
    onSetupComplete,
    requestUrl,
    setupComplete,
    setupStore,
  } = deps;

  if (req.method === "GET" && pathname === "/setup") {
    const reconfig = requestUrl.searchParams.get("reconfig") === "1";
    sendText(res, 200, wizardHtml(config.appName, reconfig), "text/html");
    return true;
  }

  if (req.method === "GET" && pathname === "/agent-profiles") {
    sendText(res, 200, agentProfileListHtml(config.appName), "text/html");
    return true;
  }

  if (req.method === "GET" && pathname === "/agent-profiles/new") {
    sendText(res, 200, agentProfileWizardHtml(config.appName), "text/html");
    return true;
  }

  if (req.method === "GET" && pathname === "/users") {
    try {
      requireDashboardAdminActor(actorPrincipal);
    } catch (error) {
      sendJson(res, 403, { error: error instanceof Error ? error.message : "Forbidden" });
      return true;
    }
    sendText(res, 200, usersHtml(config.appName), "text/html");
    return true;
  }

  if (req.method === "GET" && pathname === "/model-prices") {
    try {
      requireDashboardAdminActor(actorPrincipal);
    } catch (error) {
      sendJson(res, 403, { error: error instanceof Error ? error.message : "Forbidden" });
      return true;
    }
    sendText(res, 200, modelPricesHtml(config.appName), "text/html");
    return true;
  }

  if (req.method === "GET" && pathname === "/api/setup/status") {
    if (!setupStore) {
      sendJson(res, 501, { error: "Setup not available" });
      return true;
    }
    const status = await setupStore.getWizardState();
    sendJson(res, 200, status);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/setup/password") {
    if (!setupStore) {
      sendJson(res, 501, { error: "Setup not available" });
      return true;
    }
    if (setupComplete) {
      sendJson(res, 403, { error: "Password changes require reconfiguration" });
      return true;
    }
    const body = await readBody(req);
    if (!body) {
      sendJson(res, 400, { error: "Missing body" });
      return true;
    }
    let parsed: { password?: string };
    try {
      parsed = JSON.parse(body) as { password?: string };
    } catch {
      sendJson(res, 400, { error: "Invalid JSON" });
      return true;
    }
    const { password } = parsed;
    if (!password || password.length < 8) {
      sendJson(res, 400, { error: "Password must be at least 8 characters" });
      return true;
    }
    const hash = await setupStore.setPassword(password);
    const sessionValue = hashToken(hash);
    res.setHeader("set-cookie", buildDashboardSessionCookie(sessionValue, config));
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/setup/github") {
    if (!setupStore) {
      sendJson(res, 501, { error: "Setup not available" });
      return true;
    }
    const body = await readBody(req);
    if (!body) {
      sendJson(res, 400, { error: "Missing body" });
      return true;
    }
    let ghConfig: unknown;
    try {
      ghConfig = JSON.parse(body);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON" });
      return true;
    }
    await setupStore.saveGitHub(ghConfig as Parameters<SetupStore["saveGitHub"]>[0]);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/setup/validate-github") {
    const body = await readBody(req);
    if (!body) {
      sendJson(res, 400, { error: "Missing body" });
      return true;
    }
    let ghConfig: { authMode: string; token?: string };
    try {
      ghConfig = JSON.parse(body) as { authMode: string; token?: string };
    } catch {
      sendJson(res, 400, { error: "Invalid JSON" });
      return true;
    }
    if (ghConfig.authMode === "pat" && ghConfig.token) {
      try {
        const result = await GitHubService.validateToken(ghConfig.token);
        sendJson(res, 200, result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Validation failed";
        sendJson(res, 400, { error: msg });
      }
    } else {
      sendJson(res, 400, { error: "Only PAT validation is supported in the wizard" });
    }
    return true;
  }

  if (req.method === "POST" && pathname === "/api/setup/llm") {
    if (!setupStore) {
      sendJson(res, 501, { error: "Setup not available" });
      return true;
    }
    const body = await readBody(req);
    if (!body) {
      sendJson(res, 400, { error: "Missing body" });
      return true;
    }
    let llmConfig: Parameters<SetupStore["saveLLM"]>[0];
    try {
      llmConfig = JSON.parse(body) as Parameters<SetupStore["saveLLM"]>[0];
    } catch {
      sendJson(res, 400, { error: "Invalid JSON" });
      return true;
    }
    if (!llmConfig.apiKey) {
      sendJson(res, 400, { error: "API key is required" });
      return true;
    }
    await setupStore.saveLLM(llmConfig);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/setup/validate-llm") {
    const body = await readBody(req);
    if (!body) {
      sendJson(res, 400, { error: "Missing body" });
      return true;
    }
    let parsed: { provider: string; apiKey: string };
    try {
      parsed = JSON.parse(body) as { provider: string; apiKey: string };
    } catch {
      sendJson(res, 400, { error: "Invalid JSON" });
      return true;
    }
    const { provider, apiKey } = parsed;
    if (!apiKey) {
      sendJson(res, 400, { error: "API key is required" });
      return true;
    }
    try {
      const baseUrl = provider === "anthropic" ? "https://api.anthropic.com/v1/models"
        : provider === "openai" ? "https://api.openai.com/v1/models"
        : "https://openrouter.ai/api/v1/models";
      const headers: Record<string, string> = provider === "anthropic"
        ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
        : { Authorization: `Bearer ${apiKey}` };
      const resp = await fetch(baseUrl, { headers, signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) throw new Error(`API returned ${String(resp.status)}`);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Validation failed";
      sendJson(res, 400, { error: msg });
    }
    return true;
  }

  if (req.method === "POST" && pathname === "/api/setup/slack") {
    if (!setupStore) {
      sendJson(res, 501, { error: "Setup not available" });
      return true;
    }
    const body = await readBody(req);
    if (!body) {
      sendJson(res, 400, { error: "Missing body" });
      return true;
    }
    let slackConfig: Parameters<SetupStore["saveSlack"]>[0];
    try {
      slackConfig = JSON.parse(body) as Parameters<SetupStore["saveSlack"]>[0];
    } catch {
      sendJson(res, 400, { error: "Invalid JSON" });
      return true;
    }
    if (!slackConfig.botToken) {
      sendJson(res, 400, { error: "Bot Token is required" });
      return true;
    }
    if (!slackConfig.appToken) {
      sendJson(res, 400, { error: "App-Level Token is required" });
      return true;
    }
    await setupStore.saveSlack(slackConfig);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/setup/validate-slack") {
    const body = await readBody(req);
    if (!body) {
      sendJson(res, 400, { error: "Missing body" });
      return true;
    }
    let parsed: { botToken?: string };
    try {
      parsed = JSON.parse(body) as { botToken?: string };
    } catch {
      sendJson(res, 400, { error: "Invalid JSON" });
      return true;
    }
    if (!parsed.botToken) {
      sendJson(res, 400, { error: "Bot Token is required" });
      return true;
    }
    try {
      const resp = await fetch("https://slack.com/api/auth.test", {
        method: "POST",
        headers: { Authorization: `Bearer ${parsed.botToken}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      const data = await resp.json() as { ok: boolean; error?: string; bot_id?: string; user?: string; team?: string };
      if (!data.ok) throw new Error(data.error || "auth.test failed");
      sendJson(res, 200, { botName: data.user || data.bot_id, teamName: data.team });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Validation failed";
      sendJson(res, 400, { error: msg });
    }
    return true;
  }

  if (req.method === "POST" && pathname === "/api/setup/complete") {
    if (!setupStore) {
      sendJson(res, 501, { error: "Setup not available" });
      return true;
    }
    try {
      await setupStore.markComplete();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Setup incomplete";
      sendJson(res, 400, { error: msg });
      return true;
    }
    if (onSetupComplete) {
      try {
        await onSetupComplete();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown";
        logError("Setup completion callback failed", { error: msg });
      }
    } else {
      await setupStore.applyToEnv();
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}
