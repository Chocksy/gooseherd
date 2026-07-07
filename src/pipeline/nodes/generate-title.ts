import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { summarizeTitle } from "../../llm/caller.js";
import { describeAgentProfileSelection, resolveLLMProfileSelection } from "../../agent-profile-resolver.js";
import { appendLog } from "../shell.js";
import { logInfo } from "../../logger.js";

/**
 * Generate Title node: uses LLM to create a short dashboard title from the task.
 * Runs early in the pipeline (after clone, before implement).
 * Non-fatal — falls back to raw task text if LLM call fails.
 */
export async function generateTitleNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const config = deps.config;
  const run = deps.run;
  const logFile = deps.logFile;

  const llmSelection = resolveLLMProfileSelection(
    config,
    deps.agentProfileTarget,
    "llm_text",
    config.defaultLlmModel,
    10_000,
  );
  if (!llmSelection) {
    await appendLog(logFile, "\n[generate_title] skipped (no OpenRouter API key)\n");
    return { outcome: "skipped" };
  }

  if (run.task.length <= 60) {
    // Short tasks don't need summarization — they're already good titles
    ctx.set("generatedTitle", run.task);
    return { outcome: "success", outputs: { generatedTitle: run.task } };
  }

  try {
    await appendLog(logFile, "[agent-profile] " + describeAgentProfileSelection(llmSelection) + "\n");
    const result = await summarizeTitle(llmSelection.llmConfig, run.task, llmSelection.model);
    await appendLog(logFile, `[generate_title] "${result.title}" (${String(result.inputTokens + result.outputTokens)} tokens)\n`);
    logInfo("generate_title", { title: result.title });

    ctx.set("generatedTitle", result.title);

    // Store on the run record so it persists
    run.title = result.title;

    return {
      outcome: "success",
      outputs: {
        generatedTitle: result.title,
        _tokenUsage_generateTitle: {
          input: result.inputTokens,
          output: result.outputTokens,
          model: result.model
        }
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await appendLog(logFile, `[generate_title] failed (non-fatal): ${message}\n`);
    // Non-fatal — title is nice-to-have
    return { outcome: "soft_fail", error: message };
  }
}
