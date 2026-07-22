#!/usr/bin/env npx tsx
/**
 * CLI entry point for the eval harness.
 *
 * Usage:
 *   npm run eval -- --scenario evals/homepage-title.yml
 *   npm run eval -- --dir evals/
 *   npm run eval -- --tag ui
 *   npm run eval -- --scenario evals/homepage-title.yml --label "sonnet-test"
 *
 * Research mode (autonomous iteration):
 *   npm run eval -- --research --iterations 5
 *   npm run eval -- --research --iterations 0   # "never stop" mode
 *   npm run eval -- --research --dir evals/ --tag ui --iterations 10
 */

import dotenv from "dotenv";
dotenv.config();

import path from "node:path";
import { loadConfig } from "../src/config.js";
import { initDatabase } from "../src/db/index.js";
import { RunStore } from "../src/store.js";
import { RunManager } from "../src/run-manager.js";
import { EvalStore } from "../src/eval/eval-store.js";
import { EvalRunner } from "../src/eval/eval-runner.js";
import { loadScenario, loadScenariosFromDir, filterByTag } from "../src/eval/scenario-loader.js";
import { ResearchSession } from "../src/eval/research-session.js";
import type { EvalResult } from "../src/eval/types.js";
import type { LLMCallerConfig } from "../src/llm/caller.js";

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[arg.slice(2)] = next;
        i++;
      } else {
        flags.add(arg.slice(2));
      }
    }
  }
  return { args, flags };
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${String(min)}m ${String(sec).padStart(2, "0")}s` : `${String(sec)}s`;
}

function printResults(results: EvalResult[]): void {
  const now = new Date().toISOString();
  console.log(`\nEval Results — ${now}\n`);

  // Header
  const cols = { scenario: 24, result: 8, score: 7, duration: 10, cost: 8, judges: 9 };
  const header = [
    "Scenario".padEnd(cols.scenario),
    "Result".padEnd(cols.result),
    "Score".padEnd(cols.score),
    "Duration".padEnd(cols.duration),
    "Cost".padEnd(cols.cost),
    "Judges".padEnd(cols.judges),
  ].join(" | ");

  const separator = Object.values(cols).map((w) => "-".repeat(w)).join("-+-");

  console.log(header);
  console.log(separator);

  for (const r of results) {
    const passedJudges = r.judgeResults.filter((j) => j.pass).length;
    const totalJudges = r.judgeResults.length;
    const line = [
      r.scenarioName.slice(0, cols.scenario).padEnd(cols.scenario),
      (r.overallPass ? "PASS" : "FAIL").padEnd(cols.result),
      String(r.overallScore).padEnd(cols.score),
      formatDuration(r.durationMs).padEnd(cols.duration),
      `$${r.costUsd.toFixed(2)}`.padEnd(cols.cost),
      `${String(passedJudges)}/${String(totalJudges)}`.padEnd(cols.judges),
    ].join(" | ");
    console.log(line);
  }

  console.log(separator);

  const totalPassed = results.filter((r) => r.overallPass).length;
  const avgScore = results.length > 0
    ? Math.round(results.reduce((s, r) => s + r.overallScore, 0) / results.length)
    : 0;
  const totalCost = results.reduce((s, r) => s + r.costUsd, 0);
  const totalDuration = results.reduce((s, r) => s + r.durationMs, 0);

  console.log(
    `\nTotal: ${String(totalPassed)}/${String(results.length)} passed | Avg score: ${String(avgScore)} | Cost: $${totalCost.toFixed(2)} | Time: ${formatDuration(totalDuration)}`
  );
}

/** Benchmark category tags — a result belongs to a category if it carries the tag. */
const BENCHMARK_CATEGORIES = ["delivery", "exploration", "clarification", "scope"] as const;

/**
 * Print a per-category summary table (category → scenarios, passed, avg score).
 * Aggregates from the in-memory results by the benchmark category tags. Only
 * prints when more than one scenario ran and at least one carries a category tag.
 */
function printCategorySummary(results: EvalResult[]): void {
  if (results.length <= 1) return;

  const rows = BENCHMARK_CATEGORIES.map((category) => {
    const inCategory = results.filter((r) => r.tags?.includes(category));
    const passed = inCategory.filter((r) => r.overallPass).length;
    const avgScore = inCategory.length > 0
      ? Math.round(inCategory.reduce((s, r) => s + r.overallScore, 0) / inCategory.length)
      : 0;
    return { category, scenarios: inCategory.length, passed, avgScore };
  }).filter((row) => row.scenarios > 0);

  if (rows.length === 0) return;

  const cols = { category: 14, scenarios: 10, passed: 8, score: 9 };
  const header = [
    "Category".padEnd(cols.category),
    "Scenarios".padEnd(cols.scenarios),
    "Passed".padEnd(cols.passed),
    "Avg Score".padEnd(cols.score),
  ].join(" | ");
  const separator = Object.values(cols).map((w) => "-".repeat(w)).join("-+-");

  console.log("\nPer-category summary\n");
  console.log(header);
  console.log(separator);
  for (const row of rows) {
    console.log([
      row.category.padEnd(cols.category),
      String(row.scenarios).padEnd(cols.scenarios),
      `${String(row.passed)}/${String(row.scenarios)}`.padEnd(cols.passed),
      String(row.avgScore).padEnd(cols.score),
    ].join(" | "));
  }
  console.log(separator);
}

async function main() {
  const { args, flags } = parseArgs(process.argv.slice(2));

  // Load scenarios
  let scenarios: import("../src/eval/types.js").EvalScenario[] = [];
  if (args.scenario) {
    scenarios.push(await loadScenario(path.resolve(args.scenario)));
  } else if (args.dir) {
    scenarios = await loadScenariosFromDir(path.resolve(args.dir));
  } else {
    // Default: load all from evals/
    scenarios = await loadScenariosFromDir(path.resolve("evals"));
  }

  if (args.tag) {
    scenarios = filterByTag(scenarios, args.tag);
  }

  if (scenarios.length === 0) {
    console.error("No scenarios found. Check --scenario, --dir, or --tag arguments.");
    process.exit(1);
  }

  console.log(`Loading ${String(scenarios.length)} scenario(s)...`);

  // Init database (shared across scenarios)
  const config = loadConfig();
  const db = await initDatabase(config.databaseUrl);

  // Shared eval store (results DB)
  const evalStore = new EvalStore(db);

  // Dynamic imports (avoid circular deps + defer heavy backend modules).
  const { PipelineEngine: PE } = await import("../src/pipeline/pipeline-engine.js");
  const { LocalExecutionBackend } = await import("../src/runtime/local-backend.js");
  const { DockerExecutionBackend } = await import("../src/runtime/docker-backend.js");

  const buildLlmConfig = (cfg: import("../src/config.js").AppConfig): LLMCallerConfig | undefined => {
    const apiKey = cfg.openrouterApiKey ?? cfg.anthropicApiKey ?? cfg.openaiApiKey;
    return apiKey
      ? {
          apiKey,
          defaultModel: cfg.defaultLlmModel,
          defaultTimeoutMs: 30_000,
          providerPreferences: cfg.openrouterProviderPreferences,
        }
      : undefined;
  };

  // Per-scenario context factory: reloads config from the (override-mutated)
  // process.env each call, so scenario config_overrides such as
  // AGENT_COMMAND_TEMPLATE / DEFAULT_LLM_MODEL actually reach the agent + judges.
  // Evals run in-process and sequentially, so only local/docker backends are
  // registered — no kubernetes.
  //
  // Cost note: this constructs a fresh engine, runtime backends, and RunManager
  // for every scenario. That is the price of per-scenario config reload (correct,
  // but adds startup overhead across the 10-scenario suite — see docs/benchmark.md).
  const buildContext = async () => {
    const scenarioConfig = loadConfig();
    const runStore = new RunStore(db);
    const pipelineEngine = new PE(scenarioConfig);
    const runtimeRegistry: import("../src/runtime/backend.js").RuntimeRegistry = {
      local: new LocalExecutionBackend(pipelineEngine),
      docker: new DockerExecutionBackend(pipelineEngine),
      kubernetes: undefined,
    };
    const runManager = new RunManager(scenarioConfig, runStore, runtimeRegistry, undefined);
    return {
      runManager,
      llmConfig: buildLlmConfig(scenarioConfig),
      workRoot: scenarioConfig.workRoot,
    };
  };

  // LLM config for research proposals (uses base env, not per-scenario overrides).
  const llmConfig = buildLlmConfig(config);

  const runner = new EvalRunner(evalStore, buildContext);

  // ── Research mode ──
  if (flags.has("research")) {
    const parsed = args.iterations ? Number.parseInt(args.iterations, 10) : 5;
    if (Number.isNaN(parsed) || parsed < 0) {
      console.error(`Invalid --iterations value: "${args.iterations}". Must be a non-negative integer.`);
      process.exit(1);
    }
    const maxIterations = parsed;

    if (!llmConfig) {
      console.error("Research mode requires an API key (OPENROUTER_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY).");
      process.exit(1);
    }

    console.log(`Starting research session: ${String(maxIterations || "unlimited")} iterations × ${String(scenarios.length)} scenarios`);

    const abortController = new AbortController();
    process.on("SIGINT", () => {
      console.log("\nReceived SIGINT — finishing current iteration...");
      abortController.abort();
    });

    const session = new ResearchSession(runner);
    const history = await session.run({
      maxIterations,
      scenarios,
      llmConfig,
      signal: abortController.signal,
      onIteration: (result) => {
        console.log(`\n── Iteration ${String(result.iteration)} ──`);
        console.log(`Experiment: ${result.experiment.label}`);
        console.log(`Rationale: ${result.experiment.rationale}`);
        printResults(result.results);
        console.log(`Champion: ${result.champion.label} (pass: ${String(result.champion.passRate)}%, score: ${String(result.champion.avgScore)}, cost: $${result.champion.avgCostUsd.toFixed(2)})`);
        if (result.isNewChampion) {
          console.log("*** NEW CHAMPION ***");
        }
      },
    });

    const champion = session.getChampion();
    console.log("\n═══════════════════════════════════════");
    console.log("RESEARCH SESSION COMPLETE");
    console.log(`Iterations: ${String(history.length)}`);
    if (champion) {
      console.log(`Champion: ${champion.label}`);
      console.log(`  Pass rate: ${String(champion.passRate)}%`);
      console.log(`  Avg score: ${String(champion.avgScore)}`);
      console.log(`  Avg cost: $${champion.avgCostUsd.toFixed(2)}`);
      console.log(`  Config: ${JSON.stringify(champion.config.configOverrides)}`);
    }
    console.log("═══════════════════════════════════════");
    process.exit(0);
  }

  // ── Standard eval mode ──
  const results = await runner.runAll(scenarios, args.label);
  printResults(results);
  printCategorySummary(results);

  const allPass = results.every((r) => r.overallPass);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error("Eval runner failed:", err);
  process.exit(1);
});
