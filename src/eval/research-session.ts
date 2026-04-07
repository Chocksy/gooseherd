/**
 * Research Session — autonomous iteration loop inspired by Karpathy's autoresearch pattern.
 *
 * Loop: propose experiment → execute via EvalRunner → evaluate → track champion → iterate.
 * Builds on the eval harness + champion tracking pattern from quant-algos research.
 */

import { logInfo, logError } from "../logger.js";
import type { EvalRunner } from "./eval-runner.js";
import type { EvalScenario, EvalResult } from "./types.js";
import { callLLMForJSON, type LLMCallerConfig } from "../llm/caller.js";

// ── Types ──

export interface ExperimentConfig {
  /** Human-readable label for this experiment (e.g. "sonnet-fast-skip-browser"). */
  label: string;
  /** Rationale from the LLM for why this config was proposed. */
  rationale: string;
  /** Env var overrides (e.g. DEFAULT_LLM_MODEL, AGENT_TIMEOUT_SECONDS). */
  configOverrides: Record<string, string>;
  /** Pipeline node IDs to skip. */
  skipNodes?: string[];
  /** Pipeline node IDs to force-enable. */
  enableNodes?: string[];
}

export interface Champion {
  label: string;
  passRate: number;
  avgScore: number;
  avgCostUsd: number;
  avgDurationMs: number;
  totalRuns: number;
  config: ExperimentConfig;
}

export interface IterationResult {
  iteration: number;
  experiment: ExperimentConfig;
  results: EvalResult[];
  champion: Champion;
  /** Whether this iteration's config became the new champion. */
  isNewChampion: boolean;
}

export interface ResearchSessionConfig {
  /** Max iterations (0 = unlimited / "never stop" mode). */
  maxIterations: number;
  /** Scenarios to run each iteration. */
  scenarios: EvalScenario[];
  /** Seed configs to try in early iterations (before LLM proposes). */
  seedConfigs?: ExperimentConfig[];
  /** LLM config for proposing experiments (required if no seedConfigs or maxIterations > seedConfigs.length). */
  llmConfig?: LLMCallerConfig;
  /** Called after each iteration with results. */
  onIteration?: (result: IterationResult) => void;
  /** AbortSignal for external cancellation. */
  signal?: AbortSignal;
}

/** Max history entries kept in memory — prevents unbounded growth in never-stop mode. */
const MAX_HISTORY_SIZE = 200;

// ── Research Session ──

export class ResearchSession {
  private champion: Champion | undefined;
  private history: IterationResult[] = [];

  constructor(
    private readonly evalRunner: EvalRunner,
  ) {}

  async run(config: ResearchSessionConfig): Promise<IterationResult[]> {
    const maxIter = config.maxIterations === 0 ? Infinity : config.maxIterations;
    if (!Number.isFinite(maxIter) && maxIter !== Infinity) {
      throw new Error(`Invalid maxIterations: ${String(config.maxIterations)}`);
    }

    // Reset state so instances can be reused across multiple run() calls
    this.champion = undefined;
    this.history = [];
    let iteration = 0;

    while (iteration < maxIter) {
      if (config.signal?.aborted) {
        logInfo("Research session aborted by signal", { iteration });
        break;
      }

      iteration++;
      logInfo("Research session: starting iteration", { iteration, maxIter: config.maxIterations });

      // 1. Get experiment config for this iteration
      let experiment: ExperimentConfig | undefined;
      try {
        experiment = await this.getExperiment(iteration, config);
      } catch (err) {
        logError("Research session: experiment proposal failed, skipping iteration", { iteration, error: String(err) });
        continue;
      }
      if (!experiment) {
        logInfo("Research session: no more experiments to propose", { iteration });
        break;
      }

      // 2. Execute all scenarios with this config
      const results = await this.executeExperiment(experiment, config.scenarios);

      // 3. Evaluate and update champion
      const iterResult = this.evaluateResults(iteration, experiment, results);
      this.history.push(iterResult);

      // Cap history to prevent unbounded memory growth in never-stop mode
      if (this.history.length > MAX_HISTORY_SIZE) {
        this.history = this.history.slice(-MAX_HISTORY_SIZE);
      }

      logInfo("Research session: iteration complete", {
        iteration,
        label: experiment.label,
        passRate: this.passRate(results),
        avgScore: this.avgScore(results),
        isNewChampion: iterResult.isNewChampion,
        championLabel: this.getChampion()?.label,
      });

      config.onIteration?.(iterResult);
    }

    return [...this.history];
  }

  getChampion(): Champion | undefined {
    return this.champion;
  }

  getHistory(): IterationResult[] {
    return [...this.history];
  }

  // ── Private ──

  private async getExperiment(
    iteration: number,
    config: ResearchSessionConfig
  ): Promise<ExperimentConfig | undefined> {
    // Use seed configs first
    if (config.seedConfigs && iteration <= config.seedConfigs.length) {
      return config.seedConfigs[iteration - 1];
    }

    // Then use LLM to propose
    if (!config.llmConfig) {
      return undefined;
    }

    return this.proposeExperiment(config);
  }

