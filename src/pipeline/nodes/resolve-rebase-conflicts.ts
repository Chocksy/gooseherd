import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NodeConfig, NodeDeps, NodeResult } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { appendLog, runShell, runShellCapture, shellEscape } from "../shell.js";
import { buildAgentCommandWithSelection } from "../agent-command.js";
import { describeAgentProfileSelection } from "../../agent-profile-resolver.js";

const DEFAULT_MAX_REBASE_STEPS = 10;

// Files where a malicious resolution can shape the next CI run (with the
// caller's secrets) or the runtime image. Conflicts here must not be
// auto-resolved by the agent.
const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /^\.github\/workflows\//,
  /^\.github\/actions\//,
  /(^|\/)Dockerfile(\..+)?$/,
  /(^|\/)docker-compose(\..+)?\.ya?ml$/,
  /(^|\/)Makefile$/,
  /(^|\/)(bin|scripts)\//,
  /(^|\/)\.husky\//,
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)Gemfile\.lock$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)Pipfile\.lock$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)go\.sum$/,
];

function getMaxRebaseSteps(nodeConfig: NodeConfig): number {
  const configured = nodeConfig.config?.["maxRebaseSteps"];
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return DEFAULT_MAX_REBASE_STEPS;
}

function findSensitivePaths(files: string[]): string[] {
  return files.filter((file) => SENSITIVE_PATH_PATTERNS.some((re) => re.test(file)));
}

/**
 * Agent fallback for sync_base_branch when deterministic rebase hits conflicts.
 *
 * Mirrors the fix_ci pattern: the node owns all git operations (rebase, add,
 * continue, push) and only delegates conflict-marker resolution to the agent.
 * That keeps the agent inside its sandbox (file edits only) and avoids the
 * read-only `.git` and network restrictions that block agent-driven git work.
 */
