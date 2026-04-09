import path from "node:path";
import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { appendLog, runShellCapture } from "../shell.js";
import { buildAgentCommand } from "../agent-command.js";

export interface AgentAnalysis {
  verdict: "clean" | "suspect" | "empty";
  filesChanged: string[];
  diffSummary: string;
  diffStats: { added: number; removed: number; filesCount: number };
  signals: string[];
}

const INTERNAL_GENERATED_FILES = new Set(["AGENTS.md"]);

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

  if (result.code !== 0) {
    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    const timeoutDetected = /\[timeout[^\]]*\]|timed out|timeout:/i.test(combinedOutput);

    await appendLog(
      logFile,
      `[implement] failure classification: timeoutDetected=${String(timeoutDetected)}\n`
    );

    return {
      outcome: "failure",
      error: timeoutDetected
        ? `Agent timed out after ${String(config.agentTimeoutSeconds)}s`
        : `Agent exited with code ${String(result.code)}`,
      rawOutput: (result.stdout + result.stderr).slice(-2000)
    };
  }

  // Analyze agent output
  const analysis = await analyzeAgentOutput(repoDir, result.stdout, result.stderr, logFile);

  if (analysis.verdict === "empty") {
    return {
      outcome: "failure",
      error: `Agent exited 0 but made no meaningful changes. Signals: ${analysis.signals.join("; ") || "none"}`,
      rawOutput: (result.stdout + result.stderr).slice(-2000)
    };
  }

  // Extract cost/token data from pi-agent JSONL output (agent_end event)
  const agentCost = extractPiAgentCost(result.stdout);

  return {
    outcome: "success",
    outputs: { agentAnalysis: analysis, ...(agentCost ? { agentCost } : {}) }
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
  const meaningfulFilesChanged = filesChanged.filter((file) => !INTERNAL_GENERATED_FILES.has(file));

  // Parse numstat for added/removed lines
  let totalAdded = 0;
  let totalRemoved = 0;
  for (const line of numstatResult.stdout.trim().split("\n")) {
    const match = line.match(/^(\d+)\s+(\d+)\s+/);
    const file = line.split("\t")[2];
    if (file && INTERNAL_GENERATED_FILES.has(file)) {
      continue;
    }
    if (match) {
      totalAdded += parseInt(match[1]!, 10);
      totalRemoved += parseInt(match[2]!, 10);
    }
  }

  const diffStats = { added: totalAdded, removed: totalRemoved, filesCount: meaningfulFilesChanged.length };

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
  const combined = stdout + stderr;
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
