import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { appendLog, runShellCapture } from "../shell.js";
import { buildAgentCommand } from "../agent-command.js";
import { filterInternalGeneratedFiles, isInternalGeneratedFile, mergeInternalArtifacts } from "../internal-generated-files.js";
import { logInfo, logWarn } from "../../logger.js";
import { isFeatureDeliveryAutoReviewRun } from "../../runs/run-intent.js";
import type { RunRecord } from "../../types.js";

export interface AgentAnalysis {
  verdict: "clean" | "suspect" | "empty" | "context_conflict";
  filesChanged: string[];
  diffSummary: string;
  diffStats: { added: number; removed: number; filesCount: number };
  signals: string[];
  contextConflictReason?: string;
}

export interface AutoReviewSummaryArtifact {
  selectedFindings: string[];
  ignoredFindings: string[];
  rationale: string;
  groundingMetrics?: AutoReviewGroundingMetrics;
}

export interface AutoReviewGroundingMetrics {
  selectedFindingCount: number;
  selectedFindingOverlapCount: number;
  selectedFindingOverlapRatio: number;
  ignoredFindingCount: number;
  ignoredFindingOverlapCount: number;
}

export interface AutoReviewNoopClassification {
  allowed: boolean;
  reason?: string;
}

export type AutoReviewSentinelExtractionMethod =
  | "plain_text"
  | "pi_jsonl_message_update"
  | "pi_jsonl_message_end"
  | "pi_jsonl_turn_end"
  | "pi_jsonl_agent_end"
  | "none";

interface AutoReviewSentinelMatch {
  text: string;
  method: Exclude<AutoReviewSentinelExtractionMethod, "none">;
}

interface AutoReviewSummaryParseResult {
  found: boolean;
  summary?: AutoReviewSummaryArtifact;
  parseError?: "missing_json" | "invalid_json";
}

export interface AutoReviewOutputInspection {
  summaryFound: boolean;
  summaryExtractionMethod: AutoReviewSentinelExtractionMethod;
  contextConflictFound: boolean;
  contextConflictExtractionMethod: AutoReviewSentinelExtractionMethod;
  preview?: string;
}

const AUTO_REVIEW_SUMMARY_ARTIFACT = "auto-review-summary.json";
const AUTO_REVIEW_SUMMARY_PATTERN = /^\s*GOOSEHERD_REVIEW_SUMMARY:/m;
const AUTO_REVIEW_SUMMARY_PREFIX = "GOOSEHERD_REVIEW_SUMMARY:";
const AGENT_STDOUT_ARTIFACT = "agent-stdout.log";
const AGENT_STDERR_ARTIFACT = "agent-stderr.log";
const AUTO_REVIEW_OUTPUT_PREVIEW_MAX_LINES = 10;
const AUTO_REVIEW_OUTPUT_PREVIEW_MAX_CHARS = 600;

/**
 * Implement node: run the coding agent.
 */
