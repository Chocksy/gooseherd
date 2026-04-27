import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { runShell, runShellCapture, appendLog, sleep } from "../shell.js";
import { buildAgentCommand } from "../agent-command.js";
import { commitCaptureAndPush } from "../git-ops.js";
import { isNonCodeFixFailure, type BrowserVerifyFailureCode } from "../quality-gates/browser-verify-routing.js";
import { filterInternalGeneratedFiles, mergeInternalArtifacts } from "../internal-generated-files.js";

/**
 * Fix Browser node: "fat" agent node that fixes browser verification failures.
 *
 * Like fix_ci, this node commits+pushes internally and then waits for the
 * preview deployment to update before browser_verify re-runs.
 *
 * Called by the pipeline engine's on_failure loop when browser_verify fails.
 */
export async function fixBrowserNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const config = deps.config;
  const logFile = deps.logFile;
  const repoDir = ctx.getRequired<string>("repoDir");
  const run = deps.run;
  const attempt = ctx.get<number>("loopAttempt") ?? 1;
  const existingInternalArtifacts = ctx.get<string[]>("internalArtifacts");

  await deps.onPhase("ci_fixing");
  await appendLog(logFile, `\n[browser:fix] starting browser fix attempt ${String(attempt)}\n`);

  // Read browser verify failure context
  const verdictReason = ctx.get<string>("browserVerifyVerdictReason") ?? "Browser verification failed";
  const failureCode = ctx.get<BrowserVerifyFailureCode>("browserVerifyFailureCode");
  const domFindings = ctx.get<string[]>("browserVerifyDomFindings") ?? [];
  const reviewAppUrl = ctx.get<string>("reviewAppUrl") ?? "";
  const task = run.task;
  const changedFiles = ctx.get<string[]>("changedFiles") ?? [];

  if (isNonCodeFixFailure(failureCode)) {
    await appendLog(logFile, `[browser:fix] skip: failure class '${failureCode}' is not code-fix-first\n`);
    return { outcome: "failure", error: `Browser failure ${failureCode} should not run fix_browser` };
  }

  // Read CDP artifacts for richer fix context
  const actionsPath = ctx.get<string>("actionsPath");
  const consolePath = ctx.get<string>("consolePath");
  const failureHistory = ctx.get<Array<{ round: number; verdict?: string }>>("browserVerifyFailureHistory");

  let agentActions: Array<{ type: string; reasoning?: string; pageUrl?: string }> | undefined;
  if (actionsPath) {
    try {
      const raw = await readFile(actionsPath, "utf8");
      agentActions = JSON.parse(raw) as typeof agentActions;
    } catch { /* non-fatal */ }
  }

  let consoleErrors: Array<{ level: string; text: string }> | undefined;
  if (consolePath) {
    try {
      const raw = await readFile(consolePath, "utf8");
      const allLogs = JSON.parse(raw) as Array<{ level?: string; text?: string; message?: string }>;
      consoleErrors = allLogs
        .filter(l => l.level === "error" || l.level === "warning")
        .map((entry) => ({
          level: entry.level ?? "log",
          text: normalizeConsoleText(entry)
        }))
        .slice(0, 10);
    } catch { /* non-fatal */ }
  }

  // Extract last visited URL from agent actions
  const lastVisitedUrl = agentActions?.filter(a => a.pageUrl).pop()?.pageUrl;

  // Build fix prompt
  const fixPrompt = buildBrowserFixPrompt(
    task, verdictReason, domFindings, changedFiles, reviewAppUrl,
    agentActions, consoleErrors, lastVisitedUrl, failureHistory, failureCode
  );

  // Write fix prompt to disk for the agent
  const runDir = ctx.getRequired<string>("runDir");
  const fixPromptFile = path.join(runDir, `browser-fix-round-${String(attempt)}.md`);
  await writeFile(fixPromptFile, fixPrompt, "utf8");

  // Run the coding agent
  const isFollowUp = ctx.get<boolean>("isFollowUp") ?? false;
  const agentCommand = buildAgentCommand(config, run, repoDir, fixPromptFile, isFollowUp);

  await runShell(agentCommand, {
    cwd: path.resolve("."),
    logFile,
    timeoutMs: config.agentTimeoutSeconds * 1000
  });

  // Check if agent made any changes
  const diffCheck = await runShellCapture("git status --porcelain", { cwd: repoDir, logFile });
  if (diffCheck.code === 0 && diffCheck.stdout.trim() === "") {
    await appendLog(logFile, "\n[browser:fix] agent made no changes — nothing to commit\n");
    return { outcome: "failure", error: "Fix agent made no changes" };
  }

  // Commit, capture SHA + changed files, and push
  const commitMsg = `${config.appSlug}: fix browser verification (attempt ${String(attempt)})`;
  const { commitSha: newSha, changedFiles: newChangedFiles, internalArtifacts } = await commitCaptureAndPush(
    repoDir, commitMsg, logFile, run.branchName
  );

  await appendLog(logFile, `\n[browser:fix] pushed fix commit ${newSha.slice(0, 8)}\n`);

  // Wait for the preview deployment to update
  if (reviewAppUrl) {
    await appendLog(logFile, `\n[browser:fix] waiting for preview to redeploy: ${reviewAppUrl}\n`);
    await waitForPreviewRedeploy(reviewAppUrl, 180_000, logFile);
  }

  return {
    outcome: "success",
    outputs: {
      commitSha: newSha,
      changedFiles: newChangedFiles,
      internalArtifacts: mergeInternalArtifacts(existingInternalArtifacts, internalArtifacts)
    }
  };
}