export async function resolveRebaseConflictsNode(
  nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps,
): Promise<NodeResult> {
  const config = deps.config;
  const logFile = deps.logFile;
  const repoDir = ctx.getRequired<string>("repoDir");
  const run = deps.run;
  const attempt = ctx.get<number>("loopAttempt") ?? 1;
  const baseBranch = ctx.get<string>("rebaseConflictBaseBranch")
    ?? ctx.get<string>("resolvedBaseBranch")
    ?? run.baseBranch
    ?? "main";
  const branchName = run.branchName;
  const maxRebaseSteps = getMaxRebaseSteps(nodeConfig);

  await deps.onPhase("rebasing");
  await appendLog(logFile, `\n[resolve_rebase_conflicts] starting attempt ${String(attempt)} (base=${baseBranch})\n`);

  // Refresh both refs in one fetch: base for the rebase target, feature so
  // the lease-SHA we capture below reflects any human pushes that landed
  // between the original clone/sync_base_branch fetch and now.
  const refsToFetch = branchName
    ? `${shellEscape(baseBranch)} ${shellEscape(branchName)}`
    : shellEscape(baseBranch);
  const fetchResult = await runShellCapture(`git fetch origin ${refsToFetch}`, { cwd: repoDir, logFile });
  if (fetchResult.code !== 0) {
    return {
      outcome: "failure",
      error: `Failed to fetch origin refs (${refsToFetch}) before agent rebase.`,
      rawOutput: fetchResult.stderr || fetchResult.stdout,
    };
  }

  let expectedRemoteSha: string | undefined;
  if (branchName) {
    const remoteShaResult = await runShellCapture(
      `git rev-parse refs/remotes/origin/${shellEscape(branchName)}`,
      { cwd: repoDir, logFile },
    );
    if (remoteShaResult.code !== 0 || !remoteShaResult.stdout.trim()) {
      return {
        outcome: "failure",
        error: `Failed to read origin/${branchName} SHA before agent rebase.`,
        rawOutput: remoteShaResult.stderr || remoteShaResult.stdout,
      };
    }
    expectedRemoteSha = remoteShaResult.stdout.trim();
  }

  const beforeHead = await currentHead(repoDir, logFile);

  const rebaseTarget = shellEscape(`origin/${baseBranch}`);
  let stepResult = await runShellCapture(`git rebase ${rebaseTarget}`, { cwd: repoDir, logFile });
  let agentRound = 0;

  for (let step = 0; step < maxRebaseSteps; step += 1) {
    if (stepResult.code === 0) {
      break;
    }

    const conflictFiles = await listConflictedFiles(repoDir, logFile);
    if (conflictFiles.length === 0) {
      // Only --skip when index+worktree are clean — that is the actual
      // "now-empty commit" signal. A dirty state means the commit failed
      // to apply (lockfile race, hook failure) and skipping would lose work.
      const indexClean = await runShellCapture(
        "git diff --cached --quiet && git diff --quiet",
        { cwd: repoDir, logFile },
      );
      if (indexClean.code !== 0) {
        await runShellCapture("git rebase --abort", { cwd: repoDir, logFile });
        return {
          outcome: "failure",
          error: "Rebase stopped on a non-conflict failure with dirty index/worktree; refusing to --skip.",
          rawOutput: [stepResult.stderr, stepResult.stdout].filter(Boolean).join("\n").trim(),
        };
      }
      const skipResult = await runShellCapture("git rebase --skip", { cwd: repoDir, logFile });
      stepResult = skipResult;
      if (skipResult.code === 0) continue;
      // Skip failed: either it surfaced fresh conflicts (next iteration
      // dispatches to the agent) or it left no conflicts at all (terminal).
      if ((await listConflictedFiles(repoDir, logFile)).length === 0) {
        await runShellCapture("git rebase --abort", { cwd: repoDir, logFile });
        return {
          outcome: "failure",
          error: `Rebase failed and produced no conflict files; cannot delegate to agent.`,
          rawOutput: [skipResult.stderr, skipResult.stdout].filter(Boolean).join("\n").trim(),
        };
      }
      continue;
    }

    const sensitive = findSensitivePaths(conflictFiles);
    if (sensitive.length > 0) {
      await runShellCapture("git rebase --abort", { cwd: repoDir, logFile });
      return {
        outcome: "failure",
        error: `Refusing to auto-resolve conflicts in sensitive path(s); needs human review: ${sensitive.join(", ")}`,
      };
    }

    agentRound += 1;
    await appendLog(
      logFile,
      `\n[resolve_rebase_conflicts] conflict round ${String(agentRound)}: ${String(conflictFiles.length)} file(s): ${conflictFiles.join(", ")}\n`,
    );

    const agentOk = await runConflictResolutionAgent({
      attempt,
      agentRound,
      conflictFiles,
      ctx,
      deps,
      run,
      config,
      logFile,
      repoDir,
    });

    if (!agentOk.ok) {
      await runShellCapture("git rebase --abort", { cwd: repoDir, logFile });
      return {
        outcome: "failure",
        error: agentOk.error,
        rawOutput: agentOk.rawOutput,
      };
    }

    // Defence against indirect prompt injection: prompt rules are model-side
    // guardrails; this enforces them harness-side.
    const scopeViolations = await listFilesOutsideScope(repoDir, logFile, conflictFiles);
    if (scopeViolations.length > 0) {
      await runShellCapture("git rebase --abort", { cwd: repoDir, logFile });
      return {
        outcome: "failure",
        error: `Agent touched files outside conflict set: ${scopeViolations.join(", ")}.`,
      };
    }

    // git add -A picks up modifications, additions, AND deletions —
    // important if the agent resolved a conflict by deleting a file.
    const addPaths = conflictFiles.map(shellEscape).join(" ");
    const addResult = await runShellCapture(`git add -A -- ${addPaths}`, { cwd: repoDir, logFile });
    if (addResult.code !== 0) {
      await runShellCapture("git rebase --abort", { cwd: repoDir, logFile });
      return {
        outcome: "failure",
        error: `Failed to stage agent-resolved files: ${conflictFiles.join(", ")}`,
        rawOutput: addResult.stderr || addResult.stdout,
      };
    }

    stepResult = await runShellCapture("GIT_EDITOR=true git rebase --continue", { cwd: repoDir, logFile });
  }

  if (stepResult.code !== 0) {
    await runShellCapture("git rebase --abort", { cwd: repoDir, logFile });
    return {
      outcome: "failure",
      error: `Rebase did not converge after ${String(maxRebaseSteps)} steps.`,
      rawOutput: [stepResult.stderr, stepResult.stdout].filter(Boolean).join("\n").trim(),
    };
  }

  const inProgress = await runShellCapture(
    "test -d .git/rebase-merge -o -d .git/rebase-apply",
    { cwd: repoDir, logFile },
  );
  if (inProgress.code === 0) {
    await runShellCapture("git rebase --abort", { cwd: repoDir, logFile });
    return { outcome: "failure", error: "Rebase still in progress after final step." };
  }

  const afterHead = await currentHead(repoDir, logFile);
  if (afterHead === beforeHead) {
    return { outcome: "failure", error: "Rebase produced no new HEAD." };
  }

  const changedFilesResult = await runShellCapture(
    `git diff --name-only ${shellEscape(beforeHead)}..${shellEscape(afterHead)}`,
    { cwd: repoDir, logFile },
  );
  const changedFiles = changedFilesResult.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);

  await appendLog(
    logFile,
    `\n[resolve_rebase_conflicts] rebase finished; HEAD ${beforeHead.slice(0, 8)} → ${afterHead.slice(0, 8)} (${String(agentRound)} agent round(s))\n`,
  );

  if (branchName) {
    // Explicit lease form: pin to the SHA we observed at the start so a
    // human push that landed during the agent run is not silently overwritten.
    // `--force-if-includes` adds a second check that our local history has
    // pulled in any commits from the remote ref.
    const leaseExpr = expectedRemoteSha
      ? `refs/heads/${shellEscape(branchName)}:${shellEscape(expectedRemoteSha)}`
      : shellEscape(`refs/heads/${branchName}`);
    const pushResult = await runShellCapture(
      `git push --force-with-lease=${leaseExpr} --force-if-includes origin HEAD:${shellEscape(branchName)}`,
      { cwd: repoDir, logFile },
    );
    if (pushResult.code !== 0) {
      return {
        outcome: "failure",
        error: "git push --force-with-lease failed after rebase.",
        rawOutput: pushResult.stderr || pushResult.stdout,
      };
    }
    await appendLog(logFile, `[resolve_rebase_conflicts] pushed ${afterHead.slice(0, 8)} to origin/${branchName}\n`);
  } else {
    await appendLog(logFile, `[resolve_rebase_conflicts] no branchName on run; skipping push\n`);
  }

  ctx.set("commitSha", afterHead);
  ctx.set("changedFiles", changedFiles);
  ctx.set("rebasePerformed", true);
  ctx.set("forcePushWithLease", true);

  return {
    outcome: "success",
    outputs: {
      commitSha: afterHead,
      changedFiles,
      rebasePerformed: true,
      requiresForcePush: true,
      forcePushWithLease: true,
    },
  };
}

