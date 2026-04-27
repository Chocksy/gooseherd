import type { PullRequestDetails, PullRequestDiscussionComment } from "../github.js";
import { logError } from "../logger.js";
import type { WorkItemRecord } from "./types.js";

export interface QaPreparationGitHubService {
  getPullRequest(repoSlug: string, prNumber: number): Promise<Pick<PullRequestDetails, "title" | "body">>;
  listPullRequestDiscussionComments(
    repoSlug: string,
    prNumber: number,
  ): Promise<Array<Pick<PullRequestDiscussionComment, "body">>>;
}

export const QA_UAT_HEADER_RE = /^#{2,6}\s+QA\s*(?:\/|-)?\s*UAT\b/im;

export class QaPreparationActions {
  constructor(private readonly deps: {
    githubService: QaPreparationGitHubService;
    queueQaPreparationRun: (workItemId: string, reason?: string) => Promise<WorkItemRecord | undefined> | WorkItemRecord | undefined | void;
  }) {}

  async handleEntry(workItem: WorkItemRecord): Promise<void> {
    if (workItem.workflow !== "feature_delivery" || workItem.state !== "qa_preparation") {
      return;
    }
    if (!workItem.repo || !workItem.githubPrNumber) {
      return;
    }

    try {
      const pullRequest = await this.deps.githubService.getPullRequest(workItem.repo, workItem.githubPrNumber);
      if (hasQaUatInPullRequestBody(pullRequest.body)) {
        return;
      }
      const comments = await this.deps.githubService.listPullRequestDiscussionComments(workItem.repo, workItem.githubPrNumber);
      if (hasQaUatInPullRequestConversationComments(comments)) {
        return;
      }

      await this.deps.queueQaPreparationRun(workItem.id, "qa_preparation.entered");
    } catch (error) {
      logError("Failed to start QA preparation", {
        workItemId: workItem.id,
        repo: workItem.repo,
        prNumber: workItem.githubPrNumber,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function hasQaUatInPullRequestBody(body: string | undefined): boolean {
  return hasQaUatHeader(body);
}

export function hasQaUatInPullRequestConversationComments(comments: Array<{ body?: string }>): boolean {
  return comments.some((comment) => hasQaUatHeader(comment.body));
}

export function hasQaUatHeader(value: string | undefined): boolean {
  return QA_UAT_HEADER_RE.test(value ?? "");
}
