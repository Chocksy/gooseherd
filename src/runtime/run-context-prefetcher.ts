import type { GitHubService, PullRequestCiSnapshot, PullRequestDiscussionComment, PullRequestDetails, PullRequestReview, PullRequestReviewComment } from "../github.js";
import type { JiraClient, JiraComment, JiraIssueDetails } from "../jira.js";
import type { RunPrefetchContext } from "./run-context-types.js";
import type { RunRecord } from "../types.js";
import type { WorkItemStore } from "../work-items/store.js";
import { GITHUB_PR_ADOPTED_FLAG, type WorkItemRecord } from "../work-items/types.js";

type GitHubDeps = Pick<
  GitHubService,
  | "getPullRequest"
  | "listPullRequestDiscussionComments"
  | "listPullRequestReviews"
  | "listUnresolvedReviewComments"
  | "getPullRequestCiSnapshot"
>;

type JiraDeps = Pick<JiraClient, "getIssue" | "getComments">;

type WorkItemDeps = Pick<WorkItemStore, "requireWorkItem">;
const MAX_COMMENT_ITEMS = 12;
const MAX_FAILED_ANNOTATIONS = 50;

export class RunContextPrefetcher {
  constructor(
    private readonly deps: {
      workItems: WorkItemDeps;
      github?: GitHubDeps;
      jira?: JiraDeps;
    }
  ) {}

  async prefetch(run: RunRecord, signal?: AbortSignal): Promise<RunPrefetchContext | undefined> {
    if (!run.workItemId) {
      return undefined;
    }

    const workItem = await this.deps.workItems.requireWorkItem(run.workItemId);
    const githubPrNumber = resolvePullRequestNumber(workItem);
    const hasGitHubSource = githubPrNumber !== undefined;
    const hasJiraSource = Boolean(workItem.jiraIssueKey);

    if (!hasGitHubSource && !hasJiraSource) {
      return undefined;
    }

    const prefetch: RunPrefetchContext = {
      meta: {
        fetchedAt: new Date().toISOString(),
        sources: [],
      },
      workItem: {
        id: workItem.id,
        title: workItem.title,
        workflow: workItem.workflow,
        state: workItem.state,
        isAdoptedPr: workItem.flags.includes(GITHUB_PR_ADOPTED_FLAG),
        flags: workItem.flags,
        jiraIssueKey: workItem.jiraIssueKey,
        githubPrUrl: workItem.githubPrUrl,
        githubPrNumber,
      },
    };

    if (hasGitHubSource) {
      prefetch.github = await this.fetchGitHubContext(run, workItem.id, githubPrNumber!, signal);
      prefetch.meta.sources.push("github_pr", "github_ci");
    }

    if (hasJiraSource) {
      prefetch.jira = await this.fetchJiraContext(workItem.id, workItem.jiraIssueKey!, signal);
      prefetch.meta.sources.push("jira");
    }

    return prefetch;
  }

