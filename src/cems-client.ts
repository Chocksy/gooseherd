import { logError, logInfo } from "./logger.js";

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

interface CemsConfig {
  apiUrl: string;
  apiKey: string;
  enabled: boolean;
}

export class CemsClient {
  private readonly config: CemsConfig;

  constructor(config: CemsConfig) {
    this.config = config;
  }

  async searchMemories(
    query: string,
    project?: string,
    maxTokens = 1500
  ): Promise<string> {
    if (!this.config.enabled) {
      return "";
    }

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

  async addMemory(
    content: string,
    tags: string[] = [],
    sourceRef?: string,
    category = "gooseherd"
  ): Promise<boolean> {
    if (!this.config.enabled) {
      return false;
    }

    try {
      const body: Record<string, unknown> = {
        content,
        scope: "shared",
        category,
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

      logInfo("CEMS memory stored", { category, tags: tags.join(",") });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logError("CEMS add memory error", { error: message });
      return false;
    }
  }
}
