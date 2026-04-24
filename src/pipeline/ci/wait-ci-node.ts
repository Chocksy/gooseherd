import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { parseRepoSlug, type CICheckRun } from "../../github.js";
import { appendLog, sleep } from "../shell.js";
import { appendGateReport } from "../quality-gates/gate-report.js";
import {
  aggregateConclusions,
  filterCheckRuns,
  type CIAnnotation
} from "./ci-monitor.js";

/**
 * Wait for CI node: poll GitHub check runs until all complete, then evaluate.
 *
 * 3-phase polling strategy:
 *   Phase 1: Patience window — wait for check suites to appear
 *   Phase 2: Completion wait — poll until all checks finish
 *   Phase 3: Evaluate — aggregate conclusions
 *
 * Returns success if CI passes or no CI configured.
 * Returns failure with structured annotations if CI fails.
 */
export async function waitCiNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const config = deps.config;

  if (!config.ciWaitEnabled) {
    return { outcome: "success", outputs: { ciConclusion: "skipped" } };
  }

  if (!deps.githubService) {
    return { outcome: "success", outputs: { ciConclusion: "no_github" } };
  }

  const commitSha = ctx.get<string>("commitSha");
  if (!commitSha) {
    await appendLog(deps.logFile, "\n[ci:wait] no commitSha in context, skipping CI wait\n");
    return { outcome: "success", outputs: { ciConclusion: "no_sha" } };
  }

  const { owner, repo } = parseRepoSlug(deps.run.repoSlug);
  const logFile = deps.logFile;
  const checkFilter = config.ciCheckFilter;

  await deps.onPhase("awaiting_ci");
  await deps.emitRunCheckpoint?.({
    checkpointKey: "external_ci_wait_started",
    checkpointType: "run.waiting_external_ci",
    payload: {
      nodeId: "wait_ci",
      commitSha,
      repo: deps.run.repoSlug,
      prNumber: ctx.get<number>("prNumber") ?? deps.run.prNumber,
    },
  });
  await appendLog(logFile, `\n[ci:wait] polling checks for ${commitSha.slice(0, 8)}...\n`);

  // Phase 1: Patience window — wait for check suites to appear
  const patienceEnd = Date.now() + config.ciPatienceTimeoutSeconds * 1000;
  const patienceInterval = 15_000; // 15 seconds

  while (Date.now() < patienceEnd) {
    const checkRuns = await deps.githubService.listCheckRuns(owner, repo, commitSha);
    const filtered = filterCheckRuns(checkRuns, checkFilter);

    if (filtered.length > 0) {
      await appendLog(logFile, `\n[ci:wait] ${String(filtered.length)} check run(s) found\n`);
      break;
    }

    await appendLog(logFile, "[ci:wait] no check runs yet, waiting...\n");
    await sleep(patienceInterval);
  }

  // Phase 2: Completion wait — poll until all checks complete
  const maxWaitEnd = Date.now() + config.ciMaxWaitSeconds * 1000;
  const pollInterval = config.ciPollIntervalSeconds * 1000;
  let lastLogTime = 0;

  while (Date.now() < maxWaitEnd) {
    const checkRuns = await deps.githubService.listCheckRuns(owner, repo, commitSha);
    const filtered = filterCheckRuns(checkRuns, checkFilter);

    if (filtered.length === 0) {
      // No CI checks at all — treat as no_ci
      await appendLog(logFile, "\n[ci:wait] no CI checks found, treating as success\n");
      appendGateReport(ctx, "ci_wait", "pass", []);
      ctx.set("ciConclusion", "no_ci");
      return { outcome: "success", outputs: { ciConclusion: "no_ci" } };
    }

    const conclusion = aggregateConclusions(filtered);

    if (conclusion !== "pending") {
      // Phase 3: Evaluate
      return await evaluateConclusion(conclusion, filtered, owner, repo, commitSha, ctx, deps);
    }

    // Heartbeat logging every 30s
    const now = Date.now();
    if (now - lastLogTime > 30_000) {
      const completed = filtered.filter(cr => cr.status === "completed").length;
      await appendLog(logFile, `[ci:wait] ${String(completed)}/${String(filtered.length)} checks complete, still waiting...\n`);
      lastLogTime = now;
    }

    await sleep(pollInterval);
  }

  // Timeout — treat as failure
  await appendLog(logFile, "\n[ci:wait] timeout waiting for CI to complete\n");
  appendGateReport(ctx, "ci_wait", "hard_fail", ["CI polling timed out"]);
  ctx.set("ciConclusion", "failure");

  return {
    outcome: "failure",
    error: "CI polling timed out after " + String(config.ciMaxWaitSeconds) + " seconds",
    rawOutput: "CI did not complete within the configured timeout."
  };
}