  private async fetchGitHubContext(
    run: RunRecord,
    workItemId: string,
    prNumber: number,
    signal?: AbortSignal,
  ): Promise<RunPrefetchContext["github"]> {
    const github = this.deps.github;
    if (!github) {
      throw new Error(`GitHub prefetch failed for work item ${workItemId}: GitHub client is not configured`);
    }

    try {
      const pr = await github.getPullRequest(run.repoSlug, prNumber, signal);
      const headSha = requireHeadSha(pr, workItemId);
      const [discussionComments, reviews, reviewComments, ci] = await Promise.all([
        github.listPullRequestDiscussionComments(run.repoSlug, prNumber, signal),
        github.listPullRequestReviews(run.repoSlug, prNumber, signal),
        github.listUnresolvedReviewComments(run.repoSlug, prNumber, signal),
        github.getPullRequestCiSnapshot(run.repoSlug, headSha, signal),
      ]);

      return {
        pr: normalizePullRequest(pr),
        discussionCommentsTotalCount: discussionComments.length,
        discussionComments: normalizeDiscussionComments(discussionComments),
        reviewsTotalCount: reviews.length,
        reviews: normalizeReviews(reviews),
        reviewCommentsTotalCount: reviewComments.length,
        reviewComments: normalizeReviewComments(reviewComments),
        ci: normalizeCiSnapshot(ci),
      };
    } catch (error) {
      if (isAbortError(error, signal)) {
        throw new Error("Run cancelled");
      }
      throw new Error(
        `GitHub prefetch failed for work item ${workItemId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async fetchJiraContext(
    workItemId: string,
    issueKey: string,
    signal?: AbortSignal,
  ): Promise<RunPrefetchContext["jira"]> {
    const jira = this.deps.jira;
    if (!jira) {
      throw new Error(`Jira prefetch failed for work item ${workItemId}: Jira client is not configured`);
    }

    try {
      const [issue, comments] = await Promise.all([
        jira.getIssue(issueKey, signal),
        jira.getComments(issueKey, signal),
      ]);

      return {
        issue: normalizeJiraIssue(issue),
        commentsTotalCount: comments.length,
        comments: normalizeJiraComments(comments),
      };
    } catch (error) {
      if (isAbortError(error, signal)) {
        throw new Error("Run cancelled");
      }
      throw new Error(
        `Jira prefetch failed for work item ${workItemId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  return error instanceof Error && error.name === "AbortError";
}

function normalizePullRequest(pr: PullRequestDetails): NonNullable<RunPrefetchContext["github"]>["pr"] {
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    body: trimBody(pr.body),
    state: pr.state,
    baseRef: pr.baseRef,
    headRef: pr.headRef,
    headSha: pr.headSha,
    authorLogin: pr.authorLogin,
  };
}

function normalizeDiscussionComments(
  comments: PullRequestDiscussionComment[]
): NonNullable<RunPrefetchContext["github"]>["discussionComments"] {
  return latestN(
    comments
      .map((comment) => ({
        id: comment.id,
        authorLogin: comment.authorLogin,
        createdAt: comment.createdAt,
        body: trimBody(comment.body),
        url: comment.url,
      }))
      .sort(sortByCreatedAt),
    MAX_COMMENT_ITEMS
  );
}

function normalizeReviews(reviews: PullRequestReview[]): NonNullable<RunPrefetchContext["github"]>["reviews"] {
  return latestN(
    reviews
      .map((review) => ({
        id: review.id,
        authorLogin: review.authorLogin,
        createdAt: review.createdAt,
        state: review.state,
        body: trimBody(review.body),
        url: review.url,
      }))
      .sort(sortByCreatedAt),
    MAX_COMMENT_ITEMS
  );
}

function normalizeReviewComments(
  comments: PullRequestReviewComment[]
): NonNullable<RunPrefetchContext["github"]>["reviewComments"] {
  return latestN(
    comments
      .map((comment) => ({
        id: comment.id,
        authorLogin: comment.authorLogin,
        createdAt: comment.createdAt,
        body: trimBody(comment.body),
        path: comment.path,
        line: comment.line,
        side: comment.side,
        url: comment.url,
        threadResolved: false as const,
      }))
      .sort(sortByCreatedAt),
    MAX_COMMENT_ITEMS
  );
}

function normalizeCiSnapshot(ci: PullRequestCiSnapshot): NonNullable<RunPrefetchContext["github"]>["ci"] {
  const failedAnnotations = ci.failedAnnotations?.map((annotation) => ({
    checkRunName: annotation.checkRunName,
    path: annotation.path,
    line: annotation.line,
    message: trimBody(annotation.message),
    level: annotation.level,
  }));
  const normalized: NonNullable<RunPrefetchContext["github"]>["ci"] = {
    headSha: ci.headSha,
    conclusion: ci.conclusion,
    failedRuns: ci.failedRuns?.map((run) => ({
      id: run.id,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      detailsUrl: run.detailsUrl,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    })),
    primaryFailedRun: ci.primaryFailedRun
      ? {
          id: ci.primaryFailedRun.id,
          name: ci.primaryFailedRun.name,
          status: ci.primaryFailedRun.status,
          conclusion: ci.primaryFailedRun.conclusion,
          detailsUrl: ci.primaryFailedRun.detailsUrl,
          startedAt: ci.primaryFailedRun.startedAt,
          completedAt: ci.primaryFailedRun.completedAt,
        }
      : undefined,
    failedLogTail: ci.failedLogTail ? trimBody(ci.failedLogTail, 3000) : undefined,
  };

  if (failedAnnotations && failedAnnotations.length > 0) {
    normalized.failedAnnotations = latestN(failedAnnotations, MAX_FAILED_ANNOTATIONS);
    normalized.failedAnnotationsTotalCount = failedAnnotations.length;
  }

  return normalized;
}

function normalizeJiraIssue(issue: JiraIssueDetails): NonNullable<RunPrefetchContext["jira"]>["issue"] {
  return {
    key: issue.key,
    url: issue.url,
    summary: issue.summary,
    status: issue.status,
    description: trimBody(issue.description),
  };
}

function normalizeJiraComments(comments: JiraComment[]): NonNullable<RunPrefetchContext["jira"]>["comments"] {
  return latestN(
    comments
      .map((comment) => ({
        id: comment.id,
        authorDisplayName: comment.authorDisplayName,
        createdAt: comment.createdAt,
        body: trimBody(comment.body),
      }))
      .sort(sortByCreatedAt),
    MAX_COMMENT_ITEMS
  );
}

function requireHeadSha(pr: PullRequestDetails, workItemId: string): string {
  if (!pr.headSha) {
    throw new Error(`GitHub prefetch failed for work item ${workItemId}: pull request head SHA is missing`);
  }
  return pr.headSha;
}

function trimBody(body: string, maxChars = 2000): string {
  if (body.length <= maxChars) {
    return body;
  }
  const suffix = " [truncated]";
  if (maxChars <= suffix.length) {
    return body.slice(0, maxChars);
  }
  return `${body.slice(0, maxChars - suffix.length)}${suffix}`;
}

function latestN<T>(items: T[], maxItems: number): T[] {
  if (items.length <= maxItems) {
    return items;
  }
  return items.slice(items.length - maxItems);
}

function sortByCreatedAt<T extends { createdAt?: string }>(left: T, right: T): number {
  const leftCreatedAt = left.createdAt ?? "";
  const rightCreatedAt = right.createdAt ?? "";
  if (leftCreatedAt === rightCreatedAt) {
    return 0;
  }
  return leftCreatedAt < rightCreatedAt ? -1 : 1;
}

function resolvePullRequestNumber(workItem: Pick<WorkItemRecord, "id" | "githubPrNumber" | "githubPrUrl">): number | undefined {
  if (workItem.githubPrNumber !== undefined) {
    return workItem.githubPrNumber;
  }
  if (!workItem.githubPrUrl) {
    return undefined;
  }
  const match = workItem.githubPrUrl.match(/\/pull\/(\d+)(?:[/?#]|$)/);
  if (!match) {
    throw new Error(`GitHub prefetch failed for work item ${workItem.id}: could not parse pull request number from URL`);
  }
  return Number.parseInt(match[1]!, 10);
}
