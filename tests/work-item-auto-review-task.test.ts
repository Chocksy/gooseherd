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
});
