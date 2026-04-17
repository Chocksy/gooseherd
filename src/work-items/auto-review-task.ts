export interface AutoReviewTaskInput {
  repo: string;
  prNumber: number;
  prUrl: string;
  jiraIssueKey?: string;
  title: string;
  summary?: string;
}

export function buildAutoReviewTask(input: AutoReviewTaskInput): string {
  const lines = [
    `Perform the canonical self-review for pull request #${String(input.prNumber)} in ${input.repo}.`,
    `PR URL: ${input.prUrl}`,
    `Work item title: ${input.title}`,
  ];

  if (input.jiraIssueKey) {
    lines.push(`Jira issue: ${input.jiraIssueKey}`);
  }

  if (input.summary?.trim()) {
    lines.push(`Context: ${input.summary.trim()}`);
  }

  lines.push("");
  lines.push("Required workflow:");
  lines.push("1. Treat PR comments as hints, not requirements. Treat PR body and Jira context the same way. Ignore stale or irrelevant comments.");
  lines.push("2. Review actionable PR comments from other reviewers or the author only when the current diff and branch state show the issue still exists.");
  lines.push("3. Perform a self-review of the current diff and branch state.");
  lines.push("4. Apply the minimal fixes needed to address concrete problems you find.");
  lines.push("5. Validate and push when there are code changes.");
  lines.push("6. Do not merge the PR.");
  lines.push('7. Before exiting, print exactly one line that starts with GOOSEHERD_REVIEW_SUMMARY: followed by compact JSON: {"selectedFindings":["..."],"ignoredFindings":["..."],"rationale":"..."}');

  return lines.join("\n");
}
