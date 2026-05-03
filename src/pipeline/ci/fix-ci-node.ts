import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { runShell, runShellCapture, appendLog, shellEscape } from "../shell.js";
import { buildAgentCommandWithSelection } from "../agent-command.js";
import { describeAgentProfileSelection } from "../../agent-profile-resolver.js";
import { commitCaptureAndPush } from "../git-ops.js";
import { buildCIFixPrompt, type CIAnnotation } from "./ci-monitor.js";
import { buildGitAddPathspecs, filterInternalGeneratedFiles, mergeInternalArtifacts } from "../internal-generated-files.js";
import { parseErrors } from "../error-parser.js";

/**
 * Inner mini-loop: how many times we re-run the agent against a failing
 * local_test before giving up and returning failure (without pushing).
 *
 * Local tests are cheap compared to a CI round-trip, so we can afford a
 * generous budget here.
 */
const INNER_TEST_MAX_ROUNDS = 5;

/**
 * Exit codes we treat as "the test runner reported a real test failure"
 * — i.e. worth re-prompting the agent against. Anything else (127 command
 * not found, 126 not executable, ≥128 killed-by-signal incl. SIGKILL/OOM
 * and SIGTERM/timeout, plus runner-specific "couldn't run" codes like
 * pytest's 5 "no tests collected") is treated as an infrastructure error:
 * we log a warning, break out of the inner loop, and fall through to
 * commit+push so that CI becomes the source of truth instead of the
 * agent burning rounds on something it can't fix.
 *
 * Covers jest/mocha/rspec/bun (1 = fail) and pytest (1 = fail, 2 = usage
 * or collection error — treated as a retriable code issue within the
 * normal inner-loop budget).
 */
const REAL_TEST_FAILURE_EXIT_CODES = new Set([1, 2]);

/**
 * Sentinel path the agent can create (relative to repoDir) to opt out of
 * further inner-loop retries. The harness reads its first line as the
 * reason, deletes the file, and (if enabled and round >= 2) breaks out of
 * the loop and proceeds to commit+push so CI judges. Honored only when
 * config.ciFixAgentBailEnabled is true.
 */
const AGENT_BAIL_SENTINEL_RELPATH = ".gooseherd/bail-test-loop";

/**
 * The agent-driven bail is gated to round >= 2: at least one honest fix
 * attempt must happen before the agent is allowed to declare the failure
 * environmental.
 */
const AGENT_BAIL_MIN_ROUND = 2;

