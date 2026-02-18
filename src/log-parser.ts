/**
 * Parses raw Goose agent logs into structured events for dashboard rendering.
 *
 * Goose (--debug mode) emits:
 *   ─── tool_name | extension ──────────────────────────
 *   key: value                    (tool parameters)
 *   <stdout from tool>
 *   Annotated { ... }             (tool result in Rust debug format)
 *   <free text>                   (agent thinking)
 *
 * Gooseherd executor emits:
 *   $ command                     (shell commands)
 *   <AppName> run <uuid>          (run header)
 *   starting session | provider:  (session start)
 */

export type RunEventType =
  | "session_start"
  | "agent_thinking"
  | "tool_call"
  | "shell_cmd"
  | "phase_marker"
  | "info";

export interface RunEvent {
  type: RunEventType;
  index: number;
  progressPercent: number;

  // tool_call fields
  tool?: string;
  extension?: string;
  params?: Record<string, string>;

  // shell_cmd fields
  command?: string;

  // session_start fields
  provider?: string;
  model?: string;

  // phase_marker fields
  phase?: string;

  // Common
  content: string;
}

// ── Pattern matchers ──────────────────────────────────────

const TOOL_HEADER_RE = /^─── (\S+) \| (\S+) ─+$/;
const SHELL_CMD_RE = /^\$ (.+)$/;
const SESSION_START_RE = /^starting session \| provider: (\S+) model: (.+)$/;
const ANNOTATED_START_RE = /^Annotated\s*\{/;
const APP_RUN_RE = /^\w+ run ([\w-]+)$/;
const TOOL_PARAM_RE = /^([a-z_]+): (.+)$/;
const SESSION_META_RE = /^\s+(session id|working directory): .+$/;

const NOISE_PATTERNS = [
  /^---\s*loading\s+\.bash_profile/,
  /All secrets loaded from cache/,
  /^🎊/,
  /^\s*$/,
  /^zsh:\d+: command not found:/,
];

// Patterns that indicate leaked Annotated block content (safety net).
// Covers Rust Debug fields that appear in Goose tool result blocks.
const ANNOTATED_LEAK_RE =
  /^\s*(raw:\s*Text\(|RawTextContent\s*\{|annotations:\s*(Some|None)|Annotations\s*\{|audience:\s*Some\(|priority:\s*Some\(|meta:\s*None)/;

function isNoiseLine(line: string): boolean {
  return NOISE_PATTERNS.some((pattern) => pattern.test(line));
}

// ── Annotated block skipper ──────────────────────────────

function skipAnnotatedBlock(lines: string[], startIndex: number): number {
  let depth = 1;
  let i = startIndex + 1;
  while (i < lines.length && depth > 0) {
    const line = lines[i];
    // Count braces, but skip braces inside quoted strings.
    // Rust Debug format wraps string values in "..." — braces inside
    // those strings (e.g. CSS, code snippets) must not affect depth.
    let inQuote = false;
    for (let ci = 0; ci < line.length; ci++) {
      const ch = line[ci];
      if (ch === '"' && (ci === 0 || line[ci - 1] !== "\\")) {
        inQuote = !inQuote;
        continue;
      }
      if (!inQuote) {
        if (ch === "{") depth++;
        if (ch === "}") depth--;
      }
    }
    i++;
    if (depth <= 0) break;
  }
  return i;
}

// ── Main parser ──────────────────────────────────────────

export function parseRunLog(rawLog: string): RunEvent[] {
  const lines = rawLog.split("\n");
  const events: RunEvent[] = [];
  let i = 0;
  let thinkingBuffer: string[] = [];

  function flushThinking(): void {
    // Filter out lines that look like leaked Annotated block internals.
    // This is a safety net for when skipAnnotatedBlock exits too early
    // (e.g. interleaved async tool output corrupts brace counting).
    const cleaned = thinkingBuffer.filter(
      (line) => !ANNOTATED_LEAK_RE.test(line)
    );
    const text = cleaned.join("\n").trim();

    // If the block starts with Annotated block debris, discard entirely.
    // Catches: "),", "},", "]" (closing delimiters from Rust Debug),
    // and "text: " (the text field inside RawTextContent).
    if (/^["'),}\]]/.test(text) || /^text:\s*"/.test(text)) {
      thinkingBuffer = [];
      return;
    }

    if (text.length > 0) {
      events.push({
        type: "agent_thinking",
        index: 0,
        progressPercent: 0,
        content: text,
      });
    }
    thinkingBuffer = [];
  }

  while (i < lines.length) {
    const line = lines[i];

    // Skip noise lines
    if (isNoiseLine(line)) {
      i++;
      continue;
    }

    // Skip Annotated { ... } blocks (orphaned ones between tool calls)
    if (ANNOTATED_START_RE.test(line)) {
      i = skipAnnotatedBlock(lines, i);
      continue;
    }

    // ── App run header ────────────────────────────
    const appRunMatch = APP_RUN_RE.exec(line);
    if (appRunMatch) {
      flushThinking();
      events.push({
        type: "info",
        index: 0,
        progressPercent: 0,
        content: line,
      });
      i++;
      continue;
    }

    // ── Session start ────────────────────────────
    const sessionMatch = SESSION_START_RE.exec(line);
    if (sessionMatch) {
      flushThinking();
      // Skip the following session metadata lines (session id, working directory)
      let j = i + 1;
      while (j < lines.length && SESSION_META_RE.test(lines[j])) {
        j++;
      }
      events.push({
        type: "session_start",
        index: 0,
        progressPercent: 0,
        provider: sessionMatch[1],
        model: sessionMatch[2],
        content: `Session started with ${sessionMatch[1]} / ${sessionMatch[2]}`,
      });
      i = j;
      continue;
    }

    // ── Shell command ($ prefix) ──────────────────
    const shellMatch = SHELL_CMD_RE.exec(line);
    if (shellMatch) {
      flushThinking();
      const command = shellMatch[1];

      // Determine phase from command
      let phase: string | undefined;
      if (command.includes("git clone")) phase = "cloning";
      else if (command.includes("goose run") || command.includes("AGENT_COMMAND")) phase = "agent";
      else if (command.includes("git push")) phase = "pushing";
      else if (command.includes("git add") || command.includes("git commit")) phase = "committing";

      // Skip stdout lines until next structural element
      let j = i + 1;
      const outputLines: string[] = [];
      while (j < lines.length) {
        const nextLine = lines[j];
        if (
          TOOL_HEADER_RE.test(nextLine) ||
          SHELL_CMD_RE.test(nextLine) ||
          SESSION_START_RE.test(nextLine) ||
          APP_RUN_RE.test(nextLine)
        ) {
          break;
        }
        if (ANNOTATED_START_RE.test(nextLine)) {
          j = skipAnnotatedBlock(lines, j);
          continue;
        }
        if (!isNoiseLine(nextLine)) {
          outputLines.push(nextLine);
        }
        j++;
      }

      const output = outputLines.join("\n").trim();
      events.push({
        type: phase ? "phase_marker" : "shell_cmd",
        index: 0,
        progressPercent: 0,
        command,
        phase,
        content: output ? `$ ${command}\n${output}` : `$ ${command}`,
      });
      i = j;
      continue;
    }

    // ── Tool call header ─────────────────────────
    const toolMatch = TOOL_HEADER_RE.exec(line);
    if (toolMatch) {
      flushThinking();
      const tool = toolMatch[1];
      const extension = toolMatch[2];
      const params: Record<string, string> = {};

      // Collect params (key: value lines immediately after header)
      let j = i + 1;
      while (j < lines.length) {
        const paramLine = lines[j];
        if (isNoiseLine(paramLine)) {
          j++;
          continue;
        }
        const paramMatch = TOOL_PARAM_RE.exec(paramLine);
        if (paramMatch) {
          params[paramMatch[1]] = paramMatch[2];
          j++;
          continue;
        }
        break;
      }

      // Collect tool stdout until Annotated block or next structural element.
      // Once we see the Annotated block (tool result), the tool call is done —
      // any text after it is agent thinking, not tool output.
      const outputLines: string[] = [];
      while (j < lines.length) {
        const nextLine = lines[j];
        if (
          TOOL_HEADER_RE.test(nextLine) ||
          SHELL_CMD_RE.test(nextLine) ||
          SESSION_START_RE.test(nextLine) ||
          APP_RUN_RE.test(nextLine)
        ) {
          break;
        }
        if (ANNOTATED_START_RE.test(nextLine)) {
          j = skipAnnotatedBlock(lines, j);
          // After the Annotated result block, the tool call is complete.
          // Skip trailing noise/blank lines but stop before real content.
          while (j < lines.length && isNoiseLine(lines[j])) {
            j++;
          }
          break;
        }
        if (!isNoiseLine(nextLine)) {
          outputLines.push(nextLine);
        }
        j++;
      }

      // Build a readable summary for the tool call
      let summary = `${tool}`;
      if (params.path) {
        summary = `${tool}: ${shortenPath(params.path)}`;
      } else if (params.command) {
        summary = `${tool}: ${params.command}`;
      }

      const output = outputLines.join("\n").trim();
      events.push({
        type: "tool_call",
        index: 0,
        progressPercent: 0,
        tool,
        extension,
        params,
        content: output ? `${summary}\n${output}` : summary,
      });
      i = j;
      continue;
    }

    // ── Agent thinking (free text) ───────────────
    thinkingBuffer.push(line);
    i++;
  }

  // Flush any remaining thinking text
  flushThinking();

  // Assign indices and progress percentages
  const significantEvents = events.filter(
    (e) => e.type === "tool_call" || e.type === "agent_thinking" || e.type === "session_start"
  );
  const totalSignificant = significantEvents.length;

  for (let idx = 0; idx < events.length; idx++) {
    events[idx].index = idx;
  }

  // Calculate progress: infrastructure events get fixed %, agent events get proportional %
  let significantIndex = 0;
  for (const event of events) {
    if (event.type === "tool_call" || event.type === "agent_thinking" || event.type === "session_start") {
      event.progressPercent =
        totalSignificant > 0
          ? Math.round(((significantIndex + 1) / totalSignificant) * 1000) / 10
          : 0;
      significantIndex++;
    } else if (event.type === "phase_marker") {
      if (event.phase === "cloning") event.progressPercent = 5;
      else if (event.phase === "agent") event.progressPercent = 10;
      else if (event.phase === "committing") event.progressPercent = 88;
      else if (event.phase === "pushing") event.progressPercent = 95;
      else event.progressPercent = 0;
    }
  }

  return events;
}

// ── Helpers ──────────────────────────────────────────────

function shortenPath(fullPath: string): string {
  // Strip the long .work/<uuid>/repo/ prefix for readability
  const repoIndex = fullPath.indexOf("/repo/");
  if (repoIndex >= 0) {
    return fullPath.slice(repoIndex + 6);
  }
  // Fallback: show last 3 segments
  const segments = fullPath.split("/");
  if (segments.length > 3) {
    return ".../" + segments.slice(-3).join("/");
  }
  return fullPath;
}

/** Parse events and return summary stats */
export function getEventStats(events: RunEvent[]): {
  totalEvents: number;
  toolCalls: number;
  thinkingBlocks: number;
  shellCommands: number;
  tools: Record<string, number>;
} {
  const tools: Record<string, number> = {};
  let toolCalls = 0;
  let thinkingBlocks = 0;
  let shellCommands = 0;

  for (const event of events) {
    if (event.type === "tool_call") {
      toolCalls++;
      const name = event.tool ?? "unknown";
      tools[name] = (tools[name] ?? 0) + 1;
    } else if (event.type === "agent_thinking") {
      thinkingBlocks++;
    } else if (event.type === "shell_cmd" || event.type === "phase_marker") {
      shellCommands++;
    }
  }

  return {
    totalEvents: events.length,
    toolCalls,
    thinkingBlocks,
    shellCommands,
    tools,
  };
}
