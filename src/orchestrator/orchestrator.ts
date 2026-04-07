/**
 * Conversational orchestrator — replaces command-driven routing with a
 * single LLM call that can answer questions, ask for clarification,
 * or trigger pipeline runs via tool use.
 */

import { callLLMWithTools, type ChatMessage, type LLMCallerConfig, type ToolDefinition } from "../llm/caller.js";
import { logInfo } from "../logger.js";
import type { HandleMessageRequest, HandleMessageDeps, HandleMessageResult, HandleMessageOptions } from "./types.js";

function buildTools(deps: HandleMessageDeps): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      type: "function",
      function: {
        name: "execute_task",
        description: "Queue a pipeline run to make code changes in a repository. Call this when the user wants code modified, a feature added, a bug fixed, etc.",
        parameters: {
          type: "object",
          properties: {
            repo: {
              type: "string",
              description: "Repository slug in owner/repo format (e.g. 'yourorg/yourrepo')"
            },
            task: {
              type: "string",
              description: "Clear description of what code changes to make"
            },
            skipNodes: {
              type: "array",
              items: { type: "string" },
              description: "Node IDs to skip (e.g. ['diff_gate', 'security_scan'] for docs-only changes)"
            },
            enableNodes: {
              type: "array",
              items: { type: "string" },
              description: "Node IDs to force-enable (e.g. ['deploy_preview', 'browser_verify', 'summarize_changes', 'upload_screenshot'] for UI changes, ['plan_task'] for complex tasks)"
            },
            continueFromThread: {
              type: "boolean",
              description: "Set to true to continue from the latest run in this thread (reuse branch). Use when the user wants follow-up changes."
            },
            pipeline: {
              type: "string",
              description: "Pipeline preset name. Use 'pipeline' (default). Use skipNodes/enableNodes to customize behavior instead of preset names. Omit to use the default."
            }
          },
          required: ["repo", "task"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "list_runs",
        description: "List recent pipeline runs with status, repo, task, requester, and timestamps.",
        parameters: {
          type: "object",
          properties: {
            repoSlug: {
              type: "string",
              description: "Optional: filter by repo slug (owner/repo)"
            }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "get_config",
        description: "Get current bot configuration. Returns pipeline settings, allowed repos, and feature flags.",
        parameters: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "Optional: specific config key to retrieve (e.g. 'repoAllowlist', 'pipelineFile'). Omit for full config."
            }
          }
        }
      }
    }
  ];

  if (deps.searchMemory) {
    tools.push({
      type: "function",
      function: {
        name: "search_memory",
        description: "Search organizational memory for past solutions, conventions, or context relevant to the task.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query describing what you're looking for"
            }
          },
          required: ["query"]
        }
      }
    });
  }

  if (deps.searchCode) {
    tools.push({
      type: "function",
      function: {
        name: "search_code",
        description: "Search code in a GitHub repository without cloning. Returns matching file paths and code fragments.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Code search query (function names, keywords, etc.)"
            },
            repoSlug: {
              type: "string",
              description: "Repository to search in (owner/repo format)"
            }
          },
          required: ["query", "repoSlug"]
        }
      }
    });
  }

  if (deps.describeRepo) {
    tools.push({
      type: "function",
      function: {
        name: "describe_repo",
        description: "Get a repository overview: programming languages used, root file listing, and README snippet. Use to answer questions about tech stack, project structure, or code type.",
        parameters: {
          type: "object",
          properties: {
            repoSlug: {
              type: "string",
              description: "Repository to describe (owner/repo format)"
            }
          },
          required: ["repoSlug"]
        }
      }
    });
  }

  if (deps.readFile) {
    tools.push({
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file's content from a GitHub repository (no cloning needed). Returns the full file content (truncated at 15K chars for large files). Use to answer questions about specific code files.",
        parameters: {
          type: "object",
          properties: {
            repoSlug: {
              type: "string",
              description: "Repository (owner/repo format)"
            },
            path: {
              type: "string",
              description: "File path relative to repo root (e.g. 'config/routes.rb', 'src/index.ts')"
            }
          },
          required: ["repoSlug", "path"]
        }
      }
    });
  }

  if (deps.listFiles) {
    tools.push({
      type: "function",
      function: {
        name: "list_files",
        description: "List files and directories in a repository path (no cloning needed). Use to explore repository structure before reading specific files.",
        parameters: {
          type: "object",
          properties: {
            repoSlug: {
              type: "string",
              description: "Repository (owner/repo format)"
            },
            path: {
              type: "string",
              description: "Directory path relative to repo root (e.g. 'config/', 'app/models'). Use '' for root."
            }
          },
          required: ["repoSlug", "path"]
        }
      }
    });
  }

  return tools;
}

/**
 * Handle an incoming message through the LLM orchestrator.
 * The LLM decides whether to answer directly, ask questions,
 * or trigger a pipeline run via the execute_task tool.
 */
