import type { AppConfig } from "../config.js";

/** Escape HTML special characters to prevent XSS */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function dashboardHtml(config: AppConfig): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(config.appName)} Runs</title>
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
    .app.board-mode {
      grid-template-columns: 1fr;
      grid-template-areas:
        "top"
        "main";
    }
    .app.board-mode .sidebar {
      display: none;
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
    .view-switch {
      display: flex;
      border: 1px solid var(--border);
      background: var(--panel-3);
      border-radius: 999px;
      padding: 2px;
      gap: 2px;
    }
    .view-btn {
      border: 0;
      background: transparent;
      color: var(--muted);
      border-radius: 999px;
      padding: 6px 10px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      font-family: var(--font-ui);
    }
    .view-btn.active {
      color: var(--text);
      background: var(--panel-2);
      border: 1px solid var(--border);
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
    /* ── Settings slide-over ── */
    .settings-overlay {
      display: none; position: fixed; inset: 0; z-index: 100;
      background: rgba(0,0,0,0.4); backdrop-filter: blur(3px);
    }
    .settings-overlay.open { display: block; }
    .settings-panel {
      position: fixed; top: 0; right: 0; bottom: 0; width: 420px; max-width: 90vw;
      background: var(--panel); border-left: 1px solid var(--border);
      box-shadow: -8px 0 30px rgba(0,0,0,0.3); z-index: 101;
      display: flex; flex-direction: column; transform: translateX(100%);
      transition: transform 200ms ease;
    }
    .settings-overlay.open .settings-panel { transform: translateX(0); }
    .settings-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 16px 20px; border-bottom: 1px solid var(--border);
    }
    .settings-header h2 { margin: 0; font-size: 16px; }
    .settings-close {
      border: 0; background: transparent; color: var(--muted); cursor: pointer;
      font-size: 20px; padding: 4px; line-height: 1;
    }
    .settings-body { flex: 1; overflow-y: auto; padding: 20px; }
    .settings-section { margin-bottom: 20px; }
    .settings-section h3 {
      font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--muted); margin: 0 0 10px; font-weight: 700;
    }
    .settings-row {
      display: flex; justify-content: space-between; align-items: flex-start;
      gap: 12px; padding: 6px 0; font-size: 13px;
    }
    .settings-row .label { color: var(--muted); flex: 0 0 120px; }
    .settings-row .value {
      font-weight: 600; text-align: right; flex: 1 1 auto; min-width: 0;
      overflow-wrap: anywhere; word-break: break-word;
    }
    .settings-row .value.compact {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .settings-row.stacked {
      display: block;
    }
    .settings-row.stacked .label {
      display: block; flex: none; margin-bottom: 6px;
    }
    .settings-row.stacked .value {
      display: block; text-align: left;
    }
    .settings-row .value.settings-code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .settings-badge {
      display: inline-block; padding: 2px 8px; border-radius: 999px;
      font-size: 11px; font-weight: 600;
    }
    .settings-badge.on { background: color-mix(in srgb, var(--ok) 18%, transparent); color: var(--ok); }
    .settings-badge.off { background: color-mix(in srgb, var(--muted) 15%, transparent); color: var(--muted); }
    .stat-grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
    }
    .stat-card {
      background: var(--panel-3); border: 1px solid var(--border);
      border-radius: 8px; padding: 12px; text-align: center;
    }
    .stat-card .stat-value { font-size: 22px; font-weight: 700; }
    .stat-card .stat-label { font-size: 11px; color: var(--muted); margin-top: 2px; }

    /* ── Search and filter ── */
    .sidebar-search {
      margin-bottom: 10px;
    }
    .sidebar-search input {
      width: 100%; padding: 7px 10px; border: 1px solid var(--border);
      background: var(--panel-3); color: var(--text); border-radius: 8px;
      font-size: 12px; font-family: var(--font-ui); outline: none;
    }
    .sidebar-search input:focus { border-color: var(--ring); }
    .filter-pills {
      display: flex; gap: 4px; margin-bottom: 10px; flex-wrap: wrap;
    }
    .filter-pill {
      border: 1px solid var(--border); background: var(--panel-3);
      color: var(--muted); border-radius: 999px; padding: 3px 10px;
      font-size: 11px; font-weight: 600; cursor: pointer; font-family: var(--font-ui);
    }
    .filter-pill.active { background: var(--badge-bg); color: var(--badge-text); border-color: var(--badge-text); }

    /* ── New Run modal ── */
    .modal-overlay {
      display: none; position: fixed; inset: 0; z-index: 100;
      background: rgba(0,0,0,0.5); backdrop-filter: blur(3px);
      align-items: center; justify-content: center;
    }
    .modal-overlay.open { display: flex; }
    .modal {
      background: var(--panel); border: 1px solid var(--border);
      border-radius: var(--radius); padding: 24px; width: 440px; max-width: 90vw;
      box-shadow: var(--shadow);
    }
    .modal h2 { margin: 0 0 16px; font-size: 16px; }
    .modal label { display: block; font-size: 12px; color: var(--muted); margin: 10px 0 4px; font-weight: 600; }
    .modal input, .modal textarea, .modal select {
      width: 100%; padding: 8px 10px; border: 1px solid var(--border);
      background: var(--panel-3); color: var(--text); border-radius: 8px;
      font-size: 13px; font-family: var(--font-ui); outline: none;
    }
    .modal select { cursor: pointer; }
    .modal textarea { min-height: 80px; resize: vertical; }
    .modal input:focus, .modal textarea:focus, .modal select:focus { border-color: var(--ring); }
    .modal-subactions { display: flex; gap: 8px; justify-content: space-between; margin-top: 8px; flex-wrap: wrap; }
    .modal-inline-btn {
      border: 1px solid var(--border); background: var(--button-bg); color: var(--text);
      border-radius: 8px; padding: 6px 10px; font-size: 12px; font-weight: 600;
      cursor: pointer; font-family: var(--font-ui);
    }
    .modal-inline-btn:hover { background: var(--button-bg-hover); }
    .modal-inline-btn:disabled { opacity: 0.6; cursor: default; }
    .modal-help { margin-top: 6px; font-size: 11px; color: var(--muted); line-height: 1.4; }
    .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
    .modal-btn {
      border: 1px solid var(--border); background: var(--button-bg); color: var(--text);
      border-radius: 8px; padding: 8px 16px; font-size: 13px; font-weight: 600;
      cursor: pointer; font-family: var(--font-ui);
    }
    .modal-btn.primary { background: var(--ring); color: #fff; border-color: var(--ring); }
    .modal-btn.primary:hover { opacity: 0.9; }

    .sidebar {
      grid-area: sidebar;
      border-right: 1px solid var(--border);
      background: color-mix(in srgb, var(--panel) 88%, transparent);
      padding: 14px;
      overflow-y: auto;
    }
    .main {
      grid-area: main;
      min-width: 0;
      padding: 16px;
      overflow-y: auto;
      overflow-x: hidden;
    }
    .stack {
      display: grid;
      gap: 12px;
      min-width: 0;
      width: 100%;
      max-width: none;
    }
    .board-view {
      display: none;
      min-width: 0;
    }
    .board-view.active {
      display: block;
    }
    .board-shell {
      display: grid;
      gap: 12px;
      min-width: 0;
    }
    .board-layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 380px;
      gap: 12px;
      min-width: 0;
      align-items: start;
    }
    .board-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .board-toolbar-left {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .board-toolbar label {
      font-size: 11px;
      font-weight: 700;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .board-toolbar select {
      border: 1px solid var(--border);
      background: var(--panel-3);
      color: var(--text);
      border-radius: 8px;
      padding: 8px 10px;
      font-size: 13px;
      font-family: var(--font-ui);
      min-width: 220px;
    }
    .board-columns {
      display: grid;
      grid-auto-flow: column;
      grid-auto-columns: minmax(260px, 1fr);
      gap: 12px;
      overflow-x: auto;
      align-items: start;
      padding-bottom: 8px;
    }
    .board-column {
      border: 1px solid var(--border);
      background: color-mix(in srgb, var(--panel) 92%, transparent);
      border-radius: 14px;
      min-height: 240px;
      padding: 12px;
      display: grid;
      gap: 10px;
    }
    .board-column-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
    }
    .board-column-title {
      font-size: 12px;
      font-weight: 700;
      color: var(--text);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .board-column-count {
      color: var(--muted);
      font-size: 12px;
    }
    .board-column-items {
      display: grid;
      gap: 10px;
    }
    .board-card {
      border: 1px solid var(--border);
      background: var(--panel-3);
      border-radius: 12px;
      padding: 12px;
      display: grid;
      gap: 8px;
      box-shadow: var(--shadow);
      cursor: pointer;
      transition: border-color 120ms ease, transform 120ms ease, background 120ms ease;
    }
    .board-card:hover {
      transform: translateY(-1px);
      border-color: var(--border-strong);
    }
    .board-card.selected {
      border-color: var(--ring);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--ring) 45%, transparent), var(--shadow);
    }
    .board-card-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .board-card-key {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--badge-text);
      background: var(--badge-bg);
      border: 1px solid color-mix(in srgb, var(--badge-text) 35%, var(--border));
      border-radius: 999px;
      padding: 3px 8px;
      white-space: nowrap;
    }
    .board-card-title {
      font-size: 14px;
      font-weight: 700;
      line-height: 1.35;
    }
    .board-card-summary {
      font-size: 12px;
      color: var(--muted);
      line-height: 1.45;
      white-space: pre-wrap;
    }
    .board-card-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      color: var(--muted);
      font-size: 11px;
    }
    .board-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      border: 1px solid var(--border);
      background: var(--panel-2);
      border-radius: 999px;
      padding: 3px 8px;
      font-size: 11px;
      color: var(--muted);
    }
    .board-flags {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .board-empty {
      border: 1px dashed var(--border);
      border-radius: 10px;
      padding: 14px 12px;
      color: var(--muted);
      font-size: 12px;
      text-align: center;
      background: color-mix(in srgb, var(--panel-3) 88%, transparent);
    }
    .board-detail {
      position: sticky;
      top: 0;
      display: grid;
      gap: 12px;
    }
    .board-detail-title {
      font-size: 18px;
      font-weight: 700;
      line-height: 1.35;
    }
    .board-detail-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .board-detail-flags {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .board-detail-section {
      display: grid;
      gap: 8px;
    }
    .board-detail-section-title {
      font-size: 11px;
      font-weight: 700;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .board-detail-empty {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.5;
      border: 1px dashed var(--border);
      border-radius: 10px;
      padding: 12px;
      background: color-mix(in srgb, var(--panel-3) 88%, transparent);
    }
    .board-review-item,
    .board-event-item {
      border: 1px solid var(--border);
      background: var(--panel-3);
      border-radius: 10px;
      padding: 10px;
      display: grid;
      gap: 8px;
    }
    .board-review-head,
    .board-event-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }
    .board-review-title {
      font-size: 13px;
      font-weight: 700;
      line-height: 1.35;
    }
    .board-review-message,
    .board-event-payload {
      font-size: 12px;
      color: var(--muted);
      white-space: pre-wrap;
      line-height: 1.45;
    }
    .board-review-focus {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .board-review-comments {
      display: grid;
      gap: 6px;
    }
    .board-review-comment {
      border: 1px solid var(--border);
      background: color-mix(in srgb, var(--panel-2) 78%, transparent);
      border-radius: 8px;
      padding: 8px;
      display: grid;
      gap: 4px;
    }
    .board-review-comment-meta {
      font-size: 11px;
      color: var(--muted);
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .board-review-comment-body {
      font-size: 12px;
      color: var(--text);
      white-space: pre-wrap;
      line-height: 1.45;
    }
    .board-detail-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .board-detail-form {
      display: grid;
      gap: 8px;
    }
    .board-detail-form label {
      font-size: 11px;
      font-weight: 700;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .board-detail-form input,
    .board-detail-form select,
    .board-detail-form textarea {
      width: 100%;
      border: 1px solid var(--border);
      background: var(--panel-3);
      color: var(--text);
      border-radius: 8px;
      padding: 8px 10px;
      font-size: 13px;
      font-family: var(--font-ui);
      outline: none;
    }
    .board-detail-form textarea {
      min-height: 76px;
      resize: vertical;
    }
    .board-inline-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .board-status-message {
      min-height: 18px;
      font-size: 12px;
      color: var(--muted);
    }
    .board-status-message.error {
      color: var(--err);
    }
    .board-status-message.ok {
      color: var(--ok);
    }
    .stack-top {
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
      min-width: 0;
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
    .status-pill.running::before,
    .status-pill.validating::before,
    .status-pill.pushing::before,
    .status-pill.queued::before {
      content: '';
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
      margin-right: 4px;
      vertical-align: middle;
      animation: pulse-dot 1.4s ease-in-out infinite;
    }
    @keyframes pulse-dot {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.7); }
    }
    .live-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      font-weight: 700;
      color: var(--running);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .live-badge::before {
      content: '';
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--running);
      animation: pulse-dot 1.4s ease-in-out infinite;
    }
    .phase-progress {
      display: flex;
      gap: 3px;
      margin-top: 8px;
      align-items: center;
    }
    .phase-step {
      flex: 1;
      height: 4px;
      border-radius: 2px;
      background: var(--border);
      transition: background 300ms ease;
    }
    .phase-step.done { background: var(--ok); }
    .phase-step.active { background: var(--running); animation: pulse-bar 1.4s ease-in-out infinite; }
    .phase-step.warn { background: #f59e0b; }
    .phase-step.fail { background: var(--err); }
    @keyframes pulse-bar {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .card {
      min-width: 0;
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
      flex-wrap: wrap;
      min-width: 0;
      gap: 10px;
      margin-bottom: 10px;
    }
    .toolbar > :first-child {
      flex: 1 1 auto;
      min-width: 0;
    }
    .summary-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      justify-content: flex-end;
      max-width: 100%;
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
    /* Session viewer tabs */
    .session-tabs {
      display: flex;
      gap: 0;
      border-bottom: 1px solid var(--border);
      margin: 10px -12px 0;
      padding: 0 12px;
    }
    .session-tab {
      padding: 8px 14px;
      font-size: 12px;
      font-weight: 600;
      font-family: var(--font-ui);
      color: var(--muted);
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      transition: color 120ms, border-color 120ms;
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .session-tab:hover { color: var(--text); }
    .session-tab.active {
      color: var(--text);
      border-bottom-color: var(--ring);
    }
    .tab-count {
      font-size: 10px;
      font-weight: 600;
      color: var(--muted);
      background: var(--panel-3);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1px 5px;
      min-width: 16px;
      text-align: center;
    }
    .session-tab.active .tab-count { color: var(--text); }
    .session-panel {
      display: none;
      padding-top: 12px;
    }
    .session-panel.active { display: block; }
    .session-empty {
      color: var(--muted);
      font-size: 12px;
      text-align: center;
      padding: 24px 12px;
    }
    .console-filter-btn {
      font-size: 11px;
      padding: 3px 10px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--panel-3);
      color: var(--muted);
      cursor: pointer;
      font-family: var(--font-ui);
      font-weight: 600;
      margin-right: 4px;
      transition: background 80ms, color 80ms;
    }
    .console-filter-btn:hover { background: var(--panel-2); color: var(--text); }
    .console-filter-btn.active { background: var(--panel-2); color: var(--text); border-color: var(--ring); }
    .console-entry {
      padding: 4px 8px;
      border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
      display: flex;
      gap: 8px;
      align-items: flex-start;
      line-height: 1.4;
    }
    .console-entry:last-child { border-bottom: none; }
    .console-entry .level {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      min-width: 44px;
      flex-shrink: 0;
      padding-top: 1px;
    }
    .console-entry.error { color: #e53e3e; }
    .console-entry.warning { color: #d69e2e; }
    .console-entry.info { color: #3182ce; }
    .console-entry.log { color: var(--text); }
    .actions-table {
      width: 100%;
      border-collapse: collapse;
    }
    .actions-table th {
      text-align: left;
      padding: 6px 10px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      border-bottom: 2px solid var(--border);
      position: sticky;
      top: 0;
      background: var(--panel);
    }
    .actions-table td {
      padding: 6px 10px;
      border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
      vertical-align: top;
    }
    .actions-table tr:last-child td { border-bottom: none; }
    .action-type-pill {
      font-size: 10px;
      font-weight: 700;
      border-radius: 4px;
      padding: 2px 6px;
      background: var(--badge-bg);
      color: var(--badge-text);
      text-transform: lowercase;
      white-space: nowrap;
    }
    .action-type-pill.act { background: color-mix(in srgb, #3b82f6 18%, transparent); color: #60a5fa; }
    .action-type-pill.goto { background: color-mix(in srgb, #8b5cf6 18%, transparent); color: #a78bfa; }
    .action-type-pill.done { background: color-mix(in srgb, var(--ok) 18%, transparent); color: var(--ok); }
    .action-type-pill.screenshot { background: color-mix(in srgb, #ec4899 18%, transparent); color: #f472b6; }
    .action-type-pill.extract { background: color-mix(in srgb, #f59e0b 18%, transparent); color: #fbbf24; }
    .network-table {
      width: 100%;
      border-collapse: collapse;
    }
    .network-table th {
      text-align: left;
      padding: 6px 10px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      border-bottom: 2px solid var(--border);
      position: sticky;
      top: 0;
      background: var(--panel);
    }
    .network-table td {
      padding: 5px 10px;
      border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
      white-space: nowrap;
    }
    .network-table tr:last-child td { border-bottom: none; }
    .network-table .status-ok { color: var(--ok); }
    .network-table .status-err { color: var(--err); }
    .network-table .status-slow { color: var(--warn); }
    .network-table .url-cell {
      max-width: 340px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
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
    .log-viewer {
      max-height: 500px;
      overflow-y: auto;
      scroll-behavior: smooth;
      background: var(--panel-3);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 11px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-all;
      color: var(--muted);
      margin: 0;
    }
    .act-truncated, .log-truncated {
      text-align: center;
      padding: 6px 10px;
      background: color-mix(in srgb, var(--warn) 8%, var(--panel-3));
      border: 1px solid var(--border);
      border-radius: 8px;
      margin-bottom: 6px;
      font-size: 12px;
    }
    .act-show-all-btn {
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 4px;
      padding: 3px 10px;
      font-size: 11px;
      cursor: pointer;
      margin-right: 8px;
    }
    .act-show-all-btn:hover { opacity: 0.85; }
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
    }
    .act-thinking .md-heading {
      font-size: 12px;
      font-weight: 700;
      margin: 6px 0 2px;
      color: var(--text);
    }
    .act-thinking .md-list {
      margin: 2px 0 2px 16px;
      padding: 0;
      list-style: disc;
    }
    .act-thinking .md-list li {
      margin: 1px 0;
    }
    .act-thinking .md-inline-code {
      background: color-mix(in srgb, var(--panel) 60%, transparent);
      padding: 1px 4px;
      border-radius: 3px;
      font-family: var(--font-mono);
      font-size: 11px;
    }
    .act-thinking .md-code-block {
      background: color-mix(in srgb, var(--panel) 60%, transparent);
      padding: 6px 8px;
      border-radius: 4px;
      font-family: var(--font-mono);
      font-size: 11px;
      margin: 4px 0;
      overflow-x: auto;
    }
    .act-thinking .md-line {
      display: block;
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
    .act-tool-result {
      margin-top: 6px;
      border-left: 3px solid var(--accent);
      padding: 6px 8px;
      background: color-mix(in srgb, var(--accent) 8%, transparent);
      border-radius: 0 6px 6px 0;
    }
    .act-result-label {
      display: inline-block;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      color: var(--accent);
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }
    .act-result-text {
      white-space: pre-wrap;
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--fg);
      margin: 0;
      max-height: 150px;
      overflow-y: auto;
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
    .act-pipeline {
      background: color-mix(in srgb, var(--running) 6%, var(--panel-3));
      border: 1px solid color-mix(in srgb, var(--running) 15%, var(--border));
      font-size: 11px;
      font-family: var(--font-mono);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .act-pipeline .material-symbols-rounded { font-size: 14px; color: var(--running); flex-shrink: 0; }
    .act-pipeline.pl-success { border-color: color-mix(in srgb, var(--ok) 25%, var(--border)); }
    .act-pipeline.pl-success .material-symbols-rounded { color: var(--ok); }
    .act-pipeline.pl-error { border-color: color-mix(in srgb, var(--fail) 25%, var(--border)); }
    .act-pipeline.pl-error .material-symbols-rounded { color: var(--fail); }
    .act-pipeline.pl-warn { border-color: color-mix(in srgb, var(--warn) 25%, var(--border)); }
    .act-pipeline.pl-warn .material-symbols-rounded { color: var(--warn); }
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
      .board-layout {
        grid-template-columns: 1fr;
      }
      .board-detail {
        position: static;
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
  <div class="app" id="app-root">
    <header class="topbar">
      <div class="brand">
        <span class="brand-dot"></span>
        <div>
          <h1>${escapeHtml(config.appName)} Dashboard</h1>
          <p>Run inspector and operator feedback</p>
        </div>
      </div>
      <div class="top-controls">
        <div class="top-meta" id="top-meta">0 runs</div>
        <div class="view-switch" id="view-switch">
          <button class="view-btn active" data-view="runs">Runs</button>
          <button class="view-btn" data-view="board">Board</button>
        </div>
        <button class="top-btn" id="new-run-btn">
          <span class="material-symbols-rounded">add</span>
          <span>New Run</span>
        </button>
        <button class="top-btn" id="pipelines-btn">
          <span class="material-symbols-rounded">route</span>
          <span>Pipelines</span>
        </button>
        <button class="top-btn" id="evals-btn">
          <span class="material-symbols-rounded">science</span>
          <span>Evals</span>
        </button>
        <button class="top-btn" id="learnings-btn">
          <span class="material-symbols-rounded">insights</span>
          <span>Learnings</span>
        </button>
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
        <div class="sidebar-title" id="sidebar-title">Runs</div>
        <div class="meta" id="meta">Loading...</div>
      </div>
      <div class="sidebar-search">
        <input type="text" id="run-search" placeholder="Search runs..." />
      </div>
      <div class="filter-pills" id="filter-pills">
        <button class="filter-pill active" data-status="all">All</button>
        <button class="filter-pill" data-status="running">Running</button>
        <button class="filter-pill" data-status="completed">Completed</button>
        <button class="filter-pill" data-status="failed">Failed</button>
      </div>
      <div id="runs"></div>
    </aside>
    <main class="main">
      <div class="stack" id="runs-view">
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
        <div class="card" id="media-card" style="display: none;">
          <div class="card-title" style="margin-bottom: 0;">Browser session</div>
          <div class="session-tabs" id="session-tabs">
            <button class="session-tab active" data-tab="replay">Replay</button>
            <button class="session-tab" data-tab="actions">Actions <span id="tab-actions-count" class="tab-count"></span></button>
            <button class="session-tab" data-tab="console">Console <span id="tab-console-count" class="tab-count"></span></button>
            <button class="session-tab" data-tab="network">Network <span id="tab-network-count" class="tab-count"></span></button>
          </div>
          <div class="session-panel active" id="panel-replay">
            <div id="media-video" style="display: none; margin-bottom: 12px;">
              <video id="media-video-player" controls style="width: 100%; border-radius: 6px; border: 1px solid var(--border); background: #000;">
                Your browser does not support the video tag.
              </video>
            </div>
            <div id="media-screenshots" style="display: none;">
              <div style="font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 8px;">Screenshots</div>
              <div id="media-screenshots-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px;"></div>
            </div>
            <div id="panel-replay-empty" class="session-empty">No video or screenshots available.</div>
          </div>
          <div class="session-panel" id="panel-actions">
            <div id="media-actions-table" style="font-size: 12px; overflow-x: auto;"></div>
            <div id="panel-actions-empty" class="session-empty">No agent actions recorded.</div>
          </div>
          <div class="session-panel" id="panel-console">
            <div id="media-console-filters" style="display: none; margin-bottom: 8px;">
              <button class="console-filter-btn active" data-level="all">All</button>
              <button class="console-filter-btn" data-level="error">Errors</button>
              <button class="console-filter-btn" data-level="warning">Warnings</button>
            </div>
            <div id="media-console-entries" style="max-height: 400px; overflow-y: auto; font-family: var(--font-mono); font-size: 11px;"></div>
            <div id="panel-console-empty" class="session-empty">No console logs captured.</div>
          </div>
          <div class="session-panel" id="panel-network">
            <div id="media-network-table" style="max-height: 400px; overflow-y: auto; font-size: 12px; overflow-x: auto;"></div>
            <div id="panel-network-empty" class="session-empty">No network requests captured.</div>
          </div>
        </div>
        <div class="card" id="pipeline-timeline-card" style="display: none;">
          <div class="card-title" style="margin-bottom: 8px;">Pipeline timeline</div>
          <div id="pipeline-timeline" class="mono" style="max-height: 200px; font-size: 11px;"></div>
        </div>
        <div class="card">
          <div class="toolbar">
            <div class="card-title">Agent activity</div>
            <div class="act-stats" id="act-stats"></div>
          </div>
          <div class="act-truncated" id="act-truncated" style="display: none;">
            <button class="act-show-all-btn" id="act-show-all">Show all events</button>
            <span class="meta" id="act-truncated-count"></span>
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
        <div class="card" id="log-viewer-card" style="display: none;">
          <div class="toolbar">
            <div class="card-title">Run log</div>
            <div id="log-stats" class="meta"></div>
          </div>
          <div class="log-truncated" id="log-truncated" style="display: none;">
            <span class="meta" id="log-truncated-msg">Log truncated — showing last 200 KB</span>
          </div>
          <pre class="log-viewer" id="log-viewer"></pre>
          <div class="act-footer">
            <label>
              <input type="checkbox" id="log-auto-scroll" checked />
              Auto-scroll
            </label>
            <span id="log-size" class="meta"></span>
          </div>
        </div>
        <div class="card" id="observer-card" style="display: none;">
          <div class="toolbar">
            <div>
              <div class="card-title">Observer</div>
              <div class="card-subtitle" id="observer-subtitle">Watching for triggers</div>
            </div>
            <div class="summary-actions">
              <span class="meta" id="observer-budget"></span>
            </div>
          </div>
          <div id="observer-content">
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px;">
              <div id="observer-rules-panel" style="border: 1px solid var(--border); border-radius: 8px; padding: 10px; background: var(--panel-3);">
                <div style="font-size: 12px; font-weight: 700; margin-bottom: 6px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em;">Rules</div>
                <div id="observer-rules" class="meta">Loading...</div>
              </div>
              <div id="observer-stats-panel" style="border: 1px solid var(--border); border-radius: 8px; padding: 10px; background: var(--panel-3);">
                <div style="font-size: 12px; font-weight: 700; margin-bottom: 6px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em;">Budget</div>
                <div id="observer-stats" class="meta">Loading...</div>
              </div>
            </div>
            <div style="font-size: 12px; font-weight: 700; margin-bottom: 6px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em;">Recent events</div>
            <div id="observer-events" class="activity-stream" style="max-height: 300px;">
              <div class="act-info">No events yet.</div>
            </div>
          </div>
        </div>
        <div class="card" id="chat-card" style="display: none;">
          <div class="card-title" style="margin-bottom: 8px;">Thread history & follow-up</div>
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
      <div class="board-view" id="board-view">
        <div class="board-shell">
          <div class="card">
            <div class="board-toolbar">
              <div class="board-toolbar-left">
                <div>
                  <div class="card-title">Work Item Board</div>
                  <div class="card-subtitle">Workflow-specific Kanban view for managed automation.</div>
                </div>
                <div>
                  <label for="board-workflow">Workflow</label>
                  <select id="board-workflow">
                    <option value="product_discovery">Product Discovery</option>
                    <option value="feature_delivery">Feature Delivery</option>
                  </select>
                </div>
              </div>
              <div class="meta" id="board-meta">Loading work items...</div>
            </div>
          </div>
          <div class="board-layout">
            <div class="board-columns" id="board-columns"></div>
            <div class="card board-detail" id="board-detail">
              <div>
                <div class="card-title">Work Item Detail</div>
                <div class="card-subtitle" id="board-detail-subtitle">Select a card to inspect workflow context, review requests and actions.</div>
              </div>
              <div class="board-detail-title" id="board-detail-title">No work item selected</div>
              <div class="board-detail-meta" id="board-detail-meta"></div>
              <div class="board-detail-flags" id="board-detail-flags"></div>
              <div class="board-detail-section">
                <div class="board-detail-section-title">Summary</div>
                <div class="board-detail-empty" id="board-detail-summary">Choose a work item from the board to see details.</div>
              </div>
              <div class="board-detail-section">
                <div class="board-detail-section-title">Workflow Actions</div>
                <div class="board-detail-actions">
                  <button class="top-btn" id="board-stop-processing" disabled>
                    <span class="material-symbols-rounded">pause_circle</span>
                    <span>Stop Processing</span>
                  </button>
                  <button class="top-btn" id="board-confirm-approve" disabled>
                    <span class="material-symbols-rounded">task_alt</span>
                    <span>PM Approve</span>
                  </button>
                  <button class="top-btn" id="board-confirm-rework" disabled>
                    <span class="material-symbols-rounded">undo</span>
                    <span>Return To In Progress</span>
                  </button>
                </div>
              </div>
              <div class="board-detail-section">
                <div class="board-detail-section-title">Review Requests</div>
                <div id="board-detail-reviews" class="board-detail-empty">No review requests loaded.</div>
              </div>
              <div class="board-detail-section">
                <div class="board-detail-section-title">Guarded Override</div>
                <div class="board-detail-form">
                  <label for="board-override-state">State</label>
                  <select id="board-override-state"></select>
                  <label for="board-override-substate">Substate</label>
                  <input type="text" id="board-override-substate" placeholder="Optional substate" />
                  <label for="board-override-reason">Reason</label>
                  <textarea id="board-override-reason" placeholder="Explain why this override is needed"></textarea>
                  <div class="board-inline-actions">
                    <button class="top-btn" id="board-override-submit" disabled>
                      <span class="material-symbols-rounded">sync_alt</span>
                      <span>Apply Override</span>
                    </button>
                  </div>
                </div>
              </div>
              <div class="board-detail-section">
                <div class="board-detail-section-title">Events</div>
                <div id="board-detail-events" class="board-detail-empty">No events loaded.</div>
              </div>
              <div class="board-status-message" id="board-status-message"></div>
            </div>
          </div>
        </div>
      </div>
    </main>
  </div>

  <div class="feedback-toast" id="feedback-toast">
    <span class="fb-text">What did you think of this agent run?</span>
    <button class="fb-btn" id="feedback-down" title="Bad">👎</button>
    <button class="fb-btn" id="feedback-up" title="Good">👍</button>
  </div>

  <!-- Settings slide-over -->
  <div class="settings-overlay" id="settings-overlay">
    <div class="settings-panel">
      <div class="settings-header">
        <h2>Settings</h2>
        <button class="settings-close" id="settings-close">&times;</button>
      </div>
      <div class="settings-body" id="settings-body">Loading...</div>
    </div>
  </div>

  <!-- Pipeline Manager slide-over -->
  <div class="settings-overlay" id="pipelines-overlay">
    <div class="settings-panel" style="width: 560px;">
      <div class="settings-header">
        <h2>Pipeline Manager</h2>
        <button class="settings-close" id="pipelines-close">&times;</button>
      </div>
      <div class="settings-body" style="padding: 16px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <div style="font-size: 13px; font-weight: 700;">Pipelines</div>
          <button class="action-btn" id="pl-new-btn" style="font-size: 11px; padding: 5px 10px;">
            <span class="material-symbols-rounded" style="font-size: 14px; vertical-align: middle;">add</span>
            New Pipeline
          </button>
        </div>
        <div id="pl-list" style="margin-bottom: 16px;">Loading...</div>

        <!-- Pipeline editor (hidden by default) -->
        <div id="pl-editor" style="display: none; border: 1px solid var(--border); border-radius: 8px; padding: 14px; background: var(--panel-3);">
          <div style="font-size: 13px; font-weight: 700; margin-bottom: 10px;" id="pl-editor-title">New Pipeline</div>
          <label style="display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; font-weight: 600;">Pipeline ID</label>
          <input type="text" id="pl-editor-id" placeholder="e.g. my-pipeline" style="width: 100%; padding: 7px 10px; border: 1px solid var(--border); background: var(--panel); color: var(--text); border-radius: 6px; font-size: 12px; font-family: var(--font-mono); outline: none; margin-bottom: 10px;" />
          <label style="display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; font-weight: 600;">Pipeline YAML</label>
          <textarea id="pl-editor-yaml" style="width: 100%; min-height: 200px; padding: 8px 10px; border: 1px solid var(--border); background: var(--panel); color: var(--text); border-radius: 6px; font-size: 12px; font-family: var(--font-mono); resize: vertical; outline: none;" placeholder="version: 1\nname: My Pipeline\nnodes:\n  - id: step1\n    type: deterministic\n    action: clone"></textarea>
          <div id="pl-editor-result" style="margin-top: 8px; font-size: 12px; min-height: 20px;"></div>
          <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px;">
            <button class="action-btn" id="pl-editor-cancel" style="font-size: 11px; padding: 5px 12px;">Cancel</button>
            <button class="action-btn" id="pl-editor-validate" style="font-size: 11px; padding: 5px 12px;">Validate</button>
            <button class="action-btn" id="pl-editor-save" style="font-size: 11px; padding: 5px 12px; background: var(--ring); color: #fff; border-color: var(--ring);">Save</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Evals slide-over -->
  <div class="settings-overlay" id="evals-overlay">
    <div class="settings-panel" style="width: 780px;">
      <div class="settings-header">
        <h2>Evals</h2>
        <button class="settings-close" id="evals-close">&times;</button>
      </div>
      <div class="settings-body" style="padding: 16px;">
        <div id="evals-scenarios" style="margin-bottom: 16px;">
          <div style="font-size: 12px; font-weight: 700; margin-bottom: 6px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em;">Available Scenarios</div>
          <div id="evals-scenario-list">Loading...</div>
        </div>
        <div style="font-size: 12px; font-weight: 700; margin-bottom: 6px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em;">Recent Results</div>
        <div id="evals-results">Loading...</div>
      </div>
    </div>
  </div>

  <!-- Learnings slide-over -->
  <div class="settings-overlay" id="learnings-overlay">
    <div class="settings-panel" style="width: 620px;">
      <div class="settings-header">
        <h2>Learnings</h2>
        <button class="settings-close" id="learnings-close">&times;</button>
      </div>
      <div class="settings-body" style="padding: 16px;">
        <div id="learnings-system" style="margin-bottom: 16px;"></div>
        <div style="font-size: 12px; font-weight: 700; margin-bottom: 6px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em;">Per-repo breakdown</div>
        <div id="learnings-repos" style="margin-bottom: 16px;">Loading...</div>
        <div style="font-size: 12px; font-weight: 700; margin-bottom: 6px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em;">Recent outcomes</div>
        <div id="learnings-outcomes">Loading...</div>
      </div>
    </div>
  </div>

  <!-- New Run modal -->
  <div class="modal-overlay" id="new-run-overlay">
    <div class="modal">
      <h2>New Run</h2>
      <div id="nr-repo-select-wrap">
        <label for="nr-repo-select">Repository</label>
        <select id="nr-repo-select">
          <option value="">Loading repositories...</option>
        </select>
      </div>
      <div id="nr-repo-custom-wrap" style="display: none;">
        <label for="nr-repo">Repository (owner/repo)</label>
        <input type="text" id="nr-repo" placeholder="yourorg/yourrepo" />
      </div>
      <div class="modal-subactions">
        <button type="button" class="modal-inline-btn" id="nr-repo-custom-toggle">Use custom repository</button>
        <button type="button" class="modal-inline-btn" id="nr-repo-refresh">Refresh repositories</button>
      </div>
      <div class="modal-help" id="nr-repo-meta">Select a repository from the GitHub App installation or switch to manual entry.</div>
      <label for="nr-branch">Base branch</label>
      <input type="text" id="nr-branch" placeholder="main" />
      <label for="nr-task">Task description</label>
      <textarea id="nr-task" placeholder="Describe what you want the agent to do..."></textarea>
      <label for="nr-pipeline">Pipeline</label>
      <select id="nr-pipeline" class="form-control">
        <option value="">Default</option>
      </select>
      <div id="nr-error" style="color: var(--err); font-size: 12px; margin-top: 8px; display: none;"></div>
      <div class="modal-actions">
        <button class="modal-btn" id="nr-cancel">Cancel</button>
        <button class="modal-btn primary" id="nr-submit">Start Run</button>
      </div>
    </div>
  </div>

  <script>
    const state = {
      runs: [],
      workItems: [],
      selectedWorkItemId: null,
      selectedWorkItem: null,
      selectedWorkItemReviewRequests: [],
      selectedWorkItemReviewComments: {},
      selectedWorkItemEvents: [],
      selectedId: null,
      interval: null,
      themePreference: 'system',
      viewMode: 'runs',
      boardWorkflow: 'product_discovery',
      boardActorUserId: '',
    };

    var logStreamState = { runId: null, offset: 0 };

    // ── Lazy loading constants ──
    var MAX_VISIBLE_EVENTS = 150;
    var MAX_LOG_CHARS = 200000; // ~200 KB
    var activityShowAll = false;
    var lastRenderedEventCount = -1;

    const el = {
      appRoot: document.getElementById('app-root'),
      meta: document.getElementById('meta'),
      topMeta: document.getElementById('top-meta'),
      sidebarTitle: document.getElementById('sidebar-title'),
      runs: document.getElementById('runs'),
      viewSwitch: document.getElementById('view-switch'),
      runsView: document.getElementById('runs-view'),
      boardView: document.getElementById('board-view'),
      boardWorkflow: document.getElementById('board-workflow'),
      boardMeta: document.getElementById('board-meta'),
      boardColumns: document.getElementById('board-columns'),
      boardDetail: document.getElementById('board-detail'),
      boardDetailSubtitle: document.getElementById('board-detail-subtitle'),
      boardDetailTitle: document.getElementById('board-detail-title'),
      boardDetailMeta: document.getElementById('board-detail-meta'),
      boardDetailFlags: document.getElementById('board-detail-flags'),
      boardDetailSummary: document.getElementById('board-detail-summary'),
      boardDetailReviews: document.getElementById('board-detail-reviews'),
      boardDetailEvents: document.getElementById('board-detail-events'),
      boardStopProcessing: document.getElementById('board-stop-processing'),
      boardConfirmApprove: document.getElementById('board-confirm-approve'),
      boardConfirmRework: document.getElementById('board-confirm-rework'),
      boardOverrideState: document.getElementById('board-override-state'),
      boardOverrideSubstate: document.getElementById('board-override-substate'),
      boardOverrideReason: document.getElementById('board-override-reason'),
      boardOverrideSubmit: document.getElementById('board-override-submit'),
      boardStatusMessage: document.getElementById('board-status-message'),
      summary: document.getElementById('summary'),
      summarySubtitle: document.getElementById('summary-subtitle'),
      retryRun: document.getElementById('retry-run'),
      openBranch: document.getElementById('open-branch'),
      openPr: document.getElementById('open-pr'),
      openCommit: document.getElementById('open-commit'),
      files: document.getElementById('files'),
      mediaCard: document.getElementById('media-card'),
      sessionTabs: document.getElementById('session-tabs'),
      mediaVideo: document.getElementById('media-video'),
      mediaVideoPlayer: document.getElementById('media-video-player'),
      mediaScreenshots: document.getElementById('media-screenshots'),
      mediaScreenshotsGrid: document.getElementById('media-screenshots-grid'),
      panelReplayEmpty: document.getElementById('panel-replay-empty'),
      panelActionsEmpty: document.getElementById('panel-actions-empty'),
      mediaActionsTable: document.getElementById('media-actions-table'),
      tabActionsCount: document.getElementById('tab-actions-count'),
      panelConsoleEmpty: document.getElementById('panel-console-empty'),
      mediaConsoleFilters: document.getElementById('media-console-filters'),
      mediaConsoleEntries: document.getElementById('media-console-entries'),
      tabConsoleCount: document.getElementById('tab-console-count'),
      panelNetworkEmpty: document.getElementById('panel-network-empty'),
      mediaNetworkTable: document.getElementById('media-network-table'),
      tabNetworkCount: document.getElementById('tab-network-count'),
      pipelineTimelineCard: document.getElementById('pipeline-timeline-card'),
      pipelineTimeline: document.getElementById('pipeline-timeline'),
      activityStream: document.getElementById('activity-stream'),
      actStats: document.getElementById('act-stats'),
      actCount: document.getElementById('act-count'),
      actTruncated: document.getElementById('act-truncated'),
      actTruncatedCount: document.getElementById('act-truncated-count'),
      actShowAll: document.getElementById('act-show-all'),
      autoScroll: document.getElementById('auto-scroll'),
      logViewerCard: document.getElementById('log-viewer-card'),
      logViewer: document.getElementById('log-viewer'),
      logAutoScroll: document.getElementById('log-auto-scroll'),
      logSize: document.getElementById('log-size'),
      logStats: document.getElementById('log-stats'),
      logTruncated: document.getElementById('log-truncated'),
      logTruncatedMsg: document.getElementById('log-truncated-msg'),
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
      settingsOverlay: document.getElementById('settings-overlay'),
      settingsClose: document.getElementById('settings-close'),
      settingsBody: document.getElementById('settings-body'),
      reportBtn: document.getElementById('report-btn'),
      logoutBtn: document.getElementById('logout-btn'),
      runSearch: document.getElementById('run-search'),
      filterPills: document.getElementById('filter-pills'),
      newRunBtn: document.getElementById('new-run-btn'),
      newRunOverlay: document.getElementById('new-run-overlay'),
      nrRepoSelectWrap: document.getElementById('nr-repo-select-wrap'),
      nrRepoSelect: document.getElementById('nr-repo-select'),
      nrRepoCustomWrap: document.getElementById('nr-repo-custom-wrap'),
      nrRepo: document.getElementById('nr-repo'),
      nrRepoCustomToggle: document.getElementById('nr-repo-custom-toggle'),
      nrRepoRefresh: document.getElementById('nr-repo-refresh'),
      nrRepoMeta: document.getElementById('nr-repo-meta'),
      nrBranch: document.getElementById('nr-branch'),
      nrTask: document.getElementById('nr-task'),
      nrPipeline: document.getElementById('nr-pipeline'),
      nrError: document.getElementById('nr-error'),
      nrCancel: document.getElementById('nr-cancel'),
      nrSubmit: document.getElementById('nr-submit'),
      evalsBtn: document.getElementById('evals-btn'),
      evalsOverlay: document.getElementById('evals-overlay'),
      evalsClose: document.getElementById('evals-close'),
      evalsScenarioList: document.getElementById('evals-scenario-list'),
      evalsResults: document.getElementById('evals-results'),
      learningsBtn: document.getElementById('learnings-btn'),
      learningsOverlay: document.getElementById('learnings-overlay'),
      learningsClose: document.getElementById('learnings-close'),
      learningsSystem: document.getElementById('learnings-system'),
      learningsRepos: document.getElementById('learnings-repos'),
      learningsOutcomes: document.getElementById('learnings-outcomes'),
      pipelinesBtn: document.getElementById('pipelines-btn'),
      pipelinesOverlay: document.getElementById('pipelines-overlay'),
      pipelinesClose: document.getElementById('pipelines-close'),
      plList: document.getElementById('pl-list'),
      plNewBtn: document.getElementById('pl-new-btn'),
      plEditor: document.getElementById('pl-editor'),
      plEditorTitle: document.getElementById('pl-editor-title'),
      plEditorId: document.getElementById('pl-editor-id'),
      plEditorYaml: document.getElementById('pl-editor-yaml'),
      plEditorResult: document.getElementById('pl-editor-result'),
      plEditorCancel: document.getElementById('pl-editor-cancel'),
      plEditorValidate: document.getElementById('pl-editor-validate'),
      plEditorSave: document.getElementById('pl-editor-save'),
    };

    // Session tab switching
    el.sessionTabs.addEventListener('click', function(e) {
      var btn = e.target.closest('.session-tab');
      if (!btn) return;
      var tabName = btn.getAttribute('data-tab');
      el.sessionTabs.querySelectorAll('.session-tab').forEach(function(t) { t.classList.remove('active'); });
      btn.classList.add('active');
      document.querySelectorAll('.session-panel').forEach(function(p) { p.classList.remove('active'); });
      var panel = document.getElementById('panel-' + tabName);
      if (panel) panel.classList.add('active');
    });

    async function fetchJson(url, options) {
      const response = await fetch(url, options);
      if (!response.ok) {
        const text = await response.text();
        var msg = 'Request failed';
        try { msg = JSON.parse(text).error || msg; } catch (_) { msg = text || msg; }
        throw new Error(msg);
      }
      return response.json();
    }

    var BOARD_COLUMNS = {
      product_discovery: [
        'backlog',
        'in_progress',
        'waiting_for_review',
        'waiting_for_pm_confirmation',
        'done',
        'cancelled',
      ],
      feature_delivery: [
        'backlog',
        'in_progress',
        'auto_review',
        'engineering_review',
        'qa_preparation',
        'product_review',
        'qa_review',
        'ready_for_merge',
        'done',
        'cancelled',
      ],
    };

    function titleCaseWorkItemState(value) {
      return String(value || '')
        .split('_')
        .filter(Boolean)
        .map(function(part) {
          return part.charAt(0).toUpperCase() + part.slice(1);
        })
        .join(' ');
    }

    function workItemDisplayId(item) {
      return item.jiraIssueKey || shortId(item.id);
    }

    function workflowStates(workflow) {
      return BOARD_COLUMNS[workflow] || [];
    }

    function setBoardStatusMessage(message, tone) {
      if (!el.boardStatusMessage) return;
      el.boardStatusMessage.textContent = message || '';
      el.boardStatusMessage.className = 'board-status-message' + (tone ? ' ' + tone : '');
    }

    function populateOverrideStateOptions(workflow, selectedState) {
      if (!el.boardOverrideState) return;
      while (el.boardOverrideState.options.length > 0) {
        el.boardOverrideState.remove(0);
      }
      workflowStates(workflow).forEach(function(stateValue) {
        var option = document.createElement('option');
        option.value = stateValue;
        option.textContent = titleCaseWorkItemState(stateValue);
        if (stateValue === selectedState) {
          option.selected = true;
        }
        el.boardOverrideState.appendChild(option);
      });
    }

    function updateDashboardChrome() {
      var boardMode = state.viewMode === 'board';
      el.appRoot.classList.toggle('board-mode', boardMode);
      el.runsView.style.display = boardMode ? 'none' : '';
      el.boardView.classList.toggle('active', boardMode);
      if (el.sidebarTitle) {
        el.sidebarTitle.textContent = boardMode ? 'Work Items' : 'Runs';
      }
      if (el.viewSwitch) {
        el.viewSwitch.querySelectorAll('[data-view]').forEach(function(button) {
          var isActive = button.getAttribute('data-view') === state.viewMode;
          button.classList.toggle('active', isActive);
        });
      }
    }

    function shortId(id) {
      return id.slice(0, 8);
    }

    function currentHashTarget() {
      var hash = window.location.hash || '';
      if (hash.startsWith('#run/')) {
        return { type: 'run', prefix: hash.slice(5) };
      }
      if (hash.startsWith('#work-item/')) {
        return { type: 'workItem', prefix: decodeURIComponent(hash.slice(11)) };
      }
      return null;
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
        el.mediaCard.style.display = 'none';
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
      titleNode.textContent = run.title || truncateTask(run.task, 120);
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

      // Token usage row
      if (run.tokenUsage) {
        var tokenRow = document.createElement('div');
        tokenRow.className = 'summary-meta-row';
        var gateTokens = (run.tokenUsage.qualityGateInputTokens || 0) + (run.tokenUsage.qualityGateOutputTokens || 0);
        if (gateTokens > 0) {
          addChip('token', 'Gates: ' + gateTokens.toLocaleString() + ' tokens', 'Input: ' + (run.tokenUsage.qualityGateInputTokens || 0).toLocaleString() + ', Output: ' + (run.tokenUsage.qualityGateOutputTokens || 0).toLocaleString());
        }
        var agentIn = run.tokenUsage.agentInputTokens || 0;
        var agentOut = run.tokenUsage.agentOutputTokens || 0;
        if (agentIn + agentOut > 0) {
          addChip('smart_toy', 'Agent: ' + (agentIn + agentOut).toLocaleString() + ' tokens', 'Input: ' + agentIn.toLocaleString() + ', Output: ' + agentOut.toLocaleString());
        }
        if (run.tokenUsage.costUsd) {
          addChip('payments', '$' + run.tokenUsage.costUsd.toFixed(4), 'Estimated run cost (OpenRouter + Agent)');
        }
        el.summary.appendChild(tokenRow);
      }

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

    var consoleFilter = 'all';

    async function loadMedia(runId) {
      if (!runId) {
        el.mediaCard.style.display = 'none';
        return;
      }
      try {
        var data = await fetchJson('/api/runs/' + encodeURIComponent(runId) + '/media');
        var hasContent = false;
        var baseUrl = '/api/runs/' + encodeURIComponent(runId) + '/artifacts/';

        // ── Replay tab: Video + Screenshots ──
        var hasReplay = false;
        if (data.video) {
          var newSrc = baseUrl + data.video.path;
          if (el.mediaVideoPlayer.src !== newSrc && !el.mediaVideoPlayer.src.endsWith(newSrc)) {
            el.mediaVideoPlayer.src = newSrc;
          }
          el.mediaVideo.style.display = '';
          hasReplay = true;
        } else {
          el.mediaVideo.style.display = 'none';
          el.mediaVideoPlayer.src = '';
        }

        el.mediaScreenshotsGrid.innerHTML = '';
        if (data.screenshots && data.screenshots.length > 0) {
          for (var i = 0; i < data.screenshots.length; i++) {
            var ss = data.screenshots[i];
            var link = document.createElement('a');
            link.href = baseUrl + ss.path;
            link.target = '_blank';
            link.rel = 'noreferrer noopener';
            link.title = ss.name + ' (' + Math.round(ss.size / 1024) + ' KB)';
            var img = document.createElement('img');
            img.src = baseUrl + ss.path;
            img.alt = ss.name;
            img.style.cssText = 'width: 100%; border-radius: 6px; border: 1px solid var(--border); cursor: zoom-in;';
            link.appendChild(img);
            el.mediaScreenshotsGrid.appendChild(link);
          }
          el.mediaScreenshots.style.display = '';
          hasReplay = true;
        } else {
          el.mediaScreenshots.style.display = 'none';
        }
        el.panelReplayEmpty.style.display = hasReplay ? 'none' : '';
        if (hasReplay) hasContent = true;

        // ── Actions tab ──
        if (data.agentActions && data.agentActions.length > 0) {
          el.tabActionsCount.textContent = data.agentActions.length;
          var actHtml = '<table class="actions-table"><thead><tr>';
          actHtml += '<th style="width: 40px;">#</th>';
          actHtml += '<th style="width: 80px;">Type</th>';
          actHtml += '<th>Detail</th>';
          actHtml += '<th style="width: 60px;">Page</th>';
          actHtml += '</tr></thead><tbody>';
          for (var ai = 0; ai < data.agentActions.length; ai++) {
            var act = data.agentActions[ai];
            var typeClass = sanitizeCssClass((act.type || '').toLowerCase());
            var detail = act.reasoning || act.action || act.url || '';
            if (detail.length > 200) detail = detail.slice(0, 200) + '…';
            var pageLink = '';
            if (act.pageUrl) {
              var safeHref = sanitizeUrlHref(act.pageUrl);
              if (safeHref) { pageLink = '<a href="' + safeHref + '" target="_blank" rel="noreferrer" style="color: var(--ring); text-decoration: none;" title="' + escapeHtml(act.pageUrl) + '">↗</a>'; }
            }
            actHtml += '<tr>';
            actHtml += '<td style="color: var(--muted);">' + (ai + 1) + '</td>';
            actHtml += '<td><span class="action-type-pill ' + typeClass + '">' + escapeHtml(act.type || '?') + '</span></td>';
            actHtml += '<td style="white-space: pre-wrap; word-break: break-word; max-width: 500px;">' + escapeHtml(detail) + '</td>';
            actHtml += '<td style="text-align: center;">' + pageLink + '</td>';
            actHtml += '</tr>';
          }
          actHtml += '</tbody></table>';
          el.mediaActionsTable.innerHTML = actHtml;
          el.panelActionsEmpty.style.display = 'none';
          hasContent = true;
        } else {
          el.tabActionsCount.textContent = '';
          el.mediaActionsTable.innerHTML = '';
          el.panelActionsEmpty.style.display = '';
        }

        // ── Console tab ──
        if (data.consoleLogs && data.consoleLogs.length > 0) {
          el.tabConsoleCount.textContent = data.consoleLogs.length;
          el.mediaConsoleEntries.innerHTML = '';

          function renderConsoleLogs() {
            el.mediaConsoleEntries.innerHTML = '';
            for (var ci = 0; ci < data.consoleLogs.length; ci++) {
              var entry = data.consoleLogs[ci];
              if (consoleFilter !== 'all' && entry.level !== consoleFilter) continue;
              var line = document.createElement('div');
              var levelClass = KNOWN_CONSOLE_LEVELS[entry.level] ? entry.level : 'log';
              line.className = 'console-entry ' + levelClass;
              var levelSpan = document.createElement('span');
              levelSpan.className = 'level';
              levelSpan.textContent = entry.level || 'log';
              line.appendChild(levelSpan);
              var msgSpan = document.createElement('span');
              msgSpan.textContent = entry.message;
              line.appendChild(msgSpan);
              el.mediaConsoleEntries.appendChild(line);
            }
          }

          renderConsoleLogs();

          var filterBtns = document.querySelectorAll('.console-filter-btn');
          for (var fi = 0; fi < filterBtns.length; fi++) {
            filterBtns[fi].onclick = function(e) {
              consoleFilter = e.target.getAttribute('data-level');
              filterBtns.forEach(function(b) { b.classList.remove('active'); });
              e.target.classList.add('active');
              renderConsoleLogs();
            };
          }

          el.mediaConsoleFilters.style.display = '';
          el.panelConsoleEmpty.style.display = 'none';
          hasContent = true;
        } else {
          el.tabConsoleCount.textContent = '';
          el.mediaConsoleEntries.innerHTML = '';
          el.mediaConsoleFilters.style.display = 'none';
          el.panelConsoleEmpty.style.display = '';
        }

        // ── Network tab ──
        if (data.networkLog && data.networkLog.length > 0) {
          el.tabNetworkCount.textContent = data.networkLog.length;
          var netHtml = '<table class="network-table"><thead><tr>';
          netHtml += '<th>URL</th>';
          netHtml += '<th>Method</th>';
          netHtml += '<th>Status</th>';
          netHtml += '<th>Duration</th>';
          netHtml += '<th>Size</th>';
          netHtml += '</tr></thead><tbody>';
          for (var ni = 0; ni < data.networkLog.length; ni++) {
            var req = data.networkLog[ni];
            var statusClass = '';
            if (req.error || req.status >= 400) statusClass = 'status-err';
            else if (req.durationMs > 2000) statusClass = 'status-slow';
            else if (req.status >= 200 && req.status < 300) statusClass = 'status-ok';
            var shortUrl = req.url;
            try { shortUrl = new URL(req.url).pathname; } catch {}
            netHtml += '<tr class="' + statusClass + '">';
            netHtml += '<td class="url-cell" title="' + escapeHtml(req.url || '') + '">' + escapeHtml(shortUrl) + '</td>';
            netHtml += '<td>' + escapeHtml(req.method || '') + '</td>';
            netHtml += '<td>' + (req.error ? escapeHtml(req.error) : escapeHtml(String(req.status || '\u2014'))) + '</td>';
            netHtml += '<td>' + (req.durationMs !== undefined ? req.durationMs + 'ms' : '\u2014') + '</td>';
            netHtml += '<td>' + (req.encodedDataLength !== undefined ? Math.round(req.encodedDataLength / 1024) + ' KB' : '\u2014') + '</td>';
            netHtml += '</tr>';
          }
          netHtml += '</tbody></table>';
          el.mediaNetworkTable.innerHTML = netHtml;
          el.panelNetworkEmpty.style.display = 'none';
          hasContent = true;
        } else {
          el.tabNetworkCount.textContent = '';
          el.mediaNetworkTable.innerHTML = '';
          el.panelNetworkEmpty.style.display = '';
        }

        el.mediaCard.style.display = hasContent ? '' : 'none';
      } catch {
        el.mediaCard.style.display = 'none';
      }
    }

    function escapeHtml(str) {
      if (!str) return '';
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function sanitizeUrlHref(url) {
      if (!url) return '';
      try {
        var parsed = new URL(url);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return escapeHtml(url);
      } catch {}
      return '';
    }

    function sanitizeCssClass(str) {
      if (!str) return '';
      return str.replace(/[^a-z0-9_-]/g, '');
    }

    var KNOWN_CONSOLE_LEVELS = { log: true, info: true, warn: true, warning: true, error: true, debug: true, trace: true };

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

    function getFilteredRuns() {
      return state.runs.filter(function(run) {
        if (currentStatusFilter !== 'all') {
          if (currentStatusFilter === 'running') {
            if (run.status !== 'running' && run.status !== 'queued' && run.status !== 'validating' && run.status !== 'pushing' && run.status !== 'awaiting_ci' && run.status !== 'ci_fixing') return false;
          } else if (run.status !== currentStatusFilter) return false;
        }
        if (currentSearchQuery) {
          var q = currentSearchQuery;
          var haystack = ((run.title || '') + ' ' + (run.task || '') + ' ' + run.repoSlug + ' ' + run.id).toLowerCase();
          if (!haystack.includes(q)) return false;
        }
        return true;
      });
    }

    function renderRuns() {
      el.runs.innerHTML = '';
      var filtered = getFilteredRuns();
      for (var i = 0; i < filtered.length; i++) {
        var run = filtered[i];
        var button = document.createElement('button');
        button.className = 'run-item' + (state.selectedId === run.id ? ' active' : '');
        button.onclick = (function(runId) {
          return function() {
            state.selectedId = runId;
            window.location.hash = '#run/' + runId.slice(0, 8);
            activityShowAll = false;
            lastRenderedEventCount = -1;
            renderRuns();
            refreshSelected().catch(console.error);
          };
        })(run.id);

        var top = document.createElement('div');
        top.className = 'run-item-top';

        var taskNode = document.createElement('div');
        taskNode.className = 'run-item-task';
        taskNode.textContent = run.title || truncateTask(run.task, 80);
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

    /**
     * Minimal markdown → HTML for agent thinking blocks.
     * Handles: headers, bold, inline code, code blocks, lists.
     * No external dependencies.
     */
    /**
     * Minimal markdown to HTML for agent thinking blocks.
     * Uses RegExp constructors to avoid regex-in-template-literal TS parse issues.
     */
    var mdPatterns = {
      amp: new RegExp('&', 'g'),
      lt: new RegExp('<', 'g'),
      gt: new RegExp('>', 'g'),
      fence: new RegExp('\x60\x60\x60([\\\\s\\\\S]*?)\x60\x60\x60', 'g'),
      header: new RegExp('^(#{1,4})\\\\s+(.+)$'),
      ul: new RegExp('^\\\\s*[-*]\\\\s+(.+)$'),
      ol: new RegExp('^\\\\s*\\\\d+\\\\.\\\\s+(.+)$'),
      bold: new RegExp('\\\\*\\\\*(.+?)\\\\*\\\\*', 'g'),
      code: new RegExp('\x60([^\x60]+)\x60', 'g'),
    };

    function miniMarkdown(text) {
      var escaped = text
        .replace(mdPatterns.amp, '&amp;')
        .replace(mdPatterns.lt, '&lt;')
        .replace(mdPatterns.gt, '&gt;');

      escaped = escaped.replace(mdPatterns.fence, function(_, code) {
        return '<pre class="md-code-block">' + code.trim() + '</pre>';
      });

      var lines = escaped.split('\\n');
      var result = [];
      var inList = false;

      for (var li = 0; li < lines.length; li++) {
        var line = lines[li];

        var headerMatch = line.match(mdPatterns.header);
        if (headerMatch) {
          if (inList) { result.push('</ul>'); inList = false; }
          var level = Math.min(headerMatch[1].length + 2, 6);
          result.push('<h' + level + ' class="md-heading">' + inlineFormat(headerMatch[2]) + '</h' + level + '>');
          continue;
        }

        var listMatch = line.match(mdPatterns.ul);
        if (listMatch) {
          if (!inList) { result.push('<ul class="md-list">'); inList = true; }
          result.push('<li>' + inlineFormat(listMatch[1]) + '</li>');
          continue;
        }

        var numMatch = line.match(mdPatterns.ol);
        if (numMatch) {
          if (!inList) { result.push('<ul class="md-list">'); inList = true; }
          result.push('<li>' + inlineFormat(numMatch[1]) + '</li>');
          continue;
        }

        if (inList) { result.push('</ul>'); inList = false; }

        if (!line.trim()) {
          result.push('<br>');
          continue;
        }

        result.push('<span class="md-line">' + inlineFormat(line) + '</span>');
      }

      if (inList) result.push('</ul>');
      return result.join('');
    }

    function inlineFormat(text) {
      text = text.replace(mdPatterns.bold, '<strong>$1</strong>');
      text = text.replace(mdPatterns.code, '<code class="md-inline-code">$1</code>');
      return text;
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

    function renderPipelineTimeline(events, isActive) {
      if (!events || events.length === 0) {
        el.pipelineTimelineCard.style.display = 'none';
        return;
      }
      el.pipelineTimelineCard.style.display = '';

      // Build progress bar from node events
      var nodeStates = {};
      var nodeOrder = [];
      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        if (ev.type === 'node_start' && ev.nodeId) {
          if (!nodeStates[ev.nodeId]) nodeOrder.push(ev.nodeId);
          nodeStates[ev.nodeId] = 'active';
        } else if (ev.type === 'node_end' && ev.nodeId) {
          if (!nodeStates[ev.nodeId]) nodeOrder.push(ev.nodeId);
          if (ev.outcome === 'success' || ev.outcome === 'skipped') {
            nodeStates[ev.nodeId] = 'done';
          } else if (ev.outcome === 'soft_fail') {
            nodeStates[ev.nodeId] = 'warn';
          } else {
            nodeStates[ev.nodeId] = 'fail';
          }
        }
      }

      // Render progress bar
      var progressBar = document.createElement('div');
      progressBar.className = 'phase-progress';
      for (var pi = 0; pi < nodeOrder.length; pi++) {
        var step = document.createElement('div');
        step.className = 'phase-step ' + (nodeStates[nodeOrder[pi]] || '');
        step.title = nodeOrder[pi];
        progressBar.appendChild(step);
      }

      // Render text log
      var lines = [];
      for (var j = 0; j < events.length; j++) {
        var evt = events[j];
        var ts = evt.timestamp ? evt.timestamp.split('T')[1].split('.')[0] : '';
        if (evt.type === 'node_start') {
          lines.push(ts + '  \u25B6 ' + (evt.nodeId || ''));
        } else if (evt.type === 'node_end') {
          var dur = evt.durationMs ? ' (' + (evt.durationMs / 1000).toFixed(1) + 's)' : '';
          var icon = evt.outcome === 'success' ? '\u2705' : evt.outcome === 'skipped' ? '\u23ED' : evt.outcome === 'soft_fail' ? '\u26A0\uFE0F' : '\u274C';
          lines.push(ts + '  ' + icon + ' ' + (evt.nodeId || '') + dur + (evt.error ? ' \u2014 ' + evt.error.slice(0, 80) : ''));
        } else if (evt.type === 'phase_change') {
          lines.push(ts + '  \u{1F504} phase \u2192 ' + (evt.phase || ''));
        } else if (evt.type === 'artifact' && evt.artifact) {
          var artifact = String(evt.artifact);
          if (artifact.indexOf('loop_start:') === 0) {
            var startParts = artifact.split(':');
            lines.push(ts + '  \u{1F501} retry loop start ' + (startParts[1] || '') + ' via ' + (startParts[2] || '') + ' (max ' + (startParts[3] || '?') + ')');
          } else if (artifact.indexOf('loop_fix_failed:') === 0) {
            var fixParts = artifact.split(':');
            lines.push(ts + '  \u26A0\uFE0F fix attempt failed ' + (fixParts[1] || '') + ' #' + (fixParts[2] || '?') + ' (' + (fixParts[3] || 'failure') + ')');
          } else if (artifact.indexOf('loop_retry_failed:') === 0) {
            var retryParts = artifact.split(':');
            lines.push(ts + '  \u26A0\uFE0F retry check failed ' + (retryParts[1] || '') + ' #' + (retryParts[2] || '?') + ' (' + (retryParts[3] || 'failure') + ')');
          } else if (artifact.indexOf('loop_success:') === 0) {
            var successParts = artifact.split(':');
            lines.push(ts + '  \u2705 retry loop resolved ' + (successParts[1] || '') + ' on attempt #' + (successParts[2] || '?'));
          } else if (artifact.indexOf('loop_exhausted:') === 0) {
            var exhaustedParts = artifact.split(':');
            lines.push(ts + '  \u274C retry loop exhausted ' + (exhaustedParts[1] || '') + ' after ' + (exhaustedParts[2] || '?') + ' rounds');
          } else if (artifact.indexOf('loop_bypassed:') === 0) {
            var bypassParts = artifact.split(':');
            lines.push(ts + '  \u23ED retry loop bypassed ' + (bypassParts[1] || '') + ' (' + (bypassParts[2] || 'unknown') + ')');
          } else if (artifact.indexOf('dynamic_skip:') === 0) {
            var skipParts = artifact.split(':');
            lines.push(ts + '  \u{1F9E0} dynamic skip from ' + (skipParts[1] || '') + ' → ' + (skipParts[2] || ''));
          } else if (artifact.indexOf('decision_reason:') === 0) {
            var reasonParts = artifact.split(':');
            lines.push(ts + '  \u{1F4A1} decision ' + (reasonParts[1] || '') + ': ' + (reasonParts.slice(2).join(':') || ''));
          }
        } else if (evt.type === 'error') {
          lines.push(ts + '  \u274C ' + (evt.error || ''));
        }
      }

      el.pipelineTimeline.innerHTML = '';
      el.pipelineTimeline.appendChild(progressBar);
      var pre = document.createElement('pre');
      pre.style.cssText = 'margin: 8px 0 0; white-space: pre-wrap; font-size: 11px;';
      pre.textContent = lines.join('\\n');
      el.pipelineTimeline.appendChild(pre);
    }

    function renderActivityStream(events, stats, isActive, serverTotalCount) {
      if (!events || events.length === 0) {
        el.activityStream.innerHTML = '<div class="act-info">No activity events parsed.</div>';
        el.actStats.innerHTML = isActive ? '<span class="live-badge">Live</span>' : '';
        el.actCount.textContent = '';
        el.actTruncated.style.display = 'none';
        lastRenderedEventCount = -1;
        return;
      }

      var totalCount = serverTotalCount != null ? serverTotalCount : events.length;

      // Skip re-render if event count unchanged (no new events since last poll)
      if (totalCount === lastRenderedEventCount) {
        return;
      }
      lastRenderedEventCount = totalCount;

      // Server already sliced via ?limit=N, so events here is the visible window
      var visibleEvents = events;
      var hiddenCount = totalCount - visibleEvents.length;

      // Show/hide truncation banner
      if (hiddenCount > 0) {
        el.actTruncated.style.display = '';
        el.actTruncatedCount.textContent = hiddenCount + ' earlier events hidden';
      } else {
        el.actTruncated.style.display = 'none';
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

      for (var idx = 0; idx < visibleEvents.length; idx++) {
        var ev = visibleEvents[idx];
        var node = document.createElement('div');
        node.className = 'act-event';

        if (ev.type === 'agent_thinking') {
          node.classList.add('act-thinking');
          node.innerHTML = miniMarkdown(ev.content);
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
          else if (ev.params && ev.params.query) descText = '"' + ev.params.query + '"';
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

          // Show memory tool results (extracted from Annotated blocks)
          if (ev.result) {
            var resultDiv = document.createElement('div');
            resultDiv.className = 'act-tool-result';
            var resultLabel = document.createElement('span');
            resultLabel.className = 'act-result-label';
            resultLabel.textContent = 'result';
            resultDiv.appendChild(resultLabel);
            var resultText = document.createElement('pre');
            resultText.className = 'act-result-text';
            resultText.textContent = ev.result;
            resultDiv.appendChild(resultText);
            body.appendChild(resultDiv);
          }

          header.onclick = function(targetNode) {
            return function() {
              targetNode.classList.toggle('open');
            };
          }(node);

          node.appendChild(header);
          node.appendChild(body);
        } else if (ev.type === 'phase_marker') {
          node.classList.add('act-phase');
          var phaseIcon = document.createElement('span');
          phaseIcon.className = 'material-symbols-rounded';
          phaseIcon.textContent = ev.phase === 'cloning' ? 'download' : ev.phase === 'agent' ? 'smart_toy' : ev.phase === 'committing' ? 'save' : ev.phase === 'pushing' ? 'cloud_upload' : 'flag';
          node.appendChild(phaseIcon);
          // Show clean phase labels instead of raw pipeline commands
          var phaseLabels = {
            cloning: 'Cloning repository',
            agent: 'Agent started',
            committing: 'Committing changes',
            pushing: 'Pushing to remote',
          };
          var phaseLabel = phaseLabels[ev.phase] || ev.phase || 'phase';
          var phaseText = document.createTextNode(phaseLabel);
          node.appendChild(phaseText);
          if (ev.progressPercent > 0) {
            var phaseBadge = document.createElement('span');
            phaseBadge.className = 'act-badge';
            phaseBadge.textContent = ev.progressPercent + '%';
            node.appendChild(phaseBadge);
          }
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
        } else if (ev.type === 'pipeline_message') {
          node.classList.add('act-pipeline');
          if (ev.phase) node.classList.add('pl-' + ev.phase);
          var plIcon = document.createElement('span');
          plIcon.className = 'material-symbols-rounded';
          plIcon.textContent = ev.phase === 'success' ? 'check_circle' : ev.phase === 'error' ? 'error' : ev.phase === 'warn' ? 'warning' : 'settings';
          node.appendChild(plIcon);
          var plText = document.createTextNode(ev.content);
          node.appendChild(plText);
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
        if (isActive) {
          var liveBadge = document.createElement('span');
          liveBadge.className = 'live-badge';
          liveBadge.textContent = 'Live';
          el.actStats.appendChild(liveBadge);
        }
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

      el.actCount.textContent = (hiddenCount > 0 ? visibleEvents.length + ' of ' : '') + totalCount + ' events';

      if (el.autoScroll.checked && wasNearBottom) {
        el.activityStream.scrollTop = el.activityStream.scrollHeight;
      }
    }

    async function loadRuns() {
      const [runsData, statsData] = await Promise.all([
        fetchJson('/api/runs?limit=200'),
        fetchJson('/api/stats').catch(function() { return {}; }),
      ]);
      state.runs = runsData.runs || [];
      el.meta.textContent = state.runs.length + ' runs';
      if (el.topMeta) {
        var parts = [state.runs.length + ' runs'];
        if (statsData.successRate !== undefined) parts.push(statsData.successRate + '% success');
        if (statsData.totalCostUsd > 0) parts.push('$' + statsData.totalCostUsd.toFixed(2) + ' total');
        el.topMeta.textContent = parts.join(' | ');
      }
      if (state.selectedId && !state.runs.some((run) => run.id === state.selectedId)) {
        state.selectedId = null;
      }
      if (!state.selectedId && state.runs.length > 0) {
        var hashTarget = currentHashTarget();
        if (hashTarget && hashTarget.type === 'run') {
          var prefix = hashTarget.prefix;
          var match = state.runs.find(function(r) { return r.id.startsWith(prefix); });
          if (match) { state.selectedId = match.id; }
          else { state.selectedId = state.runs[0].id; }
        } else {
          state.selectedId = state.runs[0].id;
        }
      }
      renderRuns();
    }

    async function loadWorkItems() {
      var workflow = state.boardWorkflow || 'product_discovery';
      var data = await fetchJson('/api/work-items?workflow=' + encodeURIComponent(workflow));
      state.workItems = Array.isArray(data.workItems) ? data.workItems : [];
      var hashTarget = currentHashTarget();
      if (hashTarget && hashTarget.type === 'workItem') {
        var hashMatch = state.workItems.find(function(item) {
          return item.id === hashTarget.prefix || item.id.startsWith(hashTarget.prefix);
        });
        if (hashMatch) {
          state.selectedWorkItemId = hashMatch.id;
          state.viewMode = 'board';
          updateDashboardChrome();
        }
      }
      if (state.selectedWorkItemId && !state.workItems.some(function(item) { return item.id === state.selectedWorkItemId; })) {
        state.selectedWorkItemId = null;
        state.selectedWorkItem = null;
        state.selectedWorkItemReviewRequests = [];
        state.selectedWorkItemEvents = [];
      }
      if (!state.selectedWorkItemId && state.workItems.length > 0) {
        state.selectedWorkItemId = state.workItems[0].id;
      }
      if (el.boardMeta) {
        el.boardMeta.textContent = state.workItems.length + ' work items';
      }
      if (state.viewMode === 'board' && el.topMeta) {
        el.topMeta.textContent = state.workItems.length + ' work items';
      }
      renderBoard();
      if (state.selectedWorkItemId) {
        await refreshSelectedWorkItem();
      } else {
        renderBoardDetail();
      }
    }

    function canRetry(run) {
      return run.status === 'failed' || run.status === 'completed';
    }

    function renderBoard() {
      if (!el.boardColumns) return;
      el.boardColumns.innerHTML = '';

      var workflow = state.boardWorkflow || 'product_discovery';
      var columns = BOARD_COLUMNS[workflow] || [];

      for (var i = 0; i < columns.length; i++) {
        var columnState = columns[i];
        var items = state.workItems.filter(function(item) {
          return item.state === columnState;
        });

        var column = document.createElement('section');
        column.className = 'board-column';

        var head = document.createElement('div');
        head.className = 'board-column-head';

        var title = document.createElement('div');
        title.className = 'board-column-title';
        title.textContent = titleCaseWorkItemState(columnState);

        var count = document.createElement('div');
        count.className = 'board-column-count';
        count.textContent = String(items.length);

        head.appendChild(title);
        head.appendChild(count);
        column.appendChild(head);

        var list = document.createElement('div');
        list.className = 'board-column-items';

        if (items.length === 0) {
          var empty = document.createElement('div');
          empty.className = 'board-empty';
          empty.textContent = 'No work items in this state.';
          list.appendChild(empty);
        }

        for (var j = 0; j < items.length; j++) {
          var item = items[j];
          var card = document.createElement('article');
          card.className = 'board-card' + (state.selectedWorkItemId === item.id ? ' selected' : '');
          card.onclick = (function(workItemId) {
            return function() {
              state.selectedWorkItemId = workItemId;
              window.location.hash = '#work-item/' + encodeURIComponent(workItemId.slice(0, 8));
              renderBoard();
              refreshSelectedWorkItem().catch(function(error) {
                setBoardStatusMessage(error.message || 'Failed to load work item detail', 'error');
              });
            };
          })(item.id);

          var top = document.createElement('div');
          top.className = 'board-card-top';

          var key = document.createElement('span');
          key.className = 'board-card-key';
          key.textContent = workItemDisplayId(item);
          top.appendChild(key);

          if (item.substate) {
            var substate = document.createElement('span');
            substate.className = 'board-chip';
            substate.textContent = titleCaseWorkItemState(item.substate);
            top.appendChild(substate);
          }

          var titleNode = document.createElement('div');
          titleNode.className = 'board-card-title';
          titleNode.textContent = item.title || '(untitled work item)';

          var summary = document.createElement('div');
          summary.className = 'board-card-summary';
          summary.textContent = truncateTask(item.summary || '', 180);

          var meta = document.createElement('div');
          meta.className = 'board-card-meta';
          meta.textContent = 'Updated ' + timeAgo(item.updatedAt);

          card.appendChild(top);
          card.appendChild(titleNode);
          card.appendChild(summary);
          card.appendChild(meta);

          if (Array.isArray(item.flags) && item.flags.length > 0) {
            var flags = document.createElement('div');
            flags.className = 'board-flags';
            item.flags.slice(0, 4).forEach(function(flag) {
              var chip = document.createElement('span');
              chip.className = 'board-chip';
              chip.textContent = titleCaseWorkItemState(flag);
              flags.appendChild(chip);
            });
            if (item.flags.length > 4) {
              var moreChip = document.createElement('span');
              moreChip.className = 'board-chip';
              moreChip.textContent = '+' + String(item.flags.length - 4) + ' more';
              flags.appendChild(moreChip);
            }
            card.appendChild(flags);
          }

          list.appendChild(card);
        }

        column.appendChild(list);
        el.boardColumns.appendChild(column);
      }
    }

    async function refreshSelectedWorkItem() {
      if (!state.selectedWorkItemId) {
        state.selectedWorkItem = null;
        state.selectedWorkItemReviewRequests = [];
        state.selectedWorkItemReviewComments = {};
        state.selectedWorkItemEvents = [];
        renderBoardDetail();
        return;
      }

      var encodedId = encodeURIComponent(state.selectedWorkItemId);
      var results = await Promise.all([
        fetchJson('/api/work-items/' + encodedId),
        fetchJson('/api/work-items/' + encodedId + '/review-requests').catch(function() { return { reviewRequests: [] }; }),
        fetchJson('/api/work-items/' + encodedId + '/events').catch(function() { return { events: [] }; }),
      ]);

      state.selectedWorkItem = results[0].workItem || null;
      state.selectedWorkItemReviewRequests = Array.isArray(results[1].reviewRequests) ? results[1].reviewRequests : [];
      state.selectedWorkItemEvents = Array.isArray(results[2].events) ? results[2].events : [];
      state.selectedWorkItemReviewComments = {};
      if (state.selectedWorkItemReviewRequests.length > 0) {
        var commentResults = await Promise.all(state.selectedWorkItemReviewRequests.map(function(request) {
          return fetchJson('/api/work-items/' + encodedId + '/review-requests/' + encodeURIComponent(request.id) + '/comments')
            .then(function(payload) {
              return [request.id, Array.isArray(payload.comments) ? payload.comments : []];
            })
            .catch(function() {
              return [request.id, []];
            });
        }));
        commentResults.forEach(function(entry) {
          state.selectedWorkItemReviewComments[entry[0]] = entry[1];
        });
      }
      renderBoard();
      renderBoardDetail();
    }

    function renderBoardDetail() {
      var item = state.selectedWorkItem;
      if (!item) {
        el.boardDetailTitle.textContent = 'No work item selected';
        el.boardDetailSubtitle.textContent = 'Select a card to inspect workflow context, review requests and actions.';
        el.boardDetailMeta.innerHTML = '';
        el.boardDetailFlags.innerHTML = '';
        el.boardDetailSummary.className = 'board-detail-empty';
        el.boardDetailSummary.textContent = 'Choose a work item from the board to see details.';
        el.boardDetailReviews.className = 'board-detail-empty';
        el.boardDetailReviews.textContent = 'No review requests loaded.';
        el.boardDetailEvents.className = 'board-detail-empty';
        el.boardDetailEvents.textContent = 'No events loaded.';
        el.boardStopProcessing.disabled = true;
        el.boardConfirmApprove.disabled = true;
        el.boardConfirmRework.disabled = true;
        el.boardOverrideSubmit.disabled = true;
        if (el.boardOverrideSubstate) el.boardOverrideSubstate.value = '';
        if (el.boardOverrideReason) el.boardOverrideReason.value = '';
        populateOverrideStateOptions(state.boardWorkflow || 'product_discovery');
        return;
      }

      el.boardDetailTitle.textContent = item.title || '(untitled work item)';
      el.boardDetailSubtitle.textContent = workItemDisplayId(item) + ' · ' + titleCaseWorkItemState(item.workflow);
      el.boardDetailSummary.className = 'board-card-summary';
      el.boardDetailSummary.textContent = item.summary || 'No summary provided.';

      el.boardDetailMeta.innerHTML = '';
      [
        titleCaseWorkItemState(item.state),
        item.substate ? titleCaseWorkItemState(item.substate) : null,
        item.jiraIssueKey ? 'Jira ' + item.jiraIssueKey : null,
        item.githubPrNumber ? 'PR #' + item.githubPrNumber : null,
        'Updated ' + timeAgo(item.updatedAt),
      ].filter(Boolean).forEach(function(value) {
        var chip = document.createElement('span');
        chip.className = 'board-chip';
        chip.textContent = value;
        el.boardDetailMeta.appendChild(chip);
      });

      el.boardDetailFlags.innerHTML = '';
      if (Array.isArray(item.flags) && item.flags.length > 0) {
        item.flags.forEach(function(flag) {
          var chip = document.createElement('span');
          chip.className = 'board-chip';
          chip.textContent = titleCaseWorkItemState(flag);
          el.boardDetailFlags.appendChild(chip);
        });
      }

      populateOverrideStateOptions(item.workflow, item.state);
      if (el.boardOverrideSubstate) {
        el.boardOverrideSubstate.value = item.substate || '';
      }
      el.boardStopProcessing.disabled = item.state === 'done' || item.state === 'cancelled';
      el.boardOverrideSubmit.disabled = false;

      var canConfirmDiscovery = item.workflow === 'product_discovery' && item.state === 'waiting_for_pm_confirmation';
      el.boardConfirmApprove.disabled = !canConfirmDiscovery;
      el.boardConfirmRework.disabled = !canConfirmDiscovery;

      renderBoardReviewRequests(item);
      renderBoardEvents();
    }

    function renderBoardReviewRequests(item) {
      var reviewRequests = state.selectedWorkItemReviewRequests || [];
      if (!reviewRequests.length) {
        el.boardDetailReviews.className = 'board-detail-empty';
        el.boardDetailReviews.textContent = 'No review requests for this work item yet.';
        return;
      }

      var container = document.createElement('div');
      container.className = 'board-detail-section';

      reviewRequests.forEach(function(request) {
        var wrapper = document.createElement('div');
        wrapper.className = 'board-review-item';

        var head = document.createElement('div');
        head.className = 'board-review-head';

        var title = document.createElement('div');
        title.className = 'board-review-title';
        title.textContent = request.title || '(untitled review request)';

        var status = document.createElement('span');
        status.className = 'board-chip';
        status.textContent = titleCaseWorkItemState(request.status) + (request.outcome ? ' · ' + titleCaseWorkItemState(request.outcome) : '');

        head.appendChild(title);
        head.appendChild(status);
        wrapper.appendChild(head);

        if (request.requestMessage) {
          var message = document.createElement('div');
          message.className = 'board-review-message';
          message.textContent = request.requestMessage;
          wrapper.appendChild(message);
        }

        if (Array.isArray(request.focusPoints) && request.focusPoints.length > 0) {
          var focus = document.createElement('div');
          focus.className = 'board-review-focus';
          request.focusPoints.forEach(function(point) {
            var chip = document.createElement('span');
            chip.className = 'board-chip';
            chip.textContent = point;
            focus.appendChild(chip);
          });
          wrapper.appendChild(focus);
        }

        var meta = document.createElement('div');
        meta.className = 'board-card-meta';
        meta.textContent = 'Round ' + request.reviewRound + ' · ' + titleCaseWorkItemState(request.type) + ' · ' + describeReviewRequestTarget(request, item) + ' · Requested ' + timeAgo(request.requestedAt);
        wrapper.appendChild(meta);

        if (request.outcome && request.resolvedAt) {
          var resolution = document.createElement('div');
          resolution.className = 'board-card-meta';
          resolution.textContent = 'Resolved ' + timeAgo(request.resolvedAt);
          wrapper.appendChild(resolution);
        }

        var comments = state.selectedWorkItemReviewComments[request.id] || [];
        if (comments.length > 0) {
          var commentsWrap = document.createElement('div');
          commentsWrap.className = 'board-review-comments';

          comments.forEach(function(commentRecord) {
            var commentNode = document.createElement('div');
            commentNode.className = 'board-review-comment';

            var commentMeta = document.createElement('div');
            commentMeta.className = 'board-review-comment-meta';
            commentMeta.textContent = describeReviewComment(commentRecord) + ' · ' + timeAgo(commentRecord.createdAt);
            commentNode.appendChild(commentMeta);

            var commentBody = document.createElement('div');
            commentBody.className = 'board-review-comment-body';
            commentBody.textContent = commentRecord.body || '';
            commentNode.appendChild(commentBody);

            commentsWrap.appendChild(commentNode);
          });

          wrapper.appendChild(commentsWrap);
        }

        if (request.status === 'pending') {
          var actions = document.createElement('div');
          actions.className = 'board-inline-actions';

          var approveBtn = document.createElement('button');
          approveBtn.className = 'top-btn';
          approveBtn.textContent = 'Approve';
          approveBtn.onclick = function() {
            var comment = window.prompt('Optional approval note', '') || '';
            respondToReviewRequest(request.id, 'approved', comment).catch(console.error);
          };

          var changesBtn = document.createElement('button');
          changesBtn.className = 'top-btn';
          changesBtn.textContent = 'Request Changes';
          changesBtn.onclick = function() {
            var comment = window.prompt('What should change?', '') || '';
            respondToReviewRequest(request.id, 'changes_requested', comment).catch(console.error);
          };

          actions.appendChild(approveBtn);
          actions.appendChild(changesBtn);
          wrapper.appendChild(actions);
        }

        container.appendChild(wrapper);
      });

      el.boardDetailReviews.className = '';
      el.boardDetailReviews.innerHTML = '';
      el.boardDetailReviews.appendChild(container);
    }

    function renderBoardEvents() {
      var events = state.selectedWorkItemEvents || [];
      if (!events.length) {
        el.boardDetailEvents.className = 'board-detail-empty';
        el.boardDetailEvents.textContent = 'No events recorded for this work item yet.';
        return;
      }

      var container = document.createElement('div');
      container.className = 'board-detail-section';

      events.slice(0, 12).forEach(function(eventRecord) {
        var item = document.createElement('div');
        item.className = 'board-event-item';

        var head = document.createElement('div');
        head.className = 'board-event-head';

        var type = document.createElement('div');
        type.className = 'board-review-title';
        type.textContent = eventRecord.eventType;

        var time = document.createElement('span');
        time.className = 'board-chip';
        time.textContent = timeAgo(eventRecord.createdAt);

        head.appendChild(type);
        head.appendChild(time);
        item.appendChild(head);

        var payload = document.createElement('div');
        payload.className = 'board-event-payload';
        payload.textContent = JSON.stringify(eventRecord.payload || {}, null, 2);
        item.appendChild(payload);

        container.appendChild(item);
      });

      el.boardDetailEvents.className = '';
      el.boardDetailEvents.innerHTML = '';
      el.boardDetailEvents.appendChild(container);
    }

    function describeReviewRequestTarget(request, workItem) {
      if (!request || !request.targetType) return 'Unknown target';
      var ref = request.targetRef || {};
      if (request.targetType === 'user') {
        return 'User ' + (ref.userId || 'unknown');
      }
      if (request.targetType === 'team') {
        return 'Team ' + (ref.teamId || workItem.ownerTeamId || 'unknown');
      }
      if (request.targetType === 'team_role') {
        var teamRole = ref.role || ref.teamRole || 'unknown';
        var teamId = ref.teamId || workItem.ownerTeamId || 'owner team';
        return 'Team role ' + teamRole + ' on ' + teamId;
      }
      if (request.targetType === 'org_role') {
        return 'Org role ' + (ref.role || ref.orgRole || 'unknown');
      }
      return titleCaseWorkItemState(request.targetType);
    }

    function describeReviewComment(commentRecord) {
      var parts = [];
      if (commentRecord.source) {
        parts.push(titleCaseWorkItemState(commentRecord.source));
      }
      if (commentRecord.authorUserId) {
        parts.push('User ' + commentRecord.authorUserId);
      }
      return parts.length > 0 ? parts.join(' · ') : 'System';
    }

    function ensureBoardActorUserId(defaultUserId, promptLabel) {
      if (state.boardActorUserId) {
        return state.boardActorUserId;
      }
      var suggested = defaultUserId || '';
      var value = window.prompt(promptLabel || 'Actor user id', suggested);
      if (value === null) {
        return null;
      }
      value = String(value || '').trim();
      if (!value) {
        return null;
      }
      state.boardActorUserId = value;
      return value;
    }

    async function refreshSelected() {
      if (!state.selectedId) {
        el.retryRun.disabled = true;
        renderSummary(null);
        renderActivityStream(null, null, false);
        renderPipelineTimeline(null, false);
        el.logViewerCard.style.display = 'none';
        el.logViewer.textContent = '';
        logStreamState.runId = null;
        logStreamState.offset = 0;
        el.feedbackToast.classList.remove('visible');
        return;
      }
      const [runData, changesData, eventsData, pipelineEventsData] = await Promise.all([
        fetchJson('/api/runs/' + encodeURIComponent(state.selectedId)),
        fetchJson('/api/runs/' + encodeURIComponent(state.selectedId) + '/changes'),
        fetchJson('/api/runs/' + encodeURIComponent(state.selectedId) + '/events' + (activityShowAll ? '' : '?limit=' + MAX_VISIBLE_EVENTS)).catch(function() { return { events: [], stats: null, totalCount: 0 }; }),
        fetchJson('/api/runs/' + encodeURIComponent(state.selectedId) + '/pipeline-events').catch(function() { return { events: [] }; }),
      ]);

      const run = runData.run;
      el.retryRun.disabled = !canRetry(run);
      renderSummary(run);

      const files = (changesData.files || []).slice();
      const detailed = (changesData.detailed || []).slice();
      renderFiles(files, detailed);

      var isActive = run && (run.status !== 'completed' && run.status !== 'failed');
      renderActivityStream(eventsData.events || [], eventsData.stats || null, isActive, eventsData.totalCount || 0);
      renderPipelineTimeline(pipelineEventsData.events || [], isActive);

      // Load media (screenshots + video) if available
      loadMedia(state.selectedId);

      // Show feedback toast for completed/failed runs without existing feedback
      var showToast = run && (run.status === 'completed' || run.status === 'failed') && !run.feedback;
      el.feedbackToast.classList.toggle('visible', showToast);
      el.feedbackUp.classList.toggle('selected', run.feedback && run.feedback.rating === 'up');
      el.feedbackDown.classList.toggle('selected', run.feedback && run.feedback.rating === 'down');

      await loadChatHistory();

      // Log streaming for active runs
      if (isActive) {
        el.logViewerCard.style.display = '';
        await pollLogStream();
      } else if (run) {
        // Show final log for completed/failed runs too
        el.logViewerCard.style.display = '';
        await pollLogStream();
      } else {
        el.logViewerCard.style.display = 'none';
        el.logViewer.textContent = '';
      }
    }

    // ── Log streaming ──

    function stripAnsi(str) {
      return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    }

    async function pollLogStream() {
      if (!state.selectedId) return;

      // Reset offset when switching runs
      if (logStreamState.runId !== state.selectedId) {
        logStreamState.runId = state.selectedId;
        logStreamState.offset = 0;
        el.logViewer.textContent = '';
        el.logTruncated.style.display = 'none';
      }

      try {
        var data = await fetchJson(
          '/api/runs/' + encodeURIComponent(state.selectedId) + '/log?offset=' + logStreamState.offset
        );

        if (data.content && data.content.length > 0) {
          var cleaned = stripAnsi(data.content);
          el.logViewer.textContent += cleaned;
          logStreamState.offset = data.offset;

          // Front-truncate if log exceeds MAX_LOG_CHARS
          var currentText = el.logViewer.textContent;
          if (currentText.length > MAX_LOG_CHARS) {
            var trimmed = currentText.slice(-MAX_LOG_CHARS);
            // Trim to next newline to avoid partial lines
            var nlIdx = trimmed.indexOf('\\n');
            if (nlIdx > 0 && nlIdx < 200) {
              trimmed = trimmed.slice(nlIdx + 1);
            }
            el.logViewer.textContent = trimmed;
            var truncKb = (logStreamState.offset / 1024).toFixed(0);
            el.logTruncatedMsg.textContent = 'Log truncated \\u2014 showing last ' + (MAX_LOG_CHARS / 1024).toFixed(0) + ' KB of ' + truncKb + ' KB';
            el.logTruncated.style.display = '';
          }

          // Auto-scroll
          if (el.logAutoScroll.checked) {
            el.logViewer.scrollTop = el.logViewer.scrollHeight;
          }
        }

        // Update size indicator
        var kb = (logStreamState.offset / 1024).toFixed(1);
        el.logSize.textContent = kb + ' KB';
      } catch (err) {
        // Silently ignore — log might not exist yet
      }
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
    el.actShowAll.onclick = function() {
      activityShowAll = true;
      lastRenderedEventCount = -1; // force re-render
      refreshSelected().catch(console.error);
    };
    // ── Settings slide-over ──
    function settingsBadge(on) {
      return '<span class="settings-badge ' + (on ? 'on' : 'off') + '">' + (on ? 'On' : 'Off') + '</span>';
    }

    async function loadAgentModels(provider, modelSelect, statusEl, manualInput) {
      if (!provider) {
        modelSelect.innerHTML = '<option value="">Select provider first</option>';
        return;
      }
      statusEl.textContent = 'Loading model catalog...';
      try {
        var data = await fetchJson('/api/agent-models?provider=' + encodeURIComponent(provider));
        var models = Array.isArray(data.models) ? data.models : [];
        modelSelect.innerHTML = '<option value="">Choose catalog model</option>';
        for (var i = 0; i < models.length; i++) {
          var opt = document.createElement('option');
          opt.value = models[i];
          opt.textContent = models[i];
          modelSelect.appendChild(opt);
        }
        statusEl.textContent = models.length ? 'Loaded ' + models.length + ' models.' : 'Catalog returned no models. Manual entry still works.';
        if (manualInput.value) {
          modelSelect.value = manualInput.value;
        }
      } catch (err) {
        modelSelect.innerHTML = '<option value="">Catalog unavailable</option>';
        statusEl.textContent = 'Could not load live catalog. Enter model id manually.';
      }
    }

    function collectAgentProfileForm() {
      var providerSelect = document.getElementById('ap-provider');
      var toolsInput = document.getElementById('ap-tools');
      var extensionsInput = document.getElementById('ap-extensions');
      return {
        name: (document.getElementById('ap-name')?.value || '').trim(),
        description: (document.getElementById('ap-description')?.value || '').trim(),
        runtime: document.getElementById('ap-runtime')?.value || 'pi',
        provider: providerSelect ? providerSelect.value || undefined : undefined,
        model: (document.getElementById('ap-model-manual')?.value || document.getElementById('ap-model-select')?.value || '').trim(),
        tools: (toolsInput?.value || '').split(',').map(function(v) { return v.trim(); }).filter(Boolean),
        mode: (document.getElementById('ap-mode')?.value || '').trim() || undefined,
        extensions: (extensionsInput?.value || '').split(',').map(function(v) { return v.trim(); }).filter(Boolean),
        extraArgs: (document.getElementById('ap-extra-args')?.value || '').trim() || undefined,
        customCommandTemplate: (document.getElementById('ap-custom-command')?.value || '').trim() || undefined,
        isActive: !!document.getElementById('ap-is-active')?.checked
      };
    }

    function buildProfileCard(profile, activeId) {
      var meta = [profile.runtime, profile.provider, profile.model].filter(Boolean).join(' / ');
      var actions = '<div style="display:flex; gap:8px; margin-top:10px;">';
      if (profile.id !== activeId) {
        actions += '<button class="action-btn" data-ap-activate="' + esc(profile.id) + '" style="font-size:11px; padding:5px 10px;">Set Active</button>';
      } else {
        actions += '<span class="settings-badge on">Active</span>';
      }
      if (!profile.isBuiltin) {
        actions += '<button class="action-btn" data-ap-delete="' + esc(profile.id) + '" style="font-size:11px; padding:5px 10px;">Delete</button>';
      }
      actions += '</div>';
      return '<div style="border:1px solid var(--border); border-radius:10px; background:var(--panel-3); padding:12px; margin-bottom:10px;">' +
        '<div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">' +
        '<div><div style="font-size:13px; font-weight:700;">' + esc(profile.name || '') + '</div>' +
        '<div style="font-size:12px; color:var(--muted); margin-top:3px;">' + esc(profile.description || '') + '</div></div>' +
        '<div style="font-size:11px; color:var(--muted); white-space:nowrap;">' + esc(meta || 'custom') + '</div>' +
        '</div>' +
        '<div style="margin-top:10px; font-size:12px; color:var(--muted);">Command preview</div>' +
        '<div class="value settings-code" style="margin-top:4px;">' + esc(profile.customCommandTemplate || profile.commandTemplate || '') + '</div>' +
        actions +
        '</div>';
    }

    function bindSettingsAgentProfileActions() {
      var providerSelect = document.getElementById('ap-provider');
      var runtimeSelect = document.getElementById('ap-runtime');
      var modelSelect = document.getElementById('ap-model-select');
      var modelManual = document.getElementById('ap-model-manual');
      var statusEl = document.getElementById('ap-model-status');
      var customWrap = document.getElementById('ap-custom-wrap');
      var structuredWrap = document.getElementById('ap-structured-wrap');
      var previewEl = document.getElementById('ap-preview');
      var submitBtn = document.getElementById('ap-save');
      var previewBtn = document.getElementById('ap-preview-btn');
      var refreshBtn = document.getElementById('ap-refresh-models');

      async function refreshModels() {
        if (providerSelect && modelSelect && statusEl && modelManual) {
          await loadAgentModels(providerSelect.value, modelSelect, statusEl, modelManual);
        }
      }

      function syncRuntimeUi() {
        var isCustom = runtimeSelect && runtimeSelect.value === 'custom';
        if (customWrap) customWrap.style.display = isCustom ? 'block' : 'none';
        if (structuredWrap) structuredWrap.style.display = isCustom ? 'none' : 'block';
      }

      if (runtimeSelect) {
        runtimeSelect.onchange = function() {
          syncRuntimeUi();
        };
        syncRuntimeUi();
      }
      if (providerSelect) {
        providerSelect.onchange = function() {
          refreshModels().catch(console.error);
        };
      }
      if (modelSelect && modelManual) {
        modelSelect.onchange = function() {
          if (modelSelect.value) modelManual.value = modelSelect.value;
        };
      }
      if (refreshBtn) {
        refreshBtn.onclick = function() {
          refreshModels().catch(console.error);
        };
      }
      if (previewBtn) {
        previewBtn.onclick = async function() {
          previewEl.textContent = 'Generating preview...';
          var payload = collectAgentProfileForm();
          try {
            var result = await fetchJson('/api/agent-profiles/preview', { method: 'POST', body: JSON.stringify(payload) });
            previewEl.textContent = (result.errors && result.errors.length ? 'Validation: ' + result.errors.join('; ') + '\\n\\n' : '') + (result.commandTemplate || '');
          } catch (err) {
            previewEl.textContent = 'Failed to build preview.';
          }
        };
      }
      if (submitBtn) {
        submitBtn.onclick = async function() {
          var payload = collectAgentProfileForm();
          submitBtn.disabled = true;
          try {
            await fetchJson('/api/agent-profiles', { method: 'POST', body: JSON.stringify(payload) });
            await refreshSettingsPanel();
          } catch (err) {
            previewEl.textContent = err && err.message ? err.message : 'Failed to save profile.';
          } finally {
            submitBtn.disabled = false;
          }
        };
      }

      el.settingsBody.querySelectorAll('[data-ap-activate]').forEach(function(btn) {
        btn.onclick = async function() {
          var id = btn.getAttribute('data-ap-activate');
          if (!id) return;
          await fetchJson('/api/agent-profiles/' + encodeURIComponent(id) + '/activate', { method: 'POST' });
          await refreshSettingsPanel();
        };
      });
      el.settingsBody.querySelectorAll('[data-ap-delete]').forEach(function(btn) {
        btn.onclick = async function() {
          var id = btn.getAttribute('data-ap-delete');
          if (!id || !confirm('Delete this profile?')) return;
          await fetchJson('/api/agent-profiles/' + encodeURIComponent(id), { method: 'DELETE' });
          await refreshSettingsPanel();
        };
      });

      refreshModels().catch(function() {});
    }

    async function refreshSettingsPanel() {
      el.settingsBody.textContent = 'Loading...';
      try {
        var data = await fetchJson('/api/settings');
        var c = data.config || {};
        var s = data.stats || {};
        var sandboxRuntimeLabel = c.sandboxRuntimeLabel || c.sandboxRuntime || '';
        var sandboxStatus = c.sandboxStatus && c.sandboxStatus.enabled === false
          ? ' <span class="settings-badge off">Disabled</span>'
          : ' ' + settingsBadge(Boolean(c.sandboxStatus && c.sandboxStatus.enabled));
        el.settingsBody.innerHTML =
          '<div class="settings-section"><h3>Configuration</h3>' +
          '<div class="settings-row"><span class="label">App Name</span><span class="value compact">' + esc(c.appName || '') + '</span></div>' +
          '<div class="settings-row"><span class="label">Pipeline</span><span class="value compact">' + esc(c.pipelineFile || '') + '</span></div>' +
          '<div class="settings-row"><span class="label">Slack</span><span class="value">' + settingsBadge(c.slackConnected) + '</span></div>' +
          '<div class="settings-row"><span class="label">GitHub Auth</span><span class="value compact">' + esc(c.githubAuthMode || 'none') + '</span></div>' +
          '<div class="settings-row stacked">' +
          '<div style="display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:8px;">' +
          '<span class="label">Agent Command</span>' +
          '<a href="/agent-profiles" class="top-btn" style="padding:6px 12px;">Edit</a>' +
          '</div>' +
          '<span class="value settings-code" title="' + esc(c.agentCommandTemplate || '') + '">' + esc(c.agentCommandTemplate || '') + '</span></div>' +
          '</div>' +
          '<div class="settings-section"><h3>Features</h3>' +
          '<div class="settings-row"><span class="label">Observer</span>' + settingsBadge(c.features?.observer) + '</div>' +
          '<div class="settings-row"><span class="label">Sandbox Runtime</span><span class="value compact">' + esc(sandboxRuntimeLabel) + sandboxStatus + '</span></div>' +
          '<div class="settings-row"><span class="label">Browser Verify</span>' + settingsBadge(c.features?.browserVerify) + '</div>' +
          '<div class="settings-row"><span class="label">Scope Judge</span>' + settingsBadge(c.features?.scopeJudge) + '</div>' +
          '<div class="settings-row"><span class="label">CI Wait</span>' + settingsBadge(c.features?.ciWait) + '</div>' +
          '<div class="settings-row"><span class="label">Dry Run</span>' + settingsBadge(c.features?.dryRun) + '</div>' +
          '</div>' +
          '<div class="settings-section"><h3>Models</h3>' +
          '<div class="settings-row"><span class="label">Default</span><span class="value compact">' + esc(c.models?.default || '') + '</span></div>' +
          '<div class="settings-row"><span class="label">Plan Task</span><span class="value compact">' + esc(c.models?.planTask || '') + '</span></div>' +
          '<div class="settings-row"><span class="label">Orchestrator</span><span class="value compact">' + esc(c.models?.orchestrator || '') + '</span></div>' +
          '<div class="settings-row"><span class="label">Browser Verify</span><span class="value compact">' + esc(c.models?.browserVerify || '') + '</span></div>' +
          '</div>' +
          '<div class="settings-section"><h3>Aggregate Stats</h3>' +
          '<div class="stat-grid">' +
          '<div class="stat-card"><div class="stat-value">' + (s.totalRuns || 0) + '</div><div class="stat-label">Total Runs</div></div>' +
          '<div class="stat-card"><div class="stat-value">' + (s.successRate || 0) + '%</div><div class="stat-label">Success Rate</div></div>' +
          '<div class="stat-card"><div class="stat-value">$' + (s.totalCostUsd || 0).toFixed(2) + '</div><div class="stat-label">Total Cost</div></div>' +
          '<div class="stat-card"><div class="stat-value">$' + (s.avgCostUsd || 0).toFixed(2) + '</div><div class="stat-label">Avg Cost/Run</div></div>' +
          '<div class="stat-card"><div class="stat-value">' + (s.runsLast24h || 0) + '</div><div class="stat-label">Last 24h</div></div>' +
          '</div></div>' +
          '<div class="settings-section" style="margin-top: 16px; padding-top: 16px; border-top: 1px solid #22314f;">' +
          '<a href="/setup?reconfig=1" style="display: inline-block; padding: 8px 16px; background: #1e293b; color: #94a3b8; border-radius: 8px; text-decoration: none; font-size: 13px; font-weight: 600;">Reconfigure</a>' +
          '</div>';
        bindSettingsAgentProfileActions();
      } catch (e) {
        el.settingsBody.textContent = 'Failed to load settings.';
      }
    }

    el.settingsBtn.onclick = async () => {
      el.settingsOverlay.classList.add('open');
      await refreshSettingsPanel();
    };
    el.settingsClose.onclick = () => el.settingsOverlay.classList.remove('open');
    el.settingsOverlay.onclick = (e) => { if (e.target === el.settingsOverlay) el.settingsOverlay.classList.remove('open'); };

    // ── Search and filter ──
    var currentStatusFilter = 'all';
    var currentSearchQuery = '';

    if (el.viewSwitch) {
      el.viewSwitch.onclick = function(e) {
        var button = e.target.closest('[data-view]');
        if (!button) return;
        state.viewMode = button.getAttribute('data-view') === 'board' ? 'board' : 'runs';
        updateDashboardChrome();
        if (state.viewMode === 'board') {
          loadWorkItems().catch(console.error);
        } else if (el.topMeta) {
          el.topMeta.textContent = state.runs.length + ' runs';
        }
      };
    }

    if (el.boardWorkflow) {
      el.boardWorkflow.onchange = function() {
        state.boardWorkflow = el.boardWorkflow.value || 'product_discovery';
        setBoardStatusMessage('');
        loadWorkItems().catch(console.error);
      };
    }

    async function respondToReviewRequest(reviewRequestId, outcome, comment) {
      if (!reviewRequestId) return;
      var request = (state.selectedWorkItemReviewRequests || []).find(function(entry) { return entry.id === reviewRequestId; }) || null;
      var defaultActorUserId = request && request.targetType === 'user' && request.targetRef
        ? request.targetRef.userId
        : (state.selectedWorkItem && state.selectedWorkItem.createdByUserId) || '';
      var authorUserId = ensureBoardActorUserId(defaultActorUserId, 'Reviewer user id');
      if (!authorUserId) {
        setBoardStatusMessage('Reviewer user id is required to respond from the board.', 'error');
        return;
      }
      setBoardStatusMessage('Saving review response...');
      try {
        await fetchJson('/api/review-requests/' + encodeURIComponent(reviewRequestId) + '/respond', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            outcome: outcome,
            comment: comment || undefined,
            authorUserId: authorUserId,
          }),
        });
        await loadWorkItems();
        setBoardStatusMessage('Review response saved.', 'ok');
      } catch (error) {
        setBoardStatusMessage(error.message || 'Failed to save review response', 'error');
      }
    }

    if (el.boardConfirmApprove) {
      el.boardConfirmApprove.onclick = async function() {
        if (!state.selectedWorkItemId) return;
        var item = state.selectedWorkItem;
        var actorUserId = ensureBoardActorUserId(item && item.createdByUserId, 'PM user id');
        if (!actorUserId) {
          setBoardStatusMessage('PM user id is required to approve discovery.', 'error');
          return;
        }
        var jiraIssueKey = item && item.jiraIssueKey ? item.jiraIssueKey : '';
        if (!jiraIssueKey) {
          jiraIssueKey = String(window.prompt('Jira issue key', '') || '').trim();
          if (!jiraIssueKey) {
            setBoardStatusMessage('Jira issue key is required before discovery can be approved.', 'error');
            return;
          }
        }
        setBoardStatusMessage('Applying PM approval...');
        try {
          await fetchJson('/api/work-items/' + encodeURIComponent(state.selectedWorkItemId) + '/confirm-discovery', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ approved: true, actorUserId: actorUserId, jiraIssueKey: jiraIssueKey }),
          });
          await loadWorkItems();
          setBoardStatusMessage('Discovery approved.', 'ok');
        } catch (error) {
          setBoardStatusMessage(error.message || 'Failed to approve discovery', 'error');
        }
      };
    }

    if (el.boardConfirmRework) {
      el.boardConfirmRework.onclick = async function() {
        if (!state.selectedWorkItemId) return;
        var item = state.selectedWorkItem;
        var actorUserId = ensureBoardActorUserId(item && item.createdByUserId, 'PM user id');
        if (!actorUserId) {
          setBoardStatusMessage('PM user id is required to return discovery to rework.', 'error');
          return;
        }
        setBoardStatusMessage('Returning item to in_progress...');
        try {
          await fetchJson('/api/work-items/' + encodeURIComponent(state.selectedWorkItemId) + '/confirm-discovery', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ approved: false, actorUserId: actorUserId }),
          });
          await loadWorkItems();
          setBoardStatusMessage('Discovery returned to in_progress.', 'ok');
        } catch (error) {
          setBoardStatusMessage(error.message || 'Failed to update discovery', 'error');
        }
      };
    }

    if (el.boardStopProcessing) {
      el.boardStopProcessing.onclick = async function() {
        if (!state.selectedWorkItemId) return;
        var item = state.selectedWorkItem;
        var actorUserId = ensureBoardActorUserId(item && item.createdByUserId, 'Actor user id');
        if (!actorUserId) {
          setBoardStatusMessage('Actor user id is required to stop processing.', 'error');
          return;
        }
        setBoardStatusMessage('Stopping active processing...');
        try {
          var result = await fetchJson('/api/work-items/' + encodeURIComponent(state.selectedWorkItemId) + '/stop-processing', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ actorUserId: actorUserId }),
          });
          await loadWorkItems();
          var stopped = Array.isArray(result.stoppedRunIds) ? result.stoppedRunIds.length : 0;
          var failed = Array.isArray(result.failedRunIds) ? result.failedRunIds.length : 0;
          if (failed > 0) {
            setBoardStatusMessage('Stop requested for ' + stopped + ' run(s), but ' + failed + ' could not be interrupted.', 'error');
            return;
          }
          setBoardStatusMessage('Stop requested for ' + stopped + ' run(s).', 'ok');
        } catch (error) {
          setBoardStatusMessage(error.message || 'Failed to stop processing', 'error');
        }
      };
    }

    if (el.boardOverrideSubmit) {
      el.boardOverrideSubmit.onclick = async function() {
        if (!state.selectedWorkItemId) return;
        var item = state.selectedWorkItem;
        var actorUserId = ensureBoardActorUserId(item && item.createdByUserId, 'Actor user id');
        if (!actorUserId) {
          setBoardStatusMessage('Actor user id is required to override work item state.', 'error');
          return;
        }
        var reason = (el.boardOverrideReason.value || '').trim();
        if (!reason) {
          setBoardStatusMessage('Override reason is required.', 'error');
          return;
        }
        setBoardStatusMessage('Applying guarded override...');
        try {
          await fetchJson('/api/work-items/' + encodeURIComponent(state.selectedWorkItemId) + '/override-state', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              state: el.boardOverrideState.value,
              substate: (el.boardOverrideSubstate.value || '').trim() || undefined,
              reason: reason,
              actorUserId: actorUserId,
            }),
          });
          el.boardOverrideReason.value = '';
          await loadWorkItems();
          setBoardStatusMessage('Override applied.', 'ok');
        } catch (error) {
          var message = error.message || 'Failed to apply override';
          if (/processing is active/i.test(message)) {
            message += ' Stop processing first, then retry the override.';
          }
          setBoardStatusMessage(message, 'error');
        }
      };
    }

    el.runSearch.oninput = function() {
      currentSearchQuery = el.runSearch.value.trim().toLowerCase();
      renderRuns();
    };

    el.filterPills.onclick = function(e) {
      var pill = e.target.closest('.filter-pill');
      if (!pill) return;
      currentStatusFilter = pill.getAttribute('data-status') || 'all';
      el.filterPills.querySelectorAll('.filter-pill').forEach(function(p) { p.classList.remove('active'); });
      pill.classList.add('active');
      renderRuns();
    };

    // ── New Run modal ──
    var newRunRepoMode = 'select';

    function setNewRunRepoMode(mode) {
      newRunRepoMode = mode === 'custom' ? 'custom' : 'select';
      var selectMode = newRunRepoMode === 'select';
      el.nrRepoSelectWrap.style.display = selectMode ? 'block' : 'none';
      el.nrRepoCustomWrap.style.display = selectMode ? 'none' : 'block';
      el.nrRepoCustomToggle.textContent = selectMode ? 'Use custom repository' : 'Use installation repository';
      el.nrBranch.disabled = selectMode;
      if (selectMode) {
        applySelectedRepositoryDefaults();
      }
    }

    function populateRepositoryOptions(repositories) {
      var select = el.nrRepoSelect;
      while (select.options.length > 0) select.remove(0);

      var placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = repositories.length ? 'Select repository' : 'No repositories available';
      select.appendChild(placeholder);

      for (var i = 0; i < repositories.length; i++) {
        var repo = repositories[i];
        var opt = document.createElement('option');
        opt.value = repo.fullName;
        opt.textContent = repo.fullName + (repo.private ? '' : ' (public)');
        if (repo.defaultBranch) opt.setAttribute('data-default-branch', repo.defaultBranch);
        select.appendChild(opt);
      }
    }

    function applySelectedRepositoryDefaults() {
      if (newRunRepoMode !== 'select') return;
      var option = el.nrRepoSelect.options[el.nrRepoSelect.selectedIndex];
      var defaultBranch = option ? option.getAttribute('data-default-branch') : '';
      el.nrBranch.value = defaultBranch || '';
    }

    async function loadRepositoryOptions(forceRefresh) {
      el.nrRepoRefresh.disabled = true;
      try {
        var suffix = forceRefresh ? '?refresh=1' : '';
        var res = await fetchJson('/api/github/repositories' + suffix);
        var repositories = Array.isArray(res.repositories) ? res.repositories : [];
        populateRepositoryOptions(repositories);
        if (repositories.length > 0 && newRunRepoMode !== 'custom') {
          setNewRunRepoMode('select');
        } else if (repositories.length === 0) {
          setNewRunRepoMode('custom');
        }
        if (res.stale) {
          el.nrRepoMeta.textContent = 'Showing cached repositories because GitHub refresh failed. Manual entry is also available.';
        } else if (repositories.length > 0) {
          el.nrRepoMeta.textContent = 'Select a repository from the GitHub App installation or switch to manual entry.';
        } else {
          el.nrRepoMeta.textContent = 'No repositories returned by GitHub. Enter owner/repo manually.';
        }
      } catch (e) {
        populateRepositoryOptions([]);
        setNewRunRepoMode('custom');
        el.nrRepoMeta.textContent = (e && e.message ? e.message + '. ' : '') + 'Enter owner/repo manually.';
      } finally {
        el.nrRepoRefresh.disabled = false;
      }
    }

    async function loadPipelineOptions() {
      try {
        var res = await fetchJson('/api/pipelines');
        var select = el.nrPipeline;
        // Keep only the default option
        while (select.options.length > 1) select.remove(1);
        if (res.pipelines) {
          for (var i = 0; i < res.pipelines.length; i++) {
            var p = res.pipelines[i];
            var opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.name + (p.isBuiltIn ? ' (built-in)' : '');
            select.appendChild(opt);
          }
        }
      } catch(e) { /* pipelines not available */ }
    }

    el.newRunBtn.onclick = () => {
      el.newRunOverlay.classList.add('open');
      el.nrError.style.display = 'none';
      setNewRunRepoMode('select');
      populateRepositoryOptions([]);
      el.nrRepo.value = '';
      el.nrRepoSelect.value = '';
      el.nrRepoMeta.textContent = 'Loading repositories...';
      el.nrBranch.value = '';
      el.nrBranch.disabled = true;
      el.nrTask.value = '';
      el.nrPipeline.value = '';
      loadPipelineOptions();
      loadRepositoryOptions(false).then(function() {
        if (newRunRepoMode === 'custom') {
          el.nrRepo.focus();
        } else {
          el.nrRepoSelect.focus();
        }
      });
    };
    el.nrCancel.onclick = () => el.newRunOverlay.classList.remove('open');
    el.newRunOverlay.onclick = (e) => { if (e.target === el.newRunOverlay) el.newRunOverlay.classList.remove('open'); };
    el.nrRepoCustomToggle.onclick = () => {
      setNewRunRepoMode(newRunRepoMode === 'custom' ? 'select' : 'custom');
      if (newRunRepoMode === 'custom') {
        el.nrBranch.disabled = false;
        el.nrRepo.focus();
      } else {
        el.nrRepoSelect.focus();
        applySelectedRepositoryDefaults();
      }
    };
    el.nrRepoRefresh.onclick = () => { loadRepositoryOptions(true); };
    el.nrRepoSelect.onchange = applySelectedRepositoryDefaults;
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        el.settingsOverlay.classList.remove('open');
        el.newRunOverlay.classList.remove('open');
        el.pipelinesOverlay.classList.remove('open');
      }
    });
    el.nrSubmit.onclick = async () => {
      var repo = (newRunRepoMode === 'custom' ? el.nrRepo.value : el.nrRepoSelect.value).trim();
      var task = el.nrTask.value.trim();
      if (!repo || !task) {
        el.nrError.textContent = 'Repository and task are required.';
        el.nrError.style.display = 'block';
        return;
      }
      el.nrSubmit.disabled = true;
      el.nrError.style.display = 'none';
      try {
        var result = await fetchJson('/api/runs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            repoSlug: repo,
            baseBranch: el.nrBranch.value.trim() || undefined,
            task: task,
            pipeline: el.nrPipeline.value.trim() || undefined,
          }),
        });
        el.newRunOverlay.classList.remove('open');
        state.selectedId = result.run.id;
        await refreshAll();
      } catch (e) {
        el.nrError.textContent = e.message || 'Failed to create run.';
        el.nrError.style.display = 'block';
      } finally {
        el.nrSubmit.disabled = false;
      }
    };

    // ── Permalink (URL hash) ──
    function applyHashSelection() {
      var hash = window.location.hash;
      if (hash && hash.startsWith('#run/')) {
        var prefix = hash.slice(5);
        var match = state.runs.find(function(r) { return r.id.startsWith(prefix); });
        if (match) {
          state.selectedId = match.id;
          renderRuns();
          refreshSelected().catch(console.error);
        }
      }
    }
    window.addEventListener('hashchange', applyHashSelection);

    el.logoutBtn.onclick = () => {
      document.cookie = 'gooseherd-session=; Max-Age=0; Path=/; SameSite=Strict';
      window.location.href = '/login';
    };

    // Chat / follow-up logic
    async function loadChatHistory() {
      if (!state.selectedId) {
        el.chatCard.style.display = 'none';
        return;
      }
      el.chatCard.style.display = '';
      var threadMsgCount = 0;
      var conversationAvailable = true;
      try {
        var [chainData, conversationData] = await Promise.all([
          fetchJson('/api/runs/' + encodeURIComponent(state.selectedId) + '/chain'),
          fetchJson('/api/runs/' + encodeURIComponent(state.selectedId) + '/conversation').catch(function() { return { messages: [] }; }),
        ]);
        var chain = chainData.chain || [];
        conversationAvailable = conversationData.available !== false;
        var threadMessages = conversationData.messages || [];
        threadMsgCount = threadMessages.length;
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
          var requester = run.requestedBy ? String(run.requestedBy) : 'unknown';
          time.textContent = formatDate(run.createdAt) + ' — by ' + requester + ' — ' + run.status;
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

        if (threadMessages.length > 0) {
          var sectionLabel = document.createElement('div');
          sectionLabel.className = 'chat-time';
          sectionLabel.style.margin = '8px 0 2px';
          sectionLabel.textContent = 'Thread Q/A (orchestrator memory)';
          el.chatHistory.appendChild(sectionLabel);

          threadMessages.forEach(function(msg) {
            var bubble = document.createElement('div');
            bubble.className = msg.role === 'user' ? 'chat-msg human' : 'chat-msg agent';

            var bubbleSender = document.createElement('div');
            bubbleSender.className = 'chat-sender';
            bubbleSender.textContent = msg.role === 'user' ? 'Thread user' : 'Assistant';
            bubble.appendChild(bubbleSender);

            var bubbleText = document.createElement('div');
            bubbleText.textContent = msg.content;
            bubble.appendChild(bubbleText);

            el.chatHistory.appendChild(bubble);
          });
        } else if (!conversationAvailable) {
          var unavailable = document.createElement('div');
          unavailable.className = 'chat-time';
          unavailable.style.margin = '8px 0 2px';
          unavailable.textContent = 'Thread Q/A unavailable: conversation memory source is not attached for this process.';
          el.chatHistory.appendChild(unavailable);
        }

        el.chatHistory.scrollTop = el.chatHistory.scrollHeight;
      } catch(e) {
        console.error('Failed to load chain', e);
      }
      // Enable/disable send based on run status
      var selectedRun = state.runs.find(function(r) { return r.id === state.selectedId; });
      var canContinue = selectedRun && (selectedRun.status === 'completed' || selectedRun.status === 'failed');
      el.chatSend.disabled = !canContinue;
      var baseStatus = canContinue ? 'Ready for follow-up instructions.' : (selectedRun ? 'Waiting for run to finish...' : '');
      if (threadMsgCount > 0) {
        baseStatus += ' ' + threadMsgCount + ' thread messages visible.';
      } else if (!conversationAvailable) {
        baseStatus += ' Thread Q/A unavailable in this process.';
      }
      el.chatStatus.textContent = baseStatus;
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

    // ── Observer panel ──

    var observerEl = {
      card: document.getElementById('observer-card'),
      subtitle: document.getElementById('observer-subtitle'),
      budget: document.getElementById('observer-budget'),
      rules: document.getElementById('observer-rules'),
      stats: document.getElementById('observer-stats'),
      events: document.getElementById('observer-events'),
    };

    function esc(s) {
      if (!s) return '';
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    function outcomeIcon(outcome) {
      if (outcome === 'triggered') return '\\u2705';
      if (outcome === 'denied') return '\\u26d4';
      if (outcome === 'no_match') return '\\u2796';
      if (outcome === 'approval_required') return '\\u23f3';
      return '\\u2753';
    }

    function renderObserverRules(rules, ruleOutcomes) {
      if (!rules || rules.length === 0) {
        observerEl.rules.textContent = 'No rules loaded.';
        return;
      }
      observerEl.rules.innerHTML = '';
      for (var i = 0; i < rules.length; i++) {
        var r = rules[i];
        var stats = (ruleOutcomes || {})[r.id];
        var row = document.createElement('div');
        row.style.cssText = 'padding: 4px 0; border-bottom: 1px dashed color-mix(in srgb, var(--border) 60%, transparent); font-size: 12px;';
        var approvalBadge = r.requiresApproval ? ' <span style="color: var(--warn); font-size: 10px;">[approval]</span>' : '';
        var statsLabel = stats ? ' <span style="font-size: 10px; color: var(--muted);">\\u2705' + stats.success + ' \\u274c' + stats.failure + '</span>' : '';
        row.innerHTML = '<span style="font-weight: 600; font-family: var(--font-mono);">' + esc(r.id) + '</span>' + approvalBadge + statsLabel +
          '<br><span style="color: var(--muted); font-size: 11px;">' + esc(r.source) + (r.repoSlug ? ' \\u00b7 ' + esc(r.repoSlug) : '') +
          ' \\u00b7 ' + r.conditions.length + ' condition' + (r.conditions.length !== 1 ? 's' : '') + '</span>';
        observerEl.rules.appendChild(row);
      }
    }

    function renderObserverStats(stateData) {
      if (!stateData || !stateData.enabled) {
        observerEl.stats.textContent = 'Observer not enabled.';
        return;
      }
      var lines = [];
      lines.push('Daily runs: <strong>' + stateData.dailyCount + '</strong> (' + stateData.counterDay + ')');

      var repoEntries = Object.entries(stateData.dailyPerRepo || {});
      if (repoEntries.length > 0) {
        for (var ri = 0; ri < repoEntries.length; ri++) {
          lines.push('\\u00a0\\u00a0' + repoEntries[ri][0] + ': ' + repoEntries[ri][1]);
        }
      }

      lines.push('Active dedup keys: ' + stateData.activeDedups + ' / ' + stateData.dedupCount + ' total');

      var rlEntries = Object.entries(stateData.rateLimitSources || {});
      if (rlEntries.length > 0) {
        lines.push('Rate limit events:');
        for (var si = 0; si < rlEntries.length; si++) {
          lines.push('\\u00a0\\u00a0' + rlEntries[si][0] + ': ' + rlEntries[si][1] + '/hr');
        }
      }

      observerEl.stats.innerHTML = lines.join('<br>');
    }

    function renderObserverEvents(events) {
      if (!events || events.length === 0) {
        observerEl.events.innerHTML = '<div class="act-info">No events processed yet.</div>';
        return;
      }
      observerEl.events.innerHTML = '';
      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        var node = document.createElement('div');
        node.className = 'act-event act-info';
        node.style.cssText = 'padding: 6px 10px; font-size: 12px; line-height: 1.5; border-bottom: 1px dashed color-mix(in srgb, var(--border) 60%, transparent);';
        var icon = outcomeIcon(ev.outcome);
        var ruleLabel = ev.matchedRuleId ? ' \\u00b7 rule: <span style="font-family: var(--font-mono);">' + esc(ev.matchedRuleId) + '</span>' : '';
        var runLabel = ev.runId ? ' \\u00b7 <span style="font-family: var(--font-mono);">' + esc(ev.runId.slice(0, 8)) + '</span>' : '';
        node.innerHTML = icon + ' <strong>' + esc(ev.source) + '</strong>' +
          (ev.repoSlug ? ' \\u00b7 ' + esc(ev.repoSlug) : '') +
          ruleLabel + runLabel +
          '<br><span style="color: var(--muted); font-size: 11px;">' + esc(ev.reason) + ' \\u00b7 ' + timeAgo(ev.processedAt) + '</span>';
        observerEl.events.appendChild(node);
      }
    }

    async function refreshObserver() {
      try {
        var [stateData, eventsData, rulesData] = await Promise.all([
          fetchJson('/api/observer/state'),
          fetchJson('/api/observer/events?limit=50'),
          fetchJson('/api/observer/rules'),
        ]);

        if (!stateData.enabled) {
          observerEl.card.style.display = 'none';
          return;
        }

        observerEl.card.style.display = '';
        observerEl.subtitle.textContent = 'Day: ' + stateData.counterDay + ' \\u00b7 ' + (rulesData.rules || []).length + ' rules loaded';
        observerEl.budget.textContent = stateData.dailyCount + ' runs today';

        renderObserverRules(rulesData.rules || [], stateData.ruleOutcomes || {});
        renderObserverStats(stateData);
        renderObserverEvents(eventsData.events || []);
      } catch (e) {
        // Observer not available — hide panel
        observerEl.card.style.display = 'none';
      }
    }

    // ── Pipeline Manager ──

    var plEditingId = null; // null = new, string = editing existing

    el.pipelinesBtn.onclick = function() {
      el.pipelinesOverlay.classList.add('open');
      el.plEditor.style.display = 'none';
      refreshPipelineList();
    };
    el.pipelinesClose.onclick = function() { el.pipelinesOverlay.classList.remove('open'); };
    el.pipelinesOverlay.onclick = function(e) { if (e.target === el.pipelinesOverlay) el.pipelinesOverlay.classList.remove('open'); };

    async function refreshPipelineList() {
      try {
        var res = await fetchJson('/api/pipelines');
        var pipelines = res.pipelines || [];
        if (pipelines.length === 0) {
          el.plList.innerHTML = '<div style="color: var(--muted); font-size: 12px; padding: 12px 0; text-align: center;">No pipelines found.</div>';
          return;
        }
        var html = '<table style="width: 100%; border-collapse: collapse; font-size: 12px;">';
        html += '<thead><tr style="border-bottom: 2px solid var(--border); text-align: left;">';
        html += '<th style="padding: 6px 8px; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em;">Name</th>';
        html += '<th style="padding: 6px 8px; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em;">ID</th>';
        html += '<th style="padding: 6px 8px; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em;">Nodes</th>';
        html += '<th style="padding: 6px 8px; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em;">Updated</th>';
        html += '<th style="padding: 6px 8px; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em;"></th>';
        html += '</tr></thead><tbody>';
        for (var i = 0; i < pipelines.length; i++) {
          var p = pipelines[i];
          var builtInBadge = p.isBuiltIn ? '<span style="font-size: 10px; font-weight: 600; background: color-mix(in srgb, var(--ok) 18%, transparent); color: var(--ok); border-radius: 4px; padding: 1px 5px; margin-left: 4px;">built-in</span>' : '';
          html += '<tr style="border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);">';
          html += '<td style="padding: 8px 8px; font-weight: 600;">' + esc(p.name) + builtInBadge + '</td>';
          html += '<td style="padding: 8px 8px; font-family: var(--font-mono); color: var(--muted);">' + esc(p.id) + '</td>';
          html += '<td style="padding: 8px 8px; text-align: center;">' + p.nodeCount + '</td>';
          html += '<td style="padding: 8px 8px; color: var(--muted);">' + timeAgo(p.updatedAt) + '</td>';
          html += '<td style="padding: 8px 8px; text-align: right; white-space: nowrap;">';
          html += '<button class="action-btn pl-edit-btn" data-id="' + esc(p.id) + '" style="font-size: 11px; padding: 3px 8px; margin-right: 4px;">Edit</button>';
          if (!p.isBuiltIn) {
            html += '<button class="action-btn pl-delete-btn" data-id="' + esc(p.id) + '" style="font-size: 11px; padding: 3px 8px; color: var(--err); border-color: color-mix(in srgb, var(--err) 30%, var(--border));">Delete</button>';
          }
          html += '</td></tr>';
        }
        html += '</tbody></table>';
        el.plList.innerHTML = html;

        // Wire edit buttons
        el.plList.querySelectorAll('.pl-edit-btn').forEach(function(btn) {
          btn.onclick = function() { openPipelineEditor(btn.getAttribute('data-id')); };
        });
        // Wire delete buttons
        el.plList.querySelectorAll('.pl-delete-btn').forEach(function(btn) {
          btn.onclick = function() { deletePipeline(btn.getAttribute('data-id')); };
        });
      } catch(e) {
        el.plList.innerHTML = '<div style="color: var(--err); font-size: 12px; padding: 12px 0;">Failed to load pipelines: ' + esc(e.message) + '</div>';
      }
    }

    async function openPipelineEditor(id) {
      el.plEditor.style.display = '';
      el.plEditorResult.innerHTML = '';
      if (id) {
        // Edit existing
        plEditingId = id;
        el.plEditorTitle.textContent = 'Edit Pipeline';
        el.plEditorId.value = id;
        el.plEditorId.disabled = true;
        try {
          var res = await fetchJson('/api/pipelines/' + encodeURIComponent(id));
          el.plEditorYaml.value = res.pipeline.yaml;
        } catch(e) {
          el.plEditorYaml.value = '';
          el.plEditorResult.innerHTML = '<span style="color: var(--err);">Failed to load: ' + esc(e.message) + '</span>';
        }
      } else {
        // New pipeline
        plEditingId = null;
        el.plEditorTitle.textContent = 'New Pipeline';
        el.plEditorId.value = '';
        el.plEditorId.disabled = false;
        el.plEditorYaml.value = '';
      }
    }

    el.plNewBtn.onclick = function() { openPipelineEditor(null); };

    el.plEditorCancel.onclick = function() {
      el.plEditor.style.display = 'none';
      el.plEditorResult.innerHTML = '';
    };

    el.plEditorValidate.onclick = async function() {
      var yaml = el.plEditorYaml.value.trim();
      if (!yaml) { el.plEditorResult.innerHTML = '<span style="color: var(--err);">YAML is required.</span>'; return; }
      try {
        var res = await fetchJson('/api/pipelines/validate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ yaml: yaml }),
        });
        if (res.valid) {
          el.plEditorResult.innerHTML = '<span style="color: var(--ok);">\\u2713 Valid \\u2014 ' + esc(res.name) + ' (' + res.nodeCount + ' nodes)</span>';
        } else {
          el.plEditorResult.innerHTML = '<span style="color: var(--err);">\\u2717 ' + esc(res.error) + '</span>';
        }
      } catch(e) {
        el.plEditorResult.innerHTML = '<span style="color: var(--err);">Validation failed: ' + esc(e.message) + '</span>';
      }
    };

    el.plEditorSave.onclick = async function() {
      var id = plEditingId || el.plEditorId.value.trim();
      var yaml = el.plEditorYaml.value.trim();
      if (!id) { el.plEditorResult.innerHTML = '<span style="color: var(--err);">Pipeline ID is required.</span>'; return; }
      if (!yaml) { el.plEditorResult.innerHTML = '<span style="color: var(--err);">YAML is required.</span>'; return; }
      el.plEditorSave.disabled = true;
      try {
        var url = plEditingId ? '/api/pipelines/' + encodeURIComponent(id) : '/api/pipelines';
        var method = plEditingId ? 'PUT' : 'POST';
        var bodyObj = plEditingId ? { yaml: yaml } : { id: id, yaml: yaml };
        await fetchJson(url, {
          method: method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(bodyObj),
        });
        el.plEditorResult.innerHTML = '<span style="color: var(--ok);">\\u2713 Saved successfully.</span>';
        el.plEditor.style.display = 'none';
        refreshPipelineList();
      } catch(e) {
        el.plEditorResult.innerHTML = '<span style="color: var(--err);">Save failed: ' + esc(e.message) + '</span>';
      } finally {
        el.plEditorSave.disabled = false;
      }
    };

    async function deletePipeline(id) {
      if (!confirm('Delete pipeline "' + id + '"? This cannot be undone.')) return;
      try {
        await fetchJson('/api/pipelines/' + encodeURIComponent(id), { method: 'DELETE' });
        refreshPipelineList();
      } catch(e) {
        alert('Delete failed: ' + e.message);
      }
    }

    // ── Evals Panel ──

    el.evalsBtn.onclick = function() {
      el.evalsOverlay.classList.add('open');
      refreshEvals();
    };
    el.evalsClose.onclick = function() { el.evalsOverlay.classList.remove('open'); };
    el.evalsOverlay.onclick = function(e) { if (e.target === el.evalsOverlay) el.evalsOverlay.classList.remove('open'); };

    async function refreshEvals() {
      try {
        // Load scenarios
        var scenRes = await fetchJson('/api/eval/scenarios');
        var scenarios = scenRes.scenarios || [];
        if (scenarios.length === 0) {
          el.evalsScenarioList.innerHTML = '<div style="color: var(--muted); font-size: 12px; padding: 8px 0;">No scenarios found in evals/ directory.</div>';
        } else {
          var sHtml = '<div style="display: flex; gap: 8px; flex-wrap: wrap;">';
          scenarios.forEach(function(s) {
            var tags = (s.tags || []).map(function(t) {
              return '<span style="background: var(--badge-bg); color: var(--badge-text); font-size: 10px; padding: 1px 6px; border-radius: 4px;">' + t + '</span>';
            }).join(' ');
            sHtml += '<div style="border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; background: var(--panel-3); min-width: 180px;">';
            sHtml += '<div style="font-weight: 600; font-size: 13px; margin-bottom: 4px;">' + s.name + '</div>';
            sHtml += '<div style="font-size: 11px; color: var(--muted); margin-bottom: 6px;">' + (s.description || '') + '</div>';
            sHtml += '<div style="display: flex; gap: 4px;">' + tags + '</div>';
            sHtml += '</div>';
          });
          sHtml += '</div>';
          el.evalsScenarioList.innerHTML = sHtml;
        }

        // Load recent results
        var resData = await fetchJson('/api/eval/results?limit=30');
        var results = resData.results || [];
        if (results.length === 0) {
          el.evalsResults.innerHTML = '<div style="color: var(--muted); font-size: 12px; padding: 12px 0; text-align: center;">No eval results yet. Run <code>npm run eval</code> to get started.</div>';
        } else {
          var html = '<table style="width: 100%; border-collapse: collapse; font-size: 12px;">';
          html += '<thead><tr style="border-bottom: 2px solid var(--border); text-align: left;">';
          html += '<th style="padding: 6px 8px; font-size: 11px; color: var(--muted); text-transform: uppercase;">Scenario</th>';
          html += '<th style="padding: 6px 8px; font-size: 11px; color: var(--muted); text-transform: uppercase;">Result</th>';
          html += '<th style="padding: 6px 8px; font-size: 11px; color: var(--muted); text-transform: uppercase;">Score</th>';
          html += '<th style="padding: 6px 8px; font-size: 11px; color: var(--muted); text-transform: uppercase;">Duration</th>';
          html += '<th style="padding: 6px 8px; font-size: 11px; color: var(--muted); text-transform: uppercase;">Cost</th>';
          html += '<th style="padding: 6px 8px; font-size: 11px; color: var(--muted); text-transform: uppercase;">Judges</th>';
          html += '<th style="padding: 6px 8px; font-size: 11px; color: var(--muted); text-transform: uppercase;">Model</th>';
          html += '<th style="padding: 6px 8px; font-size: 11px; color: var(--muted); text-transform: uppercase;">Date</th>';
          html += '</tr></thead><tbody>';
          results.forEach(function(r) {
            var passColor = r.overallPass ? 'var(--ok)' : 'var(--err)';
            var passLabel = r.overallPass ? 'PASS' : 'FAIL';
            var totalMs = r.durationMs || 0;
            var durMin = Math.floor(totalMs / 60000);
            var durSec = Math.floor((totalMs % 60000) / 1000);
            var durStr = durMin > 0 ? durMin + 'm ' + durSec + 's' : durSec + 's';
            var judges = r.judgeResults || [];
            var passedJ = judges.filter(function(j) { return j.pass; }).length;
            var modelShort = (r.model || '').split('/').pop() || '-';
            html += '<tr style="border-bottom: 1px solid var(--border);">';
            html += '<td style="padding: 6px 8px; font-family: var(--font-mono); font-size: 11px;">' + r.scenarioName + '</td>';
            html += '<td style="padding: 6px 8px; color: ' + passColor + '; font-weight: 700;">' + passLabel + '</td>';
            html += '<td style="padding: 6px 8px;">' + r.overallScore + '</td>';
            html += '<td style="padding: 6px 8px;">' + durStr + '</td>';
            html += '<td style="padding: 6px 8px;">$' + (r.costUsd || 0).toFixed(2) + '</td>';
            html += '<td style="padding: 6px 8px;">' + passedJ + '/' + judges.length + '</td>';
            html += '<td style="padding: 6px 8px; font-size: 11px; color: var(--muted);">' + modelShort + '</td>';
            html += '<td style="padding: 6px 8px; color: var(--muted); font-size: 11px;">' + new Date(r.createdAt).toLocaleString() + '</td>';
            html += '</tr>';
          });
          html += '</tbody></table>';
          el.evalsResults.innerHTML = html;
        }
      } catch(e) {
        el.evalsResults.innerHTML = '<div style="color: var(--err); font-size: 12px;">Failed to load evals: ' + e.message + '</div>';
      }
    }

    // ── Learnings Panel ──

    el.learningsBtn.onclick = function() {
      el.learningsOverlay.classList.add('open');
      refreshLearnings();
    };
    el.learningsClose.onclick = function() { el.learningsOverlay.classList.remove('open'); };
    el.learningsOverlay.onclick = function(e) { if (e.target === el.learningsOverlay) el.learningsOverlay.classList.remove('open'); };

    async function refreshLearnings() {
      try {
        var res = await fetchJson('/api/learnings/summary');
        var sys = res.system || {};
        var repos = res.repos || [];

        // System stats cards
        el.learningsSystem.innerHTML =
          '<div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px;">' +
          '<div style="border: 1px solid var(--border); border-radius: 8px; padding: 10px; background: var(--panel-3); text-align: center;">' +
            '<div style="font-size: 22px; font-weight: 700;">' + (sys.totalRuns || 0) + '</div>' +
            '<div style="font-size: 11px; color: var(--muted);">Total Runs</div>' +
          '</div>' +
          '<div style="border: 1px solid var(--border); border-radius: 8px; padding: 10px; background: var(--panel-3); text-align: center;">' +
            '<div style="font-size: 22px; font-weight: 700; color: var(--ok);">' + (sys.successRate || 0) + '%</div>' +
            '<div style="font-size: 11px; color: var(--muted);">Success Rate</div>' +
          '</div>' +
          '<div style="border: 1px solid var(--border); border-radius: 8px; padding: 10px; background: var(--panel-3); text-align: center;">' +
            '<div style="font-size: 22px; font-weight: 700;">$' + (sys.totalCostUsd || 0).toFixed(2) + '</div>' +
            '<div style="font-size: 11px; color: var(--muted);">Total Cost</div>' +
          '</div>' +
          '<div style="border: 1px solid var(--border); border-radius: 8px; padding: 10px; background: var(--panel-3); text-align: center;">' +
            '<div style="font-size: 22px; font-weight: 700;">' + Math.round((sys.avgDurationMs || 0) / 1000) + 's</div>' +
            '<div style="font-size: 11px; color: var(--muted);">Avg Duration</div>' +
          '</div>' +
          '</div>';

        // Repos table
        if (repos.length === 0) {
          el.learningsRepos.innerHTML = '<div style="color: var(--muted); font-size: 12px; padding: 12px 0; text-align: center;">No run data yet.</div>';
        } else {
          var html = '<table style="width: 100%; border-collapse: collapse; font-size: 12px;">';
          html += '<thead><tr style="border-bottom: 2px solid var(--border); text-align: left;">';
          html += '<th style="padding: 6px 8px; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em;">Repo</th>';
          html += '<th style="padding: 6px 8px; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em;">Runs</th>';
          html += '<th style="padding: 6px 8px; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em;">Success</th>';
          html += '<th style="padding: 6px 8px; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em;">Avg Cost</th>';
          html += '<th style="padding: 6px 8px; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em;">Last Run</th>';
          html += '</tr></thead><tbody>';
          repos.forEach(function(r) {
            var rateColor = r.successRate >= 80 ? 'var(--ok)' : r.successRate >= 50 ? 'var(--warn)' : 'var(--err)';
            html += '<tr style="border-bottom: 1px solid var(--border);">';
            html += '<td style="padding: 6px 8px; font-family: var(--font-mono); font-size: 11px;">' + r.repoSlug + '</td>';
            html += '<td style="padding: 6px 8px;">' + r.totalRuns + '</td>';
            html += '<td style="padding: 6px 8px; color: ' + rateColor + '; font-weight: 600;">' + r.successRate + '%</td>';
            html += '<td style="padding: 6px 8px;">$' + r.avgCostUsd.toFixed(2) + '</td>';
            html += '<td style="padding: 6px 8px; color: var(--muted);">' + new Date(r.lastRunAt).toLocaleDateString() + '</td>';
            html += '</tr>';
          });
          html += '</tbody></table>';
          el.learningsRepos.innerHTML = html;
        }

        // Recent outcomes
        var outRes = await fetchJson('/api/learnings/outcomes?limit=20');
        var outcomes = outRes.outcomes || [];
        if (outcomes.length === 0) {
          el.learningsOutcomes.innerHTML = '<div style="color: var(--muted); font-size: 12px; padding: 12px 0; text-align: center;">No outcomes recorded yet.</div>';
        } else {
          var oHtml = '<div style="max-height: 300px; overflow-y: auto;">';
          outcomes.forEach(function(o) {
            var statusColor = o.status === 'completed' ? 'var(--ok)' : 'var(--err)';
            oHtml += '<div style="display: flex; gap: 8px; align-items: center; padding: 5px 0; border-bottom: 1px solid var(--border); font-size: 12px;">';
            oHtml += '<span style="width: 8px; height: 8px; border-radius: 50%; background: ' + statusColor + '; flex-shrink: 0;"></span>';
            oHtml += '<span style="font-family: var(--font-mono); font-size: 11px; min-width: 140px;">' + o.repoSlug + '</span>';
            oHtml += '<span style="color: var(--muted); min-width: 60px;">' + o.source + '</span>';
            oHtml += '<span style="color: var(--muted);">$' + (o.costUsd || 0).toFixed(2) + '</span>';
            oHtml += '<span style="color: var(--muted); margin-left: auto; font-size: 11px;">' + new Date(o.timestamp).toLocaleString() + '</span>';
            oHtml += '</div>';
          });
          oHtml += '</div>';
          el.learningsOutcomes.innerHTML = oHtml;
        }
      } catch(e) {
        el.learningsSystem.innerHTML = '<div style="color: var(--err); font-size: 12px;">Failed to load learnings: ' + e.message + '</div>';
      }
    }

    async function refreshAll() {
      await loadRuns();
      await loadWorkItems();
      await refreshSelected();
      await refreshObserver();
    }

    initTheme();
    if (el.boardWorkflow) {
      el.boardWorkflow.value = state.boardWorkflow;
    }
    updateDashboardChrome();
    refreshAll().catch(console.error);
    state.interval = setInterval(() => {
      refreshAll().catch(console.error);
    }, 5000);
  </script>
</body>
</html>`;
}
