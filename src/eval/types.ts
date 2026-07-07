/**
 * Eval harness types — scenario definitions, judge configs, and result records.
 */

// ── Judge config variants ──

export interface StatusJudgeConfig {
  type: "status";
  expect: string;
}

export interface FilesChangedJudgeConfig {
  type: "files_changed";
  expect_any: string[];
}

export interface DiffContainsJudgeConfig {
  type: "diff_contains";
  patterns: string[];
}

export interface PrCreatedJudgeConfig {
  type: "pr_created";
}

export interface GateVerdictJudgeConfig {
  type: "gate_verdict";
  gate: string;
  expect: string;
}

export interface BrowserVerdictJudgeConfig {
  type: "browser_verdict";
  expect: string;
}

export interface LlmJudgeConfig {
  type: "llm_judge";
  prompt: string;
}

/**
 * Passes when the run "correctly did nothing" — its terminal status/error matches
 * one of the expected outcomes (e.g. `no_changes`, `context_conflict`), or when
 * `allow_empty_diff` is set and a completed run produced an empty diff. Makes
 * refusing to invent work a PASSING benchmark result.
 */
export interface ExpectedOutcomeJudgeConfig {
  type: "expected_outcome";
  expect: string[];
  allow_empty_diff?: boolean;
}

export type EvalJudgeConfig =
  | StatusJudgeConfig
  | FilesChangedJudgeConfig
  | DiffContainsJudgeConfig
  | PrCreatedJudgeConfig
  | GateVerdictJudgeConfig
  | BrowserVerdictJudgeConfig
  | LlmJudgeConfig
  | ExpectedOutcomeJudgeConfig;

// ── Scenario ──

export interface EvalScenario {
  name: string;
  description: string;
  repo: string;
  baseBranch: string;
  task: string;
  pipeline?: string;
  enableNodes?: string[];
  skipNodes?: string[];
  judges: EvalJudgeConfig[];
  configOverrides?: Record<string, string>;
  tags?: string[];
}

// ── Judge result ──

export interface JudgeVerdict {
  judge: string;
  pass: boolean;
  score: number;
  reason: string;
}

// ── Eval result ──

export interface EvalResult {
  scenarioName: string;
  runId: string;
  configLabel?: string;
  pipeline?: string;
  model?: string;
  overallPass: boolean;
  overallScore: number;
  judgeResults: JudgeVerdict[];
  durationMs: number;
  costUsd: number;
  tags?: string[];
}
