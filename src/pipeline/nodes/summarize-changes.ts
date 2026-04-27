import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { callLLM, type LLMCallerConfig } from "../../llm/caller.js";
import { runShellCapture, appendLog } from "../shell.js";
import { logInfo } from "../../logger.js";
import { filterInternalGeneratedFiles } from "../internal-generated-files.js";

const SUMMARIZE_SYSTEM = `You are a technical writer summarizing code changes for a QA engineer who will verify them in a browser.

Given: the original task and the git diff of changes made.

Write a concise summary (3-5 sentences) that explains:
1. WHAT was changed (specific files, templates, CSS, JavaScript)
2. WHERE the change appears on the page (which section, component, URL path)
3. HOW to verify it (what to look for visually, what text/elements should be present or absent)

Be specific about selectors, class names, URLs, and visible text. The QA engineer has browser tools and needs to know exactly what to check.

Output ONLY the summary text, no headers or formatting.`;

/**
 * Summarize Changes node: uses LLM to generate a concise summary of what the
 * coding agent actually changed. This summary provides richer context to
 * browser_verify than just the raw task description.
 *
 * Runs after commit (when changedFiles and diff are available) and before browser_verify.
 * Non-fatal — browser_verify works without it, just with less context.
 */
export async function summarizeChangesNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const config = deps.config;
  const logFile = deps.logFile;
  const run = deps.run;

  if (!config.openrouterApiKey) {
    await appendLog(logFile, "\n[summarize_changes] skipped (no OpenRouter API key)\n");
    return { outcome: "skipped" };
  }

  const repoDir = ctx.get<string>("repoDir");
  if (!repoDir) {
    await appendLog(logFile, "\n[summarize_changes] skipped (no repoDir)\n");
    return { outcome: "skipped" };
  }

  // Get the diff of committed changes
  const diffResult = await runShellCapture(
    "git show --stat --patch HEAD -- . ':!*.lock' ':!package-lock.json' ':!yarn.lock' ':!.env*' ':!*.pem' ':!*.key' ':!credentials*' ':!secrets*'",
    { cwd: repoDir, logFile, timeoutMs: 15_000 }
  );

  if (diffResult.code !== 0 || !diffResult.stdout.trim()) {
    await appendLog(logFile, "\n[summarize_changes] skipped (no diff available)\n");
    return { outcome: "skipped" };
  }

  // Truncate diff to avoid token blow-up (keep first ~4000 chars)
  const diff = diffResult.stdout.slice(0, 4000);
  const changedFiles = filterInternalGeneratedFiles(ctx.get<string[]>("changedFiles") ?? []);

  const userMessage = [
    `Original task:\n${run.task}`,
    `\nFiles changed:\n${changedFiles.map(f => `  - ${f}`).join("\n")}`,
    `\nGit diff (truncated):\n${diff}`
  ].join("\n");

  try {
    const llmConfig: LLMCallerConfig = {
      apiKey: config.openrouterApiKey,
      defaultModel: config.defaultLlmModel,
      defaultTimeoutMs: 15_000,
      providerPreferences: config.openrouterProviderPreferences
    };

    const response = await callLLM(llmConfig, {
      system: SUMMARIZE_SYSTEM,
      userMessage,
      maxTokens: 400,
      timeoutMs: 15_000
    });

    const summary = response.content.trim();
    await appendLog(logFile, `[summarize_changes] "${summary.slice(0, 100)}..." (${String(response.inputTokens + response.outputTokens)} tokens)\n`);
    logInfo("summarize_changes", { summaryLength: summary.length });

    return {
      outcome: "success",
      outputs: {
        changeSummary: summary,
        _tokenUsage_summarizeChanges: {
          input: response.inputTokens,
          output: response.outputTokens,
          model: response.model
        }
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await appendLog(logFile, `[summarize_changes] failed (non-fatal): ${message}\n`);
    return { outcome: "soft_fail", error: message };
  }
}
