import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import type { TaskType } from "./task-classifier.js";
import { parseDiffNumstat, evaluateDiffGate, DEFAULT_PROFILES } from "./diff-gate.js";
import type { DiffProfile } from "./diff-gate.js";
import { runShellCapture, appendLog } from "../shell.js";
import { appendGateReport } from "./gate-report.js";

/**
 * Diff size gate node: run `git diff --numstat HEAD` and check against
 * profile-based thresholds. Returns success/soft_fail/failure.
 */
export async function diffGateNode(
  nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const repoDir = ctx.getRequired<string>("repoDir");
  const logFile = deps.logFile;

  // Determine profile — from context (classify_task) or node config, default to "feature"
  const profileName = (ctx.get<string>("taskType") ?? nodeConfig.config?.["profile"] ?? "feature") as TaskType;

  // Allow custom thresholds from node config
  const customProfiles = nodeConfig.config?.["profiles"] as Partial<Record<TaskType, DiffProfile>> | undefined;

  // Run git diff --numstat
  const result = await runShellCapture(
    "git diff --numstat --find-renames HEAD",
    { cwd: repoDir, logFile }
  );

  if (result.code !== 0) {
    return { outcome: "failure", error: `git diff failed: ${result.stderr}` };
  }

  const stats = parseDiffNumstat(result.stdout);
  const gateResult = evaluateDiffGate(stats, profileName, customProfiles);

  await appendLog(logFile, `\n[gate:diff] profile=${profileName} lines=${String(stats.totalLines)} files=${String(stats.filesChanged)} verdict=${gateResult.verdict}\n`);

  // Store gate results in context for PR annotation
  appendGateReport(ctx, "diff_gate", gateResult.verdict, gateResult.reasons);

  ctx.set("diffStats", stats);

  if (gateResult.verdict === "hard_fail") {
    return {
      outcome: "failure",
      error: `Diff size exceeds hard limits: ${gateResult.reasons.join("; ")}`,
      outputs: { diffStats: stats, diffVerdict: gateResult.verdict }
    };
  }

  if (gateResult.verdict === "soft_fail") {
    return {
      outcome: "soft_fail",
      error: `Diff size warning: ${gateResult.reasons.join("; ")}`,
      outputs: { diffStats: stats, diffVerdict: gateResult.verdict }
    };
  }

  return {
    outcome: "success",
    outputs: { diffStats: stats, diffVerdict: gateResult.verdict }
  };
}
