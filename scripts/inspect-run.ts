#!/usr/bin/env tsx
/**
 * CLI tool to visualize parsed Goose agent logs in the terminal.
 * Same data the dashboard shows, but for debugging and parser development.
 *
 * Usage:
 *   npm run inspect -- <runId>              # Pretty-print events
 *   npm run inspect -- <runId> --json       # JSON output
 *   npm run inspect -- <runId> --filter tool_call
 *   npm run inspect -- <runId> --stats-only
 *   npm run inspect -- path/to/run.log      # Direct log file
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseRunLog, getEventStats, type RunEvent, type RunEventType } from "../src/log-parser.js";

// ── ANSI colors (no deps) ────────────────────────────────

const isTTY = process.stdout.isTTY ?? false;

const c = {
  reset: isTTY ? "\x1b[0m" : "",
  bold: isTTY ? "\x1b[1m" : "",
  dim: isTTY ? "\x1b[2m" : "",
  cyan: isTTY ? "\x1b[36m" : "",
  yellow: isTTY ? "\x1b[33m" : "",
  green: isTTY ? "\x1b[32m" : "",
  red: isTTY ? "\x1b[31m" : "",
  magenta: isTTY ? "\x1b[35m" : "",
  blue: isTTY ? "\x1b[34m" : "",
  gray: isTTY ? "\x1b[90m" : "",
  bgCyan: isTTY ? "\x1b[46m\x1b[30m" : "",
  bgYellow: isTTY ? "\x1b[43m\x1b[30m" : "",
  bgGreen: isTTY ? "\x1b[42m\x1b[30m" : "",
  bgRed: isTTY ? "\x1b[41m\x1b[37m" : "",
  bgMagenta: isTTY ? "\x1b[45m\x1b[37m" : "",
};

// ── Argument parsing ─────────────────────────────────────

interface CliArgs {
  target: string;
  json: boolean;
  filter?: RunEventType;
  statsOnly: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
${c.bold}inspect-run${c.reset} — Visualize Goose agent log parser output

${c.bold}Usage:${c.reset}
  npm run inspect -- <runId|path/to/run.log> [options]

${c.bold}Options:${c.reset}
  --json         Output parsed events as JSON array
  --filter TYPE  Show only events of TYPE (tool_call, agent_thinking, shell_cmd, phase_marker, session_start, info)
  --stats-only   Show only summary statistics
  --help, -h     Show this help

${c.bold}Examples:${c.reset}
  npm run inspect -- 1eaddfd0-4245-44ae-8804-f22982268a7c
  npm run inspect -- .work/1eaddfd0.../run.log --json
  npm run inspect -- 1eaddfd0 --filter tool_call
  npm run inspect -- 1eaddfd0 --stats-only
`);
    process.exit(0);
  }

  let target = "";
  let json = false;
  let filter: RunEventType | undefined;
  let statsOnly = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--filter") {
      const VALID_TYPES = new Set(["tool_call", "agent_thinking", "shell_cmd", "phase_marker", "session_start", "info"]);
      const val = args[++i];
      if (!val || !VALID_TYPES.has(val)) {
        console.error(`Invalid filter type: "${val}". Valid: ${[...VALID_TYPES].join(", ")}`);
        process.exit(1);
      }
      filter = val as RunEventType;
    } else if (arg === "--stats-only") {
      statsOnly = true;
    } else if (!arg.startsWith("--")) {
      target = arg;
    }
  }

  if (!target) {
    console.error("Error: provide a run ID or path to run.log");
    process.exit(1);
  }

  return { target, json, filter, statsOnly };
}

// ── Log file resolution ──────────────────────────────────

function resolveLogPath(target: string): string {
  // Direct file path
  if (existsSync(target) && target.endsWith(".log")) {
    return target;
  }

  // Try as run ID in .work directory
  const workDir = path.join(process.cwd(), ".work");
  if (existsSync(workDir)) {
    // Exact match
    const exactPath = path.join(workDir, target, "run.log");
    if (existsSync(exactPath)) return exactPath;

    // Prefix match (allow short IDs like "1eaddfd0")
    const dirs = readdirSync(workDir);
    const match = dirs.find((d) => d.startsWith(target));
    if (match) {
      const matchPath = path.join(workDir, match, "run.log");
      if (existsSync(matchPath)) return matchPath;
    }
  }

  console.error(`Error: cannot find run log for "${target}"`);
  console.error(`  Tried: ${target}, .work/${target}/run.log, .work/${target}*/run.log`);
  process.exit(1);
}

// ── Event formatters ─────────────────────────────────────

function formatToolCall(ev: RunEvent, idx: number): string {
  const lines: string[] = [];
  const toolColor = ev.tool?.startsWith("memory") ? c.magenta : c.cyan;
  const extBadge = ev.extension ? `${c.gray}| ${ev.extension}${c.reset}` : "";

  lines.push(
    `${c.gray}${String(idx).padStart(3)}${c.reset} ${toolColor}${c.bold}${ev.tool}${c.reset} ${extBadge}`
  );

  // Params
  if (ev.params && Object.keys(ev.params).length > 0) {
    for (const [key, val] of Object.entries(ev.params)) {
      const truncVal = val.length > 120 ? val.slice(0, 117) + "..." : val;
      lines.push(`     ${c.gray}${key}:${c.reset} ${truncVal}`);
    }
  }

  // Tool output (from content, skip the first summary line)
  const contentLines = ev.content.split("\n");
  const outputLines = contentLines.slice(1).filter((l) => l.trim());
  if (outputLines.length > 0) {
    const preview = outputLines.slice(0, 5);
    for (const line of preview) {
      lines.push(`     ${c.dim}${line.slice(0, 120)}${c.reset}`);
    }
    if (outputLines.length > 5) {
      lines.push(`     ${c.dim}... ${outputLines.length - 5} more lines${c.reset}`);
    }
  }

  // Memory result
  if (ev.result) {
    lines.push(`     ${c.green}${c.bold}RESULT:${c.reset}`);
    for (const rline of ev.result.split("\n")) {
      lines.push(`     ${c.green}${rline}${c.reset}`);
    }
  }

  return lines.join("\n");
}

function formatThinking(ev: RunEvent, idx: number): string {
  const text = ev.content.slice(0, 200);
  const ellipsis = ev.content.length > 200 ? "..." : "";
  return `${c.gray}${String(idx).padStart(3)} ${c.dim}[thinking] ${text}${ellipsis}${c.reset}`;
}

function formatShellCmd(ev: RunEvent, idx: number): string {
  const lines: string[] = [];
  const cmdColor = ev.phase ? c.yellow : c.blue;
  const phaseBadge = ev.phase ? ` ${c.bgYellow} ${ev.phase} ${c.reset}` : "";

  lines.push(
    `${c.gray}${String(idx).padStart(3)}${c.reset} ${cmdColor}$ ${ev.command}${c.reset}${phaseBadge}`
  );

  // Show output (skip the $ line from content)
  const contentLines = ev.content.split("\n").slice(1).filter((l) => l.trim());
  if (contentLines.length > 0) {
    const preview = contentLines.slice(0, 3);
    for (const line of preview) {
      lines.push(`     ${c.dim}${line.slice(0, 120)}${c.reset}`);
    }
    if (contentLines.length > 3) {
      lines.push(`     ${c.dim}... ${contentLines.length - 3} more lines${c.reset}`);
    }
  }

  return lines.join("\n");
}

function formatPhaseMarker(ev: RunEvent, idx: number): string {
  const bgColor =
    ev.phase === "cloning" ? c.bgCyan :
    ev.phase === "agent" ? c.bgGreen :
    ev.phase === "pushing" ? c.bgMagenta :
    ev.phase === "committing" ? c.bgYellow :
    c.bgCyan;

  return `${c.gray}${String(idx).padStart(3)}${c.reset} ${bgColor} ${ev.phase?.toUpperCase()} ${c.reset} ${c.dim}${ev.command ?? ""}${c.reset}`;
}

function formatSessionStart(ev: RunEvent, idx: number): string {
  return `${c.gray}${String(idx).padStart(3)}${c.reset} ${c.bgGreen} SESSION ${c.reset} ${c.bold}${ev.provider}${c.reset} / ${ev.model}`;
}

function formatInfo(ev: RunEvent, idx: number): string {
  return `${c.gray}${String(idx).padStart(3)}${c.reset} ${c.dim}${ev.content}${c.reset}`;
}

function formatEvent(ev: RunEvent, idx: number): string {
  switch (ev.type) {
    case "tool_call": return formatToolCall(ev, idx);
    case "agent_thinking": return formatThinking(ev, idx);
    case "shell_cmd": return formatShellCmd(ev, idx);
    case "phase_marker": return formatPhaseMarker(ev, idx);
    case "session_start": return formatSessionStart(ev, idx);
    case "info": return formatInfo(ev, idx);
    default: return `${c.gray}${String(idx).padStart(3)} [${ev.type}] ${ev.content.slice(0, 100)}${c.reset}`;
  }
}

// ── Stats formatter ──────────────────────────────────────

function formatStats(events: RunEvent[]): string {
  const stats = getEventStats(events);
  const lines: string[] = [];

  lines.push("");
  lines.push(`${c.bold}── Summary ──${c.reset}`);
  lines.push(`  Total events:    ${c.bold}${stats.totalEvents}${c.reset}`);
  lines.push(`  Tool calls:      ${c.cyan}${stats.toolCalls}${c.reset}`);
  lines.push(`  Thinking blocks: ${c.gray}${stats.thinkingBlocks}${c.reset}`);
  lines.push(`  Shell commands:  ${c.blue}${stats.shellCommands}${c.reset}`);

  // Tool breakdown
  const toolEntries = Object.entries(stats.tools).sort((a, b) => b[1] - a[1]);
  if (toolEntries.length > 0) {
    lines.push("");
    lines.push(`${c.bold}── Tools Used ──${c.reset}`);
    for (const [name, count] of toolEntries) {
      const bar = "█".repeat(Math.min(count, 40));
      const toolColor = name.startsWith("memory") ? c.magenta : c.cyan;
      lines.push(`  ${toolColor}${name.padEnd(20)}${c.reset} ${c.dim}${bar}${c.reset} ${count}`);
    }
  }

  // Memory results summary
  const memEvents = events.filter(
    (e) => e.type === "tool_call" && e.tool?.startsWith("memory")
  );
  if (memEvents.length > 0) {
    lines.push("");
    lines.push(`${c.bold}── Memory Tools ──${c.reset}`);
    for (const ev of memEvents) {
      const query = ev.params?.query ?? ev.params?.content?.slice(0, 60) ?? "(no params)";
      const hasResult = ev.result ? `${c.green}result${c.reset}` : `${c.red}no result${c.reset}`;
      lines.push(`  ${c.magenta}${ev.tool}${c.reset} ${c.dim}"${query.slice(0, 60)}"${c.reset} → ${hasResult}`);
    }
  }

  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────

function main(): void {
  const args = parseArgs();
  const logPath = resolveLogPath(args.target);
  const rawLog = readFileSync(logPath, "utf8");

  const events = parseRunLog(rawLog);

  // JSON mode
  if (args.json) {
    console.log(JSON.stringify(events, null, 2));
    return;
  }

  // Stats only
  if (args.statsOnly) {
    console.log(formatStats(events));
    return;
  }

  // Filter
  const filtered = args.filter
    ? events.filter((e) => e.type === args.filter)
    : events;

  // Header
  const runId = path.basename(path.dirname(logPath));
  console.log(`\n${c.bold}${c.cyan}── inspect-run: ${runId} ──${c.reset}`);
  console.log(`${c.dim}Log: ${logPath} (${rawLog.split("\n").length} lines)${c.reset}`);
  console.log(`${c.dim}Parsed: ${events.length} events${args.filter ? `, showing ${filtered.length} ${args.filter}` : ""}${c.reset}\n`);

  // Events
  for (let i = 0; i < filtered.length; i++) {
    console.log(formatEvent(filtered[i]!, i));
  }

  // Stats footer
  console.log(formatStats(events));
}

main();
