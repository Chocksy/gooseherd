/**
 * Eval judges — each judge inspects run data and returns a pass/fail verdict.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { logWarn } from "../logger.js";
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
  ExpectedOutcomeJudgeConfig,
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
    system: `You are an eval judge for an AI coding agent pipeline. Evaluate the agent's work and respond with raw JSON only (no markdown fences): { "pass": true/false, "score": 0-100, "reason": "brief explanation" }. Keep "reason" under two sentences.`,
    userMessage: `## Judge prompt\n${config.prompt}\n\n## Code diff\n\`\`\`diff\n${diffPreview}\n\`\`\`\n\n## Run status: ${ctx.run.status}\n## Changed files: ${(ctx.run.changedFiles ?? []).join(", ")}`,
    jsonMode: true,
    maxTokens: 1024,
    timeoutMs: 30_000,
  });

  try {
    const parsed = JSON.parse(extractJsonObject(response.content)) as { pass?: boolean; score?: number; reason?: string };
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

/**
 * LLM judges sometimes wrap their verdict in ```json fences despite jsonMode.
 * Strip fences and isolate the first balanced {...} so JSON.parse gets clean input.
 *
 * Brace-balancing (rather than a naive first-`{` … last-`}` slice) so that a `}`
 * inside a string value (e.g. a "reason" that mentions "}") and any trailing prose
 * after the object don't corrupt the slice.
 */
export function extractJsonObject(content: string): string {
  const unfenced = content.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const start = unfenced.indexOf("{");
  if (start < 0) return unfenced;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < unfenced.length; i += 1) {
    const ch = unfenced[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return unfenced.slice(start, i + 1);
      }
    }
  }
  // Unbalanced — fall back to the remainder from the first brace.
  return unfenced.slice(start);
}

/**
 * Named outcome tokens → the phrasings the run-manager classifier / implement node
 * use for the corresponding terminal error. Kept in sync with ERROR_PATTERNS in
 * src/run-manager.ts and the failure branches in src/pipeline/nodes/implement.ts.
 */
const OUTCOME_PATTERNS: Record<string, RegExp> = {
  no_changes: /no meaningful changes|no file changes|whitespace-only|made no (?:further )?changes|no candidate changes to push/i,
  context_conflict: /context conflict/i,
};