export async function implementNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const run = deps.run;
  const config = deps.config;
  const logFile = deps.logFile;
  const repoDir = ctx.getRequired<string>("repoDir");
  const promptFile = ctx.getRequired<string>("promptFile");
  const runDir = ctx.get<string>("runDir");
  const isFollowUp = ctx.get<boolean>("isFollowUp") ?? false;

  await deps.onPhase("agent");

  const agentCommand = buildAgentCommand(config, run, repoDir, promptFile, isFollowUp);

  await appendLog(
    logFile,
    `[implement] waiting for natural agent exit; hard timeout ${String(config.agentTimeoutSeconds)}s\n`
  );

  const result = await runShellCapture(agentCommand, {
    cwd: path.resolve("."),
    logFile,
    timeoutMs: config.agentTimeoutSeconds * 1000,
    login: true  // Agent command needs login shell for PATH
  });

  await appendLog(
    logFile,
    `[implement] agent process exited with code ${String(result.code)}\n`
  );

  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  const outputInspection = inspectAutoReviewOutput(combinedOutput);
  const rawAgentOutputArtifacts = runDir
    ? await persistAgentOutputArtifacts(runDir, result.stdout, result.stderr)
    : undefined;
  if (rawAgentOutputArtifacts?.length) {
    await appendLog(logFile, `[implement] wrote raw agent output artifacts: ${rawAgentOutputArtifacts.join(", ")}\n`);
  }

  if (result.code !== 0) {
    const autoReviewSummaryArtifact = runDir
      ? await persistAutoReviewSummaryArtifact(run, runDir, combinedOutput, [])
      : undefined;
    if (autoReviewSummaryArtifact) {
      await appendLog(logFile, `[implement] wrote auto-review summary artifact: ${autoReviewSummaryArtifact.path}\n`);
    }
    const contextConflictReason = extractContextConflictReason(combinedOutput);
    if (contextConflictReason) {
      return {
        outcome: "failure",
        error: `Agent reported context conflict: ${contextConflictReason}`,
        rawOutput: combinedOutput.slice(-2000)
      };
    }
    const timeoutDetected = /\[timeout[^\]]*\]|timed out|timeout:/i.test(combinedOutput);

    await appendLog(
      logFile,
      `[implement] failure classification: timeoutDetected=${String(timeoutDetected)}\n`
    );
    emitAutoReviewDebugDiagnostics(run, config.autoReviewDebugLogMode, "failure", {
      runId: run.id,
      exitCode: result.code,
      stdoutBytes: byteLength(result.stdout),
      stderrBytes: byteLength(result.stderr),
      summaryFound: outputInspection.summaryFound,
      summaryExtractionMethod: outputInspection.summaryExtractionMethod,
      contextConflictFound: outputInspection.contextConflictFound,
      contextConflictExtractionMethod: outputInspection.contextConflictExtractionMethod,
      preview: outputInspection.preview,
      timeoutDetected,
      analysisVerdict: "agent_exit_nonzero",
      filesChangedCount: 0,
    });

    const internalArtifacts = mergeInternalArtifacts(
      rawAgentOutputArtifacts,
      autoReviewSummaryArtifact ? [autoReviewSummaryArtifact.path] : undefined,
    );
    return {
      outcome: "failure",
      outputs: internalArtifacts ? { internalArtifacts } : undefined,
      error: timeoutDetected
        ? `Agent timed out after ${String(config.agentTimeoutSeconds)}s`
        : `Agent exited with code ${String(result.code)}`,
      rawOutput: (result.stdout + result.stderr).slice(-2000)
    };
  }

  // Analyze agent output
  const analysis = await analyzeAgentOutput(repoDir, result.stdout, result.stderr, logFile);
  const autoReviewSummaryArtifact = runDir
    ? await persistAutoReviewSummaryArtifact(run, runDir, combinedOutput, analysis.filesChanged)
    : undefined;
  if (autoReviewSummaryArtifact) {
    await appendLog(logFile, `[implement] wrote auto-review summary artifact: ${autoReviewSummaryArtifact.path}\n`);
  }

  if (analysis.verdict === "context_conflict") {
    emitAutoReviewDebugDiagnostics(run, config.autoReviewDebugLogMode, "failure", {
      runId: run.id,
      exitCode: result.code,
      stdoutBytes: byteLength(result.stdout),
      stderrBytes: byteLength(result.stderr),
      summaryFound: outputInspection.summaryFound,
      summaryExtractionMethod: outputInspection.summaryExtractionMethod,
      contextConflictFound: outputInspection.contextConflictFound,
      contextConflictExtractionMethod: outputInspection.contextConflictExtractionMethod,
      preview: outputInspection.preview,
      analysisVerdict: analysis.verdict,
      filesChangedCount: analysis.filesChanged.length,
    });
    const internalArtifacts = mergeInternalArtifacts(
      rawAgentOutputArtifacts,
      autoReviewSummaryArtifact ? [autoReviewSummaryArtifact.path] : undefined,
    );
    return {
      outcome: "failure",
      outputs: internalArtifacts ? { internalArtifacts } : undefined,
      error: `Agent reported context conflict: ${analysis.contextConflictReason ?? "unknown reason"}`,
      rawOutput: (result.stdout + result.stderr).slice(-2000)
    };
  }

  if (analysis.verdict === "empty") {
    if (isAutoReviewRun(run)) {
      const noop = classifyAutoReviewNoop(run, combinedOutput);
      emitAutoReviewDebugDiagnostics(
        run,
        config.autoReviewDebugLogMode,
        noop.allowed ? "success" : "failure",
        {
          runId: run.id,
          exitCode: result.code,
          stdoutBytes: byteLength(result.stdout),
          stderrBytes: byteLength(result.stderr),
          summaryFound: outputInspection.summaryFound,
          summaryExtractionMethod: outputInspection.summaryExtractionMethod,
          contextConflictFound: outputInspection.contextConflictFound,
          contextConflictExtractionMethod: outputInspection.contextConflictExtractionMethod,
          preview: outputInspection.preview,
          analysisVerdict: analysis.verdict,
          filesChangedCount: analysis.filesChanged.length,
          noopAllowed: noop.allowed,
        }
      );
      if (noop.allowed) {
        return {
          outcome: "success",
          outputs: {
            agentAnalysis: analysis,
            autoReviewNoop: true,
            internalArtifacts: mergeInternalArtifacts(
              rawAgentOutputArtifacts,
              autoReviewSummaryArtifact ? [autoReviewSummaryArtifact.path] : undefined
            ),
            ...(autoReviewSummaryArtifact
              ? {
                  autoReviewSummary: autoReviewSummaryArtifact.summary,
                  autoReviewSummaryPath: autoReviewSummaryArtifact.path,
                  autoReviewGroundingMetrics: autoReviewSummaryArtifact.summary.groundingMetrics,
                }
              : {}),
          }
        };
      }
      const internalArtifacts = mergeInternalArtifacts(
        rawAgentOutputArtifacts,
        autoReviewSummaryArtifact ? [autoReviewSummaryArtifact.path] : undefined,
      );
      return {
        outcome: "failure",
        outputs: internalArtifacts ? { internalArtifacts } : undefined,
        error: noop.reason ?? `Agent exited 0 but made no meaningful changes. Signals: ${analysis.signals.join("; ") || "none"}`,
        rawOutput: (result.stdout + result.stderr).slice(-2000)
      };
    }

    const internalArtifacts = mergeInternalArtifacts(rawAgentOutputArtifacts);
    return {
      outcome: "failure",
      outputs: internalArtifacts ? { internalArtifacts } : undefined,
      error: `Agent exited 0 but made no meaningful changes. Signals: ${analysis.signals.join("; ") || "none"}`,
      rawOutput: (result.stdout + result.stderr).slice(-2000)
    };
  }

  // Extract cost/token data from pi-agent JSONL output (agent_end event)
  const agentCost = extractPiAgentCost(result.stdout);
  emitAutoReviewDebugDiagnostics(run, config.autoReviewDebugLogMode, "success", {
    runId: run.id,
    exitCode: result.code,
    stdoutBytes: byteLength(result.stdout),
    stderrBytes: byteLength(result.stderr),
    summaryFound: outputInspection.summaryFound,
    summaryExtractionMethod: outputInspection.summaryExtractionMethod,
    contextConflictFound: outputInspection.contextConflictFound,
    contextConflictExtractionMethod: outputInspection.contextConflictExtractionMethod,
    preview: outputInspection.preview,
    analysisVerdict: analysis.verdict,
    filesChangedCount: analysis.filesChanged.length,
  });

  return {
    outcome: "success",
    outputs: {
      agentAnalysis: analysis,
      internalArtifacts: mergeInternalArtifacts(
        rawAgentOutputArtifacts,
        autoReviewSummaryArtifact ? [autoReviewSummaryArtifact.path] : undefined
      ),
      ...(agentCost ? { agentCost } : {}),
      ...(autoReviewSummaryArtifact
        ? {
            autoReviewSummary: autoReviewSummaryArtifact.summary,
            autoReviewSummaryPath: autoReviewSummaryArtifact.path,
            autoReviewGroundingMetrics: autoReviewSummaryArtifact.summary.groundingMetrics,
          }
        : {}),
    }
  };
}

