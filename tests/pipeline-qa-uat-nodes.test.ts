import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ContextBag } from "../src/pipeline/context-bag.js";
import { normalizeQaUatComment } from "../src/pipeline/nodes/generate-qa-uat.js";
import { postQaUatCommentNode } from "../src/pipeline/nodes/post-qa-uat-comment.js";
import type { NodeDeps } from "../src/pipeline/types.js";

function makeDeps(input: {
  prBody: string;
  comments?: Array<{ body: string }>;
  onComment?: (body: string) => void;
}): NodeDeps {
  const tmpLog = path.join(os.tmpdir(), `gooseherd-qa-uat-node-${String(Date.now())}.log`);
  return {
    config: { appName: "gooseherd-test" },
    run: {
      id: "run-1",
      repoSlug: "hubstaff/gooseherd",
      prNumber: 123,
      task: "Prepare QA UAT",
    },
    githubService: {
      getPullRequest: async () => ({
        number: 123,
        url: "https://github.com/hubstaff/gooseherd/pull/123",
        title: "Add export",
        body: input.prBody,
        state: "open",
      }),
      createPullRequestConversationComment: async ({ body }) => {
        input.onComment?.(body);
      },
      listPullRequestDiscussionComments: async () => input.comments ?? [],
    },
    logFile: tmpLog,
    workRoot: os.tmpdir(),
    onPhase: async () => {},
  } as NodeDeps;
}

test("postQaUatCommentNode posts generated QA UAT as a PR discussion comment", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gooseherd-qa-uat-node-"));
  const logFile = path.join(tmpDir, "run.log");
  const posted: string[] = [];
  const deps = {
    ...makeDeps({
      prBody: "## Summary\n\nAdds export.",
      onComment: (body) => posted.push(body),
    }),
    logFile,
  };
  const ctx = new ContextBag({ qaUatComment: "## QA UAT\n\n- Verify export." });

  const result = await postQaUatCommentNode({ id: "post", type: "deterministic", action: "post_qa_uat_comment" }, ctx, deps);

  assert.equal(result.outcome, "success");
  assert.deepEqual(posted, ["## QA UAT\n\n- Verify export."]);
  assert.match(await readFile(logFile, "utf8"), /posted QA UAT PR comment/);
});

test("postQaUatCommentNode skips when PR description already has QA UAT", async () => {
  const posted: string[] = [];
  const deps = makeDeps({
    prBody: "## QA UAT\n\n- Existing checks.",
    onComment: (body) => posted.push(body),
  });
  const ctx = new ContextBag({ qaUatComment: "## QA UAT\n\n- Verify export." });

  const result = await postQaUatCommentNode({ id: "post", type: "deterministic", action: "post_qa_uat_comment" }, ctx, deps);

  assert.equal(result.outcome, "skipped");
  assert.deepEqual(posted, []);
});

test("postQaUatCommentNode skips when a previous PR comment already has QA UAT", async () => {
  const posted: string[] = [];
  const deps = makeDeps({
    prBody: "## Summary\n\nAdds export.",
    comments: [{ body: "## QA UAT\n\n- Existing checks." }],
    onComment: (body) => posted.push(body),
  });
  const ctx = new ContextBag({ qaUatComment: "## QA UAT\n\n- Verify export." });

  const result = await postQaUatCommentNode({ id: "post", type: "deterministic", action: "post_qa_uat_comment" }, ctx, deps);

  assert.equal(result.outcome, "skipped");
  assert.deepEqual(posted, []);
});

test("normalizeQaUatComment does not duplicate non-level-two QA UAT headers", () => {
  assert.equal(normalizeQaUatComment("### QA UAT\n\n- Verify export."), "### QA UAT\n\n- Verify export.");
});
