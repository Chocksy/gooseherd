/**
 * Per-repo configuration — reads .gooseherd.yml from the repo root.
 *
 * Security model:
 * - Config is loaded from the BASE BRANCH (not working branch) to prevent
 *   a malicious PR from relaxing its own quality gates.
 * - Deployment-level deny patterns CANNOT be relaxed by repo config.
 * - Repo config can add guarded files but NOT remove deny patterns.
 * - Quality gate thresholds cannot be lowered below deployment minimums.
 */

import { parse as parseYaml } from "yaml";
import { logInfo, logError } from "../logger.js";
import { runShellCapture, shellEscape } from "./shell.js";

export interface RepoQualityGateOverrides {
  diff_size?: {
    profile?: string;
  };
  forbidden_files?: {
    guarded_additions?: string[];
  };
  scope_judge?: {
    enabled?: boolean;
  };
  browser_verify?: {
    enabled?: boolean;
    review_app_url?: string;
  };
}

export interface RepoConfig {
  pipeline?: string;
  qualityGates?: RepoQualityGateOverrides;
}

/**
 * Load .gooseherd.yml from the base branch (not working branch).
 *
 * Uses `git show <baseBranch>:.gooseherd.yml` to read from the remote
 * base branch, preventing malicious PRs from modifying their own config.
 *
 * @returns RepoConfig or null if not found/invalid.
 */
export async function loadRepoConfig(
  repoDir: string,
  baseBranch: string
): Promise<RepoConfig | null> {
  // Try to read from base branch first (security: prevent working branch manipulation)
  // shellEscape the ref to prevent command injection via crafted branch names
  const ref = `origin/${baseBranch}`;
  const result = await runShellCapture(
    `git show ${shellEscape(`${ref}:.gooseherd.yml`)} 2>/dev/null`,
    { cwd: repoDir, logFile: "/dev/null" }
  );

  if (result.code !== 0 || !result.stdout.trim()) {
    // No repo config found — this is normal
    return null;
  }

  try {
    const parsed = parseYaml(result.stdout);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    return validateRepoConfig(parsed as Record<string, unknown>);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    logError("Failed to parse .gooseherd.yml", { error: msg });
    return null;
  }
}

/**
 * Validate and sanitize repo config.
 * Only allows known fields with expected types.
 */
function validateRepoConfig(raw: Record<string, unknown>): RepoConfig {
  const config: RepoConfig = {};

  // Pipeline override
  if (typeof raw["pipeline"] === "string" && raw["pipeline"].trim()) {
    // Only allow simple alphanumeric pipeline names (prevent path traversal)
    const name = raw["pipeline"].trim();
    if (/^[a-zA-Z0-9_-]+$/.test(name)) {
      config.pipeline = name;
    }
  }

  // Quality gate overrides
  if (raw["quality_gates"] && typeof raw["quality_gates"] === "object") {
    const gates = raw["quality_gates"] as Record<string, unknown>;
    config.qualityGates = {};

    // Diff size profile override
    if (gates["diff_size"] && typeof gates["diff_size"] === "object") {
      const ds = gates["diff_size"] as Record<string, unknown>;
      const validProfiles = ["bugfix", "feature", "refactor", "chore"];
      if (typeof ds["profile"] === "string" && validProfiles.includes(ds["profile"])) {
        config.qualityGates.diff_size = { profile: ds["profile"] };
      }
    }

    // Forbidden files — can only ADD guarded patterns, never remove deny patterns
    if (gates["forbidden_files"] && typeof gates["forbidden_files"] === "object") {
      const ff = gates["forbidden_files"] as Record<string, unknown>;
      if (Array.isArray(ff["guarded_additions"])) {
        const additions = (ff["guarded_additions"] as unknown[])
          .filter((v): v is string => typeof v === "string")
          .filter(v => v.trim().length > 0);
        if (additions.length > 0) {
          config.qualityGates.forbidden_files = { guarded_additions: additions };
        }
      }
    }

    // Scope judge — can enable but not configure model (deployment-level only)
    if (gates["scope_judge"] && typeof gates["scope_judge"] === "object") {
      const sj = gates["scope_judge"] as Record<string, unknown>;
      if (typeof sj["enabled"] === "boolean") {
        config.qualityGates.scope_judge = { enabled: sj["enabled"] };
      }
    }

    // Browser verify
    if (gates["browser_verify"] && typeof gates["browser_verify"] === "object") {
      const bv = gates["browser_verify"] as Record<string, unknown>;
      const entry: RepoQualityGateOverrides["browser_verify"] = {};
      if (typeof bv["enabled"] === "boolean") entry.enabled = bv["enabled"];
      if (typeof bv["review_app_url"] === "string") entry.review_app_url = bv["review_app_url"];
      if (Object.keys(entry).length > 0) {
        config.qualityGates.browser_verify = entry;
      }
    }
  }

  return config;
}

/**
 * Apply repo config overrides to the context bag.
 * Called after clone, before quality gate nodes execute.
 */
export function applyRepoConfig(
  repoConfig: RepoConfig,
  ctx: { set: (key: string, value: unknown) => void; get: <T>(key: string) => T | undefined }
): void {
  if (repoConfig.qualityGates?.diff_size?.profile) {
    ctx.set("repoConfigDiffProfile", repoConfig.qualityGates.diff_size.profile);
  }

  if (repoConfig.qualityGates?.forbidden_files?.guarded_additions) {
    const existing = ctx.get<string[]>("repoGuardedFiles") ?? [];
    ctx.set("repoGuardedFiles", [
      ...existing,
      ...repoConfig.qualityGates.forbidden_files.guarded_additions
    ]);
  }

  if (repoConfig.qualityGates?.scope_judge?.enabled !== undefined) {
    ctx.set("repoScopeJudgeEnabled", repoConfig.qualityGates.scope_judge.enabled);
  }

  if (repoConfig.qualityGates?.browser_verify) {
    if (repoConfig.qualityGates.browser_verify.enabled !== undefined) {
      ctx.set("repoBrowserVerifyEnabled", repoConfig.qualityGates.browser_verify.enabled);
    }
    if (repoConfig.qualityGates.browser_verify.review_app_url) {
      ctx.set("reviewAppUrl", repoConfig.qualityGates.browser_verify.review_app_url);
    }
  }

  logInfo("Repo config applied", { pipeline: repoConfig.pipeline, gates: repoConfig.qualityGates });
}
