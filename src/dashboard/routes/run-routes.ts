import { spawn } from "node:child_process";
import { readFile, access as fsAccess } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { URL } from "node:url";
import type { AppConfig } from "../../config.js";
import { filterInternalGeneratedFiles } from "../../pipeline/internal-generated-files.js";
import { parseRunLog, getEventStats } from "../../log-parser.js";
import type { ChatMessage } from "../../llm/caller.js";
import type { RunManager } from "../../run-manager.js";
import type { RunStore } from "../../store.js";
import type { RunFeedback, RunRecord } from "../../types.js";
import type { DashboardConversationSource } from "../contracts.js";
import { parseLimit, readBody, readLogFromOffset, readLogTail, sendJson } from "./shared.js";

type DashboardRunManager = Pick<RunManager, "retryRun" | "continueRun" | "getRunChain" | "saveFeedbackFromSlackAction" | "cancelRun" | "enqueueRun">;

export interface RunRoutesDeps {
  config: AppConfig;
  conversationSource?: DashboardConversationSource;
  requestUrl: URL;
  runManager?: DashboardRunManager;
  store: RunStore;
}

export async function handleRunRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: RunRoutesDeps,
): Promise<boolean> {
  const { config, conversationSource, requestUrl, runManager, store } = deps;

  if (req.method === "POST" && pathname === "/api/runs") {
    if (!runManager) {
      sendJson(res, 501, { error: "Run creation is unavailable: run manager not attached." });
      return true;
    }
    const raw = await readBody(req);
    if (raw === null) {
      sendJson(res, 413, { error: "Request body too large" });
      return true;
    }
    let parsed: { repoSlug?: string; baseBranch?: string; task?: string; pipeline?: string } = {};
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return true;
    }
    if (!parsed.repoSlug || !parsed.task) {
      sendJson(res, 400, { error: "repoSlug and task are required" });
      return true;
    }
    if (parsed.task.length > 10_000) {
      sendJson(res, 400, { error: "task must be under 10,000 characters" });
      return true;
    }
    if (parsed.repoSlug.length > 200) {
      sendJson(res, 400, { error: "repoSlug must be under 200 characters" });
      return true;
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
    return true;
  }

  if (req.method === "GET" && pathname === "/api/runs") {
    const limit = parseLimit(requestUrl.searchParams.get("limit"));
    const teamId = requestUrl.searchParams.get("team") ?? undefined;
    const statusFilter = requestUrl.searchParams.get("status") ?? undefined;
    const search = requestUrl.searchParams.get("search") ?? undefined;
    let runs = await store.listRuns({ limit: 500, teamId });
    if (statusFilter && statusFilter !== "all") {
      runs = runs.filter((run) => run.status === statusFilter);
    }
    if (search) {
      const query = search.toLowerCase();
      runs = runs.filter((run) =>
        (run.title?.toLowerCase().includes(query))
        || run.task.toLowerCase().includes(query)
        || run.repoSlug.toLowerCase().includes(query)
        || run.id.toLowerCase().startsWith(query)
      );
    }
    sendJson(res, 200, { runs: runs.slice(0, limit) });
    return true;
  }

  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "runs" || !parts[2]) {
    return false;
  }

  const id = decodeURIComponent(parts[2]);
  const run = await store.findRunByIdentifier(id);
  if (!run) {
    sendJson(res, 404, { error: `Run not found: ${id}` });
    return true;
  }

  if (parts.length === 3 && req.method === "GET") {
    sendJson(res, 200, { run });
    return true;
  }

  if (parts.length === 4 && parts[3] === "log" && req.method === "GET") {
    const logsPath = run.logsPath ?? path.resolve(config.workRoot, run.id, "run.log");
    const offsetParam = requestUrl.searchParams.get("offset");

    if (offsetParam !== null) {
      const byteOffset = Math.max(0, Number.parseInt(offsetParam, 10) || 0);
      try {
        const result = await readLogFromOffset(logsPath, byteOffset);
        sendJson(res, 200, { runId: run.id, content: result.content, offset: result.newOffset });
      } catch {
        sendJson(res, 200, { runId: run.id, content: "", offset: byteOffset });
      }
    } else {
      const lineCount = parseLimit(requestUrl.searchParams.get("lines"));
      try {
        const log = await readLogTail(logsPath, lineCount);
        sendJson(res, 200, { runId: run.id, lines: lineCount, log });
      } catch {
        sendJson(res, 200, { runId: run.id, lines: lineCount, log: "" });
      }
    }
    return true;
  }

  if (parts.length === 4 && parts[3] === "changes" && req.method === "GET") {
    const files = await getChangedFiles(config, run);
    const detailed = await getChangedFilesDetailed(config, run);
    sendJson(res, 200, { runId: run.id, files, detailed });
    return true;
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
      sendJson(res, 200, {
        runId: run.id,
        events: [],
        stats: { totalEvents: 0, toolCalls: 0, thinkingBlocks: 0, shellCommands: 0, tools: {} },
        totalCount: 0,
      });
    }
    return true;
  }

  if (parts.length === 4 && parts[3] === "pipeline-events" && req.method === "GET") {
    const eventsPath = path.resolve(config.workRoot, run.id, "events.jsonl");
    try {
      const raw = await readFile(eventsPath, "utf8");
      const events = raw.trim().split("\n").filter(Boolean).map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      }).filter(Boolean);
      sendJson(res, 200, { runId: run.id, events });
    } catch {
      sendJson(res, 200, { runId: run.id, events: [] });
    }
    return true;
  }

  if (parts.length >= 5 && parts[3] === "artifacts" && req.method === "GET") {
    const filename = parts.slice(4).join("/");
    if (filename.includes("\\") || filename.includes("..") || filename.startsWith(".") || filename.startsWith("/")) {
      sendJson(res, 400, { error: "Invalid filename" });
      return true;
    }

    const allowedExtensions = new Set([".png", ".jpg", ".jpeg", ".json", ".txt", ".log", ".zip", ".html", ".mp4", ".webm"]);
    const ext = path.extname(filename).toLowerCase();
    if (!allowedExtensions.has(ext)) {
      sendJson(res, 400, { error: `File type not allowed: ${ext}` });
      return true;
    }

    const filePath = path.resolve(config.workRoot, run.id, filename);
    const runDir = path.resolve(config.workRoot, run.id);
    if (!filePath.startsWith(runDir + path.sep) && filePath !== runDir) {
      sendJson(res, 400, { error: "Invalid filename" });
      return true;
    }

    try {
      await fsAccess(filePath);
    } catch {
      sendJson(res, 404, { error: `Artifact not found: ${filename}` });
      return true;
    }

    const contentTypes: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".json": "application/json",
      ".txt": "text/plain",
      ".log": "text/plain",
      ".zip": "application/zip",
      ".html": "text/html",
      ".mp4": "video/mp4",
      ".webm": "video/webm",
    };

    const contentType = contentTypes[ext] ?? "application/octet-stream";
    const fileData = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": String(fileData.length),
      "Cache-Control": "public, max-age=3600",
    });
    res.end(fileData);
    return true;
  }

  if (parts.length === 4 && parts[3] === "media" && req.method === "GET") {
    const { readdir, stat } = await import("node:fs/promises");
    const runDir = path.resolve(config.workRoot, run.id);
    const screenshots: Array<{ name: string; path: string; size: number }> = [];
    let video: { name: string; path: string; size: number } | undefined;

    try {
      const screenshotsDir = path.join(runDir, "screenshots");
      const files = await readdir(screenshotsDir);
      for (const file of files) {
        if (!file.endsWith(".png") && !file.endsWith(".jpg")) continue;
        const stats = await stat(path.join(screenshotsDir, file));
        if (stats.size > 1_000) {
          screenshots.push({
            name: file,
            path: `screenshots/${file}`,
            size: stats.size,
          });
        }
      }
      screenshots.sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      // No screenshots directory.
    }

    try {
      const rootFiles = await readdir(runDir);
      const videoFile = rootFiles.find((file) => file.endsWith(".mp4")) ?? rootFiles.find((file) => file.endsWith(".webm"));
      if (videoFile) {
        const stats = await stat(path.join(runDir, videoFile));
        if (stats.size > 1_000) {
          video = { name: videoFile, path: videoFile, size: stats.size };
        }
      }
    } catch {
      // Root scan failed.
    }

    let consoleLogs: unknown[] | undefined;
    let networkLog: unknown[] | undefined;
    let agentActions: unknown[] | undefined;
    try {
      const consoleFile = path.join(runDir, "console-logs.json");
      const consoleData = await readFile(consoleFile, "utf-8");
      consoleLogs = JSON.parse(consoleData);
    } catch {
      // No console logs.
    }
    try {
      const networkFile = path.join(runDir, "network-log.json");
      const networkData = await readFile(networkFile, "utf-8");
      networkLog = JSON.parse(networkData);
    } catch {
      // No network log.
    }
    try {
      const actionsFile = path.join(runDir, "agent-actions.json");
      const actionsData = await readFile(actionsFile, "utf-8");
      agentActions = JSON.parse(actionsData);
    } catch {
      // No agent actions.
    }

    sendJson(res, 200, { runId: run.id, screenshots, video, consoleLogs, networkLog, agentActions });
    return true;
  }

  if (parts.length === 4 && parts[3] === "feedback" && req.method === "POST") {
    const raw = await readBody(req);
    if (raw === null) {
      sendJson(res, 413, { error: "Request body too large" });
      return true;
    }
    let parsed: { rating?: string; note?: string; by?: string } = {};
    try {
      parsed = JSON.parse(raw) as { rating?: string; note?: string; by?: string };
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return true;
    }

    if (parsed.rating !== "up" && parsed.rating !== "down") {
      sendJson(res, 400, { error: "rating must be one of: up, down" });
      return true;
    }

    const note = parsed.note?.trim().slice(0, 1000) || undefined;
    const by = parsed.by?.trim().slice(0, 120) || "dashboard";

    if (runManager?.saveFeedbackFromSlackAction) {
      const updated = await runManager.saveFeedbackFromSlackAction({
        runId: run.id,
        rating: parsed.rating,
        userId: by,
        note,
      });
      sendJson(res, 200, { ok: true, run: updated ?? run });
    } else {
      const feedback: RunFeedback = {
        rating: parsed.rating,
        note,
        by,
        at: new Date().toISOString(),
      };
      const updated = await store.saveFeedback(run.id, feedback);
      sendJson(res, 200, { ok: true, run: updated });
    }
    return true;
  }

  if (parts.length === 4 && parts[3] === "retry" && req.method === "POST") {
    if (!runManager) {
      sendJson(res, 501, { error: "Retry is unavailable: run manager not attached." });
      return true;
    }
    if (run.status !== "completed" && run.status !== "failed") {
      sendJson(res, 400, { error: "Can only retry completed or failed runs" });
      return true;
    }

    const raw = await readBody(req);
    if (raw === null) {
      sendJson(res, 413, { error: "Request body too large" });
      return true;
    }
    let parsed: { by?: string } = {};
    try {
      parsed = raw ? JSON.parse(raw) as { by?: string } : {};
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return true;
    }

    const requestedBy = parsed.by?.trim().slice(0, 120) || "dashboard";
    const retried = await runManager.retryRun(run.id, requestedBy);
    if (!retried) {
      sendJson(res, 404, { error: `Run not found: ${run.id}` });
      return true;
    }

    sendJson(res, 200, { ok: true, run: retried });
    return true;
  }

  if (parts.length === 4 && parts[3] === "cancel" && req.method === "POST") {
    if (!runManager) {
      sendJson(res, 501, { error: "Cancel is unavailable: run manager not attached." });
      return true;
    }
    if (!["running", "queued", "validating", "pushing", "awaiting_ci", "ci_fixing"].includes(run.status)) {
      sendJson(res, 400, { error: "Can only cancel in-progress runs" });
      return true;
    }
    const cancelled = await runManager.cancelRun(run.id);
    sendJson(res, 200, { ok: true, cancelled });
    return true;
  }

  if (parts.length === 4 && parts[3] === "continue" && req.method === "POST") {
    if (!runManager?.continueRun) {
      sendJson(res, 501, { error: "Continue is unavailable: run manager not attached." });
      return true;
    }
    if (run.status !== "completed" && run.status !== "failed") {
      sendJson(res, 400, { error: "Can only continue completed or failed runs" });
      return true;
    }

    const raw = await readBody(req);
    if (raw === null) {
      sendJson(res, 413, { error: "Request body too large" });
      return true;
    }
    let parsed: { feedbackNote?: string; by?: string } = {};
    try {
      parsed = raw ? JSON.parse(raw) as { feedbackNote?: string; by?: string } : {};
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return true;
    }
    if (!parsed.feedbackNote?.trim()) {
      sendJson(res, 400, { error: "feedbackNote is required" });
      return true;
    }

    const requestedBy = parsed.by?.trim().slice(0, 120) || "dashboard";
    const continued = await runManager.continueRun(run.id, parsed.feedbackNote.trim(), requestedBy);
    if (!continued) {
      sendJson(res, 404, { error: `Run not found: ${run.id}` });
      return true;
    }

    sendJson(res, 200, { ok: true, run: continued });
    return true;
  }

  if (parts.length === 4 && parts[3] === "chain" && req.method === "GET") {
    const chain = runManager?.getRunChain
      ? await runManager.getRunChain(run.channelId, run.threadTs)
      : [run];
    sendJson(res, 200, { chain });
    return true;
  }

  if (parts.length === 4 && parts[3] === "conversation" && req.method === "GET") {
    const threadKey = `${run.channelId}:${run.threadTs}`;
    const messages = (await conversationSource?.get(threadKey)) ?? [];
    sendJson(res, 200, {
      threadKey,
      available: Boolean(conversationSource),
      messages: buildConversationPreview(messages),
    });
    return true;
  }

  return false;
}

