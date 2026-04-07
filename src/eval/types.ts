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

export type EvalJudgeConfig =
  | StatusJudgeConfig
  | FilesChangedJudgeConfig
  | DiffContainsJudgeConfig
  | PrCreatedJudgeConfig
  | GateVerdictJudgeConfig
  | BrowserVerdictJudgeConfig
  | LlmJudgeConfig;

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