// ── Agent output analysis ──

const ERROR_PATTERNS = [
  /\bfatal\b/i, /\bpanic\b/i, /\bsegmentation fault\b/i,
  /\bunhandled exception\b/i, /\bstack overflow\b/i,
  /\bout of memory\b/i, /\btimeout\b/i,
];

const WARNING_PATTERNS = [
  /\bdeprecated\b/i, /\bwarning\b/i,
];

const CONTEXT_CONFLICT_PATTERN = /^\s*GOOSEHERD_CONTEXT_CONFLICT:\s*(.+?)\s*$/m;

export async function analyzeAgentOutput(
  repoDir: string,
  stdout: string,
  stderr: string,
  logFile: string
): Promise<AgentAnalysis> {
  const signals: string[] = [];

  // 1. Git diff analysis — stage all changes first so untracked files are visible
  await runShellCapture("git add -A", { cwd: repoDir, logFile });
  const statResult = await runShellCapture("git diff --cached --stat HEAD", { cwd: repoDir, logFile });
  const namesResult = await runShellCapture("git diff --cached --name-only HEAD", { cwd: repoDir, logFile });
  const numstatResult = await runShellCapture("git diff --cached --numstat HEAD", { cwd: repoDir, logFile });
  // Unstage to avoid affecting downstream nodes
  await runShellCapture("git reset HEAD --quiet", { cwd: repoDir, logFile });

  const filesChanged = namesResult.stdout.trim()
    ? namesResult.stdout.trim().split("\n")
    : [];
  const meaningfulFilesChanged = filterInternalGeneratedFiles(filesChanged);

  // Parse numstat for added/removed lines
  let totalAdded = 0;
  let totalRemoved = 0;
  for (const line of numstatResult.stdout.trim().split("\n")) {
    const match = line.match(/^(\d+)\s+(\d+)\s+/);
    const file = line.split("\t")[2];
    if (file && isInternalGeneratedFile(file)) {
      continue;
    }
    if (match) {
      totalAdded += parseInt(match[1]!, 10);
      totalRemoved += parseInt(match[2]!, 10);
    }
  }

  const diffStats = { added: totalAdded, removed: totalRemoved, filesCount: meaningfulFilesChanged.length };
  const combined = stdout + stderr;
  const contextConflictReason = extractContextConflictReason(combined);
  if (contextConflictReason) {
    signals.push(`context conflict: ${contextConflictReason}`);
    return {
      verdict: "context_conflict",
      filesChanged: meaningfulFilesChanged,
      diffSummary: statResult.stdout.trim(),
      diffStats,
      signals,
      contextConflictReason
    };
  }

  // 2. Garbage detection
  if (meaningfulFilesChanged.length === 0) {
    signals.push("no file changes detected");
    return {
      verdict: "empty",
      filesChanged: meaningfulFilesChanged,
      diffSummary: statResult.stdout.trim(),
      diffStats,
      signals
    };
  }

  // Mass deletion check: removed > 100 lines AND removed > 5x added AND > 5 files
  if (totalRemoved > 100 && totalRemoved > totalAdded * 5 && meaningfulFilesChanged.length > 5) {
    signals.push(`mass deletion detected: +${String(totalAdded)} -${String(totalRemoved)} across ${String(meaningfulFilesChanged.length)} files`);
    return {
      verdict: "suspect",
      filesChanged: meaningfulFilesChanged,
      diffSummary: statResult.stdout.trim(),
      diffStats,
      signals
    };
  }

  // 3. Signal parsing from stdout/stderr
  for (const pattern of ERROR_PATTERNS) {
    const match = combined.match(pattern);
    if (match) {
      signals.push(`error signal: "${match[0]}"`);
    }
  }
  for (const pattern of WARNING_PATTERNS) {
    const match = combined.match(pattern);
    if (match) {
      signals.push(`warning signal: "${match[0]}"`);
    }
  }

  return {
    verdict: "clean",
    filesChanged: meaningfulFilesChanged,
    diffSummary: statResult.stdout.trim(),
    diffStats,
    signals
  };
}

