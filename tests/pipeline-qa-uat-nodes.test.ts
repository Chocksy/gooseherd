import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ContextBag } from "../src/pipeline/context-bag.js";
import { normalizeQaUatComment } from "../src/pipeline/nodes/generate-qa-uat.js";
import { buildStickyQaUatBody, postQaUatCommentNode } from "../src/pipeline/nodes/post-qa-uat-comment.js";
import { buildQaUatMarker, parseQaUatMarkerSha } from "../src/work-items/qa-preparation-actions.js";
import type { NodeDeps } from "../src/pipeline/types.js";

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

interface CommentRecord {
  id: string;
  body: string;
}

function makeDeps(input: {
  prBody: string;
  headSha?: string;
  comments?: CommentRecord[];
  created?: string[];
  updated?: Array<{ commentId: string; body: string }>;
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
        headSha: input.headSha ?? HEAD_SHA,
      }),
      createPullRequestConversationComment: async ({ body }) => {
        input.created?.push(body);
      },
      updatePullRequestConversationComment: async ({ commentId, body }) => {
        input.updated?.push({ commentId, body });
      },
      listPullRequestDiscussionComments: async () => input.comments ?? [],
    },
    logFile: tmpLog,
    workRoot: os.tmpdir(),
    onPhase: async () => {},
  } as unknown as NodeDeps;
}

test("postQaUatCommentNode creates a sticky QA UAT comment with a marker and footer", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gooseherd-qa-uat-node-"));
  const logFile = path.join(tmpDir, "run.log");
  const created: string[] = [];
  const updated: Array<{ commentId: string; body: string }> = [];
  const deps = {
    ...makeDeps({ prBody: "## Summary\n\nAdds export.", created, updated }),
    logFile,
  };
  const ctx = new ContextBag({ qaUatComment: "## QA UAT\n\n- Verify export." });

  const result = await postQaUatCommentNode({ id: "post", type: "deterministic", action: "post_qa_uat_comment" }, ctx, deps);

  assert.equal(result.outcome, "success");
  assert.equal(created.length, 1);
  assert.equal(updated.length, 0);
  assert.match(created[0], /<!-- hubble:qa-uat sha:0123456789abcdef0123456789abcdef01234567 -->/);
  assert.match(created[0], /## QA UAT/);
  assert.match(created[0], /_QA\/UAT updated for `0123456`_/);
  assert.match(await readFile(logFile, "utf8"), /posted QA UAT PR comment/);
});

test("postQaUatCommentNode updates the existing sticky comment in place (same id)", async () => {
  const created: string[] = [];
  const updated: Array<{ commentId: string; body: string }> = [];
  const comments: CommentRecord[] = [
    { id: "555", body: `${buildQaUatMarker("oldsha0")}\n\n## QA UAT\n\n- Old checks.\n\n_QA/UAT updated for \`oldsha0\`_` },
  ];
  const deps = makeDeps({ prBody: "## Summary\n\nAdds export.", comments, created, updated });
  const ctx = new ContextBag({ qaUatComment: "## QA UAT\n\n- Fresh checks." });

  const result = await postQaUatCommentNode({ id: "post", type: "deterministic", action: "post_qa_uat_comment" }, ctx, deps);

  assert.equal(result.outcome, "success");
  assert.equal(result.outputs?.qaUatCommentId, "555");
  assert.equal(created.length, 0);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].commentId, "555");
  assert.equal(parseQaUatMarkerSha(updated[0].body), HEAD_SHA);
  assert.match(updated[0].body, /- Fresh checks\./);
});

test("postQaUatCommentNode adopts a legacy marker-less QA UAT comment instead of duplicating", async () => {
  const created: string[] = [];
  const updated: Array<{ commentId: string; body: string }> = [];
  const comments: CommentRecord[] = [
    { id: "777", body: "## QA UAT\n\n- Legacy checks from before the marker existed." },
  ];
  const deps = makeDeps({ prBody: "## Summary\n\nAdds export.", comments, created, updated });
  const ctx = new ContextBag({ qaUatComment: "## QA UAT\n\n- Verify export." });

  const result = await postQaUatCommentNode({ id: "post", type: "deterministic", action: "post_qa_uat_comment" }, ctx, deps);

  assert.equal(result.outcome, "success");
  assert.equal(created.length, 0);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].commentId, "777");
  assert.equal(parseQaUatMarkerSha(updated[0].body), HEAD_SHA);
});

test("postQaUatCommentNode skips when PR description already has QA UAT", async () => {
  const created: string[] = [];
  const updated: Array<{ commentId: string; body: string }> = [];
  const deps = makeDeps({ prBody: "## QA UAT\n\n- Existing checks.", created, updated });
  const ctx = new ContextBag({ qaUatComment: "## QA UAT\n\n- Verify export." });

  const result = await postQaUatCommentNode({ id: "post", type: "deterministic", action: "post_qa_uat_comment" }, ctx, deps);

  assert.equal(result.outcome, "skipped");
  assert.equal(created.length, 0);
  assert.equal(updated.length, 0);
});

test("buildStickyQaUatBody embeds the marker and footer", () => {
  const body = buildStickyQaUatBody("## QA UAT\n\n- Verify export.", HEAD_SHA);
  assert.equal(parseQaUatMarkerSha(body), HEAD_SHA);
  assert.match(body, /_QA\/UAT updated for `0123456`_/);
});

test("normalizeQaUatComment does not duplicate non-level-two QA UAT headers", () => {
  assert.equal(normalizeQaUatComment("### QA UAT\n\n- Verify export."), "### QA UAT\n\n- Verify export.");
});
