/**
 * Per-repo runner profile — what image to use, whether the Run needs an
 * isolated test-DB slot, and how to template per-Run env vars from that
 * slot. Single source of truth for repo-specific runner behaviour;
 * adding a new repo means adding a new profile here, not editing
 * downstream wiring.
 */

import { logInfo } from "../logger.js";

export interface DbConnectionInfo {
  host: string;
  port: number;
  user?: string;
  password?: string;
  protocol: string;
}

export interface RunnerDbHosts {
  pg: DbConnectionInfo;
  clickhouse: DbConnectionInfo;
  redis: DbConnectionInfo;
}

export interface RunnerProfile {
  /** Env-var name that holds the image tag for this profile. */
  imageEnv: string;
  /** Suffix used for `RUNNER_DB_*_ADMIN_URL_<SUFFIX>` env-var lookup. */
  adminUrlSuffix: string;
  /** Whether the Run needs an isolated test-DB slot (PG/CH/Redis). */
  needsDbSlot: boolean;
  /** Builds env vars that the runner pod sees for this Run. */
  envTemplate?: (slot: number, hosts: RunnerDbHosts) => Record<string, string>;
}

const DEFAULT_PROFILE: RunnerProfile = {
  imageEnv: "KUBERNETES_RUNNER_IMAGE",
  adminUrlSuffix: "",
  needsDbSlot: false,
};

const HUBSTAFF_SERVER_PROFILE: RunnerProfile = {
  imageEnv: "KUBERNETES_RUNNER_IMAGE_SERVER",
  adminUrlSuffix: "SERVER",
  needsDbSlot: true,
  envTemplate: (slot, hosts) => {
    const dbName = `goose_${String(slot)}`;
    const pgUrl = formatPgUrl(hosts.pg, dbName);
    return {
      ENABLE_CLICKHOUSE: "1",
      DATABASE_URL: pgUrl,
      READER_DATABASE_URL: pgUrl,
      INTERNAL_READER_DATABASE_URL: pgUrl,
      REPORTS_READER_DATABASE_URL: pgUrl,
      DATABASE_CLEANER_ALLOW_REMOTE_DATABASE_URL: "true",
      CLICKHOUSE_URL: formatChUrl(hosts.clickhouse),
      CLICKHOUSE_DATABASE: dbName,
      REDIS_DEFAULT_URL: formatRedisUrl(hosts.redis, slot),
      REDIS_INTERNAL_URL: formatRedisUrl(hosts.redis, slot),
    };
  },
};

const PROFILES: Record<string, RunnerProfile> = {
  "NetsoftHoldings/hubstaff-server": HUBSTAFF_SERVER_PROFILE,
};

export function resolveRunnerProfile(repoSlug: string): RunnerProfile {
  return PROFILES[repoSlug] ?? DEFAULT_PROFILE;
}

/**
 * Backward-compat — kept so existing call sites (kubernetes-backend.execute)
 * keep working until they switch to the profile API. Reads the same env
 * map under the hood.
 */
export function resolveRunnerImage(repoSlug: string, defaultImage: string): string {
  const profile = resolveRunnerProfile(repoSlug);
  if (profile === DEFAULT_PROFILE) {
    return defaultImage;
  }
  const override = process.env[profile.imageEnv]?.trim();
  if (!override) {
    return defaultImage;
  }
  logInfo("runner-image: using repo-specific image", {
    repoSlug,
    envKey: profile.imageEnv,
    image: override,
  });
  return override;
}

function formatPgUrl(info: DbConnectionInfo, dbName: string): string {
  const auth = info.user ? `${encodeURIComponent(info.user)}${info.password ? `:${encodeURIComponent(info.password)}` : ""}@` : "";
  return `postgres://${auth}${info.host}:${String(info.port)}/${dbName}`;
}

function formatChUrl(info: DbConnectionInfo): string {
  const auth = info.user ? `${encodeURIComponent(info.user)}${info.password ? `:${encodeURIComponent(info.password)}` : ""}@` : "";
  return `${info.protocol}//${auth}${info.host}:${String(info.port)}`;
}

function formatRedisUrl(info: DbConnectionInfo, slot: number): string {
  const auth = info.user || info.password
    ? `${info.user ? encodeURIComponent(info.user) : ""}${info.password ? `:${encodeURIComponent(info.password)}` : ""}@`
    : "";
  return `${info.protocol}//${auth}${info.host}:${String(info.port)}/${String(slot)}`;
}

/**
 * Parses an admin URL into a structured connection object. Supports:
 *  - postgres://user:pass@host:5432/dbname
 *  - http(s)://user:pass@host:8123
 *  - redis://[user:pass@]host:6379
 * If the URL is missing or unparseable, returns null.
 */
export function parseDbConnectionUrl(rawUrl: string | undefined, defaultPort: number): DbConnectionInfo | null {
  if (!rawUrl) return null;
  try {
    const u = new URL(rawUrl);
    return {
      protocol: u.protocol,
      host: u.hostname,
      port: u.port ? Number.parseInt(u.port, 10) : defaultPort,
      user: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    };
  } catch {
    return null;
  }
}