interface RunConflictAgentInput {
  attempt: number;
  agentRound: number;
  conflictFiles: string[];
  ctx: ContextBag;
  deps: NodeDeps;
  run: NodeDeps["run"];
  config: NodeDeps["config"];
  logFile: string;
  repoDir: string;
}

async function runConflictResolutionAgent(
  input: RunConflictAgentInput,
): Promise<{ ok: true } | { ok: false; error: string; rawOutput?: string }> {
  const { attempt, agentRound, conflictFiles, ctx, deps, run, config, logFile, repoDir } = input;
  const runDir = ctx.getRequired<string>("runDir");
  const promptFile = path.join(
    runDir,
    `resolve-rebase-conflicts-round-${String(attempt)}-step-${String(agentRound)}.md`,
  );

  const promptLines = [
    "You are resolving git rebase conflict markers.",
    "",
    "These files have unresolved conflict markers (`<<<<<<<`, `|||||||`, `=======`, `>>>>>>>`):",
    ...conflictFiles.map((file) => `- ${file}`),
    "",
    "Required workflow:",
    "1. Read each listed file. Each conflict block has the form `<<<<<<< HEAD ... ======= ... >>>>>>> <commit>`. With diff3 conflict style the block also includes a `||||||| <ancestor>` middle section — discard the ancestor block in your resolution.",
    "2. Edit each file to resolve the conflict based on the actual semantics of both sides — combine, choose, or rewrite as makes sense.",
    "3. Remove ALL conflict markers (`<<<<<<<`, `|||||||`, `=======`, `>>>>>>>`). They MUST NOT remain anywhere in the listed files.",
    "4. Do NOT run any git commands. Do NOT push. Do NOT commit. Do NOT abort or continue the rebase. The pipeline will handle all git operations.",
    "5. Do NOT modify any files outside the conflict list.",
    "6. Do NOT create new files.",
  ];
  await writeFile(promptFile, promptLines.join("\n"), "utf8");

  const isFollowUp = ctx.get<boolean>("isFollowUp") ?? false;
  const { command: agentCommand, selection } = buildAgentCommandWithSelection(
    config,
    run,
    repoDir,
    promptFile,
    isFollowUp,
    deps.agentProfileTarget,
  );
  await appendLog(logFile, "[agent-profile] " + describeAgentProfileSelection(selection) + "\n");

  await runShell(agentCommand, {
    cwd: path.resolve("."),
    logFile,
    timeoutMs: config.agentTimeoutSeconds * 1000,
  });

  const stillMarked: string[] = [];
  for (const file of conflictFiles) {
    const filePath = path.join(repoDir, file);
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      // Agent may have intentionally deleted the file as part of conflict resolution.
      // git add -- <file> below will record the deletion.
      continue;
    }
    if (containsConflictMarkers(content)) {
      stillMarked.push(file);
    }
  }

  if (stillMarked.length > 0) {
    return {
      ok: false,
      error: `Agent did not remove conflict markers from: ${stillMarked.join(", ")}.`,
    };
  }

  return { ok: true };
}

