import type { MemoryProvider } from "./provider.js";
import { logError, logInfo } from "../logger.js";

interface CemsSearchResult {
  content: string;
  category?: string;
  tags?: string[];
  score?: number;
}

interface CemsSearchResponse {
  results?: CemsSearchResult[];
  memories?: CemsSearchResult[];
}

interface CemsProviderConfig {
  apiUrl: string;
  apiKey: string;
}

export class CemsProvider implements MemoryProvider {
  readonly name = "cems";
  private readonly config: CemsProviderConfig;

  constructor(config: CemsProviderConfig) {
    this.config = config;
  }

  async searchMemories(
    query: string,
    project?: string,
    maxTokens = 1500
  ): Promise<string> {
    try {
      const body: Record<string, unknown> = {
        query,
        scope: "shared",
        max_results: 5,
        max_tokens: maxTokens
      };
      if (project) {
        body.project = project;
      }

      const response = await fetch(`${this.config.apiUrl}/api/memory/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        logError("CEMS search failed", {
          status: String(response.status),
          statusText: response.statusText
        });
        return "";
      }

      const data = (await response.json()) as CemsSearchResponse;
      const results = data.results ?? data.memories ?? [];

      if (results.length === 0) {
        return "";
      }

      const formatted = results
        .map((r, i) => `${String(i + 1)}. ${r.content}`)
        .join("\n");

      return formatted;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logError("CEMS search error", { error: message });
      return "";
    }
  }

  async storeMemory(
    content: string,
    tags: string[] = [],
    sourceRef?: string
  ): Promise<boolean> {
    try {
      const body: Record<string, unknown> = {
        content,
        scope: "shared",
        category: "gooseherd",
        tags,
        infer: true
      };
      if (sourceRef) {
        body.source_ref = sourceRef;
      }

      const response = await fetch(`${this.config.apiUrl}/api/memory/add`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        logError("CEMS add memory failed", {
          status: String(response.status),
          statusText: response.statusText
        });
        return false;
      }

      logInfo("CEMS memory stored", { tags: tags.join(",") });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logError("CEMS add memory error", { error: message });
      return false;
    }
  }
}
