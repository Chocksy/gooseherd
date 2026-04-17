import type { AppConfig } from "./config.js";

export interface JiraIssueDetails {
  key: string;
  url: string;
  summary?: string;
  status?: string;
  description: string;
}

export interface JiraComment {
  id: string;
  authorDisplayName?: string;
  createdAt?: string;
  body: string;
}

interface JiraClientConfig {
  jiraBaseUrl?: string;
  jiraUser?: string;
  jiraApiToken?: string;
  jiraRequestTimeoutMs: number;
}

interface JiraIssueResponse {
  key?: string;
  fields?: {
    summary?: string;
    status?: { name?: string };
    description?: unknown;
  };
}

interface JiraCommentsResponse {
  comments?: Array<{
    id?: string | number;
    author?: { displayName?: string };
    created?: string;
    body?: unknown;
  }>;
  isLast?: boolean;
  maxResults?: number;
  startAt?: number;
  total?: number;
}

export class JiraClient {
  constructor(private readonly config: JiraClientConfig) {}

  static create(config: AppConfig): JiraClient | undefined {
    if (!config.jiraBaseUrl || !config.jiraUser || !config.jiraApiToken) {
      return undefined;
    }
    return new JiraClient({
      jiraBaseUrl: config.jiraBaseUrl,
      jiraUser: config.jiraUser,
      jiraApiToken: config.jiraApiToken,
      jiraRequestTimeoutMs: config.jiraRequestTimeoutMs
    });
  }

  async getIssue(issueKey: string): Promise<JiraIssueDetails> {
    const issue = await this.fetchIssue(issueKey);
    const fields = issue.fields ?? {};
    return {
      key: issue.key ?? issueKey,
      url: `${this.baseUrl}/browse/${encodeURIComponent(issueKey)}`,
      summary: fields.summary,
      status: fields.status?.name,
      description: normalizeJiraText(fields.description)
    };
  }

  async getComments(issueKey: string): Promise<JiraComment[]> {
    const comments: JiraComment[] = [];
    let startAt = 0;
    let total: number | undefined;

    while (true) {
      const response = await this.fetchComments(issueKey, startAt);
      const pageComments = response.comments ?? [];
      comments.push(
        ...pageComments
          .map((comment) => ({
            id: String(comment.id ?? ""),
            authorDisplayName: comment.author?.displayName,
            createdAt: comment.created,
            body: normalizeJiraText(comment.body)
          }))
          .filter((comment) => comment.id !== "")
      );

      total = response.total ?? total;
      const pageSize = response.maxResults ?? pageComments.length;
      const nextStartAt = (response.startAt ?? startAt) + pageSize;
      if (response.isLast === true || pageComments.length < pageSize || (typeof total === "number" && comments.length >= total)) {
        break;
      }
      startAt = nextStartAt;
    }

    return comments.sort((left, right) => {
        const leftCreatedAt = left.createdAt ?? "";
        const rightCreatedAt = right.createdAt ?? "";
        if (leftCreatedAt === rightCreatedAt) {
          return 0;
        }
        return leftCreatedAt < rightCreatedAt ? -1 : 1;
      });
  }

  private get baseUrl(): string {
    const baseUrl = this.config.jiraBaseUrl?.trim();
    if (!baseUrl || !this.config.jiraUser || !this.config.jiraApiToken) {
      throw new Error("Jira client is not configured");
    }
    return baseUrl.replace(/\/+$/, "");
  }

  private get authHeader(): string {
    if (!this.config.jiraUser || !this.config.jiraApiToken) {
      throw new Error("Jira client is not configured");
    }
    return `Basic ${Buffer.from(`${this.config.jiraUser}:${this.config.jiraApiToken}`).toString("base64")}`;
  }

  private async fetchIssue(issueKey: string): Promise<JiraIssueResponse> {
    const response = await fetch(
      `${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,status,description`,
      {
        headers: {
          Accept: "application/json",
          Authorization: this.authHeader
        },
        signal: AbortSignal.timeout(this.config.jiraRequestTimeoutMs)
      }
    );

    if (!response.ok) {
      const message = await safeReadResponseText(response);
      throw new Error(
        `Jira request failed for ${issueKey}: ${response.status} ${response.statusText}${message ? ` - ${message}` : ""}`
      );
    }

    return response.json() as Promise<JiraIssueResponse>;
  }

  private async fetchComments(issueKey: string, startAt: number): Promise<JiraCommentsResponse> {
    const response = await fetch(
      `${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment?startAt=${startAt}&maxResults=100`,
      {
        headers: {
          Accept: "application/json",
          Authorization: this.authHeader
        },
        signal: AbortSignal.timeout(this.config.jiraRequestTimeoutMs)
      }
    );

    if (!response.ok) {
      const message = await safeReadResponseText(response);
      throw new Error(
        `Jira request failed for ${issueKey} comments: ${response.status} ${response.statusText}${message ? ` - ${message}` : ""}`
      );
    }

    return response.json() as Promise<JiraCommentsResponse>;
  }
}

function normalizeJiraText(value: unknown): string {
  const text = visitJiraValue(value).replace(/\n{3,}/g, "\n\n").trim();
  return text;
}

function visitJiraValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value !== "object") {
    return "";
  }

  const node = value as {
    type?: string;
    text?: string;
    content?: unknown[];
    marks?: unknown[];
  };

  if (typeof node.text === "string") {
    return node.text;
  }

  const content = Array.isArray(node.content) ? node.content.map(visitJiraValue) : [];
  switch (node.type) {
    case "hardBreak":
      return "\n";
    case "paragraph":
    case "heading":
    case "blockquote":
    case "codeBlock":
    case "listItem":
      return `${content.join("").trimEnd()}\n`;
    case "bulletList":
    case "orderedList":
    case "doc":
    default:
      return content.join("");
  }
}

async function safeReadResponseText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}
