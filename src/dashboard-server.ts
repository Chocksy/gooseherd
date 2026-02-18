import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { logError, logInfo } from "./logger.js";
import { RunStore } from "./store.js";
import type { RunManager } from "./run-manager.js";
import type { RunFeedback, RunRecord } from "./types.js";
import { parseRunLog, getEventStats } from "./log-parser.js";

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

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readLogTail(logPath: string, lineCount: number): Promise<string> {
  const content = await readFile(logPath, "utf8");
  const lines = content.split("\n");
  return lines.slice(-Math.max(1, lineCount)).join("\n");
}

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

function dashboardHtml(config: AppConfig): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${config.appName} Runs</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link
    href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
    rel="stylesheet"
  />
  <link
    href="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,500,0,0"
    rel="stylesheet"
  />
  <style>
    :root {
      --font-ui: "Space Grotesk", "Avenir Next", "Segoe UI", sans-serif;
      --font-mono: "IBM Plex Mono", "SF Mono", "JetBrains Mono", monospace;
      --ok: #22c55e;
      --warn: #f59e0b;
      --err: #ef4444;
      --running: #38bdf8;
      --ring: #60a5fa;
      --radius: 12px;
    }
    html[data-theme="dark"] {
      --bg: #060a14;
      --bg-gradient: radial-gradient(circle at top right, #18233f, #060a14 58%);
      --panel: #0f172a;
      --panel-2: #111d34;
      --panel-3: #0a1325;
      --text: #e2e8f0;
      --muted: #94a3b8;
      --ok: #22c55e;
      --warn: #f59e0b;
      --err: #ef4444;
      --running: #38bdf8;
      --border: #22314f;
      --border-strong: #2f4672;
      --shadow: 0 14px 36px rgba(1, 6, 18, 0.55);
      --button-bg: #0b1220;
      --button-bg-hover: #111b2d;
      --button-danger-bg: #301218;
      --button-danger-hover: #421821;
      --badge-bg: #121e37;
      --badge-text: #bfdbfe;
    }
    html[data-theme="light"] {
      --bg: #f7fafc;
      --bg-gradient: radial-gradient(circle at top right, #dbe7f7, #f7fafc 60%);
      --panel: #ffffff;
      --panel-2: #f4f8ff;
      --panel-3: #f8fbff;
      --text: #0f172a;
      --muted: #475569;
      --border: #c8d5ea;
      --border-strong: #9db7dc;
      --shadow: 0 10px 24px rgba(15, 23, 42, 0.12);
      --button-bg: #f8fbff;
      --button-bg-hover: #eef5ff;
      --button-danger-bg: #fee2e2;
      --button-danger-hover: #fecaca;
      --badge-bg: #e7f0ff;
      --badge-text: #1d4ed8;
    }
    * { box-sizing: border-box; }
    /* Thin scrollbars — Moltis style */
    ::-webkit-scrollbar { width: 5px; height: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,0.12);
      border-radius: 4px;
    }
    ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.22); }
    * { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.12) transparent; }
    body {
      margin: 0;
      font-family: var(--font-ui);
      background: var(--bg-gradient);
      color: var(--text);
      overflow: hidden;
    }
    .app {
      height: 100vh;
      display: grid;
      grid-template-columns: 340px 1fr;
      grid-template-rows: 64px 1fr;
      grid-template-areas:
        "top top"
        "sidebar main";
      gap: 0;
    }
    .topbar {
      grid-area: top;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      background: color-mix(in srgb, var(--panel) 90%, transparent);
      backdrop-filter: blur(10px);
      box-shadow: var(--shadow);
      z-index: 10;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }
    .brand-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--ok);
      box-shadow: 0 0 14px color-mix(in srgb, var(--ok) 45%, transparent);
      flex-shrink: 0;
    }
    .brand h1 {
      font-size: 16px;
      margin: 0;
      line-height: 1.1;
      letter-spacing: 0.2px;
    }
    .brand p {
      margin: 2px 0 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.2;
    }
    .top-controls {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .top-meta {
      color: var(--muted);
      font-size: 13px;
      margin-right: 2px;
      white-space: nowrap;
    }
    .material-symbols-rounded {
      font-variation-settings:
        "FILL" 0,
        "wght" 500,
        "GRAD" 0,
        "opsz" 24;
      font-size: 18px;
      line-height: 1;
    }
    .theme-switch {
      display: flex;
      border: 1px solid var(--border);
      background: var(--panel-3);
      border-radius: 999px;
      padding: 2px;
      gap: 2px;
    }
    .theme-btn {
      border: 0;
      background: transparent;
      color: var(--muted);
      border-radius: 999px;
      width: 34px;
      height: 30px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .theme-btn.active {
      color: var(--text);
      background: var(--panel-2);
      border: 1px solid var(--border);
    }
    .top-btn {
      border: 1px solid var(--border);
      background: var(--button-bg);
      color: var(--text);
      border-radius: 8px;
      padding: 6px 10px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      text-decoration: none;
      font-family: var(--font-ui);
    }
    .top-btn:hover {
      background: var(--button-bg-hover);
    }
    .top-btn .material-symbols-rounded {
      font-size: 17px;
    }
    .top-btn.danger {
      background: var(--button-danger-bg);
      border-color: color-mix(in srgb, var(--err) 25%, var(--border));
      color: color-mix(in srgb, var(--err) 75%, var(--text));
      min-width: 42px;
      justify-content: center;
    }
    .top-btn.danger:hover {
      background: var(--button-danger-hover);
    }
    .sidebar {
      grid-area: sidebar;
      border-right: 1px solid var(--border);
      background: color-mix(in srgb, var(--panel) 88%, transparent);
      padding: 14px;
      overflow-y: auto;
    }
    .main {
      grid-area: main;
      padding: 16px;
      overflow-y: auto;
    }
    .stack {
      display: grid;
      gap: 12px;
      min-width: 0;
      width: 100%;
      max-width: none;
    }
    .stack-top {
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
    }
    .sidebar-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      margin-bottom: 10px;
      gap: 8px;
    }
    .sidebar-title {
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.09em;
      font-weight: 700;
      color: var(--muted);
    }
    .meta {
      color: var(--muted);
      font-size: 12px;
    }
    .run-item {
      width: 100%;
      border: 1px solid var(--border);
      background: var(--panel-3);
      color: var(--text);
      border-radius: 10px;
      padding: 10px;
      margin-bottom: 10px;
      text-align: left;
      cursor: pointer;
      transition: border-color 120ms ease, transform 120ms ease, background 120ms ease;
    }
    .run-item:hover {
      transform: translateY(-1px);
      border-color: var(--border-strong);
    }
    .run-item.active {
      border-color: var(--ring);
      background: var(--panel-2);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--ring) 20%, transparent);
    }
    .run-item-top {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: flex-start;
    }
    .run-item-task {
      font-weight: 600;
      font-size: 13px;
      line-height: 1.35;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      word-break: break-word;
      flex: 1;
      min-width: 0;
    }
    .run-item-meta {
      color: var(--muted);
      font-size: 12px;
      margin-top: 6px;
      line-height: 1.35;
      display: flex;
      align-items: center;
      flex-wrap: wrap;
    }
    .run-item-meta .sep {
      margin: 0 5px;
      opacity: 0.5;
    }
    .status-pill {
      font-size: 11px;
      font-weight: 700;
      border-radius: 999px;
      padding: 2px 8px;
      border: 1px solid var(--border);
      background: var(--badge-bg);
      color: var(--badge-text);
      text-transform: lowercase;
      letter-spacing: 0.02em;
      line-height: 1.2;
    }
    .status-pill.completed {
      background: color-mix(in srgb, var(--ok) 20%, transparent);
      border-color: color-mix(in srgb, var(--ok) 42%, var(--border));
      color: color-mix(in srgb, var(--ok) 80%, var(--text));
    }
    .status-pill.failed {
      background: color-mix(in srgb, var(--err) 18%, transparent);
      border-color: color-mix(in srgb, var(--err) 40%, var(--border));
      color: color-mix(in srgb, var(--err) 82%, var(--text));
    }
    .status-pill.running,
    .status-pill.validating,
    .status-pill.pushing,
    .status-pill.queued {
      background: color-mix(in srgb, var(--running) 18%, transparent);
      border-color: color-mix(in srgb, var(--running) 40%, var(--border));
      color: color-mix(in srgb, var(--running) 80%, var(--text));
    }
    .card {
      border: 1px solid var(--border);
      background: color-mix(in srgb, var(--panel) 92%, transparent);
      border-radius: var(--radius);
      padding: 12px;
      box-shadow: var(--shadow);
    }
    .toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      margin-bottom: 10px;
    }
    .summary-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .summary-actions .action-btn {
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding-inline: 9px;
    }
    .summary-actions .action-btn .material-symbols-rounded {
      font-size: 16px;
    }
    .card-title {
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 0.01em;
    }
    .card-subtitle {
      margin-top: 3px;
      color: var(--muted);
      font-size: 12px;
    }
    .mono {
      white-space: pre-wrap;
      font-size: 12px;
      line-height: 1.45;
      background: color-mix(in srgb, var(--panel-3) 86%, transparent);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px;
      max-height: 440px;
      overflow: auto;
      font-family: var(--font-mono);
    }
    .file-list {
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      margin: 0;
      color: var(--text);
      font-family: var(--font-mono);
    }
    .action-btn {
      padding: 7px 10px;
      border: 1px solid var(--border);
      background: var(--button-bg);
      color: var(--text);
      border-radius: 7px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
    }
    .action-btn:hover {
      background: var(--button-bg-hover);
    }
    .action-btn:disabled {
      cursor: not-allowed;
      opacity: 0.45;
    }
    .feedback-toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: var(--panel-2);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 12px 20px;
      display: none;
      align-items: center;
      gap: 14px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.18);
      z-index: 20;
    }
    .feedback-toast.visible { display: flex; }
    .feedback-toast .fb-text {
      font-size: 14px;
      color: var(--text);
      white-space: nowrap;
    }
    .feedback-toast .fb-btn {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 24px;
      padding: 2px;
      opacity: 0.7;
      transition: opacity 0.15s, transform 0.15s;
    }
    .feedback-toast .fb-btn:hover {
      opacity: 1;
      transform: scale(1.2);
    }
    .feedback-toast .fb-btn.selected {
      opacity: 1;
      transform: scale(1.15);
    }
    .feedback-toast .fb-done {
      font-size: 13px;
      color: var(--muted);
    }
    textarea {
      width: 100%;
      min-height: 70px;
      margin-top: 8px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: color-mix(in srgb, var(--panel-3) 86%, transparent);
      color: var(--text);
      padding: 8px;
      font-family: var(--font-mono);
      font-size: 12px;
    }
    a { color: color-mix(in srgb, var(--running) 85%, var(--text)); }
    .summary-empty {
      color: var(--muted);
      font-size: 13px;
    }
    .summary-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 10px;
      padding-bottom: 10px;
      border-bottom: 1px dashed var(--border);
    }
    .summary-title {
      font-size: 15px;
      font-weight: 700;
      line-height: 1.4;
      word-break: break-word;
      flex: 1;
      min-width: 0;
    }
    .summary-meta-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .meta-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 10px;
      border: 1px solid var(--border);
      border-radius: 999px;
      font-family: var(--font-mono);
      font-size: 12px;
      background: var(--panel-3);
      white-space: nowrap;
      max-width: 260px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .meta-chip .material-symbols-rounded {
      font-size: 14px;
      color: var(--muted);
      flex-shrink: 0;
    }
    .meta-chip-text {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .summary-timing {
      font-size: 11px;
      color: var(--muted);
      margin-top: 8px;
      line-height: 1.4;
    }
    .summary-timing .sep {
      margin: 0 4px;
      opacity: 0.5;
    }
    .summary-error {
      margin-top: 10px;
      border: 1px solid color-mix(in srgb, var(--err) 45%, var(--border));
      background: color-mix(in srgb, var(--err) 12%, var(--panel));
      border-radius: 8px;
      padding: 8px;
      font-size: 12px;
      line-height: 1.4;
    }
    .file-item {
      padding: 2px 0;
      border-bottom: 1px dashed color-mix(in srgb, var(--border) 70%, transparent);
    }
    .file-item:last-child {
      border-bottom: 0;
    }
    .file-row {
      display: grid;
      grid-template-columns: 18px 1fr;
      gap: 8px;
      align-items: start;
      padding: 6px 0;
      border-bottom: 1px dashed color-mix(in srgb, var(--border) 70%, transparent);
    }
    .file-row:last-child {
      border-bottom: 0;
    }
    .file-icon {
      color: var(--muted);
      font-size: 15px;
      transform: translateY(1px);
    }
    .file-name {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text);
      line-height: 1.35;
      word-break: break-word;
    }
    .file-path {
      margin-top: 2px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.3;
      word-break: break-word;
    }
    .chat-history {
      max-height: 300px;
      overflow-y: auto;
      margin-bottom: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .chat-msg {
      padding: 8px 10px;
      border-radius: 8px;
      font-size: 12px;
      line-height: 1.5;
      word-break: break-word;
    }
    .chat-msg.human {
      background: color-mix(in srgb, var(--acc) 12%, var(--panel-3));
      border: 1px solid color-mix(in srgb, var(--acc) 30%, var(--border));
      align-self: flex-end;
      max-width: 85%;
    }
    .chat-msg.agent {
      background: var(--panel-3);
      border: 1px solid var(--border);
      align-self: flex-start;
      max-width: 85%;
    }
    .chat-msg .chat-sender {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 2px;
      opacity: 0.6;
    }
    .chat-msg .chat-time {
      font-size: 10px;
      opacity: 0.5;
      margin-top: 4px;
    }
    .chat-input-area {
      display: flex;
      gap: 8px;
      align-items: flex-end;
    }
    .chat-input-area textarea {
      flex: 1;
      font-family: inherit;
      font-size: 12px;
      padding: 8px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--panel-2);
      color: var(--text);
      resize: vertical;
      min-height: 36px;
    }
    .chat-send {
      flex-shrink: 0;
    }
    /* ── Activity stream ────────────────────────── */
    .activity-stream {
      max-height: 600px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 6px;
      scroll-behavior: smooth;
    }
    .act-event {
      border-radius: 8px;
      padding: 8px 10px;
      font-size: 12px;
      line-height: 1.5;
      position: relative;
    }
    .act-thinking {
      background: color-mix(in srgb, var(--warn) 10%, var(--panel-3));
      border: 1px solid color-mix(in srgb, var(--warn) 22%, var(--border));
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--text);
    }
    .act-thinking::before {
      content: 'Agent';
      display: inline-block;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: color-mix(in srgb, var(--warn) 85%, var(--text));
      margin-right: 8px;
      vertical-align: middle;
    }
    .act-tool {
      background: var(--panel-3);
      border: 1px solid var(--border);
    }
    .act-tool-header {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      user-select: none;
    }
    .act-tool-header:hover { opacity: 0.85; }
    .act-tool-icon {
      font-size: 16px;
      color: var(--running);
      flex-shrink: 0;
    }
    .act-tool-name {
      font-weight: 700;
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text);
    }
    .act-tool-desc {
      color: var(--muted);
      font-size: 11px;
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .act-tool-chevron {
      font-size: 18px;
      color: var(--muted);
      transition: transform 180ms ease;
      flex-shrink: 0;
    }
    .act-tool.open .act-tool-chevron { transform: rotate(90deg); }
    .act-tool-body {
      display: none;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px dashed color-mix(in srgb, var(--border) 70%, transparent);
    }
    .act-tool.open .act-tool-body { display: block; }
    .act-tool-params {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 2px 10px;
      font-family: var(--font-mono);
      font-size: 11px;
      margin-bottom: 6px;
    }
    .act-tool-params .pk { color: var(--muted); font-weight: 600; }
    .act-tool-params .pv { word-break: break-all; }
    .act-tool-output {
      white-space: pre-wrap;
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--muted);
      max-height: 200px;
      overflow-y: auto;
      background: color-mix(in srgb, var(--panel) 60%, transparent);
      border-radius: 6px;
      padding: 6px 8px;
    }
    .act-phase {
      background: color-mix(in srgb, var(--running) 10%, var(--panel-3));
      border: 1px solid color-mix(in srgb, var(--running) 20%, var(--border));
      font-weight: 600;
      letter-spacing: 0.02em;
      font-size: 11px;
      color: color-mix(in srgb, var(--running) 80%, var(--text));
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .act-phase .material-symbols-rounded { font-size: 16px; }
    .act-session {
      background: color-mix(in srgb, var(--ok) 8%, var(--panel-3));
      border: 1px solid color-mix(in srgb, var(--ok) 20%, var(--border));
      color: color-mix(in srgb, var(--ok) 80%, var(--text));
      font-size: 11px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .act-session .material-symbols-rounded { font-size: 16px; }
    .act-info {
      color: var(--muted);
      font-size: 11px;
      font-family: var(--font-mono);
      padding: 4px 10px;
    }
    .act-badge {
      position: absolute;
      top: 6px;
      right: 8px;
      font-size: 10px;
      font-weight: 700;
      color: var(--muted);
      background: color-mix(in srgb, var(--panel) 80%, transparent);
      border-radius: 4px;
      padding: 1px 5px;
      font-family: var(--font-mono);
    }
    .act-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 8px;
      font-size: 11px;
      color: var(--muted);
    }
    .act-footer label {
      display: flex;
      align-items: center;
      gap: 5px;
      cursor: pointer;
    }
    .act-footer input[type="checkbox"] {
      accent-color: var(--running);
    }
    .act-stats {
      display: flex;
      gap: 10px;
    }
    .act-stat { font-family: var(--font-mono); }
    /* ── Enhanced file list ─────────────────────── */
    .file-badge {
      display: inline-block;
      width: 18px;
      text-align: center;
      font-size: 10px;
      font-weight: 700;
      border-radius: 4px;
      padding: 1px 0;
      font-family: var(--font-mono);
      flex-shrink: 0;
    }
    .file-badge.A {
      background: color-mix(in srgb, var(--ok) 20%, transparent);
      color: color-mix(in srgb, var(--ok) 80%, var(--text));
      border: 1px solid color-mix(in srgb, var(--ok) 35%, var(--border));
    }
    .file-badge.M {
      background: color-mix(in srgb, var(--warn) 18%, transparent);
      color: color-mix(in srgb, var(--warn) 80%, var(--text));
      border: 1px solid color-mix(in srgb, var(--warn) 35%, var(--border));
    }
    .file-badge.D {
      background: color-mix(in srgb, var(--err) 18%, transparent);
      color: color-mix(in srgb, var(--err) 80%, var(--text));
      border: 1px solid color-mix(in srgb, var(--err) 35%, var(--border));
    }
    .file-badge.R {
      background: color-mix(in srgb, var(--running) 18%, transparent);
      color: color-mix(in srgb, var(--running) 80%, var(--text));
      border: 1px solid color-mix(in srgb, var(--running) 35%, var(--border));
    }
    .file-stat {
      font-family: var(--font-mono);
      font-size: 11px;
      flex-shrink: 0;
      white-space: nowrap;
    }
    .file-stat-add { color: color-mix(in srgb, var(--ok) 80%, var(--text)); }
    .file-stat-del { color: color-mix(in srgb, var(--err) 80%, var(--text)); }
    .file-row-enhanced {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 0;
      border-bottom: 1px dashed color-mix(in srgb, var(--border) 70%, transparent);
    }
    .file-row-enhanced:last-child { border-bottom: 0; }
    .file-row-enhanced .file-info {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--font-mono);
      font-size: 12px;
    }
    @media (max-width: 1160px) {
      .app {
        grid-template-columns: 1fr;
        grid-template-rows: 64px 240px 1fr;
        grid-template-areas:
          "top"
          "sidebar"
          "main";
      }
      .sidebar {
        border-right: 0;
        border-bottom: 1px solid var(--border);
      }
    }
    @media (max-width: 700px) {
      .topbar {
        padding: 8px 10px;
      }
      .brand p {
        display: none;
      }
      .theme-btn {
        padding: 5px 8px;
      }
      .top-btn {
        padding: 6px 8px;
      }
      .main {
        padding: 10px;
      }
    }
  </style>