// Tolerates marker runs longer than the 7-char spec and includes the
// diff3 ancestor marker `|||||||`. \s covers space, tab, LF, CR.
export function containsConflictMarkers(content: string): boolean {
  return /^(<{7,}|\|{7,}|={7,}|>{7,})(\s|$)/m.test(content);
}

async function listConflictedFiles(repoDir: string, logFile: string): Promise<string[]> {
  const result = await runShellCapture("git diff --name-only --diff-filter=U", { cwd: repoDir, logFile });
  return result.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// Returns paths reported by `git status --porcelain -z` that are not in the
// allowed conflict-file set. `-z` emits NUL-separated, unquoted entries so
// paths with quotes/whitespace/non-ASCII are unambiguous. Renames and copies
// emit a second NUL-terminated record holding the source path; we consume
// and ignore it (the destination is what the agent created/touched).
async function listFilesOutsideScope(
  repoDir: string,
  logFile: string,
  conflictFiles: string[],
): Promise<string[]> {
  const result = await runShellCapture("git status --porcelain=v1 -uall -z", { cwd: repoDir, logFile });
  const allowed = new Set(conflictFiles);
  const violations: string[] = [];
  const entries = result.stdout.split("\0");
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.length < 3) continue;
    const status = entry[0];
    const filePath = entry.slice(3);
    if (!allowed.has(filePath)) {
      violations.push(filePath);
    }
    // Rename (R) and copy (C) status emit the source path as the next NUL record.
    if (status === "R" || status === "C") i += 1;
  }
  return violations;
}

async function currentHead(repoDir: string, logFile: string): Promise<string> {
  const result = await runShellCapture("git rev-parse HEAD", { cwd: repoDir, logFile });
  return result.stdout.trim().split("\n").pop()?.trim() ?? "";
}