/**
 * CI Fix node: "fat" agent node that fixes CI failures, gates on a local test
 * loop, and only then commits + pushes.
 *
 * Unlike fix_validation (which only runs the agent — the engine handles retry),
 * fix_ci must also commit+push so that CI can detect the new changes.
 * After pushing, it updates commitSha in context so wait_ci polls the new ref.
 *
 * Inner mini-loop:
 *   round 1: run agent with the CI failure prompt
 *   if LOCAL_TEST_COMMAND is set, run it against the (uncommitted) working tree
 *   if it fails, run agent again with the test output as a follow-up prompt
 *   repeat up to INNER_TEST_MAX_ROUNDS — only commit+push once tests are green
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
  const outerAttempt = ctx.get<number>("loopAttempt") ?? 1;

  await deps.onPhase("ci_fixing");
  await appendLog(logFile, `\n[ci:fix] starting CI fix attempt ${String(outerAttempt)}\n`);

  // ── Build the initial CI failure prompt ──
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
  const initialChangedFiles = ctx.get<string[]>("changedFiles") ?? [];
  const existingInternalArtifacts = ctx.get<string[]>("internalArtifacts");

  const initialPrompt = buildCIFixPrompt(annotations, logTail, initialChangedFiles, failedRunNames, run.id);

  const runDir = ctx.getRequired<string>("runDir");
  const isFollowUp = ctx.get<boolean>("isFollowUp") ?? false;

  const beforeHead = await currentHead(repoDir, logFile);
  const hasLocalTest = config.localTestCommand.trim().length > 0;
  const innerMaxRounds = hasLocalTest ? INNER_TEST_MAX_ROUNDS : 1;

  await appendLog(
    logFile,
    `[ci:fix] inner loop: local_test=${hasLocalTest ? "configured" : "not configured"}` +
      ` max_rounds=${String(innerMaxRounds)}\n`
  );

  // ── Inner mini-loop: agent → local_test → retry ──
  let lastTestOutput = "";
  // HEAD baseline for "did THIS round's agent do anything?". Updated each
  // round so that an agent-made commit on round N doesn't masquerade as a
  // change on round N+1 when the round-N+1 agent in fact does nothing.
  let roundBaselineHead = beforeHead;

  for (let round = 1; round <= innerMaxRounds; round++) {
    // Working-tree baseline for this round. Without this, leftover uncommitted
    // edits from a prior round would make a noop agent look like progress.
    // We fingerprint the actual candidate tree state, not just `git status`
    // paths, so "same file still modified but with new content" counts.
    const roundBaselineSnapshot = await currentTrackedSnapshot(repoDir, logFile);
    // Build prompt for this round
    const promptFile = round === 1
      ? path.join(runDir, `ci-fix-round-${String(outerAttempt)}.md`)
      : path.join(runDir, `ci-fix-round-${String(outerAttempt)}-inner-retry-${String(round - 1)}.md`);

    if (round === 1) {
      await writeFile(promptFile, initialPrompt, "utf8");
      await appendCiFixPromptSummaryLog(logFile, promptFile, annotations, logTail, initialChangedFiles, failedRunNames);
    } else {
      const retryPrompt = buildLocalTestRetryPrompt(
        outerAttempt,
        round,
        innerMaxRounds,
        config.localTestCommand,
        lastTestOutput,
        config.ciFixAgentBailEnabled && round >= AGENT_BAIL_MIN_ROUND,
      );
      await writeFile(promptFile, retryPrompt, "utf8");
      await appendLog(
        logFile,
        `[ci:fix:inner] round ${String(round)}/${String(innerMaxRounds)}: retry prompt at ${promptFile}\n`
      );
    }

    // Run the coding agent
    await appendLog(
      logFile,
      `\n[ci:fix:inner] round ${String(round)}/${String(innerMaxRounds)}: running agent\n`
    );
    const { command: agentCommand, selection: agentProfileSelection } = buildAgentCommandWithSelection(
      config,
      run,
      repoDir,
      promptFile,
      isFollowUp,
      deps.agentProfileTarget,
    );
    await appendLog(logFile, "[agent-profile] " + describeAgentProfileSelection(agentProfileSelection) + "\n");

    await runShell(agentCommand, {
      cwd: path.resolve("."),
      logFile,
      timeoutMs: config.agentTimeoutSeconds * 1000
    });

    // Drain the agent-bail sentinel (always — so it never ends up in a
    // commit), and decide whether to honor it for this round.
    const bail = await consumeAgentBailSentinel(
      repoDir,
      logFile,
      round,
      innerMaxRounds,
      config.ciFixAgentBailEnabled,
    );

    // Detect what (if anything) the agent changed.
    const afterStatus = await currentTrackedStatus(repoDir, logFile);
    const hasWorkingTreeChanges = afterStatus !== "";
    const afterSnapshot = hasWorkingTreeChanges ? await currentTrackedSnapshot(repoDir, logFile) : "";
    const afterHead = await currentHead(repoDir, logFile);
    // "Did the agent do anything *this round*?" — used to detect a per-round
    // noop so we can fail fast instead of looping over the same state.
    const madeProgressThisRound = afterSnapshot !== roundBaselineSnapshot || afterHead !== roundBaselineHead;
    // "Is there *anything accumulated* worth pushing?" — survives across
    // rounds. A round-2 agent that only drops the bail sentinel produces
    // madeProgressThisRound=false but hasAccumulatedChange=true if round 1
    // already committed.
    const hasAccumulatedChange = hasWorkingTreeChanges || afterHead !== beforeHead;

    // Agent-driven bail takes precedence over the per-round noop check:
    // a round-2 sentinel-only message after a round-1 commit is exactly
    // the case the feature exists for.
    if (bail.honored) {
      if (!hasAccumulatedChange) {
        const reason = "CI fix agent requested local-test bail but produced no candidate changes to push";
        await appendLog(
          logFile,
          `\n[ci:fix:inner] round ${String(round)}/${String(innerMaxRounds)}: ${reason}\n`,
        );
        return { outcome: "failure", error: reason };
      }
      await appendLog(
        logFile,
        `[ci:fix:inner] round ${String(round)}/${String(innerMaxRounds)}: bail honored — skipping local_test gate, proceeding to commit\n`
      );
      // No need to advance roundBaselineHead: we're exiting the loop.
      break;
    }

    // No bail signal — require this round to have moved the needle.
    if (!madeProgressThisRound) {
      const reason = round === 1
        ? "CI fix agent made no changes"
        : `CI fix agent made no further changes after local test failed in round ${String(round - 1)}`;
      await appendLog(logFile, `\n[ci:fix:inner] round ${String(round)}/${String(innerMaxRounds)}: ${reason}\n`);
      return { outcome: "failure", error: reason };
    }

    // Advance baseline so the next round can detect "agent did nothing new"
    // even when this round's agent committed.
    roundBaselineHead = afterHead;

    if (!hasLocalTest) {
      await appendLog(
        logFile,
        `[ci:fix:inner] round ${String(round)}/${String(innerMaxRounds)}: candidate change detected; no local_test configured — proceeding to commit\n`
      );
      break;
    }

    await appendLog(
      logFile,
      `[ci:fix:inner] round ${String(round)}/${String(innerMaxRounds)}: running local_test\n`
    );
    const testResult = await runShellCapture(config.localTestCommand, {
      cwd: repoDir,
      logFile,
      timeoutMs: config.agentTimeoutSeconds * 1000,
    });

    if (testResult.code === 0) {
      await appendLog(
        logFile,
        `[ci:fix:inner] round ${String(round)}/${String(innerMaxRounds)}: local_test passed — proceeding to commit\n`
      );
      break;
    }

    // Distinguish a real test failure (worth re-prompting the agent) from
    // an infrastructure error (command not found, OOM-kill, timeout SIGTERM,
    // etc.) where retrying just burns rounds. On infra error, defer to CI.
    if (!REAL_TEST_FAILURE_EXIT_CODES.has(testResult.code)) {
      await appendLog(
        logFile,
        `[ci:fix:inner] round ${String(round)}/${String(innerMaxRounds)}: ` +
          `local_test exited with code ${String(testResult.code)} — ` +
          `treating as infrastructure error; bailing out of inner loop and deferring to CI\n`
      );
      break;
    }

    // Concatenate both streams: many test runners emit the summary on stdout
    // and warnings/progress on stderr — keeping only one would drop signal.
    lastTestOutput = [testResult.stdout.trim(), testResult.stderr.trim()]
      .filter(Boolean)
      .join("\n\n");
    await appendLog(
      logFile,
      `[ci:fix:inner] round ${String(round)}/${String(innerMaxRounds)}: local_test failed (exit ${String(testResult.code)})\n`
    );

    if (round === innerMaxRounds) {
      const reason = `Local test still failing after ${String(innerMaxRounds)} inner round(s); not pushing`;
      await appendLog(logFile, `[ci:fix:inner] exhausted — ${reason}\n`);
      return { outcome: "failure", error: reason, rawOutput: lastTestOutput };
    }
    // else: loop again with the retry prompt
  }

  // ── Commit + push (or push, for history-only) ──
  // Re-check working-tree state since the loop may have exited via either branch.
  const finalHasChanges = (await currentTrackedStatus(repoDir, logFile)) !== "";

  if (!finalHasChanges) {
    const finalHead = await currentHead(repoDir, logFile);
    if (finalHead !== beforeHead) {
      await appendLog(logFile, "\n[ci:fix] history-only CI fix; pushing rewritten ref\n");
      if (run.branchName) {
        await runShell(
          `git push --force-with-lease origin HEAD:${shellEscape(run.branchName)}`,
          { cwd: repoDir, logFile },
        );
      }
      const changedFiles = await changedFilesBetween(repoDir, logFile, beforeHead, finalHead);
      return {
        outcome: "success",
        outputs: {
          commitSha: finalHead,
          changedFiles,
          internalArtifacts: mergeInternalArtifacts(existingInternalArtifacts, []),
        },
      };
    }
    // Should not reach here — the loop already returns failure for this case.
    return { outcome: "failure", error: "CI fix agent made no changes" };
  }

  const commitMsg = `fix: Fix CI for run ${run.id}`;
  const { commitSha: newSha, changedFiles: newChangedFiles, internalArtifacts } = await commitCaptureAndPush(
    repoDir, commitMsg, logFile, run.branchName,
  );

  await appendLog(logFile, `\n[ci:fix] pushed fix commit ${newSha.slice(0, 8)}\n`);

  return {
    outcome: "success",
    outputs: {
      commitSha: newSha,
      changedFiles: newChangedFiles,
      internalArtifacts: mergeInternalArtifacts(existingInternalArtifacts, internalArtifacts),
    },
  };
}

function buildLocalTestRetryPrompt(
  outerAttempt: number,
  round: number,
  maxRounds: number,
  localTestCommand: string,
  rawOutput: string,
  bailAllowed: boolean,
): string {
  const lines = [
    `Local test suite is still failing after your previous CI fix attempt.`,
    ``,
    `CI fix attempt: ${String(outerAttempt)}`,
    `Inner test round: ${String(round)}/${String(maxRounds)}`,
    `Local test command: \`${localTestCommand}\``,
    ``,
    `Fix the failing tests. Only change what is necessary — do not refactor unrelated code.`,
    `Do not commit; the harness will commit and push once tests pass.`,
  ];

  if (bailAllowed) {
    lines.push(
      ``,
      `## If you believe the failure is environmental`,
      ``,
      `If — and only if — you have strong reason to believe this local-test failure`,
      `is not caused by your code change (e.g. missing dependency in this sandbox,`,
      `a flaky test, environment differing from CI), you may opt out of further`,
      `local retries by writing a one-line reason to \`${AGENT_BAIL_SENTINEL_RELPATH}\``,
      `in the repo root. The harness will commit your changes and let CI judge.`,
      `Use this sparingly: prefer fixing the test if the failure looks like a real bug.`,
    );
  }

  lines.push(
    ``,
    `## Test Output`,
    ``,
    parseErrors(rawOutput),
  );

  return lines.join("\n");
}

/**
 * Read and remove the agent bail sentinel. Returns honored=true only when
 * the feature is enabled, the sentinel exists, and we're past the minimum
 * round. The sentinel is *always* removed when present so it can't end up
 * in a commit, regardless of whether we honor it.
 */
