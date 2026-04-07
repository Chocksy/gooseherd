/**
 * Eval judges — each judge inspects run data and returns a pass/fail verdict.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { RunRecord } from "../types.js";
import type {
  EvalJudgeConfig,
  JudgeVerdict,
  StatusJudgeConfig,
  FilesChangedJudgeConfig,
  DiffContainsJudgeConfig,
  PrCreatedJudgeConfig,
  GateVerdictJudgeConfig,
  BrowserVerdictJudgeConfig,
  LlmJudgeConfig,
} from "./types.js";
import { callLLM, type LLMCallerConfig } from "../llm/caller.js";

const execFileAsync = promisify(execFile);

export interface JudgeContext {
  run: RunRecord;
  checkpointData: Record<string, unknown>;
  diff: string;
  workRoot: string;
  llmConfig?: LLMCallerConfig;
}

// ── Individual judge implementations ──

function judgeStatus(config: StatusJudgeConfig, ctx: JudgeContext): JudgeVerdict {
  const pass = ctx.run.status === config.expect;
  return {
    judge: "status",
    pass,
    score: pass ? 100 : 0,
    reason: pass
      ? `Run status is '${ctx.run.status}' as expected`
      : `Expected status '${config.expect}', got '${ctx.run.status}'`,
  };
}

function judgeFilesChanged(config: FilesChangedJudgeConfig, ctx: JudgeContext): JudgeVerdict {
  const changed = ctx.run.changedFiles ?? [];
  const matches = config.expect_any.filter((expected) =>
    changed.some((f) => f === expected || f.endsWith(`/${expected}`))
  );
  const pass = matches.length > 0;
  return {
    judge: "files_changed",
    pass,
    score: pass ? 100 : 0,
    reason: pass
      ? `Changed files include: ${matches.join(", ")}`
      : `None of expected files were changed. Changed: [${changed.join(", ")}]`,
  };
}

function judgeDiffContains(config: DiffContainsJudgeConfig, ctx: JudgeContext): JudgeVerdict {
  const found: string[] = [];
  const missing: string[] = [];

  for (const pattern of config.patterns) {
    if (ctx.diff.includes(pattern)) {
      found.push(pattern);
    } else {
      missing.push(pattern);
    }
  }

  const score = Math.round((found.length / config.patterns.length) * 100);
  const pass = missing.length === 0;
  return {
    judge: "diff_contains",
    pass,
    score,
    reason: pass
      ? `All patterns found in diff`
      : `Missing patterns: ${missing.join(", ")}`,
  };
}

function judgePrCreated(_config: PrCreatedJudgeConfig, ctx: JudgeContext): JudgeVerdict {
  const pass = ctx.run.prUrl != null && ctx.run.prUrl.length > 0;
  return {
    judge: "pr_created",
    pass,
    score: pass ? 100 : 0,
    reason: pass ? `PR created: ${ctx.run.prUrl}` : "No PR was created",
  };
}

function judgeGateVerdict(config: GateVerdictJudgeConfig, ctx: JudgeContext): JudgeVerdict {
  const gateReport = ctx.checkpointData.gateReport as Array<{ gate: string; verdict: string }> | undefined;
  if (!gateReport) {
    return { judge: `gate_verdict:${config.gate}`, pass: false, score: 0, reason: "No gate report in checkpoint" };
  }

  const entry = gateReport.find((g) => g.gate === config.gate);
  if (!entry) {
    return { judge: `gate_verdict:${config.gate}`, pass: false, score: 0, reason: `Gate '${config.gate}' not found in report` };
  }

  const pass = entry.verdict === config.expect;
  return {
    judge: `gate_verdict:${config.gate}`,
    pass,
    score: pass ? 100 : 0,
    reason: pass
      ? `Gate '${config.gate}' verdict is '${entry.verdict}' as expected`
      : `Expected gate '${config.gate}' verdict '${config.expect}', got '${entry.verdict}'`,
  };
}

function judgeBrowserVerdict(config: BrowserVerdictJudgeConfig, ctx: JudgeContext): JudgeVerdict {
  const result = ctx.checkpointData.browserVerifyResult as { passed?: boolean; confidence?: number; reasoning?: string } | undefined;
  if (!result) {
    return { judge: "browser_verdict", pass: false, score: 0, reason: "No browser verify result in checkpoint" };
  }

  const actual = result.passed ? "pass" : "fail";
  const pass = actual === config.expect;
  return {
    judge: "browser_verdict",
    pass,
    score: pass ? 100 : (result.confidence ?? 0),
    reason: pass
      ? `Browser verdict: ${actual} (confidence: ${String(result.confidence ?? "?")})`
      : `Expected browser verdict '${config.expect}', got '${actual}'. ${result.reasoning ?? ""}`,
  };
}

async function judgeLlm(config: LlmJudgeConfig, ctx: JudgeContext): Promise<JudgeVerdict> {
  if (!ctx.llmConfig) {
    return { judge: "llm_judge", pass: false, score: 0, reason: "No LLM config provided for llm_judge" };
  }

  const diffPreview = ctx.diff.length > 8000 ? ctx.diff.slice(0, 8000) + "\n... (truncated)" : ctx.diff;

  const response = await callLLM(ctx.llmConfig, {
    system: `You are an eval judge for an AI coding agent pipeline. Evaluate the agent's work and respond with JSON: { "pass": true/false, "score": 0-100, "reason": "brief explanation" }`,
    userMessage: `## Judge prompt\n${config.prompt}\n\n## Code diff\n\`\`\`diff\n${diffPreview}\n\`\`\`\n\n## Run status: ${ctx.run.status}\n## Changed files: ${(ctx.run.changedFiles ?? []).join(", ")}`,
    jsonMode: true,
    maxTokens: 512,
    timeoutMs: 30_000,
  });

  try {
    const parsed = JSON.parse(response.content) as { pass?: boolean; score?: number; reason?: string };
    return {
      judge: "llm_judge",
      pass: parsed.pass === true,
      score: typeof parsed.score === "number" ? parsed.score : (parsed.pass ? 100 : 0),
      reason: parsed.reason ?? "No reason provided",
    };
  } catch {
    return {
      judge: "llm_judge",
      pass: false,
      score: 0,
      reason: `Failed to parse LLM response: ${response.content.slice(0, 200)}`,
    };
  }
}

// ── Public API ──

/**
 * Run a single judge against the context.
 */
