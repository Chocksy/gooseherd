import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";

/**
 * Create PR node: create or update pull request via GitHub API.
 * Equivalent to executor.ts lines 462-488, 550-586.
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
  const prBody = buildPrBody(run, resolvedBaseBranch, config.appName, isFollowUp, gateReport);

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

function buildPrBody(
  run: { id: string; task: string; requestedBy: string; parentRunId?: string; feedbackNote?: string; chainIndex?: number },
  resolvedBaseBranch: string,
  appName: string,
  isFollowUp: boolean,
  gateReport?: Array<{ gate: string; verdict: string; reasons: string[] }>
): string {
  const lines = [
    "## Task",
    "",
    run.task,
    "",
    "## Details",
    "",
    `- **Base branch:** \`${resolvedBaseBranch}\``,
    `- **Requested by:** ${run.requestedBy}`,
    `- **Run:** \`${run.id.slice(0, 8)}\``,
  ];

  if (isFollowUp && run.parentRunId) {
    lines.push(
      "",
      "## Follow-up",
      "",
      `> ${run.feedbackNote ?? "retry"}`,
      "",
      `- **Previous run:** \`${run.parentRunId.slice(0, 8)}\``,
      `- **Chain depth:** ${String(run.chainIndex ?? 1)}`
    );
  }

  // Append quality gate report if any gates ran with warnings
  if (gateReport && gateReport.length > 0) {
    const warnings = gateReport.filter(g => g.verdict !== "pass" && g.reasons.length > 0);
    if (warnings.length > 0) {
      lines.push("", "## Quality Gates", "");
      for (const entry of gateReport) {
        const icon = entry.verdict === "pass" ? "\u2705" : entry.verdict === "soft_fail" ? "\u26A0\uFE0F" : "\u274C";
        lines.push(`- ${icon} **${entry.gate}**: ${entry.verdict}`);
        for (const reason of entry.reasons) {
          lines.push(`  - ${reason}`);
        }
      }
    }
  }

  lines.push(
    "",
    "---",
    `*Automated by [${appName}](https://goose-herd.com)*`
  );

  return lines.join("\n");
}
