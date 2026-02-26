import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import type { AgentAnalysis } from "./implement.js";

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
  const resolvedBaseBranch = ctx.get<string>("resolvedBaseBranch") ?? run.baseBranch;
  const dryRun = config.dryRun;

  if (dryRun || !deps.githubService) {
    return { outcome: "success" };
  }

  const prTitle = `${config.appSlug}: ${run.task.slice(0, 80)}`;
  const gateReport = ctx.get<Array<{ gate: string; verdict: string; reasons: string[] }>>("gateReport");
  const agentAnalysis = ctx.get<AgentAnalysis>("agentAnalysis");
  const commitSha = ctx.get<string>("commitSha");
  const changedFiles = ctx.get<string[]>("changedFiles");
  const screenshotUrl = config.dashboardPublicUrl
    ? `${config.dashboardPublicUrl}/api/runs/${run.id}/artifacts/screenshot.png`
    : undefined;

  const prBody = buildPrBody(
    run, resolvedBaseBranch, config.appName, isFollowUp,
    gateReport, agentAnalysis, commitSha, changedFiles, screenshotUrl
  );

  const prResult = isFollowUp
    ? await deps.githubService.findOrCreatePullRequest({
        repoSlug: run.repoSlug,
        title: prTitle,
        body: prBody,
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
  screenshotUrl?: string
): string {
  const lines: string[] = [];

  // ── Task description ──
  lines.push("## Task", "", run.task, "");

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

  const filesToShow = changedFiles ?? agentAnalysis?.filesChanged ?? [];
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
    lines.push("**Signals detected:**", "");
    for (const signal of agentAnalysis.signals) {
      lines.push(`- ${signal}`);
    }
    lines.push("");
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

  // ── Screenshot ──
  if (screenshotUrl) {
    lines.push(
      "## Screenshot",
      "",
      `![Screenshot](${screenshotUrl})`,
      ""
    );
  }

  // ── Run metadata ──
  lines.push("## Details", "");
  lines.push(
    `| | |`,
    `|---|---|`,
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

/** Format gate machine names for display: security_scan → Security Scan */
function formatGateName(gate: string): string {
  return gate.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}
