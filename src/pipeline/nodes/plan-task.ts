/**
 * Plan Task Node — LLM planning step before agent implementation.
 *
 * Calls a fast model via OpenRouter to break the task into implementation steps.
 * Writes the structured plan to context bag for hydrate-context to inject
 * into the agent prompt.
 *
 * Skips gracefully if no OPENROUTER_API_KEY is configured.
 */

import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { callLLM, type LLMCallerConfig } from "../../llm/caller.js";
import { logInfo } from "../../logger.js";

const PLAN_SYSTEM_PROMPT = [
  "You are a senior software engineer planning implementation steps for a coding task.",
  "Given a task description and repository context, produce a concise implementation plan.",
  "",
  "Output format — numbered steps only, no preamble:",
  "1. [file path] — what to change and why",
  "2. [file path] — what to change and why",
  "...",
  "",
  "Guidelines:",
  "- Be specific: reference actual file paths when possible",
  "- Keep steps atomic: one change per step",
  "- Order matters: list steps in implementation order",
  "- Max 8 steps — if the task needs more, the scope is too large",
  "- Include a test step if the project has tests"
].join("\n");

export async function planTaskNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const config = deps.config;

  // Skip if no API key
  if (!config.openrouterApiKey) {
    logInfo("plan_task: skipped (no OPENROUTER_API_KEY)");
    return { outcome: "skipped" };
  }

  const run = deps.run;
  const repoSummary = ctx.get<string>("repoSummary") ?? "";
  const taskType = ctx.get<string>("taskType") ?? "chore";

  const userMessage = [
    `Repository: ${run.repoSlug}`,
    `Task type: ${taskType}`,
    `Task: ${run.task}`,
    "",
    repoSummary ? `Repository structure:\n${repoSummary}` : ""
  ].filter(Boolean).join("\n");

  const llmConfig: LLMCallerConfig = {
    apiKey: config.openrouterApiKey,
    defaultModel: config.planTaskModel,
    defaultTimeoutMs: 15_000
  };

  try {
    const response = await callLLM(llmConfig, {
      system: PLAN_SYSTEM_PROMPT,
      userMessage,
      maxTokens: 512,
      timeoutMs: 15_000
    });

    const plan = response.content.trim();
    if (!plan) {
      logInfo("plan_task: LLM returned empty plan, skipping");
      return { outcome: "skipped" };
    }

    logInfo("plan_task: generated implementation plan", {
      runId: run.id,
      tokens: response.inputTokens + response.outputTokens,
      planLines: plan.split("\n").length
    });

    ctx.set("_tokenUsage_plan_task", {
      input: response.inputTokens,
      output: response.outputTokens
    });

    return {
      outcome: "success",
      outputs: { implementationPlan: plan }
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    logInfo("plan_task: LLM call failed, continuing without plan", { error: msg });
    return { outcome: "skipped" };
  }
}
