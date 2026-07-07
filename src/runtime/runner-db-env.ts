/**
 * Env-var helpers for the per-Run DB slot pool (PG/CH/Redis isolation
 * for runner Runs that need an isolated test DB). The orchestrator uses
 * these connection URLs to provision/teardown per-slot databases, and
 * the same connection info is reused to template runner-pod env-vars.
 */

const DEFAULT_POOL_SIZE = 16;
/** First reserved index — keep 0/1 free for system use. */
export const SLOT_ID_OFFSET = 2;

export function resolveRunnerDbPoolSize(): number {
  const raw = process.env.KUBERNETES_RUNNER_POOL_SIZE?.trim();
  if (!raw) return DEFAULT_POOL_SIZE;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) return DEFAULT_POOL_SIZE;
  return parsed;
}

export interface RunnerDbUrls {
  pg?: string;
  clickhouse?: string;
  redis?: string;
}

export function resolveRunnerDbUrls(): RunnerDbUrls {
  return {
    pg: process.env.RUNNER_DB_PG_URL?.trim() || undefined,
    clickhouse: process.env.RUNNER_DB_CH_URL?.trim() || undefined,
    redis: process.env.RUNNER_DB_REDIS_URL?.trim() || undefined,
  };
}