// ── pi-agent cost extraction ──

export interface AgentCost {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalCost: number;
}

/**
 * Extract cost/token data from pi-agent JSONL stdout.
 * Scans for the agent_end event and sums usage from all assistant messages.
 * Returns null if no pi-agent JSONL data is found.
 */
export function extractPiAgentCost(stdout: string): AgentCost | null {
  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;
  let found = false;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;

      // Use message_end events with assistant role for per-turn usage
      if (event.type === "message_end") {
        const msg = event.message as Record<string, unknown> | undefined;
        if (msg?.role === "assistant" && msg.usage) {
          const usage = msg.usage as Record<string, unknown>;
          totalInput += (usage.input as number) ?? 0;
          totalOutput += (usage.output as number) ?? 0;
          const cost = usage.cost as Record<string, number> | undefined;
          if (cost) totalCost += cost.total ?? 0;
          found = true;
        }
      }
    } catch {
      continue;
    }
  }

  if (!found) return null;

  return {
    inputTokens: totalInput,
    outputTokens: totalOutput,
    totalTokens: totalInput + totalOutput,
    totalCost
  };
}

export function extractAutoReviewSummary(output: string): AutoReviewSummaryArtifact | undefined {
  const parseResult = extractAutoReviewSummaryParseResult(output);
  if (parseResult.summary) {
    return parseResult.summary;
  }
  if (parseResult.found) {
    return undefined;
  }

  const contextConflictReason = extractContextConflictReason(output);
  if (contextConflictReason) {
    return {
      selectedFindings: [],
      ignoredFindings: [],
      rationale: `Context conflict: ${contextConflictReason}`,
    };
  }

  return undefined;
}