export async function handleMessage(
  llmConfig: LLMCallerConfig,
  model: string,
  systemContext: string,
  request: HandleMessageRequest,
  deps: HandleMessageDeps,
  options?: HandleMessageOptions
): Promise<HandleMessageResult> {
  const effectiveTimeoutMs = options?.timeoutMs ?? 180_000;
  const effectiveWallClockTimeoutMs = options?.wallClockTimeoutMs ?? 480_000;
  const runsQueued: HandleMessageResult["runsQueued"] = [];
  const tools = buildTools(deps);

  // Build the current user message (metadata + actual message)
  const parts: string[] = [];
  if (request.existingRunRepo) {
    parts.push(`## Active Thread Run\nRepo: ${request.existingRunRepo}${request.existingRunId ? ` | Run ID: ${request.existingRunId}` : ""}`);
  }
  parts.push(`## Current Message (from <@${request.userId}>)\n${request.message}`);

  const userMessage = parts.join("\n\n");

  // Build initialMessages: prior conversation (if any) + new user message
  const priorMessages = request.priorMessages ?? [];
  const initialMessages: ChatMessage[] = [
    ...priorMessages,
    { role: "user", content: userMessage }
  ];

  try {
    const result = await callLLMWithTools(llmConfig, {
      system: systemContext,
      initialMessages,
      tools,
      executeTool: async (name: string, args: Record<string, unknown>) => {
        options?.onToolCall?.(name, args);

        if (name === "execute_task") {
          return executeTask(args, request, deps, runsQueued);
        }
        if (name === "list_runs") {
          return deps.listRuns(args["repoSlug"] as string | undefined);
        }
        if (name === "get_config") {
          return deps.getConfig(args["key"] as string | undefined);
        }
        if (name === "search_memory" && deps.searchMemory) {
          return deps.searchMemory(args["query"] as string);
        }
        if (name === "search_code" && deps.searchCode) {
          return deps.searchCode(
            args["query"] as string,
            args["repoSlug"] as string
          );
        }
        if (name === "describe_repo" && deps.describeRepo) {
          return deps.describeRepo(args["repoSlug"] as string);
        }
        if (name === "read_file" && deps.readFile) {
          return deps.readFile(
            args["repoSlug"] as string,
            args["path"] as string
          );
        }
        if (name === "list_files" && deps.listFiles) {
          return deps.listFiles(
            args["repoSlug"] as string,
            args["path"] as string
          );
        }
        return "Unknown tool";
      },
      model,
      maxTokens: 2048,
      maxTurns: 8,
      wallClockTimeoutMs: effectiveWallClockTimeoutMs,
      timeoutMs: effectiveTimeoutMs
    });

    logInfo("Orchestrator: handleMessage completed", {
      turnsUsed: result.turnsUsed,
      inputTokens: result.totalInputTokens,
      outputTokens: result.totalOutputTokens,
      runsQueued: runsQueued.length
    });

    // Strip system message from stored history — it's re-injected fresh each call
    const conversationMessages = result.messages.filter(m => m.role !== "system");

    const content = result.content || "";
    const isExhausted = !content || content.startsWith("Loop exhausted:");
    return {
      response: isExhausted
        ? "Sorry, I ran out of time processing that. Could you try again or rephrase?"
        : content,
      runsQueued,
      messages: conversationMessages
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    logInfo("Orchestrator: handleMessage failed", { error: msg });
    const timeoutDetected = /timed out|timeout|abort(ed)?/i.test(msg);
    if (timeoutDetected) {
      logInfo("Orchestrator: timeout while handling message", {
        timeoutMs: effectiveTimeoutMs,
        wallClockTimeoutMs: effectiveWallClockTimeoutMs
      });
    }
    return {
      response: timeoutDetected
        ? `I hit an LLM timeout after ${String(effectiveTimeoutMs)}ms while answering. Please retry this question.`
        : `Something went wrong: ${msg}`,
      runsQueued,
      messages: [...priorMessages, { role: "user", content: userMessage }]
    };
  }
}

async function executeTask(
  args: Record<string, unknown>,
  request: HandleMessageRequest,
  deps: HandleMessageDeps,
  runsQueued: HandleMessageResult["runsQueued"]
): Promise<string> {
  const repo = args["repo"] as string | undefined;
  const task = args["task"] as string | undefined;

  if (!repo || !task) {
    return "Error: both 'repo' and 'task' are required.";
  }

  // Validate repo is in allowlist
  if (deps.repoAllowlist.length > 0 && !deps.repoAllowlist.includes(repo)) {
    return `Error: repo '${repo}' is not in the allowlist. Allowed repos: ${deps.repoAllowlist.join(", ")}`;
  }

  const skipNodes = Array.isArray(args["skipNodes"])
    ? (args["skipNodes"] as unknown[]).filter(s => typeof s === "string") as string[]
    : undefined;
  const enableNodes = Array.isArray(args["enableNodes"])
    ? (args["enableNodes"] as unknown[]).filter(s => typeof s === "string") as string[]
    : undefined;
  const continueFromThread = args["continueFromThread"] === true;
  const pipeline = typeof args["pipeline"] === "string" ? args["pipeline"] : undefined;

  const continueFrom = continueFromThread && request.existingRunId
    ? request.existingRunId
    : undefined;

  try {
    const run = await deps.enqueueRun(repo, task, {
      skipNodes,
      enableNodes,
      continueFrom,
      pipeline
    });
    runsQueued.push(run);
    const continuation = continueFrom ? ` (continuing from previous run)` : "";
    return `Run queued successfully. ID: ${run.id.slice(0, 8)}, Branch: ${run.branchName}, Repo: ${run.repoSlug}${continuation}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    return `Error queueing run: ${msg}`;
  }
}
