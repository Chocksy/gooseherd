/**
 * Eval Store — Drizzle CRUD for eval_results table.
 */

import { eq, desc, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { evalResults } from "../db/schema.js";
import type { EvalResult, JudgeVerdict } from "./types.js";

type EvalRow = typeof evalResults.$inferSelect;

function rowToResult(row: EvalRow): EvalResult & { id: number; createdAt: string } {
  return {
    id: row.id,
    scenarioName: row.scenarioName,
    runId: row.runId,
    configLabel: row.configLabel ?? undefined,
    pipeline: row.pipeline ?? undefined,
    model: row.model ?? undefined,
    overallPass: row.overallPass,
    overallScore: row.overallScore,
    judgeResults: row.judgeResults as JudgeVerdict[],
    durationMs: row.durationMs,
    costUsd: Number(row.costUsd),
    tags: row.tags ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

export class EvalStore {
  constructor(private readonly db: Database) {}

  async recordResult(result: EvalResult): Promise<void> {
    await this.db.insert(evalResults).values({
      scenarioName: result.scenarioName,
      runId: result.runId,
      configLabel: result.configLabel,
      pipeline: result.pipeline,
      model: result.model,
      overallPass: result.overallPass,
      overallScore: result.overallScore,
      judgeResults: result.judgeResults,
      durationMs: result.durationMs,
      costUsd: String(result.costUsd),
      tags: result.tags,
    });
  }

  async getScenarioHistory(scenarioName: string, limit = 20) {
    const rows = await this.db
      .select()
      .from(evalResults)
      .where(eq(evalResults.scenarioName, scenarioName))
      .orderBy(desc(evalResults.createdAt))
      .limit(limit);

    return rows.map(rowToResult);
  }

  async getRecentResults(limit = 50) {
    const rows = await this.db
      .select()
      .from(evalResults)
      .orderBy(desc(evalResults.createdAt))
      .limit(limit);

    return rows.map(rowToResult);
  }

  async getComparison(scenarioName: string) {
    const rows = await this.db
      .select({
        configLabel: evalResults.configLabel,
        model: evalResults.model,
        totalRuns: sql<number>`count(*)::int`,
        passCount: sql<number>`count(*) filter (where overall_pass = true)::int`,
        avgScore: sql<number>`coalesce(avg(overall_score)::int, 0)`,
        avgCostUsd: sql<number>`coalesce(avg(cost_usd::float), 0)`,
        avgDurationMs: sql<number>`coalesce(avg(duration_ms)::int, 0)`,
      })
      .from(evalResults)
      .where(eq(evalResults.scenarioName, scenarioName))
      .groupBy(evalResults.configLabel, evalResults.model);

    return rows.map((r) => ({
      configLabel: r.configLabel,
      model: r.model,
      totalRuns: r.totalRuns,
      passRate: Math.round((r.passCount / r.totalRuns) * 100),
      avgScore: r.avgScore,
      avgCostUsd: r.avgCostUsd,
      avgDurationMs: r.avgDurationMs,
    }));
  }
}