function judgeExpectedOutcome(config: ExpectedOutcomeJudgeConfig, ctx: JudgeContext): JudgeVerdict {
  const haystack = `${ctx.run.status} ${ctx.run.error ?? ""}`;
  const diffEmpty = ctx.diff.trim() === "";
  const matched = config.expect.find((token) => {
    const pattern = OUTCOME_PATTERNS[token];
    if (pattern) {
      // "Did nothing" outcomes (no_changes, context_conflict) must not have produced
      // a diff — a matching status/error string alongside a non-empty diff means the
      // agent DID change files, so the outcome does not actually hold.
      return pattern.test(haystack) && diffEmpty;
    }
    // Unknown token: require an exact run-status match (no fuzzy substring matching,
    // which would let an unrelated error string satisfy the expectation).
    return ctx.run.status === token;
  });

  if (matched) {
    return {
      judge: "expected_outcome",
      pass: true,
      score: 100,
      reason: `Run outcome matched '${matched}' (status='${ctx.run.status}', error='${ctx.run.error ?? ""}')`,
    };
  }

  if (config.allow_empty_diff && ctx.run.status === "completed" && ctx.diff.trim() === "") {
    return {
      judge: "expected_outcome",
      pass: true,
      score: 100,
      reason: "Completed run produced an empty diff (allow_empty_diff)",
    };
  }

  return {
    judge: "expected_outcome",
    pass: false,
    score: 0,
    reason: `None of expected outcomes [${config.expect.join(", ")}] matched. status='${ctx.run.status}', error='${ctx.run.error ?? ""}', diffEmpty=${String(ctx.diff.trim() === "")}`,
  };
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
    case "expected_outcome":
      return judgeExpectedOutcome(config, ctx);
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
 *
 * The pipeline clones the target repo single-branch, so the bare base branch
 * ref (e.g. `main`) usually does not exist locally. Resolve robustly:
 *   1. `git diff origin/<baseBranch>...HEAD` (the tracking ref is normally present).
 *   2. If that ref is missing, `git fetch origin <baseBranch>` then retry.
 *   3. Fall back to the patch for HEAD, but ONLY when HEAD is exactly one commit
 *      ahead of the base (the single commit the agent made); otherwise return ""
 *      rather than emit the base tip's unrelated patch. A warning marks either path.
 */
export async function readDiff(workRoot: string, runId: string, baseBranch: string): Promise<string> {
  const repoDir = path.resolve(workRoot, runId, "repo");
  const runGit = async (args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoDir,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  };

  const originRef = `origin/${baseBranch}`;
  try {
    return await runGit(["diff", `${originRef}...HEAD`]);
  } catch {
    // Tracking ref missing — try to fetch it, then retry the merge-base diff.
    try {
      await runGit(["fetch", "origin", baseBranch]);
      return await runGit(["diff", `${originRef}...HEAD`]);
    } catch {
      // Last resort: the patch for the agent's commit (HEAD). This is only valid when
      // the agent made exactly one commit on top of the base — then HEAD's patch IS
      // that change. If HEAD is the untouched base tip (zero commits) `git show HEAD`
      // would return an unrelated base commit's patch, so gate on the commit count and
      // otherwise return empty rather than fabricate a diff.
      try {
        const ahead = (await runGit(["rev-list", "--count", `${originRef}..HEAD`])).trim();
        if (ahead === "1") {
          logWarn("Eval: diff base ref unavailable, falling back to `git show HEAD` (single commit ahead of base)", {
            runId,
            baseBranch,
          });
          return await runGit(["show", "--format=", "HEAD"]);
        }
        logWarn("Eval: diff base ref unavailable and HEAD is not exactly one commit ahead of base — cannot resolve diff", {
          runId,
          baseBranch,
          commitsAhead: ahead,
        });
        return "";
      } catch {
        logWarn("Eval: diff base ref unavailable and commit count unresolvable — cannot resolve diff", {
          runId,
          baseBranch,
        });
        return "";
      }
    }
  }
}

/** Gate nodes that append a gate-report verdict when they actually run. */
const GATE_NODE_IDS = new Set(["scope_judge", "diff_gate", "forbidden_files", "security_scan", "browser_verify"]);

/**
 * Map a pipeline node's terminal outcome to the verdict vocabulary used by gate
 * reports. Only outcomes for gates that actually ran are mapped — `skipped`
 * outcomes never reach here because the reconstruction below drops them (a skipped
 * gate appends no verdict in production, so it must stay absent from the report).
 */
export function outcomeToVerdict(outcome: string): string {
  switch (outcome) {
    case "success":
      return "pass";
    case "failure":
      return "hard_fail";
    case "soft_fail":
      return "soft_fail";
    default:
      return outcome;
  }
}

/**
 * Reconstruct a gate report from the run's events.jsonl.
 *
 * The canonical gate report lives only in the in-memory pipeline context and is
 * never persisted to `checkpoints/checkpoint.json` on the local runtime path used
 * by evals. The `node_end` events, however, record each gate node's terminal
 * outcome, which we translate back into a verdict. This lets `gate_verdict` judges
 * work without wiring the production checkpoint store into the eval path.
 *
 * The mapping is NOT 1:1 with production's gate report: a gate that self-skips
 * (e.g. scope_judge with no OPENROUTER_API_KEY) emits `node_end outcome: "skipped"`
 * but appends NO gate-report entry, so we drop skipped outcomes and leave the gate
 * absent — `gate_verdict` then correctly reports "not found" rather than inventing a
 * `skipped` verdict production never recorded. (The LLM-error fail-open path is the
 * opposite: it appends `pass` and ends `success`, which we do map.)
 */
async function readGateReportFromEvents(
  workRoot: string,
  runId: string,
): Promise<Array<{ gate: string; verdict: string }>> {
  const eventsPath = path.resolve(workRoot, runId, "events.jsonl");
  let raw: string;
  try {
    raw = await readFile(eventsPath, "utf8");
  } catch {
    return [];
  }

  // Keep the last outcome per gate node (fix loops can re-run a gate).
  const verdicts = new Map<string, string>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event: { type?: string; nodeId?: string; outcome?: string };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    if (event.type === "node_end" && event.nodeId && event.outcome && GATE_NODE_IDS.has(event.nodeId)) {
      // A skipped gate appends no verdict in production; keep it absent here too.
      if (event.outcome === "skipped") continue;
      verdicts.set(event.nodeId, outcomeToVerdict(event.outcome));
    }
  }

  return Array.from(verdicts, ([gate, verdict]) => ({ gate, verdict }));
}

/**
 * Read checkpoint data for the run's judges.
 *
 * Prefers `checkpoints/checkpoint.json` (production path), and falls back to a
 * gate report reconstructed from events.jsonl when the checkpoint is absent —
 * which is always the case for local-runtime eval runs.
 */
export async function readCheckpoint(workRoot: string, runId: string): Promise<Record<string, unknown>> {
  const checkpointPath = path.resolve(workRoot, runId, "checkpoints", "checkpoint.json");
  let data: Record<string, unknown> = {};
  try {
    const raw = await readFile(checkpointPath, "utf8");
    const parsed = JSON.parse(raw) as { data?: Record<string, unknown> };
    data = parsed.data ?? {};
  } catch {
    data = {};
  }

  // Fall back to the events-derived gate report when the checkpoint has no gate
  // report OR persisted an empty one ([]) — an empty array is "missing", not "no
  // gates ran", so treat it the same as absent.
  if (!data.gateReport || (Array.isArray(data.gateReport) && data.gateReport.length === 0)) {
    const gateReport = await readGateReportFromEvents(workRoot, runId);
    if (gateReport.length > 0) {
      data = { ...data, gateReport };
    }
  }

  return data;
}
