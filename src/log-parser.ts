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

  // tool result (extracted from Annotated blocks for memory/cems tools)
  result?: string;

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
    // Safety valve: tool headers never appear inside valid Annotated blocks.
    // If we hit one, the brace counting got confused by interleaved async output.
    if (TOOL_HEADER_RE.test(line)) break;
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

// Tools whose Annotated result blocks should be extracted (not skipped)
const RESULT_CAPTURE_TOOLS = new Set(["memory_search", "memory_add", "memory_forget", "memory_update"]);

/**
 * Extract a human-readable summary from an Annotated block for memory tools.
 * Looks for JSON inside `text: "..."` fields and formats memory results.
 */
function extractAnnotatedResult(lines: string[], startIndex: number): { endIndex: number; summary: string } {
  const collected: string[] = [];
  let depth = 1;
  let i = startIndex + 1;
  while (i < lines.length && depth > 0) {
    const line = lines[i];
    // Safety valve: tool headers never appear inside valid Annotated blocks.
    if (TOOL_HEADER_RE.test(line)) break;
    collected.push(line);
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

  // Try to find JSON in the text field
  const blob = collected.join("\n");
  const jsonMatch = blob.match(/text:\s*"(\{.*?\})"/s);
  if (!jsonMatch) return { endIndex: i, summary: "" };

  try {
    // Unescape the Rust debug string (\\n → \n, \\" → ")
    const raw = jsonMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
    const data = JSON.parse(raw);

    if (data.results && Array.isArray(data.results)) {
      // memory_search response
      const count = data.count ?? data.results.length;
      const summaryParts = [`${count} result${count !== 1 ? "s" : ""}`];
      if (data.mode) summaryParts.push(`(${data.mode})`);
      if (data.tokens_used) summaryParts.push(`${data.tokens_used} tokens`);

      const resultLines = [summaryParts.join(" ")];
      for (const r of data.results.slice(0, 3)) {
        const score = typeof r.score === "number" ? ` [${Math.round(r.score * 100)}%]` : "";
        const content = (r.content ?? "").slice(0, 150);
        resultLines.push(`  ${score} ${content}${(r.content ?? "").length > 150 ? "..." : ""}`);
      }
      if (data.results.length > 3) {
        resultLines.push(`  ... and ${data.results.length - 3} more`);
      }
      return { endIndex: i, summary: resultLines.join("\n") };
    }

    if (data.success !== undefined) {
      // memory_add / memory_update / memory_forget response
      return { endIndex: i, summary: data.success ? "stored" : "failed" };
    }
  } catch {
    // JSON parse failed — return raw truncated
  }

  return { endIndex: i, summary: "" };
}

/**
 * Find the first memory tool call event that hasn't received a result yet.
 * Used to match orphaned Annotated blocks back to their originating tool call
 * when Goose batches parallel calls (headers first, results later in FIFO order).
 */
function findFirstUnresolvedMemoryEvent(events: RunEvent[]): number | undefined {
  for (let k = 0; k < events.length; k++) {
    if (
      events[k].type === "tool_call" &&
      RESULT_CAPTURE_TOOLS.has(events[k].tool ?? "") &&
      !events[k].result
    ) {
      return k;
    }
  }
  return undefined;
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

    // Handle orphaned Annotated { ... } blocks between tool calls.
    // When Goose batches parallel tool calls, results arrive as separate
    // Annotated blocks AFTER all the call headers. Try to attach memory
    // results to the first unresolved memory tool call (FIFO order).
    if (ANNOTATED_START_RE.test(line)) {
      const unresolvedIdx = findFirstUnresolvedMemoryEvent(events);
      if (unresolvedIdx !== undefined) {
        const extracted = extractAnnotatedResult(lines, i);
        i = extracted.endIndex;
        if (extracted.summary) {
          events[unresolvedIdx].result = extracted.summary;
        }
      } else {
        i = skipAnnotatedBlock(lines, i);
      }
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
      // For memory tools (memory_search, memory_add), extract a human-readable
      // summary from the Annotated block instead of discarding it.
      const outputLines: string[] = [];
      let toolResult: string | undefined;
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
          if (RESULT_CAPTURE_TOOLS.has(tool)) {
            const extracted = extractAnnotatedResult(lines, j);
            j = extracted.endIndex;
            if (extracted.summary) toolResult = extracted.summary;
          } else {
            j = skipAnnotatedBlock(lines, j);
          }
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
      } else if (params.query) {
        summary = `${tool}: "${params.query}"`;
      }

      const output = outputLines.join("\n").trim();
      events.push({
        type: "tool_call",
        index: 0,
        progressPercent: 0,
        tool,
        extension,
        params,
        result: toolResult,
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