interface ConversationPreviewMessage {
  role: "user" | "assistant";
  content: string;
}

interface FileChangeDetail {
  additions: number;
  deletions: number;
  path: string;
  status: "A" | "M" | "D" | "R" | "?";
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
      content: truncateText(text, 2000),
    });
  }
  return preview;
}

async function captureCommand(command: string, cwd: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
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
    return filterInternalGeneratedFiles(run.changedFiles);
  }

  if (!run.commitSha) {
    return [];
  }

  const repoDir = path.resolve(config.workRoot, run.id, "repo");
  const result = await captureCommand("git show --name-only --pretty='' HEAD", repoDir);
  if (result.code !== 0) {
    return [];
  }

  return filterInternalGeneratedFiles(
    result.stdout
      .split("\n")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0 && !entry.startsWith("---")),
  );
}

async function getChangedFilesDetailed(config: AppConfig, run: RunRecord): Promise<FileChangeDetail[]> {
  if (!run.commitSha) {
    return [];
  }

  const repoDir = path.resolve(config.workRoot, run.id, "repo");
  const numstat = await captureCommand("git diff --numstat HEAD~1 HEAD 2>/dev/null", repoDir);
  const nameStatus = await captureCommand("git diff --name-status HEAD~1 HEAD 2>/dev/null", repoDir);

  if (numstat.code !== 0 || nameStatus.code !== 0) {
    const files = await getChangedFiles(config, run);
    return files.map((file) => ({ path: file, status: "?" as const, additions: 0, deletions: 0 }));
  }

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

  return results.filter((result) => filterInternalGeneratedFiles([result.path]).length > 0);
}
