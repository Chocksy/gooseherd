import { randomBytes } from "node:crypto";
import type { AppConfig } from "../config.js";

export type SlackAuthIntent = "signin" | "signup";

interface SlackAuthTransaction {
  intent: SlackAuthIntent;
  nonce: string;
  expiresAt: number;
}

export interface SlackIdentity {
  slackUserId: string;
  teamId?: string;
  email?: string;
  displayName?: string;
}

interface SlackTokenResponse {
  ok?: boolean;
  error?: string;
  access_token?: string;
  id_token?: string;
}

interface SlackUserInfoResponse {
  ok?: boolean;
  error?: string;
  sub?: string;
  email?: string;
  name?: string;
  "https://slack.com/user_id"?: string;
  "https://slack.com/team_id"?: string;
}

function base64UrlJsonDecode(value: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
}

function buildSlackRedirectUri(config: Pick<AppConfig, "dashboardPublicUrl" | "dashboardHost" | "dashboardPort" | "slackAuthRedirectUri">): string {
  if (config.slackAuthRedirectUri) return config.slackAuthRedirectUri;
  if (config.dashboardPublicUrl) {
    return new URL("/auth/slack/callback", config.dashboardPublicUrl).toString();
  }
  return `http://${config.dashboardHost}:${String(config.dashboardPort)}/auth/slack/callback`;
}

export function isSlackAuthConfigured(config: Pick<AppConfig, "slackClientId" | "slackClientSecret">): boolean {
  return Boolean(config.slackClientId && config.slackClientSecret);
}

export class SlackAuthFlow {
  private readonly transactions = new Map<string, SlackAuthTransaction>();

  constructor(private readonly config: Pick<AppConfig, "dashboardPublicUrl" | "dashboardHost" | "dashboardPort" | "slackAuthRedirectUri" | "slackClientId" | "slackClientSecret">) {}

  start(intent: SlackAuthIntent): { state: string; url: string } {
    if (!isSlackAuthConfigured(this.config)) {
      throw new Error("Slack auth is not configured");
    }
    const state = randomBytes(16).toString("hex");
    const nonce = randomBytes(16).toString("hex");
    this.transactions.set(state, {
      intent,
      nonce,
      expiresAt: Date.now() + 10 * 60_000,
    });

    const url = new URL("https://slack.com/openid/connect/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid profile email");
    url.searchParams.set("client_id", this.config.slackClientId!);
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("redirect_uri", buildSlackRedirectUri(this.config));
    return { state, url: url.toString() };
  }

  consume(state: string): SlackAuthTransaction | undefined {
    const transaction = this.transactions.get(state);
    this.transactions.delete(state);
    if (!transaction) return undefined;
    if (transaction.expiresAt <= Date.now()) return undefined;
    return transaction;
  }

  async exchangeCode(code: string, state: string): Promise<{ intent: SlackAuthIntent; identity: SlackIdentity }> {
    if (!isSlackAuthConfigured(this.config)) {
      throw new Error("Slack auth is not configured");
    }
    const transaction = this.consume(state);
    if (!transaction) {
      throw new Error("Slack auth state is invalid or expired");
    }

    const body = new URLSearchParams({
      code,
      client_id: this.config.slackClientId!,
      client_secret: this.config.slackClientSecret!,
      grant_type: "authorization_code",
      redirect_uri: buildSlackRedirectUri(this.config),
    });

    const response = await fetch("https://slack.com/api/openid.connect.token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Slack token exchange failed with ${String(response.status)}`);
    }
    const payload = await response.json() as SlackTokenResponse;
    if (!payload.ok || !payload.access_token) {
      throw new Error(payload.error || "Slack token exchange failed");
    }

    if (payload.id_token) {
      const jwtParts = payload.id_token.split(".");
      if (jwtParts.length < 2) {
        throw new Error("Slack returned an invalid id_token");
      }
      const claims = base64UrlJsonDecode(jwtParts[1]!);
      if (claims["nonce"] !== transaction.nonce) {
        throw new Error("Slack auth nonce mismatch");
      }
    }

    const userInfoResponse = await fetch("https://slack.com/api/openid.connect.userInfo", {
      method: "POST",
      headers: { Authorization: `Bearer ${payload.access_token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!userInfoResponse.ok) {
      throw new Error(`Slack user info lookup failed with ${String(userInfoResponse.status)}`);
    }
    const claims = await userInfoResponse.json() as SlackUserInfoResponse;
    if (!claims.ok) {
      throw new Error(claims.error || "Slack user info lookup failed");
    }

    const slackUserId = String(claims["https://slack.com/user_id"] ?? claims["sub"] ?? "").trim();
    if (!slackUserId) {
      throw new Error("Slack auth payload is missing user id");
    }

    return {
      intent: transaction.intent,
      identity: {
        slackUserId,
        teamId: typeof claims["https://slack.com/team_id"] === "string" ? claims["https://slack.com/team_id"] : undefined,
        email: typeof claims["email"] === "string" ? claims["email"] : undefined,
        displayName: typeof claims["name"] === "string" ? claims["name"] : undefined,
      },
    };
  }
}
