import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, access as fsAccess } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { resolveGitHubAuthMode } from "./config.js";
import { logError, logInfo } from "./logger.js";
import { RunStore } from "./store.js";
import type { RunManager } from "./run-manager.js";
import type { RunFeedback, RunRecord } from "./types.js";
import { parseRunLog, getEventStats } from "./log-parser.js";
import type { ObserverEventRecord, ObserverStateSnapshot, TriggerRule } from "./observer/types.js";
import type { ChatMessage } from "./llm/caller.js";
import { dashboardHtml } from "./dashboard/html.js";
import { checkAuth, hashToken, loginPageHtml, handleLogin, type AuthOptions } from "./dashboard/auth.js";
import type { PipelineStore } from "./pipeline/pipeline-store.js";
import type { LearningStore } from "./observer/learning-store.js";
import { SetupStore } from "./db/setup-store.js";
import { wizardHtml } from "./dashboard/wizard-html.js";
import { GitHubService } from "./github.js";
import type { EvalStore } from "./eval/eval-store.js";
import { loadScenariosFromDir } from "./eval/scenario-loader.js";

/** Lean interface — dashboard only reads observer state, never mutates it. */
export interface DashboardObserver {
  getStateSnapshot(): Promise<ObserverStateSnapshot>;
  getRecentEvents(limit?: number): ObserverEventRecord[];
  getRules(): TriggerRule[];
}

/** Optional source for in-memory orchestrator thread messages. */
export interface DashboardConversationSource {
  get(threadKey: string): Promise<ChatMessage[] | undefined>;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function sendText(res: ServerResponse, status: number, text: string, contentType = "text/plain"): void {
  res.statusCode = status;
  res.setHeader("content-type", `${contentType}; charset=utf-8`);
  res.end(text);
}

function parseLimit(value: string | null): number {
  if (!value) {
    return 100;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    return 100;
  }
  return Math.min(parsed, 500);
}

/** Max request body size: 1 MB (matches webhook-server.ts) */
const MAX_BODY_BYTES = 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let resolved = false;

    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy();
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    req.on("end", () => {
      if (!resolved) {
        resolved = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });

    req.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });
  });
}

async function readLogTail(logPath: string, lineCount: number): Promise<string> {
  const content = await readFile(logPath, "utf8");
  const lines = content.split("\n");
  return lines.slice(-Math.max(1, lineCount)).join("\n");
}

/** Read log from a byte offset. Returns new content and the new offset. */
async function readLogFromOffset(logPath: string, offset: number): Promise<{ content: string; newOffset: number }> {
  const { open } = await import("node:fs/promises");
  const { stat } = await import("node:fs/promises");
  const fileStats = await stat(logPath);
  const fileSize = fileStats.size;

  if (offset >= fileSize) {
    return { content: "", newOffset: fileSize };
  }

  const fh = await open(logPath, "r");
  try {
    const readSize = fileSize - offset;
    const buffer = Buffer.alloc(readSize);
    await fh.read(buffer, 0, readSize, offset);
    return { content: buffer.toString("utf8"), newOffset: fileSize };
  } finally {
    await fh.close();
  }
}

