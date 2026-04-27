import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { appendLog, runShellCapture, shellEscape } from "../shell.js";

interface LightweightCheck {
  id: string;
  label: string;
  matches: (file: string) => boolean;
  buildCommand: (file: string) => string;
}

const LIGHTWEIGHT_CHECKS: LightweightCheck[] = [
  {
    id: "ruby",
    label: "Ruby syntax",
    matches: (file) => file.endsWith(".rb"),
    buildCommand: (file) => `ruby -c ${shellEscape(file)}`,
  },
  {
    id: "javascript",
    label: "JavaScript syntax",
    matches: (file) => /\.(?:cjs|mjs|js)$/.test(file),
    buildCommand: (file) => `node --check ${shellEscape(file)}`,
  },
];

/**
 * Lightweight checks gate: run cheap syntax/smoke checks for changed files.
 *
 * Uses a temporary git add/reset cycle so untracked files are included.
 */
export async function lightweightChecksNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const repoDir = ctx.getRequired<string>("repoDir");
  const logFile = deps.logFile;

  await deps.onPhase("validating");

  const changedFiles = await detectChangedFiles(repoDir, logFile);
  const scheduledChecks = LIGHTWEIGHT_CHECKS.flatMap((check) =>
    changedFiles
      .filter((file) => check.matches(file))
      .map((file) => ({ check, file }))
  );

  if (scheduledChecks.length === 0) {
    await appendLog(logFile, "\n[pipeline] lightweight_checks: skipped (no matching changed files)\n");
    return { outcome: "skipped" };
  }

  await appendLog(
    logFile,
    `\n[pipeline] lightweight_checks: checking ${String(scheduledChecks.length)} file(s) across ${String(new Set(scheduledChecks.map(({ check }) => check.id)).size)} checker(s)\n`
  );

  for (const { check, file } of scheduledChecks) {
    const result = await runShellCapture(check.buildCommand(file), {
      cwd: repoDir,
      logFile
    });

    if (result.code !== 0) {
      await appendLog(logFile, `\n[pipeline] lightweight_checks: failed for ${file} (${check.id})\n`);
      return {
        outcome: "failure",
        error: `${check.label} check failed for ${file}`,
        rawOutput: `${result.stdout}${result.stderr}`.slice(-2000)
      };
    }
  }

  await appendLog(logFile, "\n[pipeline] lightweight_checks: passed\n");
  return { outcome: "success" };
}

async function detectChangedFiles(repoDir: string, logFile: string): Promise<string[]> {
  await runShellCapture("git add -A", { cwd: repoDir, logFile });
  try {
    const result = await runShellCapture(
      "git diff --cached --name-only --diff-filter=ACMR HEAD",
      { cwd: repoDir, logFile }
    );
    if (result.code !== 0 || !result.stdout.trim()) {
      return [];
    }

    return result.stdout
      .trim()
      .split("\n")
      .map((file) => file.trim())
      .filter(Boolean);
  } finally {
    await runShellCapture("git reset HEAD --quiet", { cwd: repoDir, logFile });
  }
}
