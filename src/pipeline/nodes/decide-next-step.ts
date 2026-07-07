/**
 * Decision node — mid-pipeline intelligence.
 *
 * Examines the current pipeline state (via ContextBag) and decides which
 * subsequent nodes to skip or whether to modify the recovery approach.
 *
 * Uses callLLMForJSON() with structured output — same pattern as smart-triage.ts.
 */

import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { callLLMForJSON, type LLMCallerConfig } from "../../llm/caller.js";
import { appendLog } from "../shell.js";
import { logInfo } from "../../logger.js";
import { describeAgentProfileSelection, resolveLLMProfileSelection } from "../../agent-profile-resolver.js";

const DECISION_SYSTEM_PROMPT = `You are a pipeline orchestrator deciding what to do next.
Given the current pipeline state, decide which nodes to skip and optionally jump to a different node.

Respond ONLY with a JSON object:
{
  "skipNodes": ["node_ids_to_skip"],
  "goto": "node_id_to_jump_to_or_null",
  "reason": "one-line explanation of your decision"
}

Rules for "goto":
- Set to a node ID to jump execution to that node (e.g. jump back to "implement" for a second pass).
- Set to null or omit if execution should continue normally.
- Only jump to nodes that exist in the available_nodes list.

## Decision guidelines:

### Browser verification failures:
- browserVerifyFailureCode=provider_mismatch|auth_required|auth_action_blocked|signup_failed means this is likely NOT a code-change bug.
- For auth/provider failures, prefer skipping fix_browser and keep browser_verify enabled for strategy retries.
- For feature_not_found, code fix may still be required.
- If the failure pattern is repeating (same verdict across rounds), suggest skipping browser_verify.
- If the issue is clearly a CSS/layout problem, recommend retrying fix_browser.

### General pipeline decisions:
- If validation passed but tests failed, consider jumping back to implement for a targeted fix.
- If the task classification suggests docs-only changes but code changes were made, skip deploy_preview/browser_verify.
- If scope_judge flagged the changes as out-of-scope, consider skipping push/create_pr.
- Default to empty skipNodes and null goto (let everything run normally).`;

interface DecisionOutput {
  skipNodes: string[];
  goto?: string | null;
  reason: string;
}

export async function decideNextStepNode(
  nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const logFile = deps.logFile;
  const nc = nodeConfig.config as Record<string, unknown> | undefined;

  // Resolve model from node config or default
  const configuredModel = (nc?.["model"] as string) ?? "z-ai/glm-5";
  const model = normalizeOpenRouterModel(configuredModel);
  const configuredFallbackModel = (nc?.["fallback_model"] as string) ?? "openai/gpt-4.1-mini";
  const fallbackModel = normalizeOpenRouterModel(configuredFallbackModel);

  // Build state summary from context
  const contextKeys = Array.isArray(nc?.["context_keys"])
    ? nc["context_keys"] as string[]
    : undefined;
  const stateSummary = ctx.toSummary(contextKeys);

  // Build available actions list
  const availableActions = Array.isArray(nc?.["available_actions"])
    ? (nc["available_actions"] as string[]).join(", ")
    : "fix_browser, browser_verify, implement";

  const userMessage = [
    "## Current pipeline state",
    stateSummary,
    "",
    `## Available actions: ${availableActions}`,
    "",
    "Decide which nodes (if any) to skip based on the current state."
  ].join("\n");

  const llmSelection = resolveLLMProfileSelection(
    deps.config,
    deps.agentProfileTarget,
    "llm_json",
    model,
    15_000,
  );

  if (!llmSelection) {
    await appendLog(logFile, "[decide] OPENROUTER_API_KEY missing, skipping decision\n");
    return { outcome: "success", outputs: {} };
  }

  await appendLog(logFile, "[agent-profile] " + describeAgentProfileSelection(llmSelection) + "\n");

  const primaryModel = llmSelection.profile ? llmSelection.model : model;
  const llmConfig: LLMCallerConfig = llmSelection.llmConfig;

  try {
    const { parsed, raw } = await requestDecision(llmConfig, userMessage, primaryModel);

    const skipNodes = Array.isArray(parsed.skipNodes)
      ? parsed.skipNodes.filter(s => typeof s === "string")
      : [];
    const gotoTarget = typeof parsed.goto === "string" ? parsed.goto : undefined;
    const reason = typeof parsed.reason === "string" ? parsed.reason : "No reason provided";

    await appendLog(logFile, `[decide] decision: skip=[${skipNodes.join(",")}]${gotoTarget ? ` goto=${gotoTarget}` : ""} reason="${reason}"\n`);
    logInfo("Decision node", { skipNodes, gotoTarget, reason });

    const outputs: Record<string, unknown> = {
      _skipNodes: skipNodes,
      decisionReason: reason,
      _tokenUsage_decide: { input: raw.inputTokens, output: raw.outputTokens, model: raw.model }
    };
    if (gotoTarget) {
      outputs["_goto"] = gotoTarget;
    }

    return { outcome: "success", outputs };
  } catch (err) {
    const firstError = err instanceof Error ? err.message : "unknown";
    if (fallbackModel && fallbackModel !== primaryModel) {
      try {
        await appendLog(logFile, `[decide] primary model failed (${primaryModel}): ${firstError}; retrying with fallback ${fallbackModel}\n`);
        const { parsed, raw } = await requestDecision(llmConfig, userMessage, fallbackModel);

        const skipNodes = Array.isArray(parsed.skipNodes)
          ? parsed.skipNodes.filter(s => typeof s === "string")
          : [];
        const gotoTarget = typeof parsed.goto === "string" ? parsed.goto : undefined;
        const reasonBase = typeof parsed.reason === "string" ? parsed.reason : "No reason provided";
        const reason = `${reasonBase} (fallback:${fallbackModel})`;
        await appendLog(logFile, `[decide] fallback decision: skip=[${skipNodes.join(",")}]${gotoTarget ? ` goto=${gotoTarget}` : ""} reason="${reason}"\n`);
        logInfo("Decision node fallback", { skipNodes, gotoTarget, reason, fallbackModel });

        const outputs: Record<string, unknown> = {
          _skipNodes: skipNodes,
          decisionReason: reason,
          _tokenUsage_decide: { input: raw.inputTokens, output: raw.outputTokens, model: raw.model }
        };
        if (gotoTarget) {
          outputs["_goto"] = gotoTarget;
        }

        return { outcome: "success", outputs };
      } catch (fallbackErr) {
        const msg = fallbackErr instanceof Error ? fallbackErr.message : "unknown";
        await appendLog(
          logFile,
          `[decide] fallback LLM call failed: ${msg} (primary error: ${firstError}), continuing without skipping\n`
        );
        return { outcome: "success", outputs: {} };
      }
    }

    await appendLog(logFile, `[decide] LLM call failed: ${firstError}, continuing without skipping\n`);
    return { outcome: "success", outputs: {} };
  }
}

function normalizeOpenRouterModel(model: string): string {
  const trimmed = model.trim();
  if (trimmed.toLowerCase().startsWith("openrouter/")) {
    return trimmed.slice("openrouter/".length);
  }
  return trimmed;
}

async function requestDecision(
  llmConfig: LLMCallerConfig,
  userMessage: string,
  model: string
): Promise<{ parsed: DecisionOutput; raw: import("../../llm/caller.js").LLMResponse }> {
  return callLLMForJSON<DecisionOutput>(llmConfig, {
    system: DECISION_SYSTEM_PROMPT,
    userMessage,
    maxTokens: 256,
    timeoutMs: 15_000,
    model
  });
}
