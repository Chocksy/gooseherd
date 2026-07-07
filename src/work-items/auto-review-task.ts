export interface AutoReviewTaskInput {
  repo: string;
  prNumber: number;
  prUrl: string;
  jiraIssueKey?: string;
  title: string;
  summary?: string;
  maxBehindCommits?: number;
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
  lines.push("8. selectedFindings must list only actionable remaining problems, risks, or review findings that still apply to the current diff.");
  lines.push("9. ignoredFindings must list only reviewed hints or comments you intentionally ignored because they are stale, irrelevant, already fixed, or out of scope.");
  lines.push("10. If there are no issues, both arrays should be empty.");
  lines.push("11. Do not use selectedFindings or ignoredFindings as a changelog, test summary, or positive summary of the PR. Put that in rationale instead.");
  lines.push("12. Do not put environment or validation limitations in selectedFindings unless they reveal a concrete defect in the current diff. Mention blocked validation in rationale instead.");

  return lines.join("\n");
}

export function buildCiFixTask(input: AutoReviewTaskInput): string {
  const lines = [
    `Investigate and fix the currently failing CI for pull request #${String(input.prNumber)} in ${input.repo}.`,
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
  lines.push("1. Reuse the current PR branch. Do not create a new branch or a new PR.");
  lines.push("2. Focus on the failing CI signal for the current PR head and apply only the minimal code changes needed to make CI pass.");
  lines.push("3. Validate your fix before finishing.");
  lines.push("4. Do not merge the PR.");

  return lines.join("\n");
}

export function buildCiTriageTask(input: AutoReviewTaskInput): string {
  const lines = [
    `Investigate why CI is currently failing for pull request #${String(input.prNumber)} in ${input.repo}.`,
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
  lines.push("1. Read the prefetched \"CI Snapshot\" section in the context above (failed checks, annotations, log tail).");
  lines.push("2. Inspect the PR diff against the base branch (git diff origin/<base>...HEAD).");
  lines.push("3. Decide whether the failure is caused by code in this PR's diff, or by something unrelated (infrastructure, flaky/unrelated test, broken main branch, network, runner, DB setup, etc.).");
  lines.push("4. Do NOT modify any code. Do NOT push commits. Do NOT comment on the PR. Do NOT update labels.");
  lines.push("5. Before exiting, print exactly one line that starts with GOOSEHERD_CI_TRIAGE: followed by compact JSON: {\"verdict\":\"fix_needed\"|\"rerun\",\"reason\":\"...\",\"evidence\":[\"...\"]}");
  lines.push("");
  lines.push("Verdict rules:");
  lines.push("- \"fix_needed\" — the failure is plausibly caused by the PR's diff: the failing test/build references files in the diff, the error matches a behavior change in the diff, a new lint rule the diff introduced, etc.");
  lines.push("- \"rerun\" — the failure is unrelated to the diff: infra/runner problem, DB connection refused, timeout, OOM, image pull failed, flaky test that doesn't touch any file in the diff, broken main branch (failure exists on base too), etc.");
  lines.push("");
  lines.push("Examples:");
  lines.push("");
  lines.push("Example 1 — UNRELATED (verdict: rerun):");
  lines.push("");
  lines.push("  Tests / RSpec (40, 7) (pull_request) Failing after 16m");
  lines.push("  \"Run RSpec\" tail:");
  lines.push("    Failures:");
  lines.push("      1) OvertimePolicies::RestoreAction#call when policy is Archived ...");
  lines.push("         Failure/Error: before { OvertimePolicy.where(id: policy.id).update_all(policy_type: nil) }");
  lines.push("         ActiveRecord::NotNullViolation:");
  lines.push("           PG::NotNullViolation: ERROR:  null value in column \"policy_type\"");
  lines.push("           of relation \"overtime_policies\" violates not-null constraint");
  lines.push("");
  lines.push("  PR diff (only):");
  lines.push("    # app/controllers/user_invoices_controller.rb");
  lines.push("    -    redirect_url = request.referer.match?(index_path) || invoice.nil? ?");
  lines.push("    -      index_path : polymorphic_path(invoice)");
  lines.push("    +    redirect_url =");
  lines.push("    +      if invoice.nil? || request.referer.blank? || request.referer.match?(index_path)");
  lines.push("    +        index_path");
  lines.push("    +      else");
  lines.push("    +        polymorphic_path(invoice)");
  lines.push("    +      end");
  lines.push("");
  lines.push("  Reasoning: failing spec is in OvertimePolicies, PR only touches user_invoices_controller. No overlap.");
  lines.push("");
  lines.push("  GOOSEHERD_CI_TRIAGE: {\"verdict\":\"rerun\",\"reason\":\"Failing OvertimePolicies spec is unrelated to PR diff (only user_invoices_controller.rb changed)\",\"evidence\":[\"spec: OvertimePolicies::RestoreAction#call\",\"diff files: app/controllers/user_invoices_controller.rb\"]}");
  lines.push("");
  lines.push("Example 2 — UNRELATED INFRA (verdict: rerun):");
  lines.push("");
  lines.push("  Tests / Build Failing after 1m");
  lines.push("  \"Setup PostgreSQL\" tail:");
  lines.push("    psql: error: connection to server at \"localhost\" (127.0.0.1),");
  lines.push("    port 5432 failed: Connection refused");
  lines.push("    Is the server running on that host and accepting TCP/IP connections?");
  lines.push("");
  lines.push("  Reasoning: DB never started — pure infra. No diff inspection needed.");
  lines.push("");
  lines.push("  GOOSEHERD_CI_TRIAGE: {\"verdict\":\"rerun\",\"reason\":\"PostgreSQL service failed to start in CI runner\",\"evidence\":[\"psql: connection refused before any spec ran\"]}");
  lines.push("");
  lines.push("Example 3 — RELATED (verdict: fix_needed):");
  lines.push("");
  lines.push("  Tests / RSpec (12, 4) (pull_request) Failing after 8m");
  lines.push("  \"Run RSpec\" tail:");
  lines.push("    Failures:");
  lines.push("      1) UserInvoicesController#redirect_after_save when referer is blank");
  lines.push("         expected: index_path");
  lines.push("         got:      polymorphic_path(invoice)");
  lines.push("");
  lines.push("  PR diff:");
  lines.push("    # app/controllers/user_invoices_controller.rb");
  lines.push("    -    redirect_url = request.referer.match?(index_path) || invoice.nil? ? ...");
  lines.push("    +    redirect_url =");
  lines.push("    +      if invoice.nil? || request.referer.blank? || ...");
  lines.push("");
  lines.push("  Reasoning: failing spec is for UserInvoicesController#redirect_after_save, which is exactly the method modified in the diff.");
  lines.push("");
  lines.push("  GOOSEHERD_CI_TRIAGE: {\"verdict\":\"fix_needed\",\"reason\":\"Spec for UserInvoicesController#redirect_after_save fails; method changed in diff\",\"evidence\":[\"spec: UserInvoicesController#redirect_after_save when referer is blank\",\"diff file: app/controllers/user_invoices_controller.rb (same method)\"]}");

  return lines.join("\n");
}

export function buildBranchSyncTask(input: AutoReviewTaskInput): string {
  const maxBehindCommits = input.maxBehindCommits ?? 5;
  const lines = [
    `Bring pull request #${String(input.prNumber)} in ${input.repo} up to date with its base branch.`,
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
  lines.push(`1. Check whether the current PR branch is behind its base branch by more than ${String(maxBehindCommits)} commits.`);
  lines.push("2. If it is not behind enough, make no changes and exit cleanly.");
  lines.push("3. If it is behind enough, rebase the existing PR branch onto the current base branch.");
  lines.push("4. If conflicts arise, resolve them based on the actual semantics of the changes.");
  lines.push("5. Push the rebased branch back with --force-with-lease.");
  lines.push("6. Do not create a new branch, new PR, or unrelated code changes.");

  return lines.join("\n");
}

export function buildReadyForMergeTask(input: AutoReviewTaskInput): string {
  const lines = [
    `Prepare pull request #${String(input.prNumber)} in ${input.repo} for merge by reducing its PR branch to one commit.`,
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
  lines.push("1. Reuse the current PR branch. Do not create a new branch or a new PR.");
  lines.push("2. If the PR branch is already a single commit ahead of its base branch, make no changes and exit cleanly.");
  lines.push("3. Otherwise squash the PR branch changes into one deterministic commit.");
  lines.push("4. Push the squashed branch back with --force-with-lease.");
  lines.push("5. Do not merge the PR or add labels.");

  return lines.join("\n");
}

export function buildQaPreparationTask(input: AutoReviewTaskInput): string {
  const lines = [
    `Run QA preparation for pull request #${String(input.prNumber)} in ${input.repo}.`,
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
  lines.push("1. First prepare a meaningful QA UAT plan.");
  lines.push("2. Read the PR description, Jira/work-item context, and current branch diff.");
  lines.push("3. Produce a concise QA UAT plan tailored to the actual user-facing behavior and risk areas in this PR.");
  lines.push("4. Include concrete setup/data assumptions, happy-path checks, edge cases, regression checks, and acceptance signals where relevant.");
  lines.push("5. Do not change code, push commits, alter labels, or update the PR description.");
  lines.push("6. The pipeline will post your UAT as a PR discussion comment.");

  return lines.join("\n");
}
