import path from "node:path";
import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { runShellCapture, shellEscape, renderTemplate, buildMcpFlags, mapToContainerPath } from "../shell.js";

export interface AgentAnalysis {
  verdict: "clean" | "suspect" | "empty";
  filesChanged: string[];
  diffSummary: string;
  diffStats: { added: number; removed: number; filesCount: number };
  signals: string[];
}

/**
 * Implement node: run the coding agent with MCP extension.
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

  const template = isFollowUp && config.agentFollowUpTemplate
    ? config.agentFollowUpTemplate
    : config.agentCommandTemplate;

  const agentCommand = renderTemplate(template, {
    repo_dir: mapToContainerPath(repoDir),
    prompt_file: mapToContainerPath(promptFile),
    task_file: mapToContainerPath(promptFile),
    run_id: run.id,
    repo_slug: run.repoSlug,
    parent_run_id: run.parentRunId ?? ""
  });

  // Append MCP extensions if configured
  let cmd = agentCommand;
  const mcpFlags = buildMcpFlags(config.mcpExtensions);
  if (mcpFlags) {
    cmd = `${cmd} ${mcpFlags}`;
  }

  const result = await runShellCapture(cmd, {
    cwd: path.resolve("."),
    logFile,
    timeoutMs: config.agentTimeoutSeconds * 1000,
    login: true  // Agent command needs login shell for PATH (goose, etc.)
  });

  if (result.code !== 0) {
    return {
      outcome: "failure",
      error: `Agent exited with code ${String(result.code)}`,
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

  return {
    outcome: "success",
    outputs: { agentAnalysis: analysis }
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

  // Parse numstat for added/removed lines
  let totalAdded = 0;
  let totalRemoved = 0;
  for (const line of numstatResult.stdout.trim().split("\n")) {
    const match = line.match(/^(\d+)\s+(\d+)\s+/);
    if (match) {
      totalAdded += parseInt(match[1]!, 10);
      totalRemoved += parseInt(match[2]!, 10);
    }
  }

  const diffStats = { added: totalAdded, removed: totalRemoved, filesCount: filesChanged.length };

  // 2. Garbage detection
  if (filesChanged.length === 0) {
    signals.push("no file changes detected");
    return {
      verdict: "empty",
      filesChanged,
      diffSummary: statResult.stdout.trim(),
      diffStats,
      signals
    };
  }

  // Mass deletion check: removed > 100 lines AND removed > 5x added AND > 5 files
  if (totalRemoved > 100 && totalRemoved > totalAdded * 5 && filesChanged.length > 5) {
    signals.push(`mass deletion detected: +${String(totalAdded)} -${String(totalRemoved)} across ${String(filesChanged.length)} files`);
    return {
      verdict: "suspect",
      filesChanged,
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
    filesChanged,
    diffSummary: statResult.stdout.trim(),
    diffStats,
    signals
  };
}
