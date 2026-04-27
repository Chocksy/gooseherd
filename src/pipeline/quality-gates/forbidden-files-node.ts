import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { checkForbiddenFiles } from "./forbidden-files.js";
import { runShellCapture, appendLog } from "../shell.js";
import { appendGateReport } from "./gate-report.js";
import { filterInternalGeneratedFiles } from "../internal-generated-files.js";

/**
 * Forbidden files gate node: check changed files against deny/guarded patterns.
 * Returns success/soft_fail/failure.
 */
export async function forbiddenFilesNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const repoDir = ctx.getRequired<string>("repoDir");
  const logFile = deps.logFile;
  const taskText = deps.run.task;

  // Get list of changed files via git diff
  const result = await runShellCapture(
    "git diff --name-only --find-renames HEAD",
    { cwd: repoDir, logFile }
  );

  if (result.code !== 0) {
    return { outcome: "failure", error: `git diff --name-only failed: ${result.stderr}` };
  }

  const changedFiles = result.stdout
    .split("\n")
    .map(f => f.trim())
    .filter(f => f.length > 0);

  const userChangedFiles = filterInternalGeneratedFiles(changedFiles);

  if (userChangedFiles.length === 0) {
    return { outcome: "success" };
  }

  const gateResult = checkForbiddenFiles(userChangedFiles, taskText);

  await appendLog(logFile, `\n[gate:forbidden_files] verdict=${gateResult.verdict} denied=${String(gateResult.deniedFiles.length)} guarded=${String(gateResult.guardedFiles.length)} lockfile=${String(gateResult.lockfileViolations.length)}\n`);

  // Store gate results in context for PR annotation
  appendGateReport(ctx, "forbidden_files", gateResult.verdict, gateResult.reasons);

  if (gateResult.verdict === "hard_fail") {
    return {
      outcome: "failure",
      error: `Forbidden files detected: ${gateResult.deniedFiles.join(", ")}`,
      outputs: {
        deniedFiles: gateResult.deniedFiles,
        guardedFiles: gateResult.guardedFiles,
        lockfileViolations: gateResult.lockfileViolations
      }
    };
  }

  if (gateResult.verdict === "soft_fail") {
    return {
      outcome: "soft_fail",
      error: `Guarded files or lockfile violations: ${gateResult.reasons.join("; ")}`,
      outputs: {
        guardedFiles: gateResult.guardedFiles,
        lockfileViolations: gateResult.lockfileViolations
      }
    };
  }

  return { outcome: "success" };
}
