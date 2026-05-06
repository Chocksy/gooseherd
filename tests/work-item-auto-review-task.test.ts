import assert from "node:assert/strict";
import test from "node:test";

test("auto review task renderer includes repo, PR metadata, Jira key, and title", async () => {
  const { buildAutoReviewTask } = await import("../src/work-items/auto-review-task.js");
  const prNumber = 4077;
  const prUrl = `https://github.com/hubstaff/gooseherd/pull/${prNumber}`;

  const rendered = buildAutoReviewTask({
    repo: "hubstaff/gooseherd",
    prNumber,
    prUrl,
    jiraIssueKey: "HBL-404",
    title: "Add auto-review orchestration",
  });

  assert.ok(rendered.includes("hubstaff/gooseherd"));
  assert.ok(rendered.includes(prUrl));
  assert.match(rendered.replace(prUrl, ""), new RegExp(`\\b${prNumber}\\b`));
  assert.ok(rendered.includes("HBL-404"));
  assert.ok(rendered.includes("Add auto-review orchestration"));
  assert.match(rendered, /review actionable pr comments/i);
  assert.match(rendered, /comments .* hints, not requirements/i);
  assert.match(rendered, /ignore stale or irrelevant comments/i);
  assert.match(rendered, /perform a self-review of the current diff/i);
  assert.match(rendered, /apply the minimal fixes needed/i);
  assert.match(rendered, /validate and push/i);
  assert.match(rendered, /do not merge the pr/i);
  assert.match(rendered, /GOOSEHERD_REVIEW_SUMMARY/);
  assert.match(rendered, /selectedFindings/i);
  assert.match(rendered, /ignoredFindings/i);
  assert.match(rendered, /rationale/i);
  assert.match(rendered, /selectedFindings .* only .*actionable/i);
  assert.match(rendered, /ignoredFindings .* stale.*irrelevant/i);
  assert.match(rendered, /if there are no issues, both arrays should be empty/i);
  assert.match(rendered, /do not use .* selectedFindings .* changelog|do not use .* ignoredFindings .* changelog/i);
  assert.match(rendered, /do not put .*environment.*validation.*selectedFindings/i);
});

test("ci fix task renderer includes repo, PR metadata, Jira key, and branch reuse constraints", async () => {
  const { buildCiFixTask } = await import("../src/work-items/auto-review-task.js");
  const prNumber = 4078;
  const prUrl = `https://github.com/hubstaff/gooseherd/pull/${prNumber}`;

  const rendered = buildCiFixTask({
    repo: "hubstaff/gooseherd",
    prNumber,
    prUrl,
    jiraIssueKey: "HBL-405",
    title: "Fix CI for adopted PR",
    summary: "CI is already red on the current PR head",
  });

  assert.ok(rendered.includes("hubstaff/gooseherd"));
  assert.ok(rendered.includes(prUrl));
  assert.match(rendered.replace(prUrl, ""), new RegExp(`\\b${prNumber}\\b`));
  assert.ok(rendered.includes("HBL-405"));
  assert.ok(rendered.includes("Fix CI for adopted PR"));
  assert.match(rendered, /fix the currently failing ci/i);
  assert.match(rendered, /reuse the current PR branch/i);
  assert.match(rendered, /do not create .* new branch/i);
  assert.match(rendered, /do not create .* new PR/i);
  assert.match(rendered, /do not merge the PR/i);
});

test("ci triage task renderer instructs the agent to classify, not to modify", async () => {
  const { buildCiTriageTask } = await import("../src/work-items/auto-review-task.js");
  const prNumber = 4079;
  const prUrl = `https://github.com/hubstaff/gooseherd/pull/${prNumber}`;

  const rendered = buildCiTriageTask({
    repo: "hubstaff/gooseherd",
    prNumber,
    prUrl,
    jiraIssueKey: "HBL-406",
    title: "Triage failing CI",
  });

  assert.ok(rendered.includes("hubstaff/gooseherd"));
  assert.ok(rendered.includes(prUrl));
  assert.ok(rendered.includes("HBL-406"));
  assert.match(rendered, /investigate why ci is currently failing/i);
  assert.match(rendered, /CI Snapshot/);
  assert.match(rendered, /git diff origin/);
  assert.match(rendered, /do not modify any code/i);
  assert.match(rendered, /do not push commits/i);
  assert.match(rendered, /GOOSEHERD_CI_TRIAGE/);
  assert.match(rendered, /"verdict"/);
  assert.match(rendered, /fix_needed/);
  assert.match(rendered, /"rerun"/);
  // Examples present
  assert.match(rendered, /Example 1.*UNRELATED.*rerun/i);
  assert.match(rendered, /Example 2.*INFRA.*rerun/i);
  assert.match(rendered, /Example 3.*RELATED.*fix_needed/i);
});
