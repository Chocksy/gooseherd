/**
 * Thin LLM caller — raw HTTP to OpenRouter (OpenAI-compatible Chat Completions API).
 * No SDK dependency. Supports model selection, timeout, JSON mode.
 */


export interface LLMCallerConfig {
  apiKey: string;
  defaultModel: string;
  defaultTimeoutMs: number;
  /** OpenRouter provider routing preferences (e.g. { ignore: ["DeepInfra"] }). */
  providerPreferences?: Record<string, unknown>;
}

export interface LLMRequest {
  system: string;
  userMessage: string;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** When true, sends response_format: { type: "json_object" } to the API. */
  jsonMode?: boolean;
}

/** Content part for multimodal (vision) messages. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface LLMVisionRequest {
  system: string;
  userContent: ContentPart[];
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** When true, sends response_format: { type: "json_object" } to the API. */
  jsonMode?: boolean;
}

export interface LLMResponse {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return true;
  return /operation was aborted|aborted/i.test(error.message);
}

const RETRYABLE_STATUS_CODES = new Set([429, 502, 503]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < MAX_RETRIES) {
        const retryAfter = response.headers.get("retry-after");
        const delayMs = retryAfter
          ? Math.min(Number(retryAfter) * 1000, 30_000)
          : BASE_DELAY_MS * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      return response;
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error(`LLM request timed out after ${String(timeoutMs)}ms`);
      }
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, BASE_DELAY_MS * Math.pow(2, attempt)));
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  // unreachable, but satisfies TS
  throw new Error("fetchWithRetry: max retries exceeded");
}

/**
 * Call the OpenRouter Chat Completions API with timeout support.
 * Returns the text content from the first choice.
 * Throws on timeout, network errors, or API errors.
 */
export async function callLLM(
  config: LLMCallerConfig,
  request: LLMRequest
): Promise<LLMResponse> {
  const model = request.model ?? config.defaultModel;
  const maxTokens = request.maxTokens ?? 1024;
  const timeoutMs = request.timeoutMs ?? config.defaultTimeoutMs;

  const response = await fetchWithRetry(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.userMessage }
        ],
        ...(request.jsonMode ? { response_format: { type: "json_object" } } : {}),
        ...(config.providerPreferences ? { provider: config.providerPreferences } : {})
      })
    },
    timeoutMs
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenRouter API ${String(response.status)}: ${body.slice(0, 200)}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
    model: string;
    usage: { prompt_tokens: number; completion_tokens: number };
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("No text content in API response");
  }

  return {
    content,
    model: data.model,
    inputTokens: data.usage.prompt_tokens,
    outputTokens: data.usage.completion_tokens
  };
}

/**
 * Call the OpenRouter Chat Completions API with multimodal (vision) content.
 * Supports text + image_url content parts in the user message.
 */
export async function callLLMVision(
  config: LLMCallerConfig,
  request: LLMVisionRequest
): Promise<LLMResponse> {
  const model = request.model ?? config.defaultModel;
  const maxTokens = request.maxTokens ?? 1024;
  const timeoutMs = request.timeoutMs ?? config.defaultTimeoutMs;

  const response = await fetchWithRetry(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.userContent }
        ],
        ...(request.jsonMode ? { response_format: { type: "json_object" } } : {}),
        ...(config.providerPreferences ? { provider: config.providerPreferences } : {})
      })
    },
    timeoutMs
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenRouter API ${String(response.status)}: ${body.slice(0, 200)}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
    model: string;
    usage: { prompt_tokens: number; completion_tokens: number };
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("No text content in API response");
  }

  return {
    content,
    model: data.model,
    inputTokens: data.usage.prompt_tokens,
    outputTokens: data.usage.completion_tokens
  };
}

/**
 * Generate a short dashboard title (5-8 words) from a task description.
 * Uses a fast, cheap model to keep latency and cost minimal.
 */
