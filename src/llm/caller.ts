/**
 * Thin LLM caller — raw HTTP to Anthropic Messages API.
 * No SDK dependency. Supports model selection, timeout, JSON mode.
 */


export interface LLMCallerConfig {
  apiKey: string;
  defaultModel: string;
  defaultTimeoutMs: number;
}

export interface LLMRequest {
  system: string;
  userMessage: string;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface LLMResponse {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Call the Anthropic Messages API with timeout support.
 * Returns the text content from the first content block.
 * Throws on timeout, network errors, or API errors.
 */
export async function callLLM(
  config: LLMCallerConfig,
  request: LLMRequest
): Promise<LLMResponse> {
  const model = request.model ?? config.defaultModel;
  const maxTokens = request.maxTokens ?? 1024;
  const timeoutMs = request.timeoutMs ?? config.defaultTimeoutMs;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: request.system,
        messages: [
          { role: "user", content: request.userMessage }
        ]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Anthropic API ${String(response.status)}: ${body.slice(0, 200)}`);
    }

    const data = await response.json() as {
      content: Array<{ type: string; text?: string }>;
      model: string;
      usage: { input_tokens: number; output_tokens: number };
    };

    const textBlock = data.content.find(b => b.type === "text");
    if (!textBlock?.text) {
      throw new Error("No text content in API response");
    }

    return {
      content: textBlock.text,
      model: data.model,
      inputTokens: data.usage.input_tokens,
      outputTokens: data.usage.output_tokens
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call LLM and parse the response as JSON.
 * Extracts JSON from markdown code fences if present.
 */
export async function callLLMForJSON<T>(
  config: LLMCallerConfig,
  request: LLMRequest
): Promise<{ parsed: T; raw: LLMResponse }> {
  const raw = await callLLM(config, request);

  // Extract JSON from code fences if present
  let jsonText = raw.content.trim();
  const fenceMatch = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    jsonText = fenceMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(jsonText) as T;
    return { parsed, raw };
  } catch {
    throw new Error(`Failed to parse LLM response as JSON: ${jsonText.slice(0, 200)}`);
  }
}