interface ConversationPreviewMessage {
  role: "user" | "assistant";
  content: string;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…`;
}

function chatMessageToText(message: ChatMessage): string | null {
  if (message.role === "user") {
    if (typeof message.content === "string") {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => {
          if (part.type === "text") return part.text;
          if (part.type === "image_url") return "[image]";
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    return null;
  }

  if (message.role === "assistant") {
    return typeof message.content === "string" ? message.content : null;
  }

  return null;
}

function buildConversationPreview(messages: ChatMessage[]): ConversationPreviewMessage[] {
  const preview: ConversationPreviewMessage[] = [];

  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = chatMessageToText(message)?.trim();
    if (!text) continue;
    preview.push({
      role: message.role,
      content: truncateText(text, 2000)
    });
  }

  return preview;
}

// Auth helpers moved to ./dashboard/auth.ts

async function captureCommand(command: string, cwd: string): Promise<{ code: number; stdout: string }> {
  return new Promise<{ code: number; stdout: string }>((resolve) => {
    const child = spawn("bash", ["-lc", command], { cwd });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("exit", (code) => {
      resolve({ code: code ?? 1, stdout });
    });
    child.on("error", () => {
      resolve({ code: 1, stdout: "" });
    });
  });
}

async function getChangedFiles(config: AppConfig, run: RunRecord): Promise<string[]> {
  if (run.changedFiles && run.changedFiles.length > 0) {
    return run.changedFiles;
  }

  // Only fall back to git if the run actually committed (has a commitSha)
  if (!run.commitSha) {
    return [];
  }

  const repoDir = path.resolve(config.workRoot, run.id, "repo");
  const result = await captureCommand("git show --name-only --pretty='' HEAD", repoDir);
  if (result.code !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !entry.startsWith("---"));
}

interface FileChangeDetail {
  path: string;
  status: "A" | "M" | "D" | "R" | "?";
  additions: number;
  deletions: number;
}

async function getChangedFilesDetailed(config: AppConfig, run: RunRecord): Promise<FileChangeDetail[]> {
  // Only show file changes if the run actually produced a commit
  if (!run.commitSha) {
    return [];
  }

  const repoDir = path.resolve(config.workRoot, run.id, "repo");

  // Get line counts: additions\tdeletions\tpath
  const numstat = await captureCommand("git diff --numstat HEAD~1 HEAD 2>/dev/null", repoDir);
  // Get status: A/M/D\tpath
  const nameStatus = await captureCommand("git diff --name-status HEAD~1 HEAD 2>/dev/null", repoDir);

  if (numstat.code !== 0 || nameStatus.code !== 0) {
    // Fallback to simple file list
    const files = await getChangedFiles(config, run);
    return files.map((f) => ({ path: f, status: "?" as const, additions: 0, deletions: 0 }));
  }

  // Parse name-status into a lookup map
  const statusMap = new Map<string, string>();
  for (const line of nameStatus.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    if (parts.length >= 2) {
      const status = parts[0].charAt(0);
      const filePath = parts[parts.length - 1];
      statusMap.set(filePath, status);
    }
  }

  // Parse numstat for line counts
  const results: FileChangeDetail[] = [];
  for (const line of numstat.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    if (parts.length >= 3) {
      const additions = parts[0] === "-" ? 0 : Number.parseInt(parts[0], 10) || 0;
      const deletions = parts[1] === "-" ? 0 : Number.parseInt(parts[1], 10) || 0;
      const filePath = parts[2];
      const rawStatus = statusMap.get(filePath) ?? "M";
      const status = (["A", "M", "D", "R"].includes(rawStatus) ? rawStatus : "?") as FileChangeDetail["status"];
      results.push({ path: filePath, status, additions, deletions });
    }
  }

  return results;
}


// Dashboard HTML moved to ./dashboard/html.ts

async function computeRunStats(store: RunStore) {
  const allRuns = await store.listRuns({ limit: 500 });
  const totalRuns = allRuns.length;
  const completedRuns = allRuns.filter(r => r.status === "completed").length;
  const failedRuns = allRuns.filter(r => r.status === "failed").length;
  const successRate = totalRuns > 0 ? Math.round((completedRuns / (completedRuns + failedRuns || 1)) * 100) : 0;
  const totalCostUsd = allRuns.reduce((sum, r) => sum + (r.tokenUsage?.costUsd ?? 0), 0);
  const avgCostUsd = totalRuns > 0 ? totalCostUsd / totalRuns : 0;
  const oneDayAgo = Date.now() - 86400_000;
  const runsLast24h = allRuns.filter(r => new Date(r.createdAt).getTime() > oneDayAgo).length;
  return { totalRuns, completedRuns, failedRuns, successRate, totalCostUsd, avgCostUsd, runsLast24h };
}

export function startDashboardServer(
  config: AppConfig,
  store: RunStore,
  runManager?: Pick<RunManager, "retryRun" | "continueRun" | "getRunChain" | "saveFeedbackFromSlackAction" | "cancelRun" | "enqueueRun">,
  observer?: DashboardObserver,
  conversationSource?: DashboardConversationSource,
  pipelineStore?: PipelineStore,
  learningStore?: LearningStore,
  setupStore?: SetupStore,
  onSetupComplete?: () => Promise<void>,
  evalStore?: EvalStore,
): void {
  const server = createServer(async (req, res) => {
    try {
      // Security headers — applied to all responses
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
      res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:");

      const requestUrl = new URL(req.url ?? "/", `http://${config.dashboardHost}:${String(config.dashboardPort)}`);
      const pathname = requestUrl.pathname;

      // Build auth options (async — reads wizard password hash from DB)
      const setupComplete = setupStore ? await setupStore.isComplete() : true;
      const passwordHash = setupStore ? await setupStore.getPasswordHash() : undefined;
      const authOpts: AuthOptions = {
        dashboardToken: config.dashboardToken,
        passwordHash,
        setupComplete,
      };

      // Auth check — must come before route dispatch
      if (!checkAuth(req, res, authOpts, pathname)) return;

      if (req.method === "GET" && pathname === "/healthz") {
        sendJson(res, 200, { ok: true });
        return;
      }

      // ── Setup wizard routes ──

      if (req.method === "GET" && pathname === "/setup") {
        const reconfig = requestUrl.searchParams.get("reconfig") === "1";
        sendText(res, 200, wizardHtml(config.appName, reconfig), "text/html");
        return;
      }

      if (req.method === "GET" && pathname === "/api/setup/status") {
        if (!setupStore) { sendJson(res, 501, { error: "Setup not available" }); return; }
        const status = await setupStore.getStatus();
        sendJson(res, 200, status);
        return;
      }