export function classifyAutoReviewNoop(
  runOrRequestedBy: RunRecord | string | undefined,
  output: string,
): AutoReviewNoopClassification {
  if (!isAutoReviewRun(runOrRequestedBy)) {
    return { allowed: false };
  }

  const parseResult = extractAutoReviewSummaryParseResult(output);
  if (!parseResult.found) {
    return {
      allowed: false,
      reason: "Agent made no changes and did not emit GOOSEHERD_REVIEW_SUMMARY.",
    };
  }

  if (!parseResult.summary) {
    return {
      allowed: false,
      reason: "Agent emitted GOOSEHERD_REVIEW_SUMMARY but the JSON payload could not be parsed.",
    };
  }

  const summary = parseResult.summary;

  if (summary.selectedFindings.length > 0) {
    return {
      allowed: false,
      reason: "Agent reported actionable findings but made no code changes.",
    };
  }

  return { allowed: true };
}

export async function persistAutoReviewSummaryArtifact(
  runOrRequestedBy: RunRecord | string | undefined,
  runDir: string,
  output: string,
  changedFiles: string[] = []
): Promise<{ path: string; summary: AutoReviewSummaryArtifact } | undefined> {
  if (!isAutoReviewRun(runOrRequestedBy)) {
    return undefined;
  }

  const parseResult = extractAutoReviewSummaryParseResult(output);
  const baseSummary = extractAutoReviewSummary(output)
    ?? (parseResult.found
      ? {
          selectedFindings: [],
          ignoredFindings: [],
          rationale: "Agent emitted GOOSEHERD_REVIEW_SUMMARY but the JSON payload could not be parsed.",
        }
      : {
          selectedFindings: [],
          ignoredFindings: [],
          rationale: "Agent did not emit GOOSEHERD_REVIEW_SUMMARY.",
        });
  const summary: AutoReviewSummaryArtifact = {
    ...baseSummary,
    groundingMetrics: buildAutoReviewGroundingMetrics(baseSummary, changedFiles),
  };

  await writeFile(
    path.join(runDir, AUTO_REVIEW_SUMMARY_ARTIFACT),
    JSON.stringify(summary, null, 2) + "\n",
    "utf8"
  );

  return {
    path: AUTO_REVIEW_SUMMARY_ARTIFACT,
    summary,
  };
}