export async function summarizeTitle(
  config: LLMCallerConfig,
  task: string,
  model?: string
): Promise<{ title: string; inputTokens: number; outputTokens: number; model: string }> {
  const response = await callLLM(config, {
    system: "You are a title generator. Given a task description, produce a concise title of 5-8 words. " +
      "Output ONLY the title, nothing else. No quotes, no punctuation at the end. " +
      "Examples:\n" +
      "Task: 'Add a testimonials carousel section to the homepage. Requirements: 1. Create app/views/shared/_testimonials_carousel.html.erb partial. 2. Add SCSS in app/assets/stylesheets/components/_testimonials_carousel.scss. 3. Make it responsive.'\n" +
      "Title: Add homepage testimonials carousel\n\n" +
      "Task: 'Fix the login page 500 error when users submit empty passwords'\n" +
      "Title: Fix login empty password error",
    userMessage: task,
    maxTokens: 30,
    timeoutMs: 10_000,
    model: model ?? "anthropic/claude-sonnet-4-6"
  });

  let title = response.content.trim();
  // Strip markdown artifacts: **, *, ``, ```, #, newlines
  title = title.replace(/```[\s\S]*/g, "");   // Remove code blocks and everything after
  title = title.split("\n")[0]!;               // Take first line only
  title = title.replace(/[*`#]+/g, "");        // Strip markdown formatting chars
  title = title.replace(/[."']+$/, "");        // Strip trailing punctuation
  title = title.replace(/\s+/g, " ").trim();   // Normalize whitespace
  if (title.length > 72) title = title.slice(0, 69) + "...";
  return {
    title,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    model: response.model
  };
}

/**
 * Call LLM and parse the response as JSON.
 * Uses response_format: json_object when available.
 * Falls back to extracting JSON from code fences or prose.
 */
export async function callLLMForJSON<T>(
  config: LLMCallerConfig,
  request: LLMRequest
): Promise<{ parsed: T; raw: LLMResponse }> {
  const raw = await callLLM(config, { ...request, jsonMode: true });

  const parsed = extractJSON<T>(raw.content);
  if (parsed !== undefined) {
    return { parsed, raw };
  }

  throw new Error(`Failed to parse LLM response as JSON: ${raw.content.slice(0, 200)}`);
}

// ── Tool Use Types ──

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface LLMToolUseRequest {
  system: string;
  initialMessages: ChatMessage[];
  tools: ToolDefinition[];
  /** Execute a tool call. Return the result text to send back to the LLM. */
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  model?: string;
  maxTokens?: number;
  /** Timeout per individual API call (not total). */
  timeoutMs?: number;
  /** Max tool-use rounds before forcing a text response. Default 25. */
  maxTurns?: number;
  /** Wall-clock timeout for the entire loop in ms. Default 300_000 (5 min). */
  wallClockTimeoutMs?: number;
  /** Max chars for tool results older than the current round. Prevents quadratic token growth from large snapshots. */
  maxToolResultLength?: number;
  /** Max cumulative input tokens before stopping the loop. */
  maxInputTokens?: number;
  /** Called after each turn for logging. */
  onTurn?: (turn: number, message: ChatMessage) => void;
}

export interface LLMToolUseResponse {
  /** Final text content from the LLM (the verdict). */
  content: string;
  model: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  turnsUsed: number;
  messages: ChatMessage[];
}

/**
 * Run an agentic tool_use loop via OpenRouter.
 *
 * The LLM receives tools and calls them one (or more) at a time.
 * After each tool call, results are sent back and the LLM decides
 * what to do next. The loop ends when the LLM responds with text
 * (no tool_calls) or maxTurns is reached.
 */
export async function callLLMWithTools(
  config: LLMCallerConfig,
  request: LLMToolUseRequest
): Promise<LLMToolUseResponse> {
  const model = request.model ?? config.defaultModel;
  const maxTokens = request.maxTokens ?? 1024;
  const timeoutMs = request.timeoutMs ?? config.defaultTimeoutMs;
  const maxTurns = request.maxTurns ?? 25;
  const wallClockTimeoutMs = request.wallClockTimeoutMs ?? 300_000;
  const wallClockDeadline = Date.now() + wallClockTimeoutMs;

  const messages: ChatMessage[] = [
    { role: "system", content: request.system },
    ...request.initialMessages
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let turnsUsed = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    if (Date.now() > wallClockDeadline) {
      break;
    }
    if (request.maxInputTokens && totalInputTokens > request.maxInputTokens) {
      break;
    }
    turnsUsed = turn + 1;

    // Compact old tool results to prevent quadratic token growth.
    // Keep the last 6 messages (current round) in full; truncate older tool results.
    if (request.maxToolResultLength && messages.length > 8) {
      const limit = request.maxToolResultLength;
      const keepFullAfter = messages.length - 6;
      for (let i = 0; i < keepFullAfter; i++) {
        const m = messages[i];
        if (m.role === "tool" && m.content.length > limit) {
          (m as { content: string }).content =
            m.content.slice(0, limit) + "\n[...truncated — call browser_snapshot for current state]";
        }
      }
    }

    let data: {
      choices: Array<{ message: { role: string; content: string | null; tool_calls?: ToolCall[] } }>;
      model: string;
      usage: { prompt_tokens: number; completion_tokens: number };
    };

    const response = await fetchWithRetry(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${config.apiKey}`
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages,
          tools: request.tools,
          parallel_tool_calls: false,
          ...(config.providerPreferences ? { provider: config.providerPreferences } : {})
        })
      },
      timeoutMs
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`OpenRouter API ${String(response.status)}: ${body.slice(0, 200)}`);
    }

    data = await response.json() as typeof data;

    totalInputTokens += data.usage?.prompt_tokens ?? 0;
    totalOutputTokens += data.usage?.completion_tokens ?? 0;

    const assistantMsg = data.choices?.[0]?.message;
    if (!assistantMsg) {
      throw new Error("No message in API response");
    }

    // Add assistant message to history
    const historyMsg: ChatMessage = {
      role: "assistant",
      content: assistantMsg.content,
      ...(assistantMsg.tool_calls?.length ? { tool_calls: assistantMsg.tool_calls } : {})
    };
    messages.push(historyMsg);
    request.onTurn?.(turn, historyMsg);

    // If no tool_calls, this is the final text response
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      return {
        content: assistantMsg.content ?? "",
        model: data.model,
        totalInputTokens,
        totalOutputTokens,
        turnsUsed,
        messages
      };
    }

    // Execute each tool call and add results
    for (const toolCall of assistantMsg.tool_calls) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
      } catch {
        args = {};
      }

      let result: string;
      try {
        result = await request.executeTool(toolCall.function.name, args);
      } catch (error) {
        result = `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
      }

      const toolMsg: ChatMessage = {
        role: "tool",
        tool_call_id: toolCall.id,
        content: result
      };
      messages.push(toolMsg);
      request.onTurn?.(turn, toolMsg);
    }
  }

  // Loop exhausted (max turns, wall-clock timeout, or token budget) — return what we have
  const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
  const exhaustedContent = (lastAssistant && "content" in lastAssistant ? lastAssistant.content : null) ?? "";
  const exhaustionReason = Date.now() > wallClockDeadline
    ? "wall-clock timeout"
    : (request.maxInputTokens && totalInputTokens > request.maxInputTokens)
      ? `token budget exceeded (${String(totalInputTokens)} input tokens)`
      : "max turns reached";
  return {
    content: exhaustedContent || `Loop exhausted: ${exhaustionReason} after ${String(turnsUsed)} turns`,
    model,
    totalInputTokens,
    totalOutputTokens,
    turnsUsed,
    messages
  };
}

/**
 * Extract JSON from LLM text — handles clean JSON, code fences, and JSON embedded in prose.
 */
export function extractJSON<T>(text: string): T | undefined {
  const trimmed = text.trim();

  // 1. Try direct parse
  try { return JSON.parse(trimmed) as T; } catch { /* continue */ }

  // 2. Try extracting from code fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()) as T; } catch { /* continue */ }
  }

  // 3. Try extracting first JSON object from prose (find first { to matching })
  const firstBrace = trimmed.indexOf("{");
  if (firstBrace >= 0) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = firstBrace; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(trimmed.slice(firstBrace, i + 1)) as T; } catch { break; }
        }
      }
    }
  }

  return undefined;
}
