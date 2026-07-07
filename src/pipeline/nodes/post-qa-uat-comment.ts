import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { appendLog } from "../shell.js";
import {
  buildQaUatMarker,
  hasQaUatHeader,
  hasQaUatInPullRequestBody,
  parseQaUatMarkerSha,
} from "../../work-items/qa-preparation-actions.js";

/**
 * Compose the sticky QA/UAT comment body: an invisible marker recording the PR
 * head SHA (so future runs can find and upsert this exact comment), the generated
 * plan, and a human-visible footer noting which commit it was generated for.
 */
export function buildStickyQaUatBody(qaUatComment: string, headSha: string): string {
  const marker = buildQaUatMarker(headSha);
  const parts = [marker, qaUatComment];
  if (headSha) {
    parts.push(`_QA/UAT updated for \`${headSha.slice(0, 7)}\`_`);
  }
  return parts.join("\n\n");
}

export async function postQaUatCommentNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps,
): Promise<NodeResult> {
  const githubService = deps.githubService;
  if (!githubService) {
    return { outcome: "failure", error: "post_qa_uat_comment requires GitHub service" };
  }
  if (!deps.run.repoSlug || !deps.run.prNumber) {
    return { outcome: "failure", error: "post_qa_uat_comment requires run repoSlug and prNumber" };
  }

  const pullRequest = await githubService.getPullRequest(deps.run.repoSlug, deps.run.prNumber);
  if (hasQaUatInPullRequestBody(pullRequest.body)) {
    await appendLog(deps.logFile, "[post_qa_uat_comment] skipped: PR description already has QA UAT\n");
    return { outcome: "skipped", outputs: { qaUatCommentPosted: false } };
  }

  const qaUatComment = ctx.getRequired<string>("qaUatComment").trim();
  if (!qaUatComment) {
    return { outcome: "failure", error: "qaUatComment is empty" };
  }

  const headSha = pullRequest.headSha ?? "";
  const body = buildStickyQaUatBody(qaUatComment, headSha);

  const comments = await githubService.listPullRequestDiscussionComments(deps.run.repoSlug, deps.run.prNumber);
  // Find the existing sticky comment to upsert: prefer one carrying our marker,
  // otherwise adopt a legacy (marker-less) QA/UAT comment so we never duplicate.
  const existing =
    comments.find((comment) => parseQaUatMarkerSha(comment.body) !== undefined) ??
    comments.find((comment) => hasQaUatHeader(comment.body));

  if (existing) {
    await githubService.updatePullRequestConversationComment({
      repoSlug: deps.run.repoSlug,
      commentId: existing.id,
      body,
    });
    await appendLog(deps.logFile, `[post_qa_uat_comment] updated sticky QA UAT comment ${existing.id}\n`);
    return { outcome: "success", outputs: { qaUatCommentPosted: true, qaUatCommentId: existing.id } };
  }

  await githubService.createPullRequestConversationComment({
    repoSlug: deps.run.repoSlug,
    prNumber: deps.run.prNumber,
    body,
  });
  await appendLog(deps.logFile, "[post_qa_uat_comment] posted QA UAT PR comment\n");

  return { outcome: "success", outputs: { qaUatCommentPosted: true } };
}
