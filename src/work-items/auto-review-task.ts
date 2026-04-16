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
  lines.push("1. Collect current PR/work-item context before changing code.");
  lines.push("2. Inspect CI and identify failing jobs or other active signals that matter for the self-review.");
  lines.push("3. Review actionable PR comments from other reviewers or the author when they are relevant to the current diff.");
  lines.push("4. Perform a self-review of the current diff and branch state.");
  lines.push("5. Apply the minimal fixes needed to address concrete problems you find.");
  lines.push("6. Validate and push when there are code changes.");
  lines.push("7. Do not merge the PR.");

  return lines.join("\n");
}
