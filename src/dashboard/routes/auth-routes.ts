import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { URL } from "node:url";
import { eq } from "drizzle-orm";
import type { AppConfig } from "../../config.js";
import type { Database } from "../../db/index.js";
import { users } from "../../db/schema.js";
import type { DashboardAuthSessionStore } from "../auth-session-store.js";
import {
  buildDashboardSessionCookie,
  clearDashboardSessionCookie,
  handleAdminLogin,
  hashToken,
  loginPageHtml,
  parseCookies,
  type AuthOptions,
} from "../auth.js";
import { isSlackAuthConfigured } from "../slack-auth.js";
import type { SlackAuthFlow } from "../slack-auth.js";
import { syncSlackUserGroupMemberships } from "../team-membership-sync.js";
import { readBody, sendJson, sendText } from "./shared.js";

export interface AuthRoutesDeps {
  authOpts: AuthOptions;
  authSessionStore?: DashboardAuthSessionStore;
  config: AppConfig;
  db?: Database;
  passwordHash?: string;
  requestUrl: URL;
  slackAuthFlow: SlackAuthFlow;
}

export async function handleAuthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: AuthRoutesDeps,
): Promise<boolean> {
  const {
    authOpts,
    authSessionStore,
    config,
    db,
    passwordHash,
    requestUrl,
    slackAuthFlow,
  } = deps;

  if (req.method === "GET" && pathname === "/login") {
    if (!config.dashboardToken && !passwordHash && !isSlackAuthConfigured(config)) {
      res.statusCode = 302;
      res.setHeader("location", "/");
      res.end();
      return true;
    }
    sendText(res, 200, loginPageHtml(config, requestUrl.searchParams.get("error") ?? undefined), "text/html");
    return true;
  }

  if (req.method === "POST" && pathname === "/login") {
    if (!config.dashboardToken && !passwordHash) {
      res.statusCode = 302;
      res.setHeader("location", "/");
      res.end();
      return true;
    }
    const body = await readBody(req);
    if (body === null) {
      sendJson(res, 413, { error: "Request body too large" });
      return true;
    }
    const params = new URLSearchParams(body);
    const token = params.get("token") ?? "";
    const authenticated = await handleAdminLogin(token, authOpts);
    if (authenticated && authSessionStore) {
      const session = await authSessionStore.createSession({
        principalType: "admin",
        authMethod: "admin_password",
        ttlMs: 30 * 24 * 60 * 60_000,
      });
      res.statusCode = 302;
      res.setHeader("set-cookie", buildDashboardSessionCookie(session.token, config));
      res.setHeader("location", "/");
      res.end();
      return true;
    }
    if (authenticated) {
      const fallbackSessionValue = config.dashboardToken
        ? hashToken(config.dashboardToken)
        : hashToken(passwordHash!);
      res.statusCode = 302;
      res.setHeader("set-cookie", buildDashboardSessionCookie(fallbackSessionValue, config));
      res.setHeader("location", "/");
      res.end();
      return true;
    }
    sendText(res, 200, loginPageHtml(config, "Invalid password"), "text/html");
    return true;
  }

  if (req.method === "POST" && pathname === "/logout") {
    const cookies = parseCookies(req);
    const sessionToken = cookies["gooseherd-session"];
    if (sessionToken && authSessionStore) {
      await authSessionStore.revokeSession(sessionToken);
    }
    res.statusCode = 302;
    res.setHeader("set-cookie", clearDashboardSessionCookie(config));
    res.setHeader("location", "/login");
    res.end();
    return true;
  }

  if (req.method === "GET" && pathname === "/auth/slack/signin") {
    if (!isSlackAuthConfigured(config)) {
      res.statusCode = 302;
      res.setHeader("location", "/login?error=Slack%20login%20is%20not%20configured");
      res.end();
      return true;
    }
    const { url } = slackAuthFlow.start("signin");
    res.statusCode = 302;
    res.setHeader("location", url);
    res.end();
    return true;
  }

  if (req.method === "GET" && pathname === "/auth/slack/signup") {
    if (!isSlackAuthConfigured(config)) {
      res.statusCode = 302;
      res.setHeader("location", "/login?error=Slack%20login%20is%20not%20configured");
      res.end();
      return true;
    }
    const { url } = slackAuthFlow.start("signup");
    res.statusCode = 302;
    res.setHeader("location", url);
    res.end();
    return true;
  }

  if (req.method === "GET" && pathname === "/auth/slack/callback") {
    if (!db || !authSessionStore) {
      sendJson(res, 501, { error: "Database-backed auth is not available" });
      return true;
    }
    if (!config.slackBotToken) {
      res.statusCode = 302;
      res.setHeader("location", "/login?error=Slack%20bot%20token%20is%20required%20for%20team%20sync");
      res.end();
      return true;
    }

    const callbackError = requestUrl.searchParams.get("error");
    if (callbackError) {
      res.statusCode = 302;
      res.setHeader("location", `/login?error=${encodeURIComponent(`Slack login failed: ${callbackError}`)}`);
      res.end();
      return true;
    }

    const code = requestUrl.searchParams.get("code");
    const state = requestUrl.searchParams.get("state");
    if (!code || !state) {
      res.statusCode = 302;
      res.setHeader("location", "/login?error=Slack%20callback%20is%20missing%20code%20or%20state");
      res.end();
      return true;
    }

    try {
      const { intent, identity } = await slackAuthFlow.exchangeCode(code, state);
      const existingRows = await db.select().from(users).where(eq(users.slackUserId, identity.slackUserId)).limit(1);
      let user = existingRows[0];

      if (!user) {
        if (intent !== "signup") {
          res.statusCode = 302;
          res.setHeader("location", "/login?error=Your%20Slack%20account%20is%20not%20registered%20in%20Gooseherd");
          res.end();
          return true;
        }

        const inserted = await db.transaction(async (tx) => {
          const createdUser = {
            id: randomUUID(),
            slackUserId: identity.slackUserId,
            displayName: identity.displayName?.trim() || identity.email?.trim() || identity.slackUserId,
            isActive: true,
          };
          const rows = await tx.insert(users).values(createdUser).returning();
          const created = rows[0]!;
          await syncSlackUserGroupMemberships(tx as unknown as Database, config.slackBotToken!, created.id, identity.slackUserId);
          return created;
        });
        user = inserted;
      } else {
        if (!user.isActive) {
          res.statusCode = 302;
          res.setHeader("location", "/login?error=Your%20Gooseherd%20account%20is%20inactive");
          res.end();
          return true;
        }
        await syncSlackUserGroupMemberships(db, config.slackBotToken, user.id, identity.slackUserId);
      }

      const session = await authSessionStore.createSession({
        principalType: "user",
        authMethod: "slack",
        userId: user.id,
        ttlMs: 30 * 24 * 60 * 60_000,
      });
      res.statusCode = 302;
      res.setHeader("set-cookie", buildDashboardSessionCookie(session.token, config));
      res.setHeader("location", "/");
      res.end();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Slack authentication failed";
      res.statusCode = 302;
      res.setHeader("location", `/login?error=${encodeURIComponent(msg)}`);
      res.end();
    }
    return true;
  }

  return false;
}
