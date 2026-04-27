import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import type { AgentAnalysis, AutoReviewGroundingMetrics } from "./implement.js";
import { hasReusableBranch } from "../branch-reuse.js";
import { filterInternalGeneratedFiles } from "../internal-generated-files.js";

/**
 * Create PR node: create or update pull request via GitHub API.
 */
export async function createPrNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const config = deps.config;
  const run = deps.run;
  const isFollowUp = ctx.get<boolean>("isFollowUp") ?? false;
  const reusesExistingBranch = ctx.get<boolean>("reusesExistingBranch") ?? hasReusableBranch(run);
  const isAdoptedPr = deps.run.prefetchContext?.workItem.isAdoptedPr ?? false;
  const preservesExistingPrTitle = typeof run.workItemId === "string" && run.workItemId.length > 0;
  const resolvedBaseBranch = ctx.get<string>("resolvedBaseBranch") ?? run.baseBranch;
  const dryRun = config.dryRun;

  if (dryRun || !deps.githubService) {
    return { outcome: "success" };
  }

  const titleText = run.title ?? ctx.get<string>("generatedTitle") ?? run.task.slice(0, 80);
  const prTitle = `${config.appSlug}: ${titleText}`;
  const gateReport = ctx.get<Array<{ gate: string; verdict: string; reasons: string[] }>>("gateReport");
  const agentAnalysis = ctx.get<AgentAnalysis>("agentAnalysis");
  const autoReviewGroundingMetrics = ctx.get<AutoReviewGroundingMetrics>("autoReviewGroundingMetrics");
  const commitSha = ctx.get<string>("commitSha");
  const changedFiles = ctx.get<string[]>("changedFiles");

  const changeSummary = ctx.get<string>("changeSummary");

  // Screenshot/video URLs are not available at PR creation time — they get added
  // later by upload_screenshot node after browser_verify captures them.
  const prBody = buildPrBody(
    run, resolvedBaseBranch, config.appName, isFollowUp,
    gateReport, agentAnalysis, commitSha, changedFiles,
    undefined, undefined, undefined, changeSummary, autoReviewGroundingMetrics
  );

  const prResult = reusesExistingBranch
    ? await deps.githubService.findOrCreatePullRequest({
        repoSlug: run.repoSlug,
        title: prTitle,
        body: prBody,
        updateExistingTitle: !preservesExistingPrTitle,
        updateExistingBody: !isAdoptedPr,
        head: run.branchName,
        base: resolvedBaseBranch
      })
    : await deps.githubService.createPullRequest({
        repoSlug: run.repoSlug,
        title: prTitle,
        body: prBody,
        head: run.branchName,
        base: resolvedBaseBranch
      });

  ctx.set("prUrl", prResult.url);
  ctx.set("prNumber", prResult.number);

  return {
    outcome: "success",
    outputs: { prUrl: prResult.url, prNumber: prResult.number }
  };
}