export function buildBrowserFixPrompt(
  task: string,
  verdictReason: string,
  domFindings: string[],
  changedFiles: string[],
  reviewAppUrl: string,
  agentActions?: Array<{ type: string; reasoning?: string; pageUrl?: string }>,
  consoleErrors?: Array<{ level: string; text: string }>,
  lastVisitedUrl?: string,
  failureHistory?: Array<{ round: number; verdict?: string }>,
  failureCode?: BrowserVerifyFailureCode
): string {
  const sanitizedChangedFiles = filterInternalGeneratedFiles(changedFiles);
  const parts: string[] = [
    "# Browser Verification Fix Required\n",
    `## Original Task\n${task}\n`,
    `## What Went Wrong\nThe browser verification check FAILED after deployment. The QA system inspected the live preview at ${reviewAppUrl} and found problems.\n`,
    `### Verdict\n${verdictReason}\n`
  ];

  if (lastVisitedUrl) {
    parts.push(`### Last Visited URL\nThe browser was on \`${lastVisitedUrl}\` when the verification failed.\n`);
  }

  if (failureCode) {
    parts.push(`### Failure Class\n\`${failureCode}\`\n`);
  }

  if (agentActions && agentActions.length > 0) {
    const actionLines = agentActions.map((a, i) =>
      `${String(i + 1)}. [${a.type}] ${a.reasoning ?? "(no reasoning)"}${a.pageUrl ? ` (on ${a.pageUrl})` : ""}`
    );
    parts.push(`### Browser Agent Actions\nWhat the QA agent actually did:\n${actionLines.join("\n")}\n`);
  }

  if (consoleErrors && consoleErrors.length > 0) {
    const errorLines = consoleErrors.map(e => `- [${e.level}] ${e.text.slice(0, 200)}`);
    parts.push(`### Console Errors\n${errorLines.join("\n")}\n`);
  }

  if (domFindings.length > 0) {
    parts.push(`### DOM Inspection Results\n${domFindings.map(f => `- ${f}`).join("\n")}\n`);
  }

  if (sanitizedChangedFiles.length > 0) {
    parts.push(`### Files Changed\n${sanitizedChangedFiles.map(f => `- ${f}`).join("\n")}\n`);
  }

  if (failureHistory && failureHistory.length > 0) {
    const historyLines = failureHistory.map(h =>
      `- Round ${String(h.round)}: ${h.verdict ?? "unknown failure"}`
    );
    parts.push(`### Previous Fix Attempts\nThese fixes were already tried and failed:\n${historyLines.join("\n")}\nDo NOT repeat the same approach. Try a different strategy.\n`);
  }

  parts.push(
    "## Instructions",
    "Fix the code so that the visual verification passes. Focus on:",
    "1. Ensuring the requested changes are actually visible in the rendered page",
    "2. Fix any CSS/HTML issues that prevent elements from appearing correctly",
    "3. Make sure template syntax is correct (e.g. Slim indentation, ERB tags)",
    "4. Do NOT change unrelated code — only fix the specific issues identified above",
    "",
    "Note: If the browser verification failure mentions a login page, authentication redirect,",
    "or \"page appears blank\" — this may be an authentication issue, not a code bug. The browser",
    "verification system handles auth separately. Focus only on fixing the actual UI implementation",
    "matching the original task requirements.",
    ""
  );

  return parts.join("\n");
}

/**
 * Wait for the preview URL to go through a rebuild cycle (502/503)
 * and come back up, indicating the new deployment is live.
 */
async function waitForPreviewRedeploy(
  url: string,
  timeoutMs: number,
  logFile: string
): Promise<void> {
  const startTime = Date.now();
  const deadline = startTime + timeoutMs;
  let sawDowntime = false;
  let intervalMs = 5_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(10_000),
        redirect: "follow"
      });
      const status = response.status;
      await response.body?.cancel();

      if (status === 502 || status === 503) {
        sawDowntime = true;
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        if (elapsed % 15 < 6) {
          await appendLog(logFile, `[browser:fix] preview rebuilding (HTTP ${String(status)}, ${String(elapsed)}s)\n`);
        }
      } else if (sawDowntime && status >= 200 && status < 400) {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        await appendLog(logFile, `[browser:fix] preview back up after ${String(elapsed)}s\n`);
        return;
      } else if (!sawDowntime && (Date.now() - startTime) > 30_000) {
        // No downtime detected after 30s — rebuild may be instant or we missed the window
        await sleep(10_000);
        await appendLog(logFile, "[browser:fix] no downtime detected, assuming deployment is live\n");
        return;
      }
    } catch {
      sawDowntime = true;
    }

    await sleep(intervalMs);
    intervalMs = Math.min(Math.floor(intervalMs * 1.5), 15_000);
  }

  await appendLog(logFile, `[browser:fix] redeploy wait timed out after ${String(Math.floor(timeoutMs / 1000))}s\n`);
}

function normalizeConsoleText(entry: { text?: string; message?: string }): string {
  if (typeof entry.text === "string" && entry.text.trim().length > 0) {
    return entry.text;
  }
  if (typeof entry.message === "string" && entry.message.trim().length > 0) {
    return entry.message;
  }
  return "(no console text)";
}