</head>
<body>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <span class="brand-dot"></span>
        <div>
          <h1>${config.appName} Dashboard</h1>
          <p>Run inspector and operator feedback</p>
        </div>
      </div>
      <div class="top-controls">
        <div class="top-meta" id="top-meta">0 runs</div>
        <button class="top-btn" id="settings-btn">
          <span class="material-symbols-rounded">settings</span>
          <span>Settings</span>
        </button>
        <a class="top-btn" id="report-btn" href="https://github.com/new" target="_blank" rel="noreferrer noopener">
          <span class="material-symbols-rounded">link</span>
          <span>Report issue</span>
        </a>
        <div class="theme-switch" id="theme-switch">
          <button class="theme-btn" data-theme-val="light" title="Light mode">
            <span class="material-symbols-rounded">light_mode</span>
          </button>
          <button class="theme-btn" data-theme-val="system" title="System mode">
            <span class="material-symbols-rounded">desktop_windows</span>
          </button>
          <button class="theme-btn" data-theme-val="dark" title="Dark mode">
            <span class="material-symbols-rounded">dark_mode</span>
          </button>
        </div>
        <button class="top-btn danger" id="logout-btn" title="Logout">
          <span class="material-symbols-rounded">power_settings_new</span>
        </button>
      </div>
    </header>
    <aside class="sidebar">
      <div class="sidebar-head">
        <div class="sidebar-title">Runs</div>
        <div class="meta" id="meta">Loading...</div>
      </div>
      <div id="runs"></div>
    </aside>
    <main class="main">
      <div class="stack">
        <div class="stack-top">
          <div class="card">
            <div class="toolbar">
              <div>
                <div class="card-title">Run summary</div>
                <div class="card-subtitle" id="summary-subtitle">Select a run from the left panel.</div>
              </div>
              <div class="summary-actions">
                <a class="action-btn" id="open-branch" href="#" target="_blank" rel="noreferrer noopener">
                  <span class="material-symbols-rounded">account_tree</span>
                  <span>Branch</span>
                </a>
                <a class="action-btn" id="open-pr" href="#" target="_blank" rel="noreferrer noopener">
                  <span class="material-symbols-rounded">open_in_new</span>
                  <span>PR</span>
                </a>
                <a class="action-btn" id="open-commit" href="#" target="_blank" rel="noreferrer noopener">
                  <span class="material-symbols-rounded">commit</span>
                  <span>Commit</span>
                </a>
                <button class="action-btn" id="retry-run" disabled>
                  <span class="material-symbols-rounded">refresh</span>
                  <span>Retry</span>
                </button>
              </div>
            </div>
            <div id="summary" class="summary-empty">No run selected.</div>
          </div>
        </div>
        <div class="card">
          <div class="card-title" style="margin-bottom: 8px;">Changed files</div>
          <div class="file-list" id="files">-</div>
        </div>
        <div class="card">
          <div class="toolbar">
            <div class="card-title">Agent activity</div>
            <div class="act-stats" id="act-stats"></div>
          </div>
          <div class="activity-stream" id="activity-stream">
            <div class="act-info">Select a run to see agent activity.</div>
          </div>
          <div class="act-footer">
            <label>
              <input type="checkbox" id="auto-scroll" checked />
              Auto-scroll
            </label>
            <span id="act-count" class="meta"></span>
          </div>
        </div>
        <div class="card" id="chat-card" style="display: none;">
          <div class="card-title" style="margin-bottom: 8px;">Follow-up instructions</div>
          <div class="chat-history" id="chat-history"></div>
          <div class="chat-input-area">
            <textarea id="chat-input" placeholder="Type follow-up instructions for the agent..." rows="2"></textarea>
            <button class="action-btn chat-send" id="chat-send" disabled>
              <span class="material-symbols-rounded">send</span>
              <span>Send</span>
            </button>
          </div>
          <div class="meta" id="chat-status"></div>
        </div>
      </div>
    </main>
  </div>

  <div class="feedback-toast" id="feedback-toast">
    <span class="fb-text">What did you think of this agent run?</span>
    <button class="fb-btn" id="feedback-down" title="Bad">👎</button>
    <button class="fb-btn" id="feedback-up" title="Good">👍</button>
  </div>

  <script>
    const state = {
      runs: [],
      selectedId: null,
      interval: null,
      themePreference: 'system',
    };

    const el = {
      meta: document.getElementById('meta'),
      topMeta: document.getElementById('top-meta'),
      runs: document.getElementById('runs'),
      summary: document.getElementById('summary'),
      summarySubtitle: document.getElementById('summary-subtitle'),
      retryRun: document.getElementById('retry-run'),
      openBranch: document.getElementById('open-branch'),
      openPr: document.getElementById('open-pr'),
      openCommit: document.getElementById('open-commit'),
      files: document.getElementById('files'),
      activityStream: document.getElementById('activity-stream'),
      actStats: document.getElementById('act-stats'),
      actCount: document.getElementById('act-count'),
      autoScroll: document.getElementById('auto-scroll'),
      feedbackToast: document.getElementById('feedback-toast'),
      feedbackUp: document.getElementById('feedback-up'),
      feedbackDown: document.getElementById('feedback-down'),
      chatCard: document.getElementById('chat-card'),
      chatHistory: document.getElementById('chat-history'),
      chatInput: document.getElementById('chat-input'),
      chatSend: document.getElementById('chat-send'),
      chatStatus: document.getElementById('chat-status'),
      themeSwitch: document.getElementById('theme-switch'),
      settingsBtn: document.getElementById('settings-btn'),
      reportBtn: document.getElementById('report-btn'),
      logoutBtn: document.getElementById('logout-btn'),
    };

    async function fetchJson(url, options) {
      const response = await fetch(url, options);
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || 'Request failed');
      }
      return response.json();
    }

    function shortId(id) {
      return id.slice(0, 8);
    }

    function branchRefForUrl(value) {
      return encodeURIComponent(value).replace(/%2F/g, '/');
    }

    function extractCommitSha(value) {
      if (!value) {
        return null;
      }
      const matches = String(value).match(/[0-9a-f]{7,40}/gi);
      if (!matches || matches.length === 0) {
        return null;
      }
      return matches[matches.length - 1];
    }

    function setLinkState(node, href) {
      if (!node) return;
      if (href) {
        node.href = href;
        node.style.pointerEvents = 'auto';
        node.style.opacity = '1';
        node.removeAttribute('aria-disabled');
      } else {
        node.href = '#';
        node.style.pointerEvents = 'none';
        node.style.opacity = '0.45';
        node.setAttribute('aria-disabled', 'true');
      }
    }

    function setReportIssueLink(run) {
      const fallback = 'https://github.com/new';
      if (!run || !run.repoSlug) {
        setLinkState(el.reportBtn, fallback);
        return;
      }
      setLinkState(el.reportBtn, 'https://github.com/' + run.repoSlug + '/issues/new');
    }

    function normalizeThemePreference(value) {
      if (value === 'light' || value === 'dark' || value === 'system') {
        return value;
      }
      return 'system';
    }

    function resolveTheme(preference) {
      if (preference === 'system') {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
      return preference;
    }

    function applyTheme(preference) {
      const normalized = normalizeThemePreference(preference);
      const resolved = resolveTheme(normalized);
      state.themePreference = normalized;
      document.documentElement.setAttribute('data-theme', resolved);

      if (el.themeSwitch) {
        const buttons = el.themeSwitch.querySelectorAll('[data-theme-val]');
        for (const button of buttons) {
          const value = button.getAttribute('data-theme-val');
          button.classList.toggle('active', value === normalized);
        }
      }
    }

    function initTheme() {
      const stored = normalizeThemePreference(localStorage.getItem('gooseherd.theme'));
      applyTheme(stored);

      if (el.themeSwitch) {
        const buttons = el.themeSwitch.querySelectorAll('[data-theme-val]');
        for (const button of buttons) {
          button.addEventListener('click', () => {
            const value = normalizeThemePreference(button.getAttribute('data-theme-val'));
            localStorage.setItem('gooseherd.theme', value);
            applyTheme(value);
          });
        }
      }

      const media = window.matchMedia('(prefers-color-scheme: dark)');
      media.addEventListener('change', () => {
        if (state.themePreference === 'system') {
          applyTheme('system');
        }
      });
    }

    function statusClass(status) {
      return 'status-pill ' + status;
    }

    function formatDate(value) {
      if (!value) {
        return '—';
      }
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        return value;
      }
      return date.toLocaleString();
    }

    function truncateCommit(sha) {
      return sha ? sha.slice(0, 12) : '—';
    }

    function timeAgo(dateString) {
      if (!dateString) return '—';
      var date = new Date(dateString);
      if (Number.isNaN(date.getTime())) return dateString;
      var now = Date.now();
      var diff = now - date.getTime();
      if (diff < 0) return 'just now';
      var seconds = Math.floor(diff / 1000);
      if (seconds < 60) return 'just now';
      var minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + 'm ago';
      var hours = Math.floor(minutes / 60);
      if (hours < 24) return hours + 'h ago';
      var days = Math.floor(hours / 24);
      if (days < 7) return days + 'd ago';
      var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return months[date.getMonth()] + ' ' + date.getDate();
    }

    function fullTimestamp(dateString) {
      if (!dateString) return '';
      var date = new Date(dateString);
      if (Number.isNaN(date.getTime())) return dateString;
      return date.toLocaleString();
    }

    function truncateTask(task, maxLen) {
      if (!task || !task.trim()) return '(no description)';
      if (task.length <= maxLen) return task;
      return task.slice(0, maxLen).trimEnd() + '\u2026';
    }

    function renderSummary(run) {
      if (!run) {
        el.summary.className = 'summary-empty';
        el.summary.textContent = 'No run selected.';
        el.summarySubtitle.textContent = 'Select a run from the left panel.';
        setLinkState(el.openBranch, null);
        setLinkState(el.openPr, null);
        setLinkState(el.openCommit, null);
        setReportIssueLink(null);
        return;
      }

      el.summary.className = '';
      el.summary.innerHTML = '';
      el.summarySubtitle.textContent = run.repoSlug;
      setReportIssueLink(run);

      var repoUrl = 'https://github.com/' + run.repoSlug;
      var branchUrl = repoUrl + '/tree/' + branchRefForUrl(run.branchName);
      var commitSha = extractCommitSha(run.commitSha);
      var commitUrl = commitSha ? (repoUrl + '/commit/' + commitSha) : null;

      setLinkState(el.openBranch, branchUrl);
      setLinkState(el.openPr, run.prUrl || null);
      setLinkState(el.openCommit, commitUrl);

      // Header: task title + status pill
      var head = document.createElement('div');
      head.className = 'summary-head';

      var titleNode = document.createElement('div');
      titleNode.className = 'summary-title';
      titleNode.textContent = truncateTask(run.task, 120);
      titleNode.title = run.task || '';

      var statusNode = document.createElement('span');
      statusNode.className = statusClass(run.status);
      statusNode.textContent = run.status;

      head.appendChild(titleNode);
      head.appendChild(statusNode);
      el.summary.appendChild(head);

      // Meta chips: branch, base, commit
      var metaRow = document.createElement('div');
      metaRow.className = 'summary-meta-row';

      function addChip(icon, text, tooltip) {
        var chip = document.createElement('span');
        chip.className = 'meta-chip';
        if (tooltip) chip.title = tooltip;
        var iconEl = document.createElement('span');
        iconEl.className = 'material-symbols-rounded';
        iconEl.textContent = icon;
        var textEl = document.createElement('span');
        textEl.className = 'meta-chip-text';
        textEl.textContent = text;
        chip.appendChild(iconEl);
        chip.appendChild(textEl);
        metaRow.appendChild(chip);
      }

      addChip('account_tree', run.branchName, run.branchName);
      addChip('merge_type', run.baseBranch, 'Base: ' + run.baseBranch);
      if (commitSha) {
        addChip('commit', truncateCommit(commitSha), commitSha);
      }

      el.summary.appendChild(metaRow);

      // Timing row
      var timing = document.createElement('div');
      timing.className = 'summary-timing';
      var timingParts = [];
      if (run.createdAt) {
        var tCreated = document.createElement('span');
        tCreated.title = fullTimestamp(run.createdAt);
        tCreated.textContent = 'Created ' + timeAgo(run.createdAt);
        timing.appendChild(tCreated);
        timingParts.push(true);
      }
      if (run.startedAt) {
        if (timingParts.length > 0) {
          var sep1 = document.createElement('span');
          sep1.className = 'sep';
          sep1.textContent = '\u00b7';
          timing.appendChild(sep1);
        }
        var tStarted = document.createElement('span');
        tStarted.title = fullTimestamp(run.startedAt);
        tStarted.textContent = 'Started ' + timeAgo(run.startedAt);
        timing.appendChild(tStarted);
        timingParts.push(true);
      }
      if (run.finishedAt) {
        if (timingParts.length > 0) {
          var sep2 = document.createElement('span');
          sep2.className = 'sep';
          sep2.textContent = '\u00b7';
          timing.appendChild(sep2);
        }
        var tFinished = document.createElement('span');
        tFinished.title = fullTimestamp(run.finishedAt);
        tFinished.textContent = 'Finished ' + timeAgo(run.finishedAt);
        timing.appendChild(tFinished);
      }
      el.summary.appendChild(timing);

      // Feedback
      if (run.feedback) {
        var fbRow = document.createElement('div');
        fbRow.className = 'summary-timing';
        fbRow.style.marginTop = '6px';
        var fbSpan = document.createElement('span');
        fbSpan.title = fullTimestamp(run.feedback.at);
        fbSpan.textContent = 'Feedback: ' + run.feedback.rating + (run.feedback.note ? ' \u2014 ' + run.feedback.note : '') + ' \u00b7 ' + timeAgo(run.feedback.at);
        fbRow.appendChild(fbSpan);
        el.summary.appendChild(fbRow);
      }

      if (run.error) {
        var error = document.createElement('div');
        error.className = 'summary-error';
        error.textContent = run.error;
        el.summary.appendChild(error);
      }
    }

    function renderFiles(files, detailed) {
      if ((!files || files.length === 0) && (!detailed || detailed.length === 0)) {
        el.files.textContent = '(none)';
        return;
      }
      el.files.innerHTML = '';

      const items = detailed && detailed.length > 0 ? detailed : (files || []).map(function(f) { return { path: f, status: '?', additions: 0, deletions: 0 }; });

      for (const item of items) {
        const row = document.createElement('div');
        row.className = 'file-row-enhanced';

        const badge = document.createElement('span');
        badge.className = 'file-badge ' + item.status;
        badge.textContent = item.status;
        row.appendChild(badge);

        const info = document.createElement('span');
        info.className = 'file-info';
        info.textContent = item.path;
        info.title = item.path;
        row.appendChild(info);

        if (item.additions > 0 || item.deletions > 0) {
          const stat = document.createElement('span');
          stat.className = 'file-stat';
          const parts = [];
          if (item.additions > 0) parts.push('<span class="file-stat-add">+' + item.additions + '</span>');
          if (item.deletions > 0) parts.push('<span class="file-stat-del">-' + item.deletions + '</span>');
          stat.innerHTML = parts.join(' ');
          row.appendChild(stat);
        }

        el.files.appendChild(row);
      }
    }

    function renderRuns() {
      el.runs.innerHTML = '';
      for (var i = 0; i < state.runs.length; i++) {
        var run = state.runs[i];
        var button = document.createElement('button');
        button.className = 'run-item' + (state.selectedId === run.id ? ' active' : '');
        button.onclick = (function(runId) {
          return function() {
            state.selectedId = runId;
            renderRuns();
            refreshSelected().catch(console.error);
          };
        })(run.id);

        var top = document.createElement('div');
        top.className = 'run-item-top';

        var taskNode = document.createElement('div');
        taskNode.className = 'run-item-task';
        taskNode.textContent = truncateTask(run.task, 80);
        taskNode.title = run.task || '';

        var statusNode = document.createElement('span');
        statusNode.className = statusClass(run.status);
        statusNode.textContent = run.status;

        top.appendChild(taskNode);
        top.appendChild(statusNode);

        var meta = document.createElement('div');
        meta.className = 'run-item-meta';

        var repoText = document.createElement('span');
        repoText.textContent = run.repoSlug + ' @ ' + run.baseBranch;
        meta.appendChild(repoText);

        var sep = document.createElement('span');
        sep.className = 'sep';
        sep.textContent = '\u00b7';
        meta.appendChild(sep);

        var timeNode = document.createElement('span');
        timeNode.textContent = timeAgo(run.createdAt);
        timeNode.title = fullTimestamp(run.createdAt);
        meta.appendChild(timeNode);

        button.appendChild(top);
        button.appendChild(meta);
        el.runs.appendChild(button);
      }
    }

    function toolIcon(toolName) {
      var icons = {
        text_editor: 'edit_note',
        shell: 'terminal',
        analyze: 'folder_open',
        todo_write: 'checklist',
        read_file: 'description',
        write_file: 'save',
        list_directory: 'folder',
        search: 'search',
      };
      return icons[toolName] || 'build';
    }

    function renderActivityStream(events, stats) {
      if (!events || events.length === 0) {
        el.activityStream.innerHTML = '<div class="act-info">No activity events parsed.</div>';
        el.actStats.innerHTML = '';
        el.actCount.textContent = '';
        return;
      }

      // Snapshot which expandable sections are open (by index) before rebuilding
      var openIndices = {};
      var oldNodes = el.activityStream.querySelectorAll('.act-event');
      for (var oi = 0; oi < oldNodes.length; oi++) {
        if (oldNodes[oi].classList.contains('open')) {
          openIndices[oi] = true;
        }
      }

      // Snapshot scroll position to detect if user scrolled away from bottom
      var stream = el.activityStream;
      var wasNearBottom = (stream.scrollHeight - stream.scrollTop - stream.clientHeight) < 60;

      el.activityStream.innerHTML = '';

      for (var idx = 0; idx < events.length; idx++) {
        var ev = events[idx];
        var node = document.createElement('div');
        node.className = 'act-event';

        if (ev.type === 'agent_thinking') {
          node.classList.add('act-thinking');
          node.textContent = ev.content;
          if (ev.progressPercent > 0) {
            var badge = document.createElement('span');
            badge.className = 'act-badge';
            badge.textContent = ev.progressPercent + '%';
            node.appendChild(badge);
          }
        } else if (ev.type === 'tool_call') {
          node.classList.add('act-tool');

          var header = document.createElement('div');
          header.className = 'act-tool-header';

          var icon = document.createElement('span');
          icon.className = 'material-symbols-rounded act-tool-icon';
          icon.textContent = toolIcon(ev.tool);

          var name = document.createElement('span');
          name.className = 'act-tool-name';
          name.textContent = ev.tool || 'tool';

          var desc = document.createElement('span');
          desc.className = 'act-tool-desc';
          var descText = '';
          if (ev.params && ev.params.path) descText = ev.params.path;
          else if (ev.params && ev.params.command) descText = ev.params.command;
          desc.textContent = descText;

          var chevron = document.createElement('span');
          chevron.className = 'material-symbols-rounded act-tool-chevron';
          chevron.textContent = 'chevron_right';

          header.appendChild(icon);
          header.appendChild(name);
          header.appendChild(desc);
          header.appendChild(chevron);

          var body = document.createElement('div');
          body.className = 'act-tool-body';

          if (ev.params && Object.keys(ev.params).length > 0) {
            var params = document.createElement('div');
            params.className = 'act-tool-params';
            var keys = Object.keys(ev.params);
            for (var ki = 0; ki < keys.length; ki++) {
              var pk = document.createElement('span');
              pk.className = 'pk';
              pk.textContent = keys[ki];
              var pv = document.createElement('span');
              pv.className = 'pv';
              pv.textContent = ev.params[keys[ki]];
              params.appendChild(pk);
              params.appendChild(pv);
            }
            body.appendChild(params);
          }

          var contentLines = ev.content.split('\\n');
          var firstLine = contentLines[0] || '';
          var rest = contentLines.slice(1).join('\\n').trim();
          if (rest) {
            var output = document.createElement('div');
            output.className = 'act-tool-output';
            output.textContent = rest;
            body.appendChild(output);
          }

          header.onclick = function(targetNode) {
            return function() {
              targetNode.classList.toggle('open');
            };
          }(node);

          node.appendChild(header);
          node.appendChild(body);

          if (ev.progressPercent > 0) {
            var tbadge = document.createElement('span');
            tbadge.className = 'act-badge';
            tbadge.textContent = ev.progressPercent + '%';
            node.appendChild(tbadge);
          }
        } else if (ev.type === 'phase_marker') {
          node.classList.add('act-phase');
          var phaseIcon = document.createElement('span');
          phaseIcon.className = 'material-symbols-rounded';
          phaseIcon.textContent = ev.phase === 'cloning' ? 'download' : ev.phase === 'agent' ? 'smart_toy' : ev.phase === 'committing' ? 'save' : ev.phase === 'pushing' ? 'cloud_upload' : 'flag';
          node.appendChild(phaseIcon);
          // Show clean phase labels instead of raw executor commands
          var phaseLabels = {
            cloning: 'Cloning repository',
            agent: 'Agent started',
            committing: 'Committing changes',
            pushing: 'Pushing to remote',
          };
          var phaseLabel = phaseLabels[ev.phase] || ev.phase || 'phase';
          var phaseText = document.createTextNode(phaseLabel);
          node.appendChild(phaseText);
        } else if (ev.type === 'session_start') {
          node.classList.add('act-session');
          var sessIcon = document.createElement('span');
          sessIcon.className = 'material-symbols-rounded';
          sessIcon.textContent = 'play_circle';
          node.appendChild(sessIcon);
          var sessText = document.createTextNode(ev.content);
          node.appendChild(sessText);
        } else if (ev.type === 'shell_cmd') {
          node.classList.add('act-tool');
          var shHeader = document.createElement('div');
          shHeader.className = 'act-tool-header';
          var shIcon = document.createElement('span');
          shIcon.className = 'material-symbols-rounded act-tool-icon';
          shIcon.textContent = 'terminal';
          var shName = document.createElement('span');
          shName.className = 'act-tool-name';
          shName.textContent = 'shell';
          var shDesc = document.createElement('span');
          shDesc.className = 'act-tool-desc';
          shDesc.textContent = ev.command || '';
          var shChevron = document.createElement('span');
          shChevron.className = 'material-symbols-rounded act-tool-chevron';
          shChevron.textContent = 'chevron_right';
          shHeader.appendChild(shIcon);
          shHeader.appendChild(shName);
          shHeader.appendChild(shDesc);
          shHeader.appendChild(shChevron);
          var shBody = document.createElement('div');
          shBody.className = 'act-tool-body';
          var shOutput = document.createElement('div');
          shOutput.className = 'act-tool-output';
          shOutput.textContent = ev.content;
          shBody.appendChild(shOutput);
          shHeader.onclick = function(targetNode) {
            return function() { targetNode.classList.toggle('open'); };
          }(node);
          node.appendChild(shHeader);
          node.appendChild(shBody);
        } else {
          node.classList.add('act-info');
          node.textContent = ev.content;
        }

        // Restore open state from before re-render
        if (openIndices[idx]) {
          node.classList.add('open');
        }

        el.activityStream.appendChild(node);
      }

      if (stats) {
        el.actStats.innerHTML = '';
        var statItems = [
          { label: 'tools', value: stats.toolCalls },
          { label: 'thinking', value: stats.thinkingBlocks },
          { label: 'cmds', value: stats.shellCommands },
        ];
        for (var si = 0; si < statItems.length; si++) {
          var s = document.createElement('span');
          s.className = 'act-stat meta';
          s.textContent = statItems[si].value + ' ' + statItems[si].label;
          el.actStats.appendChild(s);
        }
      }

      el.actCount.textContent = events.length + ' events';

      if (el.autoScroll.checked && wasNearBottom) {
        el.activityStream.scrollTop = el.activityStream.scrollHeight;
      }
    }

    async function loadRuns() {
      const data = await fetchJson('/api/runs?limit=200');
      state.runs = data.runs || [];
      el.meta.textContent = state.runs.length + ' runs';
      if (el.topMeta) {
        el.topMeta.textContent = state.runs.length + ' runs';
      }
      if (state.selectedId && !state.runs.some((run) => run.id === state.selectedId)) {
        state.selectedId = null;
      }
      if (!state.selectedId && state.runs.length > 0) {
        state.selectedId = state.runs[0].id;
      }
      renderRuns();
    }

    function canRetry(run) {
      return run.status === 'failed' || run.status === 'completed';
    }

    async function refreshSelected() {
      if (!state.selectedId) {
        el.retryRun.disabled = true;
        renderSummary(null);
        renderActivityStream(null, null);
        el.feedbackToast.classList.remove('visible');
        return;
      }
      const [runData, changesData, eventsData] = await Promise.all([
        fetchJson('/api/runs/' + encodeURIComponent(state.selectedId)),
        fetchJson('/api/runs/' + encodeURIComponent(state.selectedId) + '/changes'),
        fetchJson('/api/runs/' + encodeURIComponent(state.selectedId) + '/events').catch(function() { return { events: [], stats: null }; }),
      ]);

      const run = runData.run;
      el.retryRun.disabled = !canRetry(run);
      renderSummary(run);

      const files = (changesData.files || []).slice();
      const detailed = (changesData.detailed || []).slice();
      renderFiles(files, detailed);

      renderActivityStream(eventsData.events || [], eventsData.stats || null);

      // Show feedback toast for completed/failed runs without existing feedback
      var showToast = run && (run.status === 'completed' || run.status === 'failed') && !run.feedback;
      el.feedbackToast.classList.toggle('visible', showToast);
      el.feedbackUp.classList.toggle('selected', run.feedback && run.feedback.rating === 'up');
      el.feedbackDown.classList.toggle('selected', run.feedback && run.feedback.rating === 'down');

      await loadChatHistory();
    }

    async function saveFeedback(rating) {
      if (!state.selectedId) {
        return;
      }
      el.feedbackUp.classList.toggle('selected', rating === 'up');
      el.feedbackDown.classList.toggle('selected', rating === 'down');
      await fetchJson('/api/runs/' + encodeURIComponent(state.selectedId) + '/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rating }),
      });
      await refreshSelected();
    }

    async function retrySelected() {
      if (!state.selectedId) {
        return;
      }
      el.retryRun.disabled = true;
      try {
        await fetchJson('/api/runs/' + encodeURIComponent(state.selectedId) + '/retry', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ by: 'dashboard' }),
        });
        await refreshAll();
      } finally {
        await refreshSelected();
      }
    }

    el.feedbackUp.onclick = () => saveFeedback('up').catch(console.error);
    el.feedbackDown.onclick = () => saveFeedback('down').catch(console.error);
    el.retryRun.onclick = () => retrySelected().catch(console.error);
    el.settingsBtn.onclick = () => alert('Settings panel is not implemented yet.');
    el.logoutBtn.onclick = () => alert('Logout will be available when authentication is added.');

    // Chat / follow-up logic
    async function loadChatHistory() {
      if (!state.selectedId) {
        el.chatCard.style.display = 'none';
        return;
      }
      el.chatCard.style.display = '';
      try {
        var data = await fetchJson('/api/runs/' + encodeURIComponent(state.selectedId) + '/chain');
        var chain = data.chain || [];
        el.chatHistory.innerHTML = '';
        chain.forEach(function(run) {
          // Show the original task or follow-up instruction
          var isFollowUp = !!run.feedbackNote;
          var msgDiv = document.createElement('div');
          msgDiv.className = 'chat-msg human';
          var sender = document.createElement('div');
          sender.className = 'chat-sender';
          sender.textContent = isFollowUp ? 'Follow-up' : 'Original task';
          msgDiv.appendChild(sender);
          var content = document.createElement('div');
          content.textContent = run.feedbackNote || run.task;
          msgDiv.appendChild(content);
          var time = document.createElement('div');
          time.className = 'chat-time';
          time.textContent = formatDate(run.createdAt) + ' — ' + run.status;
          if (run.status === 'completed') time.textContent += ' ✅';
          if (run.status === 'failed') time.textContent += ' ❌';
          msgDiv.appendChild(time);
          el.chatHistory.appendChild(msgDiv);
          // Show agent result as a response bubble
          if (run.status === 'completed' || run.status === 'failed') {
            var agentDiv = document.createElement('div');
            agentDiv.className = 'chat-msg agent';
            var aSender = document.createElement('div');
            aSender.className = 'chat-sender';
            aSender.textContent = 'Agent';
            agentDiv.appendChild(aSender);
            var aContent = document.createElement('div');
            if (run.status === 'completed') {
              aContent.textContent = 'Completed. ' + (run.changedFiles ? run.changedFiles.length + ' files changed.' : '') + (run.prUrl ? ' PR: ' + run.prUrl : '');
            } else {
              aContent.textContent = 'Failed: ' + (run.error || 'unknown error');
            }
            agentDiv.appendChild(aContent);
            el.chatHistory.appendChild(agentDiv);
          } else if (run.status === 'running' || run.status === 'queued') {
            var workingDiv = document.createElement('div');
            workingDiv.className = 'chat-msg agent';
            workingDiv.innerHTML = '<div class="chat-sender">Agent</div><div>Working...</div>';
            el.chatHistory.appendChild(workingDiv);
          }
        });
        el.chatHistory.scrollTop = el.chatHistory.scrollHeight;
      } catch(e) {
        console.error('Failed to load chain', e);
      }
      // Enable/disable send based on run status
      var selectedRun = state.runs.find(function(r) { return r.id === state.selectedId; });
      var canContinue = selectedRun && (selectedRun.status === 'completed' || selectedRun.status === 'failed');
      el.chatSend.disabled = !canContinue;
      el.chatStatus.textContent = canContinue ? 'Ready for follow-up instructions.' : (selectedRun ? 'Waiting for run to finish...' : '');
    }

    async function sendFollowUp() {
      var note = el.chatInput.value.trim();
      if (!note || !state.selectedId) return;
      el.chatSend.disabled = true;
      el.chatStatus.textContent = 'Sending...';
      try {
        await fetchJson('/api/runs/' + encodeURIComponent(state.selectedId) + '/continue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ feedbackNote: note, by: 'dashboard' }),
        });
        el.chatInput.value = '';
        await refreshAll();
        await loadChatHistory();
      } catch(e) {
        el.chatStatus.textContent = 'Error: ' + (e.message || 'failed to send');
      }
    }

    el.chatSend.onclick = () => sendFollowUp().catch(console.error);
    el.chatInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendFollowUp().catch(console.error);
      }
    });

    async function refreshAll() {
      await loadRuns();
      await refreshSelected();
    }

    initTheme();
    refreshAll().catch(console.error);
    state.interval = setInterval(() => {
      refreshAll().catch(console.error);
    }, 5000);
  </script>