export async function runJudge(config: EvalJudgeConfig, ctx: JudgeContext): Promise<JudgeVerdict> {
  switch (config.type) {
    case "status":
      return judgeStatus(config, ctx);
    case "files_changed":
      return judgeFilesChanged(config, ctx);
    case "diff_contains":
      return judgeDiffContains(config, ctx);
    case "pr_created":
      return judgePrCreated(config, ctx);
    case "gate_verdict":
      return judgeGateVerdict(config, ctx);
    case "browser_verdict":
      return judgeBrowserVerdict(config, ctx);
    case "llm_judge":
      return judgeLlm(config, ctx);
    default:
      return { judge: "unknown", pass: false, score: 0, reason: `Unknown judge type: ${(config as { type: string }).type}` };
  }
}

/**
 * Run all judges for a scenario and return verdicts.
 */
export async function runAllJudges(judges: EvalJudgeConfig[], ctx: JudgeContext): Promise<JudgeVerdict[]> {
  const verdicts: JudgeVerdict[] = [];
  for (const judge of judges) {
    verdicts.push(await runJudge(judge, ctx));
  }
  return verdicts;
}

/**
 * Read the git diff from the run's repo directory.
 */
export async function readDiff(workRoot: string, runId: string, baseBranch: string): Promise<string> {
  const repoDir = path.resolve(workRoot, runId, "repo");
  try {
    const { stdout } = await execFileAsync("git", ["diff", `${baseBranch}...HEAD`], {
      cwd: repoDir,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return "";
  }
}

/**
 * Read checkpoint data from the run's checkpoint file.
 */
export async function readCheckpoint(workRoot: string, runId: string): Promise<Record<string, unknown>> {
  const checkpointPath = path.resolve(workRoot, runId, "checkpoints", "checkpoint.json");
  try {
    const raw = await readFile(checkpointPath, "utf8");
    const parsed = JSON.parse(raw) as { data?: Record<string, unknown> };
    return parsed.data ?? {};
  } catch {
    return {};
  }
}