      if (req.method === "POST" && pathname === "/api/setup/password") {
        if (!setupStore) { sendJson(res, 501, { error: "Setup not available" }); return; }
        // When setup is complete, require current password for password changes
        if (setupComplete) {
          sendJson(res, 403, { error: "Password changes require reconfiguration" });
          return;
        }
        const body = await readBody(req);
        if (!body) { sendJson(res, 400, { error: "Missing body" }); return; }
        let parsed: { password?: string };
        try { parsed = JSON.parse(body) as { password?: string }; }
        catch { sendJson(res, 400, { error: "Invalid JSON" }); return; }
        const { password } = parsed;
        if (!password || password.length < 8) {
          sendJson(res, 400, { error: "Password must be at least 8 characters" });
          return;
        }
        const hash = await setupStore.setPassword(password);
        // Set session cookie so subsequent wizard steps are authenticated
        const sessionValue = hashToken(hash);
        const secureSuffix = config.dashboardPublicUrl?.startsWith("https") ? "; Secure" : "";
        res.setHeader("set-cookie", `gooseherd-session=${sessionValue}; HttpOnly; SameSite=Strict; Path=/${secureSuffix}`);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && pathname === "/api/setup/github") {
        if (!setupStore) { sendJson(res, 501, { error: "Setup not available" }); return; }
        const body = await readBody(req);
        if (!body) { sendJson(res, 400, { error: "Missing body" }); return; }
        let ghConfig: unknown;
        try { ghConfig = JSON.parse(body); }
        catch { sendJson(res, 400, { error: "Invalid JSON" }); return; }
        await setupStore.saveGitHub(ghConfig as Parameters<SetupStore["saveGitHub"]>[0]);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && pathname === "/api/setup/validate-github") {
        const body = await readBody(req);
        if (!body) { sendJson(res, 400, { error: "Missing body" }); return; }
        let ghConfig: { authMode: string; token?: string };
        try { ghConfig = JSON.parse(body) as { authMode: string; token?: string }; }
        catch { sendJson(res, 400, { error: "Invalid JSON" }); return; }
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
        return;
      }