async function persistAgentOutputArtifacts(
  runDir: string,
  stdout: string,
  stderr: string,
): Promise<string[]> {
  await writeFile(path.join(runDir, AGENT_STDOUT_ARTIFACT), stdout, "utf8");
  await writeFile(path.join(runDir, AGENT_STDERR_ARTIFACT), stderr, "utf8");
  return [AGENT_STDOUT_ARTIFACT, AGENT_STDERR_ARTIFACT];
}

function extractContextConflictReason(output: string): string | undefined {
  const reason = extractContextConflictMatch(output)?.text.match(CONTEXT_CONFLICT_PATTERN)?.[1]?.trim();
  return reason ? reason : undefined;
}

export function inspectAutoReviewOutput(output: string): AutoReviewOutputInspection {
  const summaryMatch = extractSummaryMatch(output);
  const contextConflictMatch = extractContextConflictMatch(output);
  const preview = summaryMatch?.text
    ?? contextConflictMatch?.text
    ?? extractOutputTailPreview(output);
  return {
    summaryFound: Boolean(summaryMatch),
    summaryExtractionMethod: summaryMatch?.method ?? "none",
    contextConflictFound: Boolean(contextConflictMatch),
    contextConflictExtractionMethod: contextConflictMatch?.method ?? "none",
    preview: truncatePreview(preview, AUTO_REVIEW_OUTPUT_PREVIEW_MAX_CHARS),
  };
}

function extractSummaryMatch(output: string): AutoReviewSentinelMatch | undefined {
  return extractSentinelMatch(output, AUTO_REVIEW_SUMMARY_PATTERN, AUTO_REVIEW_SUMMARY_PREFIX);
}

function extractContextConflictMatch(output: string): AutoReviewSentinelMatch | undefined {
  return extractSentinelMatch(output, CONTEXT_CONFLICT_PATTERN, "GOOSEHERD_CONTEXT_CONFLICT:");
}

function extractSentinelMatch(
  output: string,
  directPattern: RegExp,
  prefix: string,
): AutoReviewSentinelMatch | undefined {
  const directMatch = directPattern.exec(output);
  if (directMatch?.index !== undefined) {
    const directText = findSentinelText(output.slice(directMatch.index), prefix) ?? directMatch[0].trim();
    return { text: directText, method: "plain_text" };
  }

  return findPiJsonlAssistantText(output, prefix);
}

