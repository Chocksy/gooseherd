import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { runShellCapture, appendLog } from "../shell.js";
import { buildAgentCommandWithSelection } from "../agent-command.js";
import { describeAgentProfileSelection } from "../../agent-profile-resolver.js";
import { extractSentinelJson } from "../agent-output/sentinel.js";
import { isCiTriageVerdict } from "../../runs/run-checkpoints.js";
import { logWarn } from "../../logger.js";

const TRIAGE_PROMPT_FILE = "ci-triage.md";
const TRIAGE_PATTERN = /^\s*GOOSEHERD_CI_TRIAGE:/m;
const TRIAGE_PREFIX = "GOOSEHERD_CI_TRIAGE:";
const CHECKPOINT_KEY = "ci_triage_decided";

/**
 * CI triage node: runs an agent that classifies a CI failure as either
 * caused by the PR's diff (verdict=fix_needed) or unrelated (verdict=rerun).
 *
 * The agent does not modify code or push; it emits a single line
 *   GOOSEHERD_CI_TRIAGE: {"verdict":"fix_needed"|"rerun","reason":"...","evidence":[...]}
 * which this node parses and forwards to the orchestrator via a
 * `run.ci_triage_decided` checkpoint.
 */
export async function triageCiNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps,
): Promise<NodeResult> {
  const config = deps.config;
  const logFile = deps.logFile;
  const repoDir = ctx.getRequired<string>("repoDir");
  const runDir = ctx.getRequired<string>("runDir");
  const run = deps.run;

  await deps.onPhase("triage_ci");

  const promptBody = ctx.get<string>("task") ?? "";
  if (!promptBody.trim()) {
    return { outcome: "failure", error: "CI triage agent has no task prompt" };
  }
  const promptFile = path.join(runDir, TRIAGE_PROMPT_FILE);
  await writeFile(promptFile, promptBody, "utf8");

  const isFollowUp = ctx.get<boolean>("isFollowUp") ?? false;
  const { command: agentCommand, selection: agentProfileSelection } = buildAgentCommandWithSelection(
    config,
    run,
    repoDir,
    promptFile,
    isFollowUp,
    deps.agentProfileTarget,
  );
  await appendLog(logFile, "[ci:triage] starting CI triage agent\n");
  await appendLog(logFile, "[agent-profile] " + describeAgentProfileSelection(agentProfileSelection) + "\n");

  const result = await runShellCapture(agentCommand, {
    cwd: path.resolve("."),
    logFile,
    timeoutMs: config.agentTimeoutSeconds * 1000,
    login: true,
  });

  await appendLog(logFile, `[ci:triage] agent process exited with code ${String(result.code)}\n`);

  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  const parsed = extractSentinelJson(combinedOutput, TRIAGE_PATTERN, TRIAGE_PREFIX);

  if (!parsed.found || !parsed.parsed) {
    const error = parsed.parseError === "invalid_json"
      ? "CI triage agent emitted GOOSEHERD_CI_TRIAGE but the JSON payload could not be parsed"
      : "CI triage agent did not emit a valid GOOSEHERD_CI_TRIAGE sentinel";
    logWarn("CI triage parse failure", {
      runId: run.id,
      parseError: parsed.parseError,
      preview: combinedOutput.slice(-1000),
    });
    return {
      outcome: "failure",
      error,
      rawOutput: combinedOutput.slice(-2000),
    };
  }

  const verdict = parsed.parsed["verdict"];
  if (!isCiTriageVerdict(verdict)) {
    logWarn("CI triage emitted unrecognized verdict", {
      runId: run.id,
      verdict,
    });
    return {
      outcome: "failure",
      error: `CI triage agent emitted unrecognized verdict: ${String(verdict)}`,
      rawOutput: combinedOutput.slice(-2000),
    };
  }

  const reason = typeof parsed.parsed["reason"] === "string" ? parsed.parsed["reason"] : undefined;
  const evidence = Array.isArray(parsed.parsed["evidence"])
    ? (parsed.parsed["evidence"] as unknown[])
        .filter((value): value is string => typeof value === "string")
    : undefined;

  const prefetchCi = deps.run.prefetchContext?.github?.ci;
  const failedJobIds = ctx.get<number[]>("ciFailedJobIds")
    ?? prefetchCi?.failedRuns
      ?.map((failedRun) => failedRun.id)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    ?? [];
  const headSha = deps.run.prefetchContext?.github?.pr.headSha
    ?? deps.run.prefetchContext?.github?.ci.headSha
    ?? ctx.get<string>("commitSha");

  await deps.emitRunCheckpoint?.({
    checkpointKey: CHECKPOINT_KEY,
    checkpointType: "run.ci_triage_decided",
    payload: {
      verdict,
      reason,
      evidence,
      headSha,
      failedJobIds,
    },
  });

  await appendLog(
    logFile,
    `[ci:triage] verdict=${verdict}; failedJobIds=${failedJobIds.length > 0 ? failedJobIds.join(",") : "none"}\n`,
  );

  return {
    outcome: "success",
    outputs: {
      ciTriageVerdict: verdict,
      ciTriageReason: reason,
      ciTriageEvidence: evidence,
    },
  };
}