      if (req.method === "POST" && pathname === "/api/setup/llm") {
        if (!setupStore) { sendJson(res, 501, { error: "Setup not available" }); return; }
        const body = await readBody(req);
        if (!body) { sendJson(res, 400, { error: "Missing body" }); return; }
        let llmConfig: Parameters<SetupStore["saveLLM"]>[0];
        try { llmConfig = JSON.parse(body) as Parameters<SetupStore["saveLLM"]>[0]; }
        catch { sendJson(res, 400, { error: "Invalid JSON" }); return; }
        if (!llmConfig.apiKey) { sendJson(res, 400, { error: "API key is required" }); return; }
        await setupStore.saveLLM(llmConfig);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && pathname === "/api/setup/validate-llm") {
        const body = await readBody(req);
        if (!body) { sendJson(res, 400, { error: "Missing body" }); return; }
        let parsed: { provider: string; apiKey: string };
        try { parsed = JSON.parse(body) as { provider: string; apiKey: string }; }
        catch { sendJson(res, 400, { error: "Invalid JSON" }); return; }
        const { provider, apiKey } = parsed;
        if (!apiKey) { sendJson(res, 400, { error: "API key is required" }); return; }
        try {
          // Minimal validation: try a GET request to the provider's models endpoint
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
        return;
      }

      if (req.method === "POST" && pathname === "/api/setup/slack") {
        if (!setupStore) { sendJson(res, 501, { error: "Setup not available" }); return; }
        const body = await readBody(req);
        if (!body) { sendJson(res, 400, { error: "Missing body" }); return; }
        let slackConfig: Parameters<SetupStore["saveSlack"]>[0];
        try { slackConfig = JSON.parse(body) as Parameters<SetupStore["saveSlack"]>[0]; }
        catch { sendJson(res, 400, { error: "Invalid JSON" }); return; }
        if (!slackConfig.botToken) { sendJson(res, 400, { error: "Bot Token is required" }); return; }
        if (!slackConfig.appToken) { sendJson(res, 400, { error: "App-Level Token is required" }); return; }
        await setupStore.saveSlack(slackConfig);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && pathname === "/api/setup/validate-slack") {
        const body = await readBody(req);
        if (!body) { sendJson(res, 400, { error: "Missing body" }); return; }
        let parsed: { botToken?: string };
        try { parsed = JSON.parse(body) as { botToken?: string }; }
        catch { sendJson(res, 400, { error: "Invalid JSON" }); return; }
        if (!parsed.botToken) { sendJson(res, 400, { error: "Bot Token is required" }); return; }
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
        return;
      }

      if (req.method === "POST" && pathname === "/api/setup/complete") {
        if (!setupStore) { sendJson(res, 501, { error: "Setup not available" }); return; }
        try {
          await setupStore.markComplete();
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Setup incomplete";
          sendJson(res, 400, { error: msg });
          return;
        }
        if (onSetupComplete) {
          try { await onSetupComplete(); } catch (err) {
            const msg = err instanceof Error ? err.message : "unknown";
            logError("Setup completion callback failed", { error: msg });
          }
        } else {
          await setupStore.applyToEnv();
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      // Login page (GET)
      if (req.method === "GET" && pathname === "/login") {
        if (!config.dashboardToken && !passwordHash) {
          res.statusCode = 302;
          res.setHeader("location", "/");
          res.end();
          return;
        }
        sendText(res, 200, loginPageHtml(config), "text/html");
        return;
      }

      // Login handler (POST)
      if (req.method === "POST" && pathname === "/login") {
        if (!config.dashboardToken && !passwordHash) {
          res.statusCode = 302;
          res.setHeader("location", "/");
          res.end();
          return;
        }
        const body = await readBody(req);
        if (body === null) { sendJson(res, 413, { error: "Request body too large" }); return; }
        const params = new URLSearchParams(body);
        const token = params.get("token") ?? "";
        const sessionValue = await handleLogin(token, authOpts);
        if (sessionValue) {
          res.statusCode = 302;
          const secureSuffix = config.dashboardPublicUrl?.startsWith("https") ? "; Secure" : "";
          res.setHeader("set-cookie", `gooseherd-session=${sessionValue}; HttpOnly; SameSite=Strict; Path=/${secureSuffix}`);
          res.setHeader("location", "/");
          res.end();
          return;
        }
        sendText(res, 200, loginPageHtml(config, "Invalid password"), "text/html");
        return;
      }


      if (req.method === "GET" && pathname === "/") {
        sendText(res, 200, dashboardHtml(config), "text/html");
        return;
      }

      if (req.method === "GET" && pathname === "/api/settings") {
        const githubAuthMode = resolveGitHubAuthMode(config);
        const stats = await computeRunStats(store);

        sendJson(res, 200, {
          config: {
            appName: config.appName,
            pipelineFile: config.pipelineFile,
            slackConnected: Boolean(config.slackBotToken),
            githubAuthMode,
            configOverrides: {
              githubFromEnv: parseOverrideFlag(process.env.GITHUB_CONFIG_OVERRIDE_FROM_ENV),
              slackFromEnv: parseOverrideFlag(process.env.SLACK_CONFIG_OVERRIDE_FROM_ENV),
              llmFromEnv: parseOverrideFlag(process.env.LLM_CONFIG_OVERRIDE_FROM_ENV),
            },
            features: {
              observer: config.observerEnabled,
              sandbox: config.sandboxEnabled,
              browserVerify: config.browserVerifyEnabled,
              scopeJudge: config.scopeJudgeEnabled,
              ciWait: config.ciWaitEnabled,
              dryRun: config.dryRun,
            },
            models: {
              default: config.defaultLlmModel,
              planTask: config.planTaskModel,
              orchestrator: config.orchestratorModel,
              browserVerify: config.browserVerifyModel,
            },
            agentCommandTemplate: config.agentCommandTemplate.length > 20
              ? config.agentCommandTemplate.slice(0, 20) + "..."
              : config.agentCommandTemplate,
          },
          stats,
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/stats") {
        const stats = await computeRunStats(store);
        sendJson(res, 200, stats);
        return;
      }

      if (req.method === "POST" && pathname === "/api/runs") {
        if (!runManager) {
          sendJson(res, 501, { error: "Run creation is unavailable: run manager not attached." });
          return;
        }
        const raw = await readBody(req);
        if (raw === null) { sendJson(res, 413, { error: "Request body too large" }); return; }
        let parsed: { repoSlug?: string; baseBranch?: string; task?: string; pipeline?: string } = {};
        try {
          parsed = JSON.parse(raw) as typeof parsed;
        } catch {
          sendJson(res, 400, { error: "Invalid JSON body" });
          return;
        }
        if (!parsed.repoSlug || !parsed.task) {
          sendJson(res, 400, { error: "repoSlug and task are required" });
          return;
        }
        if (parsed.task.length > 10_000) {
          sendJson(res, 400, { error: "task must be under 10,000 characters" });
          return;
        }
        if (parsed.repoSlug.length > 200) {
          sendJson(res, 400, { error: "repoSlug must be under 200 characters" });
          return;
        }
        const newRun = await runManager.enqueueRun({
          repoSlug: parsed.repoSlug.trim(),
          task: parsed.task.trim(),
          baseBranch: parsed.baseBranch?.trim() || config.defaultBaseBranch,
          requestedBy: "dashboard",
          channelId: "dashboard",
          threadTs: `dash-${Date.now()}`,
          pipelineHint: parsed.pipeline?.trim() || undefined,
        });
        sendJson(res, 201, { ok: true, run: newRun });
        return;
      }

      if (req.method === "GET" && pathname === "/api/runs") {
        const limit = parseLimit(requestUrl.searchParams.get("limit"));
        const teamId = requestUrl.searchParams.get("team") ?? undefined;
        const statusFilter = requestUrl.searchParams.get("status") ?? undefined;
        const search = requestUrl.searchParams.get("search") ?? undefined;
        let runs = await store.listRuns({ limit: 500, teamId });
        if (statusFilter && statusFilter !== "all") {
          runs = runs.filter(r => r.status === statusFilter);
        }
        if (search) {
          const q = search.toLowerCase();
          runs = runs.filter(r =>
            (r.title?.toLowerCase().includes(q)) ||
            r.task.toLowerCase().includes(q) ||
            r.repoSlug.toLowerCase().includes(q) ||
            r.id.toLowerCase().startsWith(q)
          );
        }
        runs = runs.slice(0, limit);
        sendJson(res, 200, { runs });
        return;
      }

      const parts = pathname.split("/").filter(Boolean);
      if (parts[0] === "api" && parts[1] === "runs" && parts[2]) {
        const id = decodeURIComponent(parts[2]);
        const run = await store.findRunByIdentifier(id);
        if (!run) {
          sendJson(res, 404, { error: `Run not found: ${id}` });
          return;
        }

        if (parts.length === 3 && req.method === "GET") {
          sendJson(res, 200, { run });
          return;
        }

        if (parts.length === 4 && parts[3] === "log" && req.method === "GET") {
          const logsPath = run.logsPath ?? path.resolve(config.workRoot, run.id, "run.log");
          const offsetParam = requestUrl.searchParams.get("offset");

          if (offsetParam !== null) {
            // Incremental mode: return content from byte offset
            const byteOffset = Math.max(0, Number.parseInt(offsetParam, 10) || 0);
            try {
              const result = await readLogFromOffset(logsPath, byteOffset);
              sendJson(res, 200, { runId: run.id, content: result.content, offset: result.newOffset });
            } catch {
              sendJson(res, 200, { runId: run.id, content: "", offset: byteOffset });
            }
          } else {
            // Legacy mode: return last N lines
            const lineCount = parseLimit(requestUrl.searchParams.get("lines"));
            try {
              const log = await readLogTail(logsPath, lineCount);
              sendJson(res, 200, { runId: run.id, lines: lineCount, log });
            } catch {
              sendJson(res, 200, { runId: run.id, lines: lineCount, log: "" });
            }
          }
          return;
        }

        if (parts.length === 4 && parts[3] === "changes" && req.method === "GET") {
          const files = await getChangedFiles(config, run);
          const detailed = await getChangedFilesDetailed(config, run);
          sendJson(res, 200, { runId: run.id, files, detailed });
          return;
        }

        if (parts.length === 4 && parts[3] === "events" && req.method === "GET") {
          const logsPath = run.logsPath ?? path.resolve(config.workRoot, run.id, "run.log");
          const limitParam = requestUrl.searchParams.get("limit");
          try {
            const rawLog = await readFile(logsPath, "utf8");
            const allEvents = parseRunLog(rawLog);
            const stats = getEventStats(allEvents);
            const totalCount = allEvents.length;
            let events = allEvents;
            if (limitParam !== null) {
              const limit = Math.max(1, Number.parseInt(limitParam, 10) || 500);
              if (totalCount > limit) {
                events = allEvents.slice(-limit);
              }
            }
            sendJson(res, 200, { runId: run.id, events, stats, totalCount });
          } catch {
            sendJson(res, 200, { runId: run.id, events: [], stats: { totalEvents: 0, toolCalls: 0, thinkingBlocks: 0, shellCommands: 0, tools: {} }, totalCount: 0 });
          }
          return;
        }

        if (parts.length === 4 && parts[3] === "pipeline-events" && req.method === "GET") {
          const eventsPath = path.resolve(config.workRoot, run.id, "events.jsonl");
          try {
            const raw = await readFile(eventsPath, "utf8");
            const events = raw.trim().split("\n").filter(Boolean).map(line => {
              try { return JSON.parse(line); } catch { return null; }
            }).filter(Boolean);
            sendJson(res, 200, { runId: run.id, events });
          } catch {
            sendJson(res, 200, { runId: run.id, events: [] });
          }
          return;
        }

        // GET /api/runs/:id/artifacts/... — serve run artifacts (screenshots, videos, etc.)
        // Supports subdirectory paths like screenshots/final.png
        if (parts.length >= 5 && parts[3] === "artifacts" && req.method === "GET") {
          const filename = parts.slice(4).join("/");

          // Path traversal protection
          if (filename.includes("\\") || filename.includes("..") || filename.startsWith(".") || filename.startsWith("/")) {
            sendJson(res, 400, { error: "Invalid filename" });
            return;
          }

          // Allowlist of safe extensions
          const ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".json", ".txt", ".log", ".zip", ".html", ".mp4", ".webm"]);
          const ext = path.extname(filename).toLowerCase();
          if (!ALLOWED_EXTENSIONS.has(ext)) {
            sendJson(res, 400, { error: `File type not allowed: ${ext}` });
            return;
          }

          const filePath = path.resolve(config.workRoot, run.id, filename);

          // Verify the resolved path stays within the run directory
          const runDir = path.resolve(config.workRoot, run.id);
          if (!filePath.startsWith(runDir + path.sep) && filePath !== runDir) {
            sendJson(res, 400, { error: "Invalid filename" });
            return;
          }

          try {
            await fsAccess(filePath);
          } catch {
            sendJson(res, 404, { error: `Artifact not found: ${filename}` });
            return;
          }

          const CONTENT_TYPES: Record<string, string> = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".json": "application/json",
            ".txt": "text/plain",
            ".log": "text/plain",
            ".zip": "application/zip",
            ".html": "text/html",
            ".mp4": "video/mp4",
            ".webm": "video/webm"
          };

          const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
          const fileData = await readFile(filePath);
          res.writeHead(200, {
            "Content-Type": contentType,
            "Content-Length": String(fileData.length),
            "Cache-Control": "public, max-age=3600"
          });
          res.end(fileData);
          return;
        }

        // GET /api/runs/:id/media — list available screenshots and video for a run
        if (parts.length === 4 && parts[3] === "media" && req.method === "GET") {
          const { readdir, stat } = await import("node:fs/promises");
          const runDir = path.resolve(config.workRoot, run.id);
          const screenshots: Array<{ name: string; path: string; size: number }> = [];
          let video: { name: string; path: string; size: number } | undefined;

          // Scan screenshots directory
          try {
            const screenshotsDir = path.join(runDir, "screenshots");
            const files = await readdir(screenshotsDir);
            for (const file of files) {
              if (!file.endsWith(".png") && !file.endsWith(".jpg")) continue;
              const s = await stat(path.join(screenshotsDir, file));
              if (s.size > 1_000) {
                screenshots.push({
                  name: file,
                  path: `screenshots/${file}`,
                  size: s.size
                });
              }
            }
            screenshots.sort((a, b) => a.name.localeCompare(b.name));
          } catch {
            // No screenshots dir
          }

          // Scan for video files (.mp4 preferred, .webm fallback)
          try {
            const rootFiles = await readdir(runDir);
            const videoFile = rootFiles.find(f => f.endsWith(".mp4")) ?? rootFiles.find(f => f.endsWith(".webm"));
            if (videoFile) {
              const s = await stat(path.join(runDir, videoFile));
              if (s.size > 1_000) {
                video = { name: videoFile, path: videoFile, size: s.size };
              }
            }
          } catch {
            // Scan failed
          }

          // Scan for console-logs.json, network-log.json, agent-actions.json
          let consoleLogs: unknown[] | undefined;
          let networkLog: unknown[] | undefined;
          let agentActions: unknown[] | undefined;
          try {
            const consoleFile = path.join(runDir, "console-logs.json");
            const consoleData = await (await import("node:fs/promises")).readFile(consoleFile, "utf-8");
            consoleLogs = JSON.parse(consoleData);
          } catch {
            // No console logs
          }
          try {
            const networkFile = path.join(runDir, "network-log.json");
            const networkData = await (await import("node:fs/promises")).readFile(networkFile, "utf-8");
            networkLog = JSON.parse(networkData);
          } catch {
            // No network log
          }
          try {
            const actionsFile = path.join(runDir, "agent-actions.json");
            const actionsData = await (await import("node:fs/promises")).readFile(actionsFile, "utf-8");
            agentActions = JSON.parse(actionsData);
          } catch {
            // No agent actions
          }

          sendJson(res, 200, { runId: run.id, screenshots, video, consoleLogs, networkLog, agentActions });
          return;
        }

        if (parts.length === 4 && parts[3] === "feedback" && req.method === "POST") {
          const raw = await readBody(req);
          if (raw === null) { sendJson(res, 413, { error: "Request body too large" }); return; }
          let parsed: { rating?: string; note?: string; by?: string } = {};
          try {
            parsed = JSON.parse(raw) as { rating?: string; note?: string; by?: string };
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }

          if (parsed.rating !== "up" && parsed.rating !== "down") {
            sendJson(res, 400, { error: "rating must be one of: up, down" });
            return;
          }

          const note = parsed.note?.trim().slice(0, 1000) || undefined;
          const by = parsed.by?.trim().slice(0, 120) || "dashboard";

          // Route through RunManager so lifecycle hooks store corrections for negative feedback
          if (runManager?.saveFeedbackFromSlackAction) {
            const updated = await runManager.saveFeedbackFromSlackAction({
              runId: run.id,
              rating: parsed.rating,
              userId: by,
              note
            });
            sendJson(res, 200, { ok: true, run: updated ?? run });
          } else {
            const feedback: RunFeedback = {
              rating: parsed.rating,
              note,
              by,
              at: new Date().toISOString()
            };
            const updated = await store.saveFeedback(run.id, feedback);
            sendJson(res, 200, { ok: true, run: updated });
          }
          return;
        }

        if (parts.length === 4 && parts[3] === "retry" && req.method === "POST") {
          if (!runManager) {
            sendJson(res, 501, { error: "Retry is unavailable: run manager not attached." });
            return;
          }
          if (run.status !== "completed" && run.status !== "failed") {
            sendJson(res, 400, { error: "Can only retry completed or failed runs" });
            return;
          }

          const raw = await readBody(req);
          if (raw === null) { sendJson(res, 413, { error: "Request body too large" }); return; }
          let parsed: { by?: string } = {};
          try {
            parsed = raw ? (JSON.parse(raw) as { by?: string }) : {};
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }

          const requestedBy = parsed.by?.trim().slice(0, 120) || "dashboard";
          const retried = await runManager.retryRun(run.id, requestedBy);
          if (!retried) {
            sendJson(res, 404, { error: `Run not found: ${run.id}` });
            return;
          }

          sendJson(res, 200, { ok: true, run: retried });
          return;
        }

        if (parts.length === 4 && parts[3] === "cancel" && req.method === "POST") {
          if (!runManager) {
            sendJson(res, 501, { error: "Cancel is unavailable: run manager not attached." });
            return;
          }
          if (run.status !== "running" && run.status !== "queued" && run.status !== "validating" && run.status !== "pushing" && run.status !== "awaiting_ci" && run.status !== "ci_fixing") {
            sendJson(res, 400, { error: "Can only cancel in-progress runs" });
            return;
          }
          const cancelled = runManager.cancelRun(run.id);
          sendJson(res, 200, { ok: true, cancelled });
          return;
        }

        if (parts.length === 4 && parts[3] === "continue" && req.method === "POST") {
          if (!runManager?.continueRun) {
            sendJson(res, 501, { error: "Continue is unavailable: run manager not attached." });
            return;
          }
          if (run.status !== "completed" && run.status !== "failed") {
            sendJson(res, 400, { error: "Can only continue completed or failed runs" });
            return;
          }

          const raw = await readBody(req);
          if (raw === null) { sendJson(res, 413, { error: "Request body too large" }); return; }
          let parsed: { feedbackNote?: string; by?: string } = {};
          try {
            parsed = raw ? (JSON.parse(raw) as { feedbackNote?: string; by?: string }) : {};
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }

          if (!parsed.feedbackNote?.trim()) {
            sendJson(res, 400, { error: "feedbackNote is required" });
            return;
          }

          const requestedBy = parsed.by?.trim().slice(0, 120) || "dashboard";
          const continued = await runManager.continueRun(run.id, parsed.feedbackNote.trim(), requestedBy);
          if (!continued) {
            sendJson(res, 404, { error: `Run not found: ${run.id}` });
            return;
          }

          sendJson(res, 200, { ok: true, run: continued });
          return;
        }

        if (parts.length === 4 && parts[3] === "chain" && req.method === "GET") {
          const chain = runManager?.getRunChain
            ? await runManager.getRunChain(run.channelId, run.threadTs)
            : [run];
          sendJson(res, 200, { chain });
          return;
        }

        if (parts.length === 4 && parts[3] === "conversation" && req.method === "GET") {
          const threadKey = `${run.channelId}:${run.threadTs}`;
          const messages = (await conversationSource?.get(threadKey)) ?? [];
          sendJson(res, 200, {
            threadKey,
            available: Boolean(conversationSource),
            messages: buildConversationPreview(messages)
          });
          return;
        }
      }

      // ── Observer API routes ──

      if (req.method === "GET" && pathname === "/api/observer/state") {
        if (!observer) {
          sendJson(res, 200, { enabled: false });
          return;
        }
        sendJson(res, 200, { enabled: true, ...(await observer.getStateSnapshot()) });
        return;
      }

      if (req.method === "GET" && pathname === "/api/observer/events") {
        if (!observer) {
          sendJson(res, 200, { events: [] });
          return;
        }
        const limit = parseLimit(requestUrl.searchParams.get("limit"));
        sendJson(res, 200, { events: observer.getRecentEvents(limit) });
        return;
      }

      if (req.method === "GET" && pathname === "/api/observer/rules") {
        if (!observer) {
          sendJson(res, 200, { rules: [] });
          return;
        }
        const rules = observer.getRules().map(r => ({
          id: r.id,
          source: r.source,
          conditions: r.conditions,
          pipeline: r.pipeline,
          requiresApproval: r.requiresApproval,
          cooldownMinutes: r.cooldownMinutes,
          maxRunsPerHour: r.maxRunsPerHour,
          repoSlug: r.repoSlug,
          skipTriage: r.skipTriage
        }));
        sendJson(res, 200, { rules });
        return;
      }

      // ── Pipeline CRUD routes ──

      if (req.method === "GET" && pathname === "/api/pipelines") {
        if (!pipelineStore) { sendJson(res, 501, { error: "Pipeline store not available" }); return; }
        const pipelines = pipelineStore.list();
        sendJson(res, 200, { pipelines });
        return;
      }

      if (req.method === "POST" && pathname === "/api/pipelines/validate") {
        if (!pipelineStore) { sendJson(res, 501, { error: "Pipeline store not available" }); return; }
        const body = await readBody(req);
        if (body === null) { sendJson(res, 413, { error: "Request body too large" }); return; }
        let parsed: { yaml?: string };
        try { parsed = JSON.parse(body); } catch { sendJson(res, 400, { error: "Invalid JSON" }); return; }
        if (!parsed.yaml) { sendJson(res, 400, { error: "yaml is required" }); return; }
        try {
          const config = pipelineStore.validate(parsed.yaml);
          sendJson(res, 200, { valid: true, name: config.name, nodeCount: config.nodes.length });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "unknown";
          sendJson(res, 200, { valid: false, error: msg });
        }
        return;
      }

      if (req.method === "POST" && pathname === "/api/pipelines") {
        if (!pipelineStore) { sendJson(res, 501, { error: "Pipeline store not available" }); return; }
        const body = await readBody(req);
        if (body === null) { sendJson(res, 413, { error: "Request body too large" }); return; }
        let parsed: { id?: string; yaml?: string };
        try { parsed = JSON.parse(body); } catch { sendJson(res, 400, { error: "Invalid JSON" }); return; }
        if (!parsed.id || !parsed.yaml) { sendJson(res, 400, { error: "id and yaml are required" }); return; }
        try {
          const saved = await pipelineStore.save(parsed.id, parsed.yaml);
          sendJson(res, 201, { pipeline: saved });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "unknown";
          sendJson(res, 400, { error: msg });
        }
        return;
      }

      if (parts[0] === "api" && parts[1] === "pipelines" && parts.length === 3) {
        const id = decodeURIComponent(parts[2]);

        if (req.method === "GET") {
          if (!pipelineStore) { sendJson(res, 501, { error: "Pipeline store not available" }); return; }
          const pipeline = pipelineStore.get(id);
          if (!pipeline) { sendJson(res, 404, { error: `Pipeline not found: ${id}` }); return; }
          sendJson(res, 200, { pipeline });
          return;
        }

        if (req.method === "PUT") {
          if (!pipelineStore) { sendJson(res, 501, { error: "Pipeline store not available" }); return; }
          const body = await readBody(req);
          if (body === null) { sendJson(res, 413, { error: "Request body too large" }); return; }
          let parsed: { yaml?: string };
          try { parsed = JSON.parse(body); } catch { sendJson(res, 400, { error: "Invalid JSON" }); return; }
          if (!parsed.yaml) { sendJson(res, 400, { error: "yaml is required" }); return; }
          try {
            const saved = await pipelineStore.save(id, parsed.yaml);
            sendJson(res, 200, { pipeline: saved });
          } catch (err) {
            const msg = err instanceof Error ? err.message : "unknown";
            sendJson(res, 400, { error: msg });
          }
          return;
        }

        if (req.method === "DELETE") {
          if (!pipelineStore) { sendJson(res, 501, { error: "Pipeline store not available" }); return; }
          const deleted = await pipelineStore.delete(id);
          if (!deleted) { sendJson(res, 400, { error: "Cannot delete: pipeline not found or is built-in" }); return; }
          sendJson(res, 200, { ok: true });
          return;
        }
      }

      // ── Learnings routes ──

      if (req.method === "GET" && pathname === "/api/learnings/summary") {
        if (!learningStore) { sendJson(res, 501, { error: "Learning store not available" }); return; }
        sendJson(res, 200, {
          system: await learningStore.getSystemStats(),
          repos: await learningStore.getAllRepoSummaries(),
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/learnings/outcomes") {
        if (!learningStore) { sendJson(res, 501, { error: "Learning store not available" }); return; }
        const limit = parseLimit(requestUrl.searchParams.get("limit"));
        let outcomes = await learningStore.getRecentOutcomes(limit);
        const repoFilter = requestUrl.searchParams.get("repo");
        if (repoFilter) outcomes = outcomes.filter(o => o.repoSlug === repoFilter);
        const sourceFilter = requestUrl.searchParams.get("source");
        if (sourceFilter) outcomes = outcomes.filter(o => o.source === sourceFilter);
        sendJson(res, 200, { outcomes });
        return;
      }

      if (parts[0] === "api" && parts[1] === "learnings" && parts[2] === "repo" && parts[3]) {
        if (!learningStore) { sendJson(res, 501, { error: "Learning store not available" }); return; }
        const slug = decodeURIComponent(parts.slice(3).join("/"));
        const repoLearnings = await learningStore.getRepoLearnings(slug);
        if (!repoLearnings) { sendJson(res, 404, { error: `No learnings for repo: ${slug}` }); return; }
        sendJson(res, 200, { learnings: repoLearnings });
        return;
      }

      // ── Eval routes ──

      if (req.method === "GET" && pathname === "/api/eval/results") {
        if (!evalStore) { sendJson(res, 501, { error: "Eval store not available" }); return; }
        const scenario = requestUrl.searchParams.get("scenario");
        const limit = parseLimit(requestUrl.searchParams.get("limit"));
        const results = scenario
          ? await evalStore.getScenarioHistory(scenario, limit)
          : await evalStore.getRecentResults(limit);
        sendJson(res, 200, { results });
        return;
      }

      if (req.method === "GET" && pathname === "/api/eval/scenarios") {
        try {
          const scenarios = await loadScenariosFromDir("evals");
          sendJson(res, 200, { scenarios: scenarios.map((s) => ({ name: s.name, description: s.description, tags: s.tags })) });
        } catch {
          sendJson(res, 200, { scenarios: [] });
        }
        return;
      }

      if (req.method === "GET" && pathname === "/api/eval/comparison") {
        if (!evalStore) { sendJson(res, 501, { error: "Eval store not available" }); return; }
        const scenario = requestUrl.searchParams.get("scenario");
        if (!scenario) { sendJson(res, 400, { error: "Missing 'scenario' query param" }); return; }
        const comparison = await evalStore.getComparison(scenario);
        sendJson(res, 200, { comparison });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown dashboard error";
      logError("Dashboard request failed", { error: message });
      sendJson(res, 500, { error: "Internal server error" });
    }
  });

  server.listen(config.dashboardPort, config.dashboardHost, () => {
    logInfo("Dashboard server started", {
      url: `http://${config.dashboardHost}:${String(config.dashboardPort)}`
    });
  });
}

function parseOverrideFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}