function findPiJsonlAssistantText(output: string, prefix: string): AutoReviewSentinelMatch | undefined {
  let fallbackMatch: AutoReviewSentinelMatch | undefined;

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }

    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      const eventType = event["type"];

      if (eventType === "message_update") {
        const assistantMessageEvent = event["assistantMessageEvent"];
        for (const content of extractAssistantUpdateTexts(assistantMessageEvent)) {
          const sentinelText = findSentinelText(content, prefix);
          if (sentinelText) {
            if (prefix === AUTO_REVIEW_SUMMARY_PREFIX && !extractJsonObjectAfterPrefix(sentinelText, prefix)) {
              fallbackMatch ??= { text: sentinelText, method: "pi_jsonl_message_update" };
              continue;
            }
            return { text: sentinelText, method: "pi_jsonl_message_update" };
          }
        }
      }

      if (eventType === "message_end" || eventType === "turn_end") {
        const message = event["message"];
        for (const text of extractAssistantMessageTexts(message)) {
          const sentinelText = findSentinelText(text, prefix);
          if (sentinelText) {
            const method = eventType === "turn_end" ? "pi_jsonl_turn_end" : "pi_jsonl_message_end";
            if (prefix === AUTO_REVIEW_SUMMARY_PREFIX && !extractJsonObjectAfterPrefix(sentinelText, prefix)) {
              fallbackMatch ??= { text: sentinelText, method };
              continue;
            }
            return { text: sentinelText, method };
          }
        }
      }

      if (eventType === "agent_end") {
        const messages = event["messages"];
        if (Array.isArray(messages)) {
          for (const message of messages) {
            for (const text of extractAssistantMessageTexts(message)) {
              const sentinelText = findSentinelText(text, prefix);
              if (sentinelText) {
                if (prefix === AUTO_REVIEW_SUMMARY_PREFIX && !extractJsonObjectAfterPrefix(sentinelText, prefix)) {
                  fallbackMatch ??= { text: sentinelText, method: "pi_jsonl_agent_end" };
                  continue;
                }
                return { text: sentinelText, method: "pi_jsonl_agent_end" };
              }
            }
          }
        }
      }
    } catch {
      continue;
    }
  }

  return fallbackMatch;
}

function truncatePreview(value: string | undefined, maxChars = 300): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.length > maxChars ? `${value.slice(0, maxChars - 3)}...` : value;
}

function extractOutputTailPreview(output: string, maxLines = AUTO_REVIEW_OUTPUT_PREVIEW_MAX_LINES): string | undefined {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  if (lines.length === 0) {
    return undefined;
  }
  const preview = lines.slice(-maxLines).join("\n");
  return preview.trim() ? preview : undefined;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function shouldEmitAutoReviewDebugDiagnostics(
  runOrRequestedBy: RunRecord | string | undefined,
  mode: string | undefined,
  outcome: "success" | "failure",
): boolean {
  if (!isAutoReviewRun(runOrRequestedBy)) {
    return false;
  }
  if (mode === "off") {
    return false;
  }
  if (mode === "always") {
    return true;
  }
  return outcome === "failure";
}

function emitAutoReviewDebugDiagnostics(
  runOrRequestedBy: RunRecord | string | undefined,
  mode: string | undefined,
  outcome: "success" | "failure",
  details: Record<string, unknown>,
): void {
  if (!shouldEmitAutoReviewDebugDiagnostics(runOrRequestedBy, mode, outcome)) {
    return;
  }
  if (outcome === "failure") {
    logWarn("Auto-review debug diagnostics", details);
    return;
  }
  logInfo("Auto-review debug diagnostics", details);
}

function extractAssistantUpdateTexts(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const event = value as Record<string, unknown>;
  if (event["type"] === "text_end") {
    const content = event["content"];
    return typeof content === "string" && content.trim() ? [content.trim()] : [];
  }

  if (event["type"] === "text_delta") {
    const partial = event["partial"];
    return extractAssistantMessageTexts(partial);
  }

  return [];
}

function findSentinelText(value: string, prefix: string): string | undefined {
  const startIndex = value.indexOf(prefix);
  if (startIndex < 0) {
    return undefined;
  }

  const suffix = value.slice(startIndex);
  const summaryJson = prefix === AUTO_REVIEW_SUMMARY_PREFIX
    ? extractJsonObjectAfterPrefix(suffix, prefix)
    : undefined;
  if (summaryJson) {
    return `${prefix} ${summaryJson}`;
  }

  for (const line of suffix.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(prefix)) {
      return trimmed;
    }
  }
  return undefined;
}