async function consumeAgentBailSentinel(
  repoDir: string,
  logFile: string,
  round: number,
  innerMaxRounds: number,
  enabled: boolean,
): Promise<{ honored: boolean; reason?: string }> {
  const sentinelPath = path.join(repoDir, AGENT_BAIL_SENTINEL_RELPATH);

  let content: string;
  try {
    content = await readFile(sentinelPath, "utf8");
  } catch {
    return { honored: false };
  }

  // Sentinel exists — drain it unconditionally so the commit phase can't
  // leak it into the tree.
  await rm(sentinelPath, { force: true });
  // Best-effort cleanup of the sentinel's parent directory if now empty.
  // We check emptiness explicitly so we never recursively remove a dir
  // that picked up other unrelated files.
  try {
    const parent = path.dirname(sentinelPath);
    const entries = await readdir(parent);
    if (entries.length === 0) {
      await rm(parent, { recursive: true, force: true });
    }
  } catch {
    // Already gone or unreadable — nothing to do.
  }

  const reason = content.split("\n")[0]?.trim() || "(no reason given)";
  const tag = `[ci:fix:inner] round ${String(round)}/${String(innerMaxRounds)}`;

  if (!enabled) {
    await appendLog(logFile, `${tag}: agent placed bail sentinel but ciFixAgentBailEnabled is false — ignoring (sentinel removed)\n`);
    return { honored: false };
  }
  if (round < AGENT_BAIL_MIN_ROUND) {
    await appendLog(
      logFile,
      `${tag}: agent placed bail sentinel on round ${String(round)} but bail is allowed only from round ${String(AGENT_BAIL_MIN_ROUND)} — ignoring (sentinel removed)\n`,
    );
    return { honored: false };
  }

  await appendLog(logFile, `${tag}: agent requested bail — ${reason}\n`);
  return { honored: true, reason };
}