async function evaluateConclusion(
  conclusion: string,
  checkRuns: CICheckRun[],
  owner: string,
  repo: string,
  commitSha: string,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const logFile = deps.logFile;

  if (conclusion === "success") {
    await appendLog(logFile, "\n[ci:wait] all checks passed!\n");
    appendGateReport(ctx, "ci_wait", "pass", []);
    ctx.set("ciConclusion", "success");
    return { outcome: "success", outputs: { ciConclusion: "success" } };
  }

  if (conclusion === "cancelled") {
    await appendLog(logFile, "\n[ci:wait] CI was cancelled by user\n");
    appendGateReport(ctx, "ci_wait", "pass", ["CI cancelled by user"]);
    ctx.set("ciConclusion", "cancelled");
    return { outcome: "success", outputs: { ciConclusion: "cancelled" } };
  }

  // CI failed — gather annotations and logs for the fix agent
  const failedRuns = checkRuns.filter(cr =>
    cr.conclusion !== null && ["failure", "timed_out", "action_required"].includes(cr.conclusion)
  );

  await appendLog(logFile, `\n[ci:wait] ${String(failedRuns.length)} check(s) failed\n`);

  const allAnnotations: CIAnnotation[] = [];
  let logTail = "";

  if (deps.githubService) {
    const failureContext = await deps.githubService.collectCiFailureContext(owner, repo, checkRuns);
    for (const annotation of failureContext.failedAnnotations ?? []) {
      allAnnotations.push({
        file: annotation.path,
        line: annotation.line,
        message: annotation.message,
        level: annotation.level,
      });
    }
    logTail = failureContext.failedLogTail ?? "";
    if (!logTail && failureContext.primaryFailedRun) {
      await appendLog(logFile, "[ci:wait] could not download job log\n");
    }
  }

  const failedCheckCount = failedRuns.length;
  ctx.set("ciConclusion", "failure");
  ctx.set("ciAnnotations", allAnnotations);
  ctx.set("ciFailedRunNames", failedRuns.map((run) => run.name));
  ctx.set("ciLogTail", logTail);
  ctx.set("ciFailedCheckCount", failedCheckCount);

  const reasons = [
    `${String(failedCheckCount)} check(s) failed: ${failedRuns.map(r => r.name).join(", ")}`,
    ...allAnnotations.slice(0, 10).map(a => `${a.file}:${String(a.line)} — ${a.message}`)
  ];
  appendGateReport(ctx, "ci_wait", "hard_fail", reasons);

  // Build rawOutput for the fix agent (via on_failure loop)
  const rawParts: string[] = [];
  if (allAnnotations.length > 0) {
    rawParts.push("## Check Run Annotations\n");
    for (const a of allAnnotations) {
      rawParts.push(`- ${a.file}:${String(a.line)} — ${a.message}`);
    }
    rawParts.push("");
  }
  if (logTail) {
    rawParts.push("## Failed Job Log\n", logTail, "");
  }

  return {
    outcome: "failure",
    error: `CI failed: ${failedRuns.map(r => r.name).join(", ")}`,
    rawOutput: rawParts.join("\n"),
    outputs: { ciConclusion: "failure", ciFailedCheckCount: failedCheckCount }
  };
}
