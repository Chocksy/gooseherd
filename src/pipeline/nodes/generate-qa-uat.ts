import { readFile } from "node:fs/promises";
import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { callLLM, type LLMCallerConfig } from "../../llm/caller.js";
import { appendLog } from "../shell.js";
import { hasQaUatHeader } from "../../work-items/qa-preparation-actions.js";

const QA_UAT_SYSTEM_PROMPT = [
  "You are a senior QA engineer preparing UAT for a pull request.",
  "Create a concise, meaningful QA UAT plan from the PR description, Jira/work-item context, discussion, and current branch diff.",
  "",
  "Output ONLY markdown for a GitHub PR comment.",
  "Start with exactly: ## QA UAT",
  "",
  "Required content:",
  "- Focus on actual user-facing behavior and risk areas in this PR.",
  "- Include setup/data assumptions only when they are useful.",
  "- Include happy-path checks, edge cases, regression checks, and acceptance signals where relevant.",
  "- Prefer concrete checks over generic testing advice.",
  "- Do not mention that you are an AI or that context was prefetched.",
  "- Do not ask QA to inspect implementation details unless that is the only practical verification path.",
].join("\n");

export async function generateQaUatNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps,
): Promise<NodeResult> {
  const apiKey = deps.config.openrouterApiKey;
  if (!apiKey) {
    const message = "generate_qa_uat requires OPENROUTER_API_KEY";
    await appendLog(deps.logFile, `\n[generate_qa_uat] failed: ${message}\n`);
    return { outcome: "failure", error: message };
  }

  const promptFile = ctx.getRequired<string>("promptFile");
  const promptContext = await readFile(promptFile, "utf8");
  const run = deps.run;

  const userMessage = [
    `Repository: ${run.repoSlug}`,
    run.prNumber ? `Pull request: #${String(run.prNumber)}` : "",
    run.prUrl ? `PR URL: ${run.prUrl}` : "",
    "",
    "Pipeline task:",
    run.task,
    "",
    "Context:",
    promptContext,
  ].filter(Boolean).join("\n");

  const llmConfig: LLMCallerConfig = {
    apiKey,
    defaultModel: deps.config.defaultLlmModel,
    defaultTimeoutMs: 30_000,
    providerPreferences: deps.config.openrouterProviderPreferences,
  };

  try {
    const response = await callLLM(llmConfig, {
      system: QA_UAT_SYSTEM_PROMPT,
      userMessage,
      maxTokens: 1600,
      timeoutMs: 30_000,
    });
    const qaUatComment = normalizeQaUatComment(response.content);
    if (!qaUatComment) {
      return { outcome: "failure", error: "LLM returned empty QA UAT content" };
    }

    await appendLog(
      deps.logFile,
      `[generate_qa_uat] generated ${String(qaUatComment.length)} chars (${String(response.inputTokens + response.outputTokens)} tokens)\n`,
    );
    if (deps.recordTokenUsage) {
      await deps.recordTokenUsage({
        model: response.model,
        input: response.inputTokens,
        output: response.outputTokens,
        source: "quality_gate",
      }).catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        await appendLog(deps.logFile, `[generate_qa_uat] token usage recording failed: ${message}\n`);
      });
    }

    return {
      outcome: "success",
      outputs: {
        qaUatComment,
        _tokenUsage_generateQaUat: {
          input: response.inputTokens,
          output: response.outputTokens,
          model: response.model,
        },
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendLog(deps.logFile, `[generate_qa_uat] failed: ${message}\n`);
    return { outcome: "failure", error: message };
  }
}

export function normalizeQaUatComment(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return "";
  }
  if (hasQaUatHeader(trimmed)) {
    return trimmed;
  }
  return `## QA UAT\n\n${trimmed}`;
}