function extractAutoReviewSummaryParseResult(output: string): AutoReviewSummaryParseResult {
  const summaryMatch = extractSummaryMatch(output);
  if (!summaryMatch) {
    return { found: false };
  }

  const summaryJson = extractJsonObjectAfterPrefix(summaryMatch.text, AUTO_REVIEW_SUMMARY_PREFIX);
  if (!summaryJson) {
    return { found: true, parseError: "missing_json" };
  }

  try {
    const parsed = JSON.parse(summaryJson) as Record<string, unknown>;
    return {
      found: true,
      summary: {
        selectedFindings: normalizeSummaryItems(parsed["selectedFindings"]),
        ignoredFindings: normalizeSummaryItems(parsed["ignoredFindings"]),
        rationale: typeof parsed["rationale"] === "string" && parsed["rationale"].trim()
          ? parsed["rationale"].trim()
          : "Agent emitted GOOSEHERD_REVIEW_SUMMARY without a rationale.",
      },
    };
  } catch {
    return { found: true, parseError: "invalid_json" };
  }
}

function extractJsonObjectAfterPrefix(value: string, prefix: string): string | undefined {
  const prefixIndex = value.indexOf(prefix);
  if (prefixIndex < 0) {
    return undefined;
  }

  let cursor = prefixIndex + prefix.length;
  while (cursor < value.length && /\s/.test(value[cursor] ?? "")) {
    cursor += 1;
  }
  if (value[cursor] !== "{") {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = cursor; index < value.length; index += 1) {
    const char = value[index] ?? "";

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return value.slice(cursor, index + 1);
      }
    }
  }

  return undefined;
}

function extractAssistantMessageTexts(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const message = value as Record<string, unknown>;
  if (message["role"] !== "assistant") {
    return [];
  }

  const content = message["content"];
  if (!Array.isArray(content)) {
    return [];
  }

  return content
    .filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === "object")
    .filter((block) => block["type"] === "text")
    .map((block) => block["text"])
    .filter((text): text is string => typeof text === "string")
    .map((text) => text.trim())
    .filter(Boolean);
}

function normalizeSummaryItems(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map(item => item.trim())
        .filter(Boolean)
    : [];
}

function buildAutoReviewGroundingMetrics(
  summary: Pick<AutoReviewSummaryArtifact, "selectedFindings" | "ignoredFindings">,
  changedFiles: string[]
): AutoReviewGroundingMetrics {
  const changedFileTokens = new Set(
    changedFiles.flatMap(tokenizeGroundingText)
  );
  const selectedFindingOverlapCount = countFindingOverlaps(summary.selectedFindings, changedFileTokens);
  const ignoredFindingOverlapCount = countFindingOverlaps(summary.ignoredFindings, changedFileTokens);
  const selectedFindingCount = summary.selectedFindings.length;

  return {
    selectedFindingCount,
    selectedFindingOverlapCount,
    selectedFindingOverlapRatio: selectedFindingCount > 0
      ? Number((selectedFindingOverlapCount / selectedFindingCount).toFixed(2))
      : 0,
    ignoredFindingCount: summary.ignoredFindings.length,
    ignoredFindingOverlapCount,
  };
}

function countFindingOverlaps(findings: string[], changedFileTokens: Set<string>): number {
  if (changedFileTokens.size === 0) {
    return 0;
  }

  return findings.filter((finding) =>
    tokenizeGroundingText(finding).some((token) => changedFileTokens.has(token))
  ).length;
}

function tokenizeGroundingText(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length >= 3);
}

function isAutoReviewRun(runOrRequestedBy: RunRecord | string | undefined): boolean {
  if (typeof runOrRequestedBy === "string" || runOrRequestedBy === undefined) {
    return runOrRequestedBy === "work-item:auto-review";
  }
  return isFeatureDeliveryAutoReviewRun(runOrRequestedBy);
}
