import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, access as fsAccess } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { resolveGitHubAuthMode } from "./config.js";
import { eq } from "drizzle-orm";
import { logError, logInfo } from "./logger.js";
import { RunStore } from "./store.js";
import type { RunManager } from "./run-manager.js";
import type { RunFeedback, RunRecord } from "./types.js";
import { parseRunLog, getEventStats } from "./log-parser.js";
import type { ObserverEventRecord, ObserverStateSnapshot, TriggerRule } from "./observer/types.js";
import type { ChatMessage } from "./llm/caller.js";
import { dashboardHtml } from "./dashboard/html.js";
import {
  buildDashboardSessionCookie,
  checkAuth,
  clearDashboardSessionCookie,
  hashToken,
  handleAdminLogin,
  loginPageHtml,
  parseCookies,
  type AuthOptions,
} from "./dashboard/auth.js";
import { DashboardAuthSessionStore } from "./dashboard/auth-session-store.js";
import { SlackAuthFlow, isSlackAuthConfigured } from "./dashboard/slack-auth.js";
import { resolveMappedSlackTeams, syncSlackUserGroupMemberships } from "./dashboard/team-membership-sync.js";
import type { PipelineStore } from "./pipeline/pipeline-store.js";
import type { LearningStore } from "./observer/learning-store.js";
import { SetupStore } from "./db/setup-store.js";
import type { Database } from "./db/index.js";
import { users } from "./db/schema.js";
import { wizardHtml } from "./dashboard/wizard-html.js";
import { agentProfileWizardHtml } from "./dashboard/agent-profile-wizard-html.js";
import { agentProfileListHtml } from "./dashboard/agent-profile-list-html.js";
import { GitHubService } from "./github.js";
import type { EvalStore } from "./eval/eval-store.js";
import { loadScenariosFromDir } from "./eval/scenario-loader.js";
import { AgentProfileStore } from "./db/agent-profile-store.js";
import {
  getAvailableProviders,
  renderAgentProfileTemplate,
  sanitizeAgentProfileInput,
  validateAgentProfile,
  type AgentProvider,
  type AgentProfileInput,
} from "./agent-profile.js";
import type { ControlPlaneStore } from "./runtime/control-plane-store.js";
import { routeControlPlaneRequest } from "./runtime/control-plane-router.js";
import type { ArtifactStore } from "./runtime/artifact-store.js";
import { formatSandboxRuntimeLabel } from "./runtime/runtime-mode.js";
import type { ReviewRequestRecord, WorkItemEventRecord, WorkItemRecord } from "./work-items/types.js";

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

