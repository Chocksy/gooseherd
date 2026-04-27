import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { appendLog } from "../shell.js";
import { hasQaUatInPullRequestBody, hasQaUatInPullRequestConversationComments } from "../../work-items/qa-preparation-actions.js";

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
  const comments = await githubService.listPullRequestDiscussionComments(deps.run.repoSlug, deps.run.prNumber);
  if (hasQaUatInPullRequestConversationComments(comments)) {
    await appendLog(deps.logFile, "[post_qa_uat_comment] skipped: PR conversation already has QA UAT\n");
    return { outcome: "skipped", outputs: { qaUatCommentPosted: false } };
  }

  const qaUatComment = ctx.getRequired<string>("qaUatComment").trim();
  if (!qaUatComment) {
    return { outcome: "failure", error: "qaUatComment is empty" };
  }

  await githubService.createPullRequestConversationComment({
    repoSlug: deps.run.repoSlug,
    prNumber: deps.run.prNumber,
    body: qaUatComment,
  });
  await appendLog(deps.logFile, "[post_qa_uat_comment] posted QA UAT PR comment\n");

  return { outcome: "success", outputs: { qaUatCommentPosted: true } };
}
