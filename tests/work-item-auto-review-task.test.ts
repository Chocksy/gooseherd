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
  assert.match(rendered, /collect current pr\/work-item context/i);
  assert.match(rendered, /inspect ci and identify failing jobs/i);
  assert.match(rendered, /review actionable pr comments/i);
  assert.match(rendered, /perform a self-review of the current diff/i);
  assert.match(rendered, /apply the minimal fixes needed/i);
  assert.match(rendered, /validate and push/i);
  assert.match(rendered, /do not merge the pr/i);
});
