/**
 * Eval Runner — orchestrates scenario execution:
 *   enqueue run → wait for completion → read checkpoint → run judges → store result.
 */

import { logInfo, logError } from "../logger.js";
import type { RunManager } from "../run-manager.js";
import type { LLMCallerConfig } from "../llm/caller.js";
import type { EvalStore } from "./eval-store.js";
import type { EvalScenario, EvalResult } from "./types.js";
import { runAllJudges, readDiff, readCheckpoint } from "./judges.js";

const EVAL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export class EvalRunner {
  constructor(
    private readonly runManager: RunManager,
    private readonly evalStore: EvalStore,
    private readonly llmConfig: LLMCallerConfig | undefined,
    private readonly workRoot: string,
  ) {}

  async runScenario(scenario: EvalScenario, configLabel?: string): Promise<EvalResult> {
    const startMs = Date.now();

    // Apply config overrides temporarily
    const savedEnv: Record<string, string | undefined> = {};
    if (scenario.configOverrides) {
      for (const [key, value] of Object.entries(scenario.configOverrides)) {
        savedEnv[key] = process.env[key];
        process.env[key] = value;
      }
    }

    try {
      // Enqueue run with eval channel (suppresses Slack)
      const threadTs = `eval-${scenario.name}-${String(Date.now())}`;
      const run = await this.runManager.enqueueRun({
        repoSlug: scenario.repo,
        task: scenario.task,
        baseBranch: scenario.baseBranch,
        requestedBy: "eval-harness",
        channelId: "eval",
        threadTs,
        runtime: "local",
        pipelineHint: scenario.pipeline,
        skipNodes: scenario.skipNodes,
        enableNodes: scenario.enableNodes,
      });

      logInfo("Eval: run enqueued", { scenario: scenario.name, runId: run.id });

      // Wait for run to reach terminal state via callback
      const terminalStatus = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Eval timeout: run ${run.id} did not complete within 30 minutes`));
        }, EVAL_TIMEOUT_MS);
        timeout.unref?.();

        this.runManager.onRunTerminal((runId, status) => {
          if (runId === run.id) {
            clearTimeout(timeout);
            resolve(status);
          }
        });
      });

      logInfo("Eval: run completed", { scenario: scenario.name, runId: run.id, status: terminalStatus });

      // Fetch final run state
      const finalRun = await this.runManager.getRun(run.id);
      if (!finalRun) {
        throw new Error(`Run ${run.id} not found after completion`);
      }

      // Read checkpoint + diff
      const checkpointData = await readCheckpoint(this.workRoot, run.id);
      const diff = await readDiff(this.workRoot, run.id, scenario.baseBranch);

      // Run judges
      const verdicts = await runAllJudges(scenario.judges, {
        run: finalRun,
        checkpointData,
        diff,
        workRoot: this.workRoot,
        llmConfig: this.llmConfig,
      });

      const durationMs = Date.now() - startMs;
      const overallPass = verdicts.every((v) => v.pass);
      const overallScore = verdicts.length > 0
        ? Math.round(verdicts.reduce((sum, v) => sum + v.score, 0) / verdicts.length)
        : 0;

      const model = scenario.configOverrides?.DEFAULT_LLM_MODEL ?? process.env.DEFAULT_LLM_MODEL;

      const result: EvalResult = {
        scenarioName: scenario.name,
        runId: run.id,
        configLabel,
        pipeline: scenario.pipeline,
        model,
        overallPass,
        overallScore,
        judgeResults: verdicts,
        durationMs,
        costUsd: finalRun.tokenUsage?.costUsd ?? 0,
        tags: scenario.tags,
      };

      await this.evalStore.recordResult(result);
      return result;
    } finally {
      // Restore original env vars
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  }

  async runAll(scenarios: EvalScenario[], configLabel?: string): Promise<EvalResult[]> {
    const results: EvalResult[] = [];
    for (const scenario of scenarios) {
      try {
        const result = await this.runScenario(scenario, configLabel);
        results.push(result);
      } catch (error) {
        const msg = error instanceof Error ? error.message : "unknown";
        logError("Eval scenario failed", { scenario: scenario.name, error: msg });
        results.push({
          scenarioName: scenario.name,
          runId: "",
          configLabel,
          overallPass: false,
          overallScore: 0,
          judgeResults: [{ judge: "runner", pass: false, score: 0, reason: msg }],
          durationMs: 0,
          costUsd: 0,
          tags: scenario.tags,
        });
      }
    }
    return results;
  }
}
