/**
 * CI monitoring pure logic — aggregate check conclusions, build fix prompts.
 *
 * Pure functions, no side effects, testable without GitHub API.
 */

import type { CICheckRun, CICheckAnnotation } from "../../github.js";

// ── Types ──

export type CIConclusion =
  | "success"
  | "failure"
  | "pending"
  | "no_ci"
  | "cancelled";

export interface CIAnnotation {
  file: string;
  line: number;
  message: string;
  level: string;
}

export interface CICheckSummary {
  name: string;
  status: string;
  conclusion: string | null;
  annotations: CIAnnotation[];
}

export interface CIPollResult {
  conclusion: CIConclusion;
  checkRuns: CICheckSummary[];
  hasChecks: boolean;
}

// Conclusions that count as "passing"
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
// Conclusions that count as "failing"
const FAILING_CONCLUSIONS = new Set(["failure", "timed_out", "action_required"]);

// ── Pure logic functions ──

/**
 * Aggregate GitHub check run conclusions into a single CIConclusion.
 *
 * - All passing → "success"
 * - Any failing → "failure"
 * - All cancelled → "cancelled"
 * - Any still in progress → "pending"
 * - Empty array → "no_ci"
 */
export function aggregateConclusions(checkRuns: CICheckRun[]): CIConclusion {
  if (checkRuns.length === 0) {
    return "no_ci";
  }

  // Any still running?
  const inProgress = checkRuns.some(cr => cr.status !== "completed");
  if (inProgress) {
    return "pending";
  }

  // Check conclusions
  const hasFailure = checkRuns.some(cr =>
    cr.conclusion !== null && FAILING_CONCLUSIONS.has(cr.conclusion)
  );
  if (hasFailure) {
    return "failure";
  }

  // All cancelled?
  const allCancelled = checkRuns.every(cr => cr.conclusion === "cancelled");
  if (allCancelled) {
    return "cancelled";
  }

  // Check if all are passing (success/neutral/skipped/cancelled mix)
  const allPassing = checkRuns.every(cr =>
    cr.conclusion !== null && (PASSING_CONCLUSIONS.has(cr.conclusion) || cr.conclusion === "cancelled")
  );
  if (allPassing) {
    return "success";
  }

  // Completed runs with null conclusion — treat as failure (fail-secure)
  const hasNullConclusion = checkRuns.some(cr =>
    cr.status === "completed" && cr.conclusion === null
  );
  if (hasNullConclusion) {
    return "failure";
  }

  // Unknown state — treat as pending
  return "pending";
}

/**
 * Filter check runs by name against a filter list.
 * Empty filter = include all.
 */
export function filterCheckRuns(checkRuns: CICheckRun[], filter: string[]): CICheckRun[] {
  if (filter.length === 0) {
    return checkRuns;
  }
  return checkRuns.filter(cr =>
    filter.some(f => cr.name.toLowerCase().includes(f.toLowerCase()))
  );
}

/**
 * Convert GitHub check annotations to our CIAnnotation format.
 */
export function mapAnnotations(ghAnnotations: CICheckAnnotation[]): CIAnnotation[] {
  return ghAnnotations.map(a => ({
    file: a.path,
    line: a.start_line,
    message: a.message,
    level: a.annotation_level
  }));
}

/**
 * Truncate log output to the last N characters.
 */
export function truncateLog(log: string, maxChars: number = 3000): string {
  if (log.length <= maxChars) {
    return log;
  }
  return "...(truncated)\n" + log.slice(-maxChars);
}

/**
 * Build a structured fix prompt for the CI fix agent.
 */
export function buildCIFixPrompt(
  annotations: CIAnnotation[],
  logTail: string,
  changedFiles: string[]
): string {
  const lines: string[] = [
    "CI has failed on your PR. Fix the following failures only.",
    ""
  ];

  if (annotations.length > 0) {
    lines.push("## Check Run Annotations", "");
    for (const a of annotations) {
      lines.push(`- ${a.file}:${String(a.line)} — ${a.message}`);
    }
    lines.push("");
  }

  if (logTail.trim()) {
    lines.push("## Failed Job Log (last 3000 chars)", "");
    lines.push("```", logTail, "```", "");
  }

  if (changedFiles.length > 0) {
    lines.push("## Your Changed Files", "");
    for (const f of changedFiles) {
      lines.push(`- ${f}`);
    }
    lines.push("");
  }

  lines.push(
    "## Instructions",
    "",
    "- Fix only the CI failures shown above",
    "- Do not refactor unrelated code",
    "- Do not change test expectations unless the test is wrong"
  );

  return lines.join("\n");
}

/**
 * Safety check: if current CI attempt has MORE failures than previous, abort.
 * Returns true if fix loop should be aborted.
 */
export function shouldAbortFixLoop(
  prevFailCount: number,
  currentFailCount: number
): boolean {
  return currentFailCount > prevFailCount && prevFailCount > 0;
}