export interface DashboardWorkItemsSource {
  listWorkItems(workflow?: string): Promise<WorkItemRecord[]>;
  getWorkItem(id: string): Promise<WorkItemRecord | undefined>;
  listReviewRequestsForWorkItem(workItemId: string): Promise<ReviewRequestRecord[]>;
  listReviewRequestComments(reviewRequestId: string): Promise<Array<{
    id: number;
    reviewRequestId: string;
    authorUserId?: string;
    source: string;
    body: string;
    createdAt: string;
  }>>;
  listEventsForWorkItem(workItemId: string): Promise<WorkItemEventRecord[]>;
  createDiscoveryWorkItem(input: {
    title: string;
    summary?: string;
    ownerTeamId?: string;
    homeChannelId?: string;
    homeThreadTs?: string;
    originChannelId?: string;
    originThreadTs?: string;
    jiraIssueKey?: string;
    createdByUserId: string;
  }): Promise<WorkItemRecord>;
  createReviewRequests(input: {
    workItemId: string;
    requestedByUserId: string;
    requests: Array<{
      type: ReviewRequestRecord["type"];
      targetType: ReviewRequestRecord["targetType"];
      targetRef: Record<string, unknown>;
      title: string;
      requestMessage?: string;
      focusPoints?: string[];
    }>;
  }): Promise<ReviewRequestRecord[]>;
  respondToReviewRequest(input: {
    reviewRequestId: string;
    outcome: NonNullable<ReviewRequestRecord["outcome"]>;
    authorUserId?: string;
    comment?: string;
  }): Promise<WorkItemRecord>;
  confirmDiscovery(input: {
    workItemId: string;
    approved: boolean;
    actorUserId?: string;
    jiraIssueKey?: string;
  }): Promise<WorkItemRecord>;
  stopProcessing(input: {
    workItemId: string;
    actorUserId?: string;
  }): Promise<{ workItem: WorkItemRecord; stoppedRunIds: string[]; alreadyIdleRunIds: string[]; failedRunIds: string[] }>;
  guardedOverrideState(input: {
    workItemId: string;
    state: WorkItemRecord["state"];
    substate?: string;
    actorUserId?: string;
    reason: string;
  }): Promise<WorkItemRecord>;
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
const GITHUB_REPOSITORIES_CACHE_TTL_MS = 60_000;

interface CachedGitHubRepositories {
  fetchedAt: number;
  repositories: Array<{
    fullName: string;
    private: boolean;
    defaultBranch?: string;
    htmlUrl?: string;
  }>;
}

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
    if (!response.ok) {
      throw new Error(`OpenAI returned ${String(response.status)}`);
    }
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
    if (!response.ok) {
      throw new Error(`Anthropic returned ${String(response.status)}`);
    }
    const data = await response.json() as { data?: Array<{ id?: string }> };
    return unique((data.data ?? []).map((entry) => entry.id?.trim()).filter((entry): entry is string => Boolean(entry)));
  }

  if (!config.openrouterApiKey) throw new Error("OPENROUTER_API_KEY is not configured");
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${config.openrouterApiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter returned ${String(response.status)}`);
  }
  const data = await response.json() as { data?: Array<{ id?: string }> };
  return unique((data.data ?? []).map((entry) => entry.id?.trim()).filter((entry): entry is string => Boolean(entry)));
}

function decorateAgentProfile(profile: AgentProfileInput & { id?: string; isBuiltin?: boolean; isActive?: boolean; createdAt?: string; updatedAt?: string }): Record<string, unknown> {
  return {
    ...profile,
    commandTemplate: renderAgentProfileTemplate(profile),
  };
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
  agentProfileStore?: AgentProfileStore,
  controlPlaneStore?: ControlPlaneStore,
  runnerArtifactStore?: ArtifactStore,
  workItemsSource?: DashboardWorkItemsSource,
  db?: Database,
): Server {
  const githubService = GitHubService.create(config);
  let githubRepositoriesCache: CachedGitHubRepositories | undefined;
  const authSessionStore = db ? new DashboardAuthSessionStore(db) : undefined;
  const slackAuthFlow = new SlackAuthFlow(config);

  const server = createServer(async (req, res) => {
    try {
      // Security headers — applied to all responses
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
      res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:");

      const requestUrl = new URL(req.url ?? "/", `http://${config.dashboardHost}:${String(config.dashboardPort)}`);
      const pathname = requestUrl.pathname;

      if (controlPlaneStore && runnerArtifactStore) {
        const handled = await routeControlPlaneRequest(req, res, pathname, controlPlaneStore, runnerArtifactStore);
        if (handled) return;
      }

      // Build auth options (async — reads wizard password hash from DB)
      const setupComplete = setupStore ? await setupStore.isComplete() : true;
      const passwordHash = setupStore ? await setupStore.getPasswordHash() : undefined;
      const authOpts: AuthOptions = {
        dashboardToken: config.dashboardToken,
        passwordHash,
        setupComplete,
        slackAuthEnabled: isSlackAuthConfigured(config),
        sessionStore: authSessionStore,
      };

      // Auth check — must come before route dispatch
      if (!await checkAuth(req, res, authOpts, pathname)) return;

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

      if (req.method === "GET" && pathname === "/agent-profiles") {
        sendText(res, 200, agentProfileListHtml(config.appName), "text/html");
        return;
      }

      if (req.method === "GET" && pathname === "/agent-profiles/new") {
        sendText(res, 200, agentProfileWizardHtml(config.appName), "text/html");
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
        if (!config.dashboardToken && !passwordHash && !isSlackAuthConfigured(config)) {
          res.statusCode = 302;
          res.setHeader("location", "/");
          res.end();
          return;
        }
        sendText(res, 200, loginPageHtml(config, requestUrl.searchParams.get("error") ?? undefined), "text/html");
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
          return;
        }
        if (authenticated) {
          const fallbackSessionValue = config.dashboardToken ? hashToken(config.dashboardToken) : hashToken(passwordHash!);
          res.statusCode = 302;
          res.setHeader("set-cookie", buildDashboardSessionCookie(fallbackSessionValue, config));
          res.setHeader("location", "/");
          res.end();
          return;
        }
        sendText(res, 200, loginPageHtml(config, "Invalid password"), "text/html");
        return;
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
        return;
      }

      if (req.method === "GET" && pathname === "/auth/slack/signin") {
        if (!isSlackAuthConfigured(config)) {
          res.statusCode = 302;
          res.setHeader("location", "/login?error=Slack%20login%20is%20not%20configured");
          res.end();
          return;
        }
        const { url } = slackAuthFlow.start("signin");
        res.statusCode = 302;
        res.setHeader("location", url);
        res.end();
        return;
      }

      if (req.method === "GET" && pathname === "/auth/slack/signup") {
        if (!isSlackAuthConfigured(config)) {
          res.statusCode = 302;
          res.setHeader("location", "/login?error=Slack%20login%20is%20not%20configured");
          res.end();
          return;
        }
        const { url } = slackAuthFlow.start("signup");
        res.statusCode = 302;
        res.setHeader("location", url);
        res.end();
        return;
      }

      if (req.method === "GET" && pathname === "/auth/slack/callback") {
        if (!db || !authSessionStore) {
          sendJson(res, 501, { error: "Database-backed auth is not available" });
          return;
        }
        if (!config.slackBotToken) {
          res.statusCode = 302;
          res.setHeader("location", "/login?error=Slack%20bot%20token%20is%20required%20for%20team%20sync");
          res.end();
          return;
        }

        const callbackError = requestUrl.searchParams.get("error");
        if (callbackError) {
          res.statusCode = 302;
          res.setHeader("location", `/login?error=${encodeURIComponent(`Slack login failed: ${callbackError}`)}`);
          res.end();
          return;
        }

        const code = requestUrl.searchParams.get("code");
        const state = requestUrl.searchParams.get("state");
        if (!code || !state) {
          res.statusCode = 302;
          res.setHeader("location", "/login?error=Slack%20callback%20is%20missing%20code%20or%20state");
          res.end();
          return;
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
              return;
            }
            const matchedTeamIds = await resolveMappedSlackTeams(db, config.slackBotToken, identity.slackUserId);
            if (matchedTeamIds.length === 0) {
              res.statusCode = 302;
              res.setHeader("location", "/login?error=Your%20Slack%20account%20is%20not%20assigned%20to%20any%20Gooseherd%20teams%20yet.");
              res.end();
              return;
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
              return;
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
        return;
      }


      if (req.method === "GET" && pathname === "/") {
        sendText(res, 200, dashboardHtml(config), "text/html");
        return;
      }

      if (req.method === "GET" && pathname === "/api/settings") {
        const githubAuthMode = resolveGitHubAuthMode(config);
        const stats = await computeRunStats(store);
        const profiles = agentProfileStore ? (await agentProfileStore.list()).map((profile) => decorateAgentProfile(profile)) : [];

        sendJson(res, 200, {
          config: {
            appName: config.appName,
            pipelineFile: config.pipelineFile,
            sandboxRuntime: config.sandboxRuntime,
            sandboxRuntimeLabel: formatSandboxRuntimeLabel(config.sandboxRuntime),
            sandboxStatus: {
              enabled: config.sandboxEnabled,
            },
            slackConnected: Boolean(config.slackBotToken),
            githubAuthMode,
            configOverrides: {
              githubFromEnv: parseOverrideFlag(process.env.GITHUB_CONFIG_OVERRIDE_FROM_ENV),
              slackFromEnv: parseOverrideFlag(process.env.SLACK_CONFIG_OVERRIDE_FROM_ENV),
              llmFromEnv: parseOverrideFlag(process.env.LLM_CONFIG_OVERRIDE_FROM_ENV),
            },
            features: {
              observer: config.observerEnabled,
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
            agentCommandTemplate: config.agentCommandTemplate,
            activeAgentProfile: config.activeAgentProfile,
            agentProfiles: profiles,
          },
          stats,
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/agent-providers") {
        sendJson(res, 200, {
          providers: getAvailableProviders(config),
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/agent-models") {
        const provider = requestUrl.searchParams.get("provider") as AgentProvider | null;
        if (!provider) {
          sendJson(res, 400, { error: "provider is required" });
          return;
        }
        try {
          const models = await loadProviderModels(config, provider);
          sendJson(res, 200, { provider, models });
        } catch (error) {
          sendJson(res, 502, { error: error instanceof Error ? error.message : "Failed to load models", models: [] });
        }
        return;
      }

      if (req.method === "POST" && pathname === "/api/agent-profiles/preview") {
        const raw = await readBody(req);
        if (raw === null) { sendJson(res, 413, { error: "Request body too large" }); return; }
        let parsed: AgentProfileInput;
        try {
          parsed = JSON.parse(raw) as AgentProfileInput;
        } catch {
          sendJson(res, 400, { error: "Invalid JSON body" });
          return;
        }
        const profile = sanitizeAgentProfileInput(parsed);
        const validation = validateAgentProfile(profile, config);
        sendJson(res, 200, {
          ok: validation.ok,
          errors: validation.errors,
          commandTemplate: renderAgentProfileTemplate(profile),
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/agent-profiles") {
        if (!agentProfileStore) {
          sendJson(res, 501, { error: "Agent profiles are unavailable" });
          return;
        }
        sendJson(res, 200, { profiles: (await agentProfileStore.list()).map((profile) => decorateAgentProfile(profile)) });
        return;
      }

      if (req.method === "POST" && pathname === "/api/agent-profiles") {
        if (!agentProfileStore) {
          sendJson(res, 501, { error: "Agent profiles are unavailable" });
          return;
        }
        const raw = await readBody(req);
        if (raw === null) { sendJson(res, 413, { error: "Request body too large" }); return; }
        let parsed: AgentProfileInput;
        try {
          parsed = JSON.parse(raw) as AgentProfileInput;
        } catch {
          sendJson(res, 400, { error: "Invalid JSON body" });
          return;
        }
        try {
          const profile = await agentProfileStore.save(parsed);
          await syncActiveAgentProfileConfig(config, agentProfileStore);
          sendJson(res, 201, { ok: true, profile: decorateAgentProfile(profile) });
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : "Failed to save agent profile" });
        }
        return;
      }

      if (req.method === "GET" && pathname === "/api/github/repositories") {
        if (!githubService) {
          sendJson(res, 501, { error: "GitHub integration is not configured" });
          return;
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
          return;
        }

        try {
          const repositories = await githubService.listAccessibleRepos();
          githubRepositoriesCache = {
            repositories,
            fetchedAt: now,
          };
          sendJson(res, 200, {
            repositories,
            cached: false,
            fetchedAt: new Date(now).toISOString(),
          });
        } catch (error) {
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
            return;
          }

          sendJson(res, 502, { error: "Failed to load repositories from GitHub" });
        }
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
          runtime: config.sandboxRuntime,
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

      if (req.method === "GET" && pathname === "/api/work-items") {
        if (!workItemsSource) {
          sendJson(res, 501, { error: "Work item APIs are unavailable" });
          return;
        }

        const workflow = requestUrl.searchParams.get("workflow") ?? undefined;
        const workItems = await workItemsSource.listWorkItems(workflow || undefined);
        sendJson(res, 200, { workItems });
        return;
      }

      if (req.method === "POST" && pathname === "/api/work-items/discovery") {
        if (!workItemsSource) {
          sendJson(res, 501, { error: "Work item APIs are unavailable" });
          return;
        }

        const raw = await readBody(req);
        if (raw === null) { sendJson(res, 413, { error: "Request body too large" }); return; }
        let parsed: {
          title?: string;
          summary?: string;
          ownerTeamId?: string;
          homeChannelId?: string;
          homeThreadTs?: string;
          originChannelId?: string;
          originThreadTs?: string;
          jiraIssueKey?: string;
          createdByUserId?: string;
        } = {};
        try {
          parsed = JSON.parse(raw) as typeof parsed;
        } catch {
          sendJson(res, 400, { error: "Invalid JSON body" });
          return;
        }

        if (!parsed.title || !parsed.createdByUserId) {
          sendJson(res, 400, { error: "title and createdByUserId are required" });
          return;
        }

        try {
          const workItem = await workItemsSource.createDiscoveryWorkItem({
            title: parsed.title,
            summary: parsed.summary,
            ownerTeamId: parsed.ownerTeamId,
            homeChannelId: parsed.homeChannelId,
            homeThreadTs: parsed.homeThreadTs,
            originChannelId: parsed.originChannelId,
            originThreadTs: parsed.originThreadTs,
            jiraIssueKey: parsed.jiraIssueKey,
            createdByUserId: parsed.createdByUserId,
          });
          sendJson(res, 201, { workItem });
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : "Failed to create discovery work item" });
        }
        return;
      }

      const parts = pathname.split("/").filter(Boolean);
      if (parts[0] === "api" && parts[1] === "agent-profiles" && parts[2]) {
        if (!agentProfileStore) {
          sendJson(res, 501, { error: "Agent profiles are unavailable" });
          return;
        }
        const profileId = decodeURIComponent(parts[2]);

        if (parts.length === 3 && req.method === "PUT") {
          const raw = await readBody(req);
          if (raw === null) { sendJson(res, 413, { error: "Request body too large" }); return; }
          let parsed: AgentProfileInput;
          try {
            parsed = JSON.parse(raw) as AgentProfileInput;
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          try {
            const profile = await agentProfileStore.save(parsed, profileId);
            await syncActiveAgentProfileConfig(config, agentProfileStore);
            sendJson(res, 200, { ok: true, profile: decorateAgentProfile(profile) });
          } catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : "Failed to update agent profile" });
          }
          return;
        }

        if (parts.length === 3 && req.method === "DELETE") {
          const deleted = await agentProfileStore.delete(profileId);
          await syncActiveAgentProfileConfig(config, agentProfileStore);
          sendJson(res, deleted ? 200 : 404, deleted ? { ok: true } : { error: "Profile not found or cannot be deleted" });
          return;
        }

        if (parts.length === 4 && parts[3] === "activate" && req.method === "POST") {
          const profile = await agentProfileStore.setActive(profileId);
          if (!profile) {
            sendJson(res, 404, { error: "Profile not found" });
            return;
          }
          await syncActiveAgentProfileConfig(config, agentProfileStore);
          sendJson(res, 200, { ok: true, profile: decorateAgentProfile(profile) });
          return;
        }
      }

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
          const cancelled = await runManager.cancelRun(run.id);
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

      if (parts[0] === "api" && parts[1] === "work-items" && parts[2]) {
        if (!workItemsSource) {
          sendJson(res, 501, { error: "Work item APIs are unavailable" });
          return;
        }

        const workItemId = decodeURIComponent(parts[2]);

        if (parts.length === 3 && req.method === "GET") {
          const workItem = await workItemsSource.getWorkItem(workItemId);
          if (!workItem) {
            sendJson(res, 404, { error: `Work item not found: ${workItemId}` });
            return;
          }
          sendJson(res, 200, { workItem });
          return;
        }

        if (parts.length === 4 && parts[3] === "review-requests" && req.method === "GET") {
          const reviewRequests = await workItemsSource.listReviewRequestsForWorkItem(workItemId);
          sendJson(res, 200, { reviewRequests });
          return;
        }

        if (parts.length === 6 && parts[3] === "review-requests" && parts[5] === "comments" && req.method === "GET") {
          const reviewRequestId = decodeURIComponent(parts[4]!);
          const comments = await workItemsSource.listReviewRequestComments(reviewRequestId);
          sendJson(res, 200, { comments });
          return;
        }

        if (parts.length === 4 && parts[3] === "events" && req.method === "GET") {
          const events = await workItemsSource.listEventsForWorkItem(workItemId);
          sendJson(res, 200, { events });
          return;
        }

        if (parts.length === 4 && parts[3] === "review-requests" && req.method === "POST") {
          const raw = await readBody(req);
          if (raw === null) { sendJson(res, 413, { error: "Request body too large" }); return; }
          let parsed: {
            requestedByUserId?: string;
            requests?: Array<{
              type: ReviewRequestRecord["type"];
              targetType: ReviewRequestRecord["targetType"];
              targetRef: Record<string, unknown>;
              title: string;
              requestMessage?: string;
              focusPoints?: string[];
            }>;
          } = {};
          try {
            parsed = JSON.parse(raw) as typeof parsed;
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          if (!parsed.requestedByUserId || !parsed.requests || parsed.requests.length === 0) {
            sendJson(res, 400, { error: "requestedByUserId and at least one request are required" });
            return;
          }

          try {
            const reviewRequests = await workItemsSource.createReviewRequests({
              workItemId,
              requestedByUserId: parsed.requestedByUserId,
              requests: parsed.requests,
            });
            sendJson(res, 201, { reviewRequests });
          } catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : "Failed to create review requests" });
          }
          return;
        }

        if (parts.length === 4 && parts[3] === "confirm-discovery" && req.method === "POST") {
          const raw = await readBody(req);
          if (raw === null) { sendJson(res, 413, { error: "Request body too large" }); return; }
          let parsed: { approved?: boolean; actorUserId?: string; jiraIssueKey?: string } = {};
          try {
            parsed = JSON.parse(raw) as typeof parsed;
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          if (typeof parsed.approved !== "boolean") {
            sendJson(res, 400, { error: "approved must be a boolean" });
            return;
          }

          try {
            const workItem = await workItemsSource.confirmDiscovery({
              workItemId,
              approved: parsed.approved,
              actorUserId: parsed.actorUserId,
              jiraIssueKey: parsed.jiraIssueKey,
            });
            sendJson(res, 200, { workItem });
          } catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : "Failed to confirm discovery" });
          }
          return;
        }

        if (parts.length === 4 && parts[3] === "stop-processing" && req.method === "POST") {
          const raw = await readBody(req);
          if (raw === null) { sendJson(res, 413, { error: "Request body too large" }); return; }
          let parsed: { actorUserId?: string } = {};
          try {
            parsed = raw ? (JSON.parse(raw) as typeof parsed) : {};
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }

          try {
            const result = await workItemsSource.stopProcessing({
              workItemId,
              actorUserId: parsed.actorUserId,
            });
            sendJson(res, 200, result);
          } catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : "Failed to stop processing" });
          }
          return;
        }

        if (parts.length === 4 && parts[3] === "override-state" && req.method === "POST") {
          const raw = await readBody(req);
          if (raw === null) { sendJson(res, 413, { error: "Request body too large" }); return; }
          let parsed: { state?: WorkItemRecord["state"]; substate?: string; actorUserId?: string; reason?: string } = {};
          try {
            parsed = JSON.parse(raw) as typeof parsed;
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          if (!parsed.state || !parsed.reason) {
            sendJson(res, 400, { error: "state and reason are required" });
            return;
          }

          try {
            const workItem = await workItemsSource.guardedOverrideState({
              workItemId,
              state: parsed.state,
              substate: parsed.substate,
              actorUserId: parsed.actorUserId,
              reason: parsed.reason,
            });
            sendJson(res, 200, { workItem });
          } catch (error) {
            sendJson(res, 409, { error: error instanceof Error ? error.message : "Guarded override rejected" });
          }
          return;
        }
      }

      if (parts[0] === "api" && parts[1] === "review-requests" && parts[2] && parts[3] === "respond" && req.method === "POST") {
        if (!workItemsSource) {
          sendJson(res, 501, { error: "Work item APIs are unavailable" });
          return;
        }

        const raw = await readBody(req);
        if (raw === null) { sendJson(res, 413, { error: "Request body too large" }); return; }
        let parsed: {
          outcome?: NonNullable<ReviewRequestRecord["outcome"]>;
          authorUserId?: string;
          comment?: string;
        } = {};
        try {
          parsed = JSON.parse(raw) as typeof parsed;
        } catch {
          sendJson(res, 400, { error: "Invalid JSON body" });
          return;
        }
        if (!parsed.outcome) {
          sendJson(res, 400, { error: "outcome is required" });
          return;
        }

        try {
          const workItem = await workItemsSource.respondToReviewRequest({
            reviewRequestId: decodeURIComponent(parts[2]),
            outcome: parsed.outcome,
            authorUserId: parsed.authorUserId,
            comment: parsed.comment,
          });
          sendJson(res, 200, { workItem });
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : "Failed to record review response" });
        }
        return;
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

  return server;
}

function parseOverrideFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}