</body>
</html>`;
}

export function startDashboardServer(
  config: AppConfig,
  store: RunStore,
  runManager?: Pick<RunManager, "retryRun" | "continueRun" | "getRunChain" | "saveFeedbackFromSlackAction">
): void {
  const server = createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? "/", `http://${config.dashboardHost}:${String(config.dashboardPort)}`);
      const pathname = requestUrl.pathname;

      if (req.method === "GET" && pathname === "/") {
        sendText(res, 200, dashboardHtml(config), "text/html");
        return;
      }

      if (req.method === "GET" && pathname === "/healthz") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET" && pathname === "/api/runs") {
        const limit = parseLimit(requestUrl.searchParams.get("limit"));
        const runs = await store.listRuns(limit);
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
          const lineCount = parseLimit(requestUrl.searchParams.get("lines"));
          const logsPath = run.logsPath ?? path.resolve(config.workRoot, run.id, "run.log");
          try {
            const log = await readLogTail(logsPath, lineCount);
            sendJson(res, 200, { runId: run.id, lines: lineCount, log });
          } catch {
            sendJson(res, 200, { runId: run.id, lines: lineCount, log: "" });
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
          try {
            const rawLog = await readFile(logsPath, "utf8");
            const events = parseRunLog(rawLog);
            const stats = getEventStats(events);
            sendJson(res, 200, { runId: run.id, events, stats });
          } catch {
            sendJson(res, 200, { runId: run.id, events: [], stats: { totalEvents: 0, toolCalls: 0, thinkingBlocks: 0, shellCommands: 0, tools: {} } });
          }
          return;
        }

        if (parts.length === 4 && parts[3] === "feedback" && req.method === "POST") {
          const raw = await readBody(req);
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
