import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../config.js";
import { verifyPassword } from "../db/setup-store.js";
import type { DashboardAuthSessionStore } from "./auth-session-store.js";
import { escapeHtml } from "./html.js";

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers["cookie"] ?? "";
  const cookies: Record<string, string> = {};
  for (const pair of header.split(";")) {
    const eqIndex = pair.indexOf("=");
    if (eqIndex > 0) {
      const key = pair.slice(0, eqIndex).trim();
      const value = pair.slice(eqIndex + 1).trim();
      cookies[key] = decodeURIComponent(value);
    }
  }
  return cookies;
}

export function safeTokenCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export interface AuthOptions {
  dashboardToken?: string;
  passwordHash?: string;
  setupComplete: boolean;
  slackAuthEnabled?: boolean;
  sessionStore?: DashboardAuthSessionStore;
}

const PUBLIC_AUTH_PATHS = new Set([
  "/login",
  "/auth/slack/signin",
  "/auth/slack/signup",
  "/auth/slack/callback",
]);

export async function checkAuth(
  req: IncomingMessage,
  res: ServerResponse,
  opts: AuthOptions,
  pathname: string
): Promise<boolean> {
  if (pathname === "/healthz") return true;
  if (PUBLIC_AUTH_PATHS.has(pathname)) return true;

  if (!opts.setupComplete) {
    if (pathname === "/setup" || pathname === "/api/setup/status") return true;
    if (pathname === "/api/setup/password") return true;

    if (pathname.startsWith("/api/setup/")) {
      if (opts.passwordHash) {
        const cookies = parseCookies(req);
        const sessionHash = cookies["gooseherd-session"];
        if (sessionHash && safeTokenCompare(sessionHash, hashToken(opts.passwordHash))) return true;
      }
      sendJson(res, 401, { error: "Unauthorized" });
      return false;
    }

    if (pathname.startsWith("/api/")) {
      sendJson(res, 503, { error: "Setup not complete" });
      return false;
    }
    res.statusCode = 302;
    res.setHeader("location", "/setup");
    res.end();
    return false;
  }

  const cookies = parseCookies(req);
  const sessionToken = cookies["gooseherd-session"];
  if (sessionToken && opts.sessionStore) {
    const session = await opts.sessionStore.getSessionByToken(sessionToken);
    if (session) return true;
  }

  if (opts.dashboardToken && pathname.startsWith("/api/")) {
    const authHeader = req.headers["authorization"] ?? "";
    if (authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice("Bearer ".length);
      if (safeTokenCompare(token, opts.dashboardToken)) return true;
    }
  }

  const authConfigured = Boolean(opts.dashboardToken || opts.passwordHash || opts.slackAuthEnabled);
  if (!authConfigured) return true;

  if (pathname.startsWith("/api/")) {
    sendJson(res, 401, { error: "Unauthorized" });
    return false;
  }

  res.statusCode = 302;
  res.setHeader("location", "/login");
  res.end();
  return false;
}

export async function handleAdminLogin(
  submittedValue: string,
  opts: AuthOptions,
): Promise<boolean> {
  if (opts.dashboardToken && safeTokenCompare(submittedValue, opts.dashboardToken)) {
    return true;
  }
  if (opts.passwordHash && await verifyPassword(submittedValue, opts.passwordHash)) {
    return true;
  }
  return false;
}

export function buildDashboardSessionCookie(token: string, config: Pick<AppConfig, "dashboardPublicUrl">): string {
  const secureSuffix = config.dashboardPublicUrl?.startsWith("https") ? "; Secure" : "";
  return `gooseherd-session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/${secureSuffix}`;
}

export function clearDashboardSessionCookie(config: Pick<AppConfig, "dashboardPublicUrl">): string {
  const secureSuffix = config.dashboardPublicUrl?.startsWith("https") ? "; Secure" : "";
  return `gooseherd-session=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/${secureSuffix}`;
}

function renderSlackAuthActions(config: AppConfig): string {
  if (!config.slackClientId || !config.slackClientSecret) return "";

  return `
    <div class="auth-divider"><span>or</span></div>
    <div class="slack-auth-actions">
      <a class="slack-button" href="/auth/slack/signin">Sign in with Slack</a>
      <a class="slack-link" href="/auth/slack/signup">Sign up with Slack</a>
    </div>
  `;
}

export function loginPageHtml(config: AppConfig, error?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(config.appName)} — Login</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: "Space Grotesk", system-ui, sans-serif;
      background: #060a14;
      color: #e2e8f0;
      padding: 24px;
    }
    .login-card {
      background: #0f172a;
      border: 1px solid #22314f;
      border-radius: 16px;
      padding: 40px 36px;
      width: 100%;
      max-width: 420px;
      box-shadow: 0 14px 36px rgba(1,6,18,0.55);
    }
    h1 { font-size: 20px; margin: 0 0 8px; }
    p { color: #94a3b8; font-size: 13px; margin: 0 0 24px; }
    .error {
      color: #fecaca;
      background: rgba(127, 29, 29, 0.45);
      border: 1px solid rgba(248, 113, 113, 0.35);
      border-radius: 10px;
      font-size: 13px;
      margin-bottom: 16px;
      padding: 10px 12px;
    }
    label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
    input[type="password"] {
      width: 100%;
      padding: 10px 12px;
      font-size: 14px;
      border: 1px solid #22314f;
      border-radius: 8px;
      background: #0a1325;
      color: #e2e8f0;
      outline: none;
    }
    input[type="password"]:focus { border-color: #60a5fa; }
    button, .slack-button {
      margin-top: 16px;
      width: 100%;
      padding: 10px;
      border: none;
      border-radius: 8px;
      background: #2563eb;
      color: #fff;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      justify-content: center;
      align-items: center;
    }
    button:hover, .slack-button:hover { background: #1d4ed8; }
    .auth-divider {
      margin: 22px 0 12px;
      display: flex;
      align-items: center;
      gap: 10px;
      color: #64748b;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .auth-divider::before, .auth-divider::after {
      content: "";
      height: 1px;
      background: #22314f;
      flex: 1;
    }
    .slack-auth-actions {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .slack-link {
      color: #93c5fd;
      text-align: center;
      font-size: 13px;
      text-decoration: none;
    }
    .slack-link:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="login-card">
    <form method="POST" action="/login">
      <h1>${escapeHtml(config.appName)}</h1>
      <p>Enter the administrator password to continue.</p>
      ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
      <label for="token">Password</label>
      <input type="password" id="token" name="token" autofocus required />
      <button type="submit">Admin login</button>
    </form>
    ${renderSlackAuthActions(config)}
  </div>
</body>
</html>`;
}
