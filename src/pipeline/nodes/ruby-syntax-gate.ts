import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { appendLog, runShellCapture, shellEscape } from "../shell.js";

/**
 * Ruby syntax gate: run `ruby -c` against changed Ruby files before commit/push.
 *
 * Uses a temporary git add/reset cycle so untracked Ruby files are included.
 */
export async function rubySyntaxGateNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const repoDir = ctx.getRequired<string>("repoDir");
  const logFile = deps.logFile;

  await deps.onPhase("validating");

  const rubyFiles = await detectChangedRubyFiles(repoDir, logFile);
  if (rubyFiles.length === 0) {
    await appendLog(logFile, "\n[pipeline] ruby_syntax_gate: skipped (no changed Ruby files)\n");
    return { outcome: "skipped" };
  }

  await appendLog(logFile, `\n[pipeline] ruby_syntax_gate: checking ${String(rubyFiles.length)} Ruby file(s)\n`);

  for (const file of rubyFiles) {
    const result = await runShellCapture(`ruby -c ${shellEscape(file)}`, {
      cwd: repoDir,
      logFile
    });

    if (result.code !== 0) {
      await appendLog(logFile, `\n[pipeline] ruby_syntax_gate: failed for ${file}\n`);
      return {
        outcome: "failure",
        error: `Ruby syntax check failed for ${file}`,
        rawOutput: `${result.stdout}${result.stderr}`.slice(-2000)
      };
    }
  }

  await appendLog(logFile, "\n[pipeline] ruby_syntax_gate: passed\n");
  return { outcome: "success" };
}

async function detectChangedRubyFiles(repoDir: string, logFile: string): Promise<string[]> {
  await runShellCapture("git add -A", { cwd: repoDir, logFile });
  try {
    const result = await runShellCapture(
      "git diff --cached --name-only --diff-filter=ACMR HEAD -- '*.rb'",
      { cwd: repoDir, logFile }
    );
    if (result.code !== 0 || !result.stdout.trim()) {
      return [];
    }

    return result.stdout
      .trim()
      .split("\n")
      .map((file) => file.trim())
      .filter((file) => file.endsWith(".rb"));
  } finally {
    await runShellCapture("git reset HEAD --quiet", { cwd: repoDir, logFile });
  }
}
