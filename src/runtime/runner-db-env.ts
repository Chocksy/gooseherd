/**
 * Env-var helpers for the per-Run DB slot pool (PG/CH/Redis isolation
 * for hubstaff-server RSpec runs). Admin URLs grant DDL/FLUSHDB to the
 * orchestrator; the same connection info is reused to template runner-pod
 * env-vars (admin = test cluster owner in v1).
 */

const DEFAULT_POOL_SIZE = 16;
/** First reserved index — keep 0/1 free for system use. */
export const SLOT_ID_OFFSET = 2;

export function resolveRunnerDbPoolSize(): number {
  const raw = process.env.KUBERNETES_RUNNER_DB_POOL_SIZE?.trim();
  if (!raw) return DEFAULT_POOL_SIZE;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) return DEFAULT_POOL_SIZE;
  return parsed;
}

export interface RunnerDbAdminUrls {
  pg?: string;
  clickhouse?: string;
  redis?: string;
}

export function resolveRunnerDbAdminUrls(profileSuffix: string): RunnerDbAdminUrls {
  const suffix = profileSuffix.toUpperCase();
  return {
    pg: process.env[`RUNNER_DB_PG_ADMIN_URL_${suffix}`]?.trim() || undefined,
    clickhouse: process.env[`RUNNER_DB_CH_ADMIN_URL_${suffix}`]?.trim() || undefined,
    redis: process.env[`RUNNER_DB_REDIS_URL_${suffix}`]?.trim() || undefined,
  };
}
