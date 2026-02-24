/**
 * Diff size gate — check lines changed and files changed against
 * profile-based thresholds.
 *
 * Pure logic, no side effects. Testable without pipeline infra.
 */

import type { TaskType } from "./task-classifier.js";

export interface DiffProfile {
  softMaxLines: number;
  hardMaxLines: number;
  softMaxFiles: number;
  hardMaxFiles: number;
}

export const DEFAULT_PROFILES: Record<TaskType, DiffProfile> = {
  bugfix:   { softMaxLines: 250,  hardMaxLines: 600,  softMaxFiles: 12, hardMaxFiles: 25 },
  feature:  { softMaxLines: 600,  hardMaxLines: 1500, softMaxFiles: 25, hardMaxFiles: 60 },
  refactor: { softMaxLines: 1000, hardMaxLines: 2500, softMaxFiles: 40, hardMaxFiles: 120 },
  chore:    { softMaxLines: 150,  hardMaxLines: 400,  softMaxFiles: 8,  hardMaxFiles: 20 }
};

export interface DiffStats {
  linesAdded: number;
  linesRemoved: number;
  totalLines: number;
  filesChanged: number;
}

export type DiffVerdict = "pass" | "soft_fail" | "hard_fail";

export interface DiffGateResult {
  verdict: DiffVerdict;
  stats: DiffStats;
  profile: TaskType;
  thresholds: DiffProfile;
  reasons: string[];
}

/**
 * Parse `git diff --numstat` output into DiffStats.
 * Each line: `<added>\t<removed>\t<filename>`
 * Binary files show `-\t-\t<filename>` — count as 1 line each.
 */
export function parseDiffNumstat(numstatOutput: string): DiffStats {
  const lines = numstatOutput.trim().split("\n").filter(l => l.length > 0);
  let linesAdded = 0;
  let linesRemoved = 0;
  let filesChanged = 0;

  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;

    filesChanged++;
    const added = parts[0]!;
    const removed = parts[1]!;

    // Binary files show "-" for both
    if (added === "-" && removed === "-") {
      linesAdded += 1;
      linesRemoved += 1;
    } else {
      linesAdded += Number(added) || 0;
      linesRemoved += Number(removed) || 0;
    }
  }

  return {
    linesAdded,
    linesRemoved,
    totalLines: linesAdded + linesRemoved,
    filesChanged
  };
}

/**
 * Evaluate diff stats against a profile's thresholds.
 */
export function evaluateDiffGate(
  stats: DiffStats,
  profileName: TaskType,
  customProfiles?: Partial<Record<TaskType, DiffProfile>>
): DiffGateResult {
  const profiles = { ...DEFAULT_PROFILES, ...customProfiles };
  const thresholds = profiles[profileName] ?? DEFAULT_PROFILES.feature;
  const reasons: string[] = [];

  let verdict: DiffVerdict = "pass";

  // Check hard limits first
  if (stats.totalLines > thresholds.hardMaxLines) {
    verdict = "hard_fail";
    reasons.push(`${String(stats.totalLines)} lines changed exceeds hard limit of ${String(thresholds.hardMaxLines)} for ${profileName}`);
  }
  if (stats.filesChanged > thresholds.hardMaxFiles) {
    verdict = "hard_fail";
    reasons.push(`${String(stats.filesChanged)} files changed exceeds hard limit of ${String(thresholds.hardMaxFiles)} for ${profileName}`);
  }

  // Check soft limits (only matters if not already hard_fail)
  if (verdict !== "hard_fail") {
    if (stats.totalLines > thresholds.softMaxLines) {
      verdict = "soft_fail";
      reasons.push(`${String(stats.totalLines)} lines changed exceeds soft limit of ${String(thresholds.softMaxLines)} for ${profileName}`);
    }
    if (stats.filesChanged > thresholds.softMaxFiles) {
      verdict = "soft_fail";
      reasons.push(`${String(stats.filesChanged)} files changed exceeds soft limit of ${String(thresholds.softMaxFiles)} for ${profileName}`);
    }
  }

  return { verdict, stats, profile: profileName, thresholds, reasons };
}