  private async proposeExperiment(config: ResearchSessionConfig): Promise<ExperimentConfig> {
    const scenarioSummary = config.scenarios
      .map((s) => `- ${s.name}: ${s.description}`)
      .join("\n");

    const historySummary = this.history.length > 0
      ? this.history.slice(-5).map((h) => {
          const pr = this.passRate(h.results);
          const as = this.avgScore(h.results);
          const cost = h.results.reduce((s, r) => s + r.costUsd, 0).toFixed(2);
          return `- "${h.experiment.label}" (pass: ${String(pr)}%, score: ${String(as)}, cost: $${cost}): ${h.experiment.rationale}`;
        }).join("\n")
      : "No previous experiments yet.";

    const championSummary = this.champion
      ? `Current champion: "${this.champion.label}" (pass: ${String(this.champion.passRate)}%, score: ${String(this.champion.avgScore)}, cost: $${this.champion.avgCostUsd.toFixed(2)})`
      : "No champion yet.";

    const { parsed } = await callLLMForJSON<ExperimentConfig>(config.llmConfig!, {
      system: [
        "You are a research experiment designer for an AI coding agent pipeline.",
        "Your job is to propose the next experiment configuration to try.",
        "Each experiment varies env overrides (models, timeouts, etc.) and pipeline node selection.",
        "",
        "Available config overrides (env vars):",
        "- DEFAULT_LLM_MODEL: The LLM model for the coding agent (e.g. anthropic/claude-sonnet-4-6, openai/gpt-4.1)",
        "- AGENT_TIMEOUT_SECONDS: Max seconds for the coding agent (default 300)",
        "- BROWSER_VERIFY_MODEL: Model for browser verification (e.g. openai/gpt-4.1-mini)",
        "",
        "Available node toggles:",
        "- skipNodes: [browser_verify, scope_judge, lint_fix, ci_wait] etc.",
        "- enableNodes: [browser_verify, scope_judge] etc.",
        "",
        "Respond with JSON: { \"label\": \"short-descriptive-name\", \"rationale\": \"why this config\", \"configOverrides\": { ... }, \"skipNodes\": [...], \"enableNodes\": [...] }",
        "",
        "Strategy: explore diverse configs early, then exploit promising directions. Vary one thing at a time to isolate effects.",
      ].join("\n"),
      userMessage: [
        "## Scenarios",
        scenarioSummary,
        "",
        "## Recent experiments",
        historySummary,
        "",
        "## Champion",
        championSummary,
        "",
        "Propose the next experiment. Pick something meaningfully different from recent attempts.",
      ].join("\n"),
      maxTokens: 512,
      timeoutMs: 30_000,
    });

    return {
      label: parsed.label ?? `auto-${String(this.history.length + 1)}`,
      rationale: parsed.rationale ?? "LLM-proposed experiment",
      configOverrides: parsed.configOverrides ?? {},
      skipNodes: parsed.skipNodes,
      enableNodes: parsed.enableNodes,
    };
  }

  private async executeExperiment(
    experiment: ExperimentConfig,
    scenarios: EvalScenario[]
  ): Promise<EvalResult[]> {
    // Merge experiment overrides into each scenario
    const augmented = scenarios.map((s) => ({
      ...s,
      configOverrides: { ...s.configOverrides, ...experiment.configOverrides },
      skipNodes: experiment.skipNodes ?? s.skipNodes,
      enableNodes: experiment.enableNodes ?? s.enableNodes,
    }));

    return this.evalRunner.runAll(augmented, experiment.label);
  }

  private evaluateResults(
    iteration: number,
    experiment: ExperimentConfig,
    results: EvalResult[]
  ): IterationResult {
    const passRate = this.passRate(results);
    const avgScore = this.avgScore(results);
    const avgCostUsd = results.length > 0
      ? results.reduce((s, r) => s + r.costUsd, 0) / results.length
      : 0;
    const avgDurationMs = results.length > 0
      ? Math.round(results.reduce((s, r) => s + r.durationMs, 0) / results.length)
      : 0;

    const candidate: Champion = {
      label: experiment.label,
      passRate,
      avgScore,
      avgCostUsd,
      avgDurationMs,
      totalRuns: results.length,
      config: experiment,
    };

    // Skip champion update when no results — empty runs shouldn't crown a champion
    const isNewChampion = results.length > 0 && this.isBetter(candidate, this.champion);
    if (isNewChampion) {
      this.champion = candidate;
    }

    return { iteration, experiment, results, champion: this.champion!, isNewChampion };
  }

  /**
   * Champion selection: higher pass rate wins. Ties broken by higher avg score,
   * then lower cost (efficiency).
   */
  private isBetter(candidate: Champion, current: Champion | undefined): boolean {
    if (!current) return true;
    if (candidate.passRate > current.passRate) return true;
    if (candidate.passRate < current.passRate) return false;
    if (candidate.avgScore > current.avgScore) return true;
    if (candidate.avgScore < current.avgScore) return false;
    return candidate.avgCostUsd < current.avgCostUsd;
  }

  private passRate(results: EvalResult[]): number {
    if (results.length === 0) return 0;
    return Math.round((results.filter((r) => r.overallPass).length / results.length) * 100);
  }

  private avgScore(results: EvalResult[]): number {
    if (results.length === 0) return 0;
    return Math.round(results.reduce((s, r) => s + r.overallScore, 0) / results.length);
  }
}
