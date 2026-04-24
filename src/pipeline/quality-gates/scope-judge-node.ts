/**
 * Scope Judge node — LLM-as-judge reviews diff vs original task.
 *
 * Opt-in (disabled by default, enabled via SCOPE_JUDGE_ENABLED or node config).
 * Uses OpenRouter API via the thin LLM caller.
 * Calibrated to prefer PASS (~25% expected veto rate).
 *
 * Escalation: if confidence < threshold, re-runs with a more capable model.
 */

import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { runShellCapture, appendLog } from "../shell.js";
import { appendGateReport } from "./gate-report.js";
import {
  buildScopeJudgeSystemPrompt,
  buildScopeJudgeUserMessage,
  parseScopeJudgeResponse
} from "./scope-judge.js";
import type { ScopeJudgeResult } from "./scope-judge.js";
import { callLLMForJSON, type LLMCallerConfig } from "../../llm/caller.js";
import { logInfo, logError } from "../../logger.js";

export async function scopeJudgeNode(
  nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const config = deps.config;
  const logFile = deps.logFile;
  const repoDir = ctx.getRequired<string>("repoDir");
  const task = ctx.getRequired<string>("task");

  // Check if enabled (deployment config, node config, or per-repo config)
  const repoEnabled = ctx.get<boolean>("repoScopeJudgeEnabled");
  if (!config.scopeJudgeEnabled && nodeConfig.enabled !== true && repoEnabled !== true) {
    await appendLog(logFile, "\n[gate:scope_judge] skipped (disabled)\n");
    return { outcome: "skipped" };
  }

  // Require API key
  if (!config.openrouterApiKey) {
    await appendLog(logFile, "\n[gate:scope_judge] skipped (no OPENROUTER_API_KEY)\n");
    return { outcome: "skipped" };
  }

  // Get diff and changed files
  const diffResult = await runShellCapture("git diff HEAD", { cwd: repoDir, logFile });
  if (diffResult.code !== 0) {
    return { outcome: "failure", error: `git diff failed: ${diffResult.stderr}` };
  }

  if (!diffResult.stdout.trim()) {
    await appendLog(logFile, "\n[gate:scope_judge] skipped (no diff)\n");
    appendGateReport(ctx, "scope_judge", "pass", []);
    return { outcome: "success" };
  }

  const changedFilesResult = await runShellCapture("git diff --name-only HEAD", { cwd: repoDir, logFile });
  const changedFiles = changedFilesResult.stdout.trim().split("\n").filter(Boolean);

  // Build LLM request
  const llmConfig: LLMCallerConfig = {
    apiKey: config.openrouterApiKey,
    defaultModel: config.scopeJudgeModel,
    defaultTimeoutMs: 15_000,
    providerPreferences: config.openrouterProviderPreferences
  };

  const nc = nodeConfig.config as Record<string, unknown> | undefined;
  const model = (nc?.["model"] as string) ?? config.scopeJudgeModel;
  const minPassScore = (nc?.["min_pass_score"] as number) ?? config.scopeJudgeMinPassScore;
  const escalateBelow = (nc?.["escalate_below_confidence"] as number) ?? 0.7;
  const escalationModel = (nc?.["escalation_model"] as string) ?? "anthropic/claude-sonnet-4-6";

  const systemPrompt = buildScopeJudgeSystemPrompt();
  const userMessage = buildScopeJudgeUserMessage(task, diffResult.stdout, changedFiles);

  // First pass
  let result: ScopeJudgeResult;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let usedModel = model;
  try {
    const { parsed, raw } = await callLLMForJSON<Record<string, unknown>>(llmConfig, {
      system: systemPrompt,
      userMessage,
      model,
      maxTokens: 512
    });
    result = parseScopeJudgeResponse(parsed);
    totalInputTokens += raw.inputTokens;
    totalOutputTokens += raw.outputTokens;
    usedModel = raw.model;
    await deps.recordTokenUsage?.({
      model: raw.model,
      input: raw.inputTokens,
      output: raw.outputTokens,
      source: "quality_gate"
    }).catch(() => {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    logError("scope_judge: LLM call failed, fail-open", { error: msg });
    await appendLog(logFile, `\n[gate:scope_judge] LLM error (fail-open): ${msg}\n`);
    appendGateReport(ctx, "scope_judge", "pass", [`LLM error: ${msg}`]);
    return { outcome: "success", outputs: { scopeJudgeError: msg } };
  }

  // Escalation: if confidence is low, re-run with more capable model
  if (result.confidence < escalateBelow && model !== escalationModel) {
    logInfo("scope_judge: low confidence, escalating", {
      confidence: result.confidence,
      escalationModel
    });
    await appendLog(logFile, `\n[gate:scope_judge] escalating (confidence ${String(result.confidence)} < ${String(escalateBelow)})\n`);

    try {
      const { parsed, raw } = await callLLMForJSON<Record<string, unknown>>(llmConfig, {
        system: systemPrompt,
        userMessage,
        model: escalationModel,
        maxTokens: 512,
        timeoutMs: 30_000 // longer timeout for bigger model
      });
      result = parseScopeJudgeResponse(parsed);
      totalInputTokens += raw.inputTokens;
      totalOutputTokens += raw.outputTokens;
      usedModel = raw.model;
      await deps.recordTokenUsage?.({
        model: raw.model,
        input: raw.inputTokens,
        output: raw.outputTokens,
        source: "quality_gate"
      }).catch(() => {});
    } catch (err) {
      // Keep original result on escalation failure
      const msg = err instanceof Error ? err.message : "unknown";
      logInfo("scope_judge: escalation failed, using initial result", { error: msg });
    }
  }

  ctx.set("_tokenUsage_scope_judge", {
    input: totalInputTokens,
    output: totalOutputTokens,
    model: usedModel
  });

  // Apply decision
  const reasons = result.violations.map(v => `${v.file}: ${v.message}`);
  await appendLog(logFile, `\n[gate:scope_judge] ${result.decision} (score: ${String(result.score)}, confidence: ${String(result.confidence)})\n`);
  appendGateReport(ctx, "scope_judge", result.decision, reasons);

  if (result.decision === "hard_fail") {
    return {
      outcome: "failure",
      error: `Scope judge hard fail (score ${String(result.score)}): ${result.reason}\n${reasons.join("\n")}`,
      outputs: { scopeJudgeResult: result }
    };
  }

  if (result.decision === "soft_fail" || result.score < minPassScore) {
    return {
      outcome: "soft_fail",
      error: `Scope judge soft fail (score ${String(result.score)}): ${result.reason}\n${reasons.join("\n")}`,
      outputs: { scopeJudgeResult: result }
    };
  }

  return {
    outcome: "success",
    outputs: { scopeJudgeResult: result }
  };
}