async function currentHead(repoDir: string, logFile: string): Promise<string> {
  const result = await runShellCapture("git rev-parse HEAD", { cwd: repoDir, logFile });
  return result.stdout.trim().split("\n").pop()?.trim() ?? "";
}

async function currentTrackedStatus(repoDir: string, logFile: string): Promise<string> {
  const pathspecArgs = buildGitAddPathspecs().map(shellEscape).join(" ");
  const result = await runShellCapture(
    `git status --porcelain --untracked-files=all -- ${pathspecArgs}`,
    { cwd: repoDir, logFile },
  );
  return result.stdout.trim();
}

async function currentTrackedSnapshot(repoDir: string, logFile: string): Promise<string> {
  const pathspecArgs = buildGitAddPathspecs().map(shellEscape).join(" ");
  const diff = await runShellCapture(
    `git diff --no-ext-diff --binary HEAD -- ${pathspecArgs}`,
    { cwd: repoDir, logFile },
  );
  const untracked = await runShellCapture(
    `git ls-files --others --exclude-standard -- ${pathspecArgs}`,
    { cwd: repoDir, logFile },
  );

  const untrackedFingerprints: string[] = [];
  for (const file of untracked.stdout.split("\n").map(line => line.trim()).filter(Boolean)) {
    const hash = await runShellCapture(`git hash-object ${shellEscape(file)}`, { cwd: repoDir, logFile });
    untrackedFingerprints.push(`?? ${file} ${hash.stdout.trim()}`);
  }

  return [diff.stdout.trim(), ...untrackedFingerprints].filter(Boolean).join("\n");
}

async function appendCiFixPromptSummaryLog(
  logFile: string,
  promptFile: string,
  annotations: CIAnnotation[],
  logTail: string,
  changedFiles: string[],
  failedRunNames: string[]
): Promise<void> {
  const lines = [
    `[ci:fix] prompt file: ${promptFile}`,
    [
      `[ci:fix] prompt context: failed_runs=${failedRunNames.length > 0 ? failedRunNames.join(", ") : "none"}`,
      `annotations=${String(annotations.length)}`,
      `log_tail=${logTail.trim() ? "yes" : "no"}`,
      `changed_files=${String(filterInternalGeneratedFiles(changedFiles).length)}`,
    ].join(" "),
  ];

  for (const [index, annotation] of annotations.slice(0, 3).entries()) {
    lines.push(
      `[ci:fix] ci annotation ${String(index + 1)}: ${annotation.file}:${String(annotation.line)} — ${truncateSingleLine(annotation.message, 240)}`
    );
  }

  await appendLog(logFile, `\n${lines.join("\n")}\n`);
}

function truncateSingleLine(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}...`;
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