export function buildPrBody(
  run: { id: string; task: string; requestedBy: string; parentRunId?: string; feedbackNote?: string; chainIndex?: number },
  resolvedBaseBranch: string,
  appName: string,
  isFollowUp: boolean,
  gateReport?: Array<{ gate: string; verdict: string; reasons: string[] }>,
  agentAnalysis?: AgentAnalysis,
  commitSha?: string,
  changedFiles?: string[],
  screenshotUrl?: string,
  videoUrl?: string,
  videoEmbedUrl?: string,
  changeSummary?: string,
  autoReviewGroundingMetrics?: AutoReviewGroundingMetrics
): string {
  const lines: string[] = [];

  // ── Task description ──
  // Prefer changeSummary (LLM-generated, human-readable) over raw task (may contain HTML/code).
  const taskDisplay = changeSummary
    ? changeSummary
    : formatTaskDescription(run.task);
  lines.push("## Task", "", taskDisplay, "");

  // ── Follow-up context ──
  if (isFollowUp && run.parentRunId) {
    lines.push(
      "## Follow-up",
      "",
      `> ${run.feedbackNote ?? "retry"}`,
      "",
      `- **Previous run:** \`${run.parentRunId.slice(0, 8)}\``,
      `- **Chain depth:** ${String(run.chainIndex ?? 1)}`,
      ""
    );
  }

  // ── What changed ──
  lines.push("## What changed", "");

  if (agentAnalysis) {
    lines.push(
      `**${String(agentAnalysis.diffStats.filesCount)}** files changed — ` +
      `**+${String(agentAnalysis.diffStats.added)}** / **-${String(agentAnalysis.diffStats.removed)}** lines`,
      ""
    );
  }

  const filesToShow = filterInternalGeneratedFiles(changedFiles ?? agentAnalysis?.filesChanged ?? []);
  if (filesToShow.length > 0 && filesToShow.length <= 30) {
    lines.push("| File |", "|------|");
    for (const file of filesToShow) {
      lines.push(`| \`${file}\` |`);
    }
    lines.push("");
  } else if (filesToShow.length > 30) {
    lines.push(`<details><summary>${String(filesToShow.length)} files changed (click to expand)</summary>`, "");
    for (const file of filesToShow) {
      lines.push(`- \`${file}\``);
    }
    lines.push("", "</details>", "");
  }

  if (agentAnalysis?.signals && agentAnalysis.signals.length > 0) {
    const meaningful = agentAnalysis.signals.filter(s => !/timeout/i.test(s));
    if (meaningful.length > 0) {
      lines.push("**Signals detected:**", "");
      for (const signal of meaningful) {
        lines.push(`- ${signal}`);
      }
      lines.push("");
    }
  }

  if (autoReviewGroundingMetrics && autoReviewGroundingMetrics.selectedFindingCount > 0) {
    const overlapPercent = Math.round(autoReviewGroundingMetrics.selectedFindingOverlapRatio * 100);
    lines.push(
      "**Auto-review grounding (heuristic):**",
      "",
      `- Selected findings overlapping changed-file tokens: ${String(autoReviewGroundingMetrics.selectedFindingOverlapCount)}/${String(autoReviewGroundingMetrics.selectedFindingCount)} (${String(overlapPercent)}%)`,
      ""
    );
  }

  // ── Quality gates (always show all, not just warnings) ──
  if (gateReport && gateReport.length > 0) {
    lines.push("## Verification", "");
    for (const entry of gateReport) {
      const icon = entry.verdict === "pass" ? "\u2705" : entry.verdict === "soft_fail" ? "\u26A0\uFE0F" : "\u274C";
      lines.push(`${icon} **${formatGateName(entry.gate)}** — ${entry.verdict}`);
      if (entry.reasons.length > 0) {
        for (const reason of entry.reasons) {
          lines.push(`  - ${reason}`);
        }
      }
    }
    lines.push("");
  }

  // ── Visual Evidence ──
  if (screenshotUrl || videoUrl) {
    lines.push("## Visual Evidence", "");
    if (screenshotUrl) {
      lines.push(`![Screenshot](${screenshotUrl})`, "");
    }
    if (videoUrl) {
      lines.push("### Verification Video", "");
      if (videoEmbedUrl) {
        lines.push(`<video src="${videoEmbedUrl}" controls muted playsinline preload="metadata" style="max-width: 100%;"></video>`, "");
      }
      lines.push(`[View verification video](${videoUrl})`, "");
    }
  }

  // ── Run metadata ──
  lines.push("## Details", "");
  lines.push(
    `| Field | Value |`,
    `|-------|-------|`,
    `| **Base branch** | \`${resolvedBaseBranch}\` |`,
    `| **Requested by** | ${run.requestedBy} |`,
    `| **Run ID** | \`${run.id.slice(0, 8)}\` |`
  );
  if (commitSha) {
    lines.push(`| **Commit** | \`${commitSha.slice(0, 12)}\` |`);
  }
  if (agentAnalysis) {
    lines.push(`| **Verdict** | ${agentAnalysis.verdict} |`);
  }
  lines.push("");

  // ── Footer ──
  lines.push(
    "---",
    `*Automated by [${appName}](https://goose-herd.com)*`
  );

  return lines.join("\n");
}

/**
 * Format task description for PR body.
 * Handles tasks with embedded code/HTML by truncating and wrapping in a details block.
 */
function formatTaskDescription(task: string): string {
  // If task contains HTML/code blocks, show a truncated version with expandable details
  const hasCode = /<[a-z][\s\S]*>/i.test(task) || /```/.test(task);
  if (hasCode && task.length > 300) {
    // Extract first meaningful line as summary
    const firstLine = task.split("\n").find(l => l.trim() && !l.trim().startsWith("<") && !l.trim().startsWith("```"))
      ?? task.slice(0, 100);
    return [
      firstLine.trim(),
      "",
      "<details><summary>Full task description</summary>",
      "",
      "```",
      task,
      "```",
      "",
      "</details>"
    ].join("\n");
  }

  // Detect numbered requirements (e.g. "1. Do X 2. Do Y") and format as list
  const firstItemMatch = /(?:^|\s)1\.\s/.exec(task);
  if (!firstItemMatch) return task;

  const afterFirst = task.slice(firstItemMatch.index);
  if (!/\s2\.\s/.test(afterFirst)) return task;

  const preamble = task.slice(0, firstItemMatch.index).replace(/\s+$/, "");
  const itemRegex = /(\d+)\.\s+((?:(?!\s\d+\.\s).)*)/g;
  const items: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(afterFirst)) !== null) {
    const text = match[2]!.replace(/\.\s*$/, "").trim();
    items.push(`${match[1]}. ${text}`);
  }

  if (items.length < 2) return task;

  const lines = preamble ? [preamble, "", ...items] : items;
  return lines.join("\n");
}

/** Format gate machine names for display: security_scan → Security Scan */
function formatGateName(gate: string): string {
  return gate.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}
