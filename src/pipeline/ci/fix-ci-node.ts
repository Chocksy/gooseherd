import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { runShell, runShellCapture, appendLog, shellEscape } from "../shell.js";
import { buildAgentCommand } from "../agent-command.js";
import { commitCaptureAndPush } from "../git-ops.js";
import { buildCIFixPrompt, type CIAnnotation } from "./ci-monitor.js";
import { buildGitAddPathspecs, filterInternalGeneratedFiles, mergeInternalArtifacts } from "../internal-generated-files.js";

/**
 * CI Fix node: "fat" agent node that fixes CI failures, commits, and pushes.
 *
 * Unlike fix_validation (which only runs the agent — the engine handles retry),
 * fix_ci must also commit+push so that CI can detect the new changes.
 * After pushing, it updates commitSha in context so wait_ci polls the new ref.
 *
 * Called by the pipeline engine's on_failure loop handler when wait_ci fails.
 */
export async function fixCiNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const config = deps.config;
  const logFile = deps.logFile;
  const repoDir = ctx.getRequired<string>("repoDir");
  const run = deps.run;
  const attempt = ctx.get<number>("loopAttempt") ?? 1;

  await deps.onPhase("ci_fixing");
  await appendLog(logFile, `\n[ci:fix] starting CI fix attempt ${String(attempt)}\n`);

  // Build fix prompt from CI failure context
  const prefetchCi = deps.run.prefetchContext?.github?.ci;
  const annotations = ctx.has("ciAnnotations")
    ? (ctx.get<CIAnnotation[]>("ciAnnotations") ?? [])
    : (prefetchCi?.failedAnnotations?.map((annotation) => ({
        file: annotation.path,
        line: annotation.line,
        message: annotation.message,
        level: annotation.level,
      })) ?? []);
  const failedRunNames = ctx.get<string[]>("ciFailedRunNames")
    ?? prefetchCi?.failedRuns?.map((failedRun) => failedRun.name).filter(Boolean)
    ?? [];
  const logTail = ctx.get<string>("ciLogTail") ?? prefetchCi?.failedLogTail ?? "";
  const changedFiles = ctx.get<string[]>("changedFiles") ?? [];
  const existingInternalArtifacts = ctx.get<string[]>("internalArtifacts");

  const fixPrompt = buildCIFixPrompt(annotations, logTail, changedFiles, failedRunNames, run.id);

  // Write fix prompt to disk for the agent
  const runDir = ctx.getRequired<string>("runDir");
  const fixPromptFile = path.join(runDir, `ci-fix-round-${String(attempt)}.md`);
  await writeFile(fixPromptFile, fixPrompt, "utf8");
  const beforeHead = await currentHead(repoDir, logFile);

  // Run the coding agent with the fix prompt
  const isFollowUp = ctx.get<boolean>("isFollowUp") ?? false;
  const agentCommand = buildAgentCommand(config, run, repoDir, fixPromptFile, isFollowUp);

  await runShell(agentCommand, {
    cwd: path.resolve("."),
    logFile,
    timeoutMs: config.agentTimeoutSeconds * 1000
  });

  // Check if agent made any user-committable changes, ignoring internal artifacts like AGENTS.md.
  const pathspecArgs = buildGitAddPathspecs().map(shellEscape).join(" ");
  const diffCheck = await runShellCapture(
    `git status --porcelain --untracked-files=all -- ${pathspecArgs}`,
    { cwd: repoDir, logFile },
  );
  if (diffCheck.code === 0 && diffCheck.stdout.trim() === "") {
    const afterHead = await currentHead(repoDir, logFile);
    if (afterHead !== beforeHead) {
      await appendLog(logFile, "\n[ci:fix] agent changed HEAD without file changes; treating as history-only CI fix\n");
      if (run.branchName) {
        await runShell(`git push --force-with-lease origin HEAD:${shellEscape(run.branchName)}`, { cwd: repoDir, logFile });
      }
      const changedFiles = await changedFilesBetween(repoDir, logFile, beforeHead, afterHead);
      return {
        outcome: "success",
        outputs: {
          commitSha: afterHead,
          changedFiles,
          internalArtifacts: mergeInternalArtifacts(existingInternalArtifacts, [])
        }
      };
    }

    await appendLog(logFile, "\n[ci:fix] agent made no user-committable changes\n");
    return { outcome: "failure", error: "CI fix agent made no changes" };
  }

  // Commit, capture SHA + changed files, and push
  const commitMsg = `fix: Fix CI for run ${run.id}`;
  const { commitSha: newSha, changedFiles: newChangedFiles, internalArtifacts } = await commitCaptureAndPush(
    repoDir, commitMsg, logFile, run.branchName
  );

  await appendLog(logFile, `\n[ci:fix] pushed fix commit ${newSha.slice(0, 8)}\n`);

  return {
    outcome: "success",
    outputs: {
      commitSha: newSha,
      changedFiles: newChangedFiles,
      internalArtifacts: mergeInternalArtifacts(existingInternalArtifacts, internalArtifacts)
    }
  };
}

async function currentHead(repoDir: string, logFile: string): Promise<string> {
  const result = await runShellCapture("git rev-parse HEAD", { cwd: repoDir, logFile });
  return result.stdout.trim().split("\n").pop()?.trim() ?? "";
}

async function changedFilesBetween(
  repoDir: string,
  logFile: string,
  beforeHead: string,
  afterHead: string
): Promise<string[]> {
  const result = await runShellCapture(
    `git diff --name-only ${shellEscape(beforeHead)} ${shellEscape(afterHead)}`,
    { cwd: repoDir, logFile },
  );
  return filterInternalGeneratedFiles(
    result.stdout
      .split("\n")
      .map(f => f.trim())
      .filter(Boolean)
  );
}
