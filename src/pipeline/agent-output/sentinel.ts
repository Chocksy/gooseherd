/**
 * Generic sentinel parser shared by agent nodes that need to read a
 * `GOOSEHERD_*: …` line out of mixed agent output (plain stdout, pi JSONL
 * event stream, assistant message blocks).
 *
 * Used for `GOOSEHERD_REVIEW_SUMMARY` (auto-review), `GOOSEHERD_CI_TRIAGE`
 * (CI failure triage), and `GOOSEHERD_CONTEXT_CONFLICT` (escape hatch).
 */

export type SentinelExtractionMethod =
  | "plain_text"
  | "pi_jsonl_message_update"
  | "pi_jsonl_message_end"
  | "pi_jsonl_turn_end"
  | "pi_jsonl_agent_end"
  | "none";

export interface SentinelMatch {
  text: string;
  method: Exclude<SentinelExtractionMethod, "none">;
}

export interface ExtractSentinelOptions {
  /**
   * When true, prefer matches whose payload after the prefix contains a
   * parseable JSON object. Falls back to a non-JSON match if no JSON-bearing
   * match exists. Use for sentinels whose contract is `<PREFIX> {…}`.
   */
  requireJsonObject?: boolean;
}

export interface SentinelJsonResult {
  found: boolean;
  match?: SentinelMatch;
  jsonText?: string;
  parsed?: Record<string, unknown>;
  parseError?: "missing_json" | "invalid_json";
}

export function extractSentinelMatch(
  output: string,
  directPattern: RegExp,
  prefix: string,
  options: ExtractSentinelOptions = {},
): SentinelMatch | undefined {
  const directMatch = directPattern.exec(output);
  if (directMatch?.index !== undefined) {
    const directText = findSentinelText(output.slice(directMatch.index), prefix, options) ?? directMatch[0].trim();
    return { text: directText, method: "plain_text" };
  }

  return findPiJsonlAssistantText(output, prefix, options);
}

export function extractSentinelJson(
  output: string,
  directPattern: RegExp,
  prefix: string,
): SentinelJsonResult {
  const match = extractSentinelMatch(output, directPattern, prefix, { requireJsonObject: true });
  if (!match) {
    return { found: false };
  }

  const jsonText = extractJsonObjectAfterPrefix(match.text, prefix);
  if (!jsonText) {
    return { found: true, match, parseError: "missing_json" };
  }

  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    return { found: true, match, jsonText, parsed };
  } catch {
    return { found: true, match, jsonText, parseError: "invalid_json" };
  }
}

export function findSentinelText(
  value: string,
  prefix: string,
  options: ExtractSentinelOptions = {},
): string | undefined {
  const startIndex = value.indexOf(prefix);
  if (startIndex < 0) {
    return undefined;
  }

  const suffix = value.slice(startIndex);
  if (options.requireJsonObject) {
    const jsonText = extractJsonObjectAfterPrefix(suffix, prefix);
    if (jsonText) {
      return `${prefix} ${jsonText}`;
    }
  }

  for (const line of suffix.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(prefix)) {
      return trimmed;
    }
  }
  return undefined;
}

export function extractJsonObjectAfterPrefix(value: string, prefix: string): string | undefined {
  const prefixIndex = value.indexOf(prefix);
  if (prefixIndex < 0) {
    return undefined;
  }

  let cursor = prefixIndex + prefix.length;
  while (cursor < value.length && /\s/.test(value[cursor] ?? "")) {
    cursor += 1;
  }
  if (value[cursor] !== "{") {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = cursor; index < value.length; index += 1) {
    const char = value[index] ?? "";

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return value.slice(cursor, index + 1);
      }
    }
  }

  return undefined;
}

function findPiJsonlAssistantText(
  output: string,
  prefix: string,
  options: ExtractSentinelOptions,
): SentinelMatch | undefined {
  const requireJson = options.requireJsonObject ?? false;
  let fallbackMatch: SentinelMatch | undefined;

  const considerCandidate = (text: string, method: Exclude<SentinelExtractionMethod, "none">):
    | { kind: "match"; match: SentinelMatch }
    | { kind: "fallback"; match: SentinelMatch }
    | undefined => {
    const sentinelText = findSentinelText(text, prefix, options);
    if (!sentinelText) {
      return undefined;
    }
    if (requireJson && !extractJsonObjectAfterPrefix(sentinelText, prefix)) {
      return { kind: "fallback", match: { text: sentinelText, method } };
    }
    return { kind: "match", match: { text: sentinelText, method } };
  };

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const eventType = event["type"];

    if (eventType === "message_update") {
      for (const content of extractAssistantUpdateTexts(event["assistantMessageEvent"])) {
        const candidate = considerCandidate(content, "pi_jsonl_message_update");
        if (candidate?.kind === "match") return candidate.match;
        if (candidate?.kind === "fallback") fallbackMatch ??= candidate.match;
      }
    }

    if (eventType === "message_end" || eventType === "turn_end") {
      const method: Exclude<SentinelExtractionMethod, "none"> =
        eventType === "turn_end" ? "pi_jsonl_turn_end" : "pi_jsonl_message_end";
      for (const text of extractAssistantMessageTexts(event["message"])) {
        const candidate = considerCandidate(text, method);
        if (candidate?.kind === "match") return candidate.match;
        if (candidate?.kind === "fallback") fallbackMatch ??= candidate.match;
      }
    }

    if (eventType === "agent_end") {
      const messages = event["messages"];
      if (Array.isArray(messages)) {
        for (const message of messages) {
          for (const text of extractAssistantMessageTexts(message)) {
            const candidate = considerCandidate(text, "pi_jsonl_agent_end");
            if (candidate?.kind === "match") return candidate.match;
            if (candidate?.kind === "fallback") fallbackMatch ??= candidate.match;
          }
        }
      }
    }
  }

  return fallbackMatch;
}

function extractAssistantUpdateTexts(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const event = value as Record<string, unknown>;
  if (event["type"] === "text_end") {
    const content = event["content"];
    return typeof content === "string" && content.trim() ? [content.trim()] : [];
  }

  if (event["type"] === "text_delta") {
    const partial = event["partial"];
    return extractAssistantMessageTexts(partial);
  }

  return [];
}

function extractAssistantMessageTexts(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const message = value as Record<string, unknown>;
  if (message["role"] !== "assistant") {
    return [];
  }

  const content = message["content"];
  if (!Array.isArray(content)) {
    return [];
  }

  return content
    .filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === "object")
    .filter((block) => block["type"] === "text")
    .map((block) => block["text"])
    .filter((text): text is string => typeof text === "string")
    .map((text) => text.trim())
    .filter(Boolean);
}
