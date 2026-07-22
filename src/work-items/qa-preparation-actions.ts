import type { PullRequestDetails, PullRequestDiscussionComment } from "../github.js";
import { logError } from "../logger.js";
import type { WorkItemRecord } from "./types.js";

export interface QaPreparationGitHubService {
  getPullRequest(repoSlug: string, prNumber: number): Promise<Pick<PullRequestDetails, "title" | "body" | "headSha">>;
  listPullRequestDiscussionComments(
    repoSlug: string,
    prNumber: number,
  ): Promise<Array<Pick<PullRequestDiscussionComment, "id" | "body">>>;
}

export const QA_UAT_HEADER_RE = /^#{2,6}\s+QA\s*(?:\/|-)?\s*UAT\b/im;

// Invisible marker embedded in the sticky QA/UAT comment so re-runs can find and
// upsert it, and record the PR head SHA it was generated for. Example:
//   <!-- hubble:qa-uat sha:0a1b2c3d... -->
const QA_UAT_MARKER_RE = /<!--\s*hubble:qa-uat\s+sha:([0-9a-fA-F]+)\s*-->/;

/** Build the invisible sticky-comment marker for a given PR head SHA. */
export function buildQaUatMarker(headSha: string): string {
  return `<!-- hubble:qa-uat sha:${headSha} -->`;
}

/** Extract the head SHA recorded in a sticky QA/UAT comment marker, if present. */
export function parseQaUatMarkerSha(value: string | undefined): string | undefined {
  const match = QA_UAT_MARKER_RE.exec(value ?? "");
  return match?.[1];
}

/** True when the comment carries a QA/UAT marker whose SHA matches `headSha`. */
export function isQaUatMarkerForHeadSha(value: string | undefined, headSha: string): boolean {
  if (!headSha) {
    return false;
  }
  const markerSha = parseQaUatMarkerSha(value);
  return markerSha !== undefined && markerSha.toLowerCase() === headSha.toLowerCase();
}

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
      const headSha = pullRequest.headSha ?? "";
      if (!headSha) {
        // Fail closed: an empty head SHA can never match a sticky marker, so queuing
        // would re-queue on every entry. Skip and let a later entry (with a resolved
        // SHA) decide, rather than spin a re-queue loop.
        logError("Skipping QA preparation: PR head SHA missing", {
          workItemId: workItem.id,
          repo: workItem.repo,
          prNumber: workItem.githubPrNumber,
        });
        return;
      }
      const comments = await this.deps.githubService.listPullRequestDiscussionComments(workItem.repo, workItem.githubPrNumber);
      // Skip ONLY when an up-to-date sticky UAT already exists (marker SHA == current
      // head SHA). A stale marker, a legacy (marker-less) comment, or no comment all
      // fall through and queue a run, which upserts the comment in place. Because the
      // upsert stamps the current head SHA, the next entry for the same SHA skips —
      // guarding against re-run loops.
      if (comments.some((comment) => isQaUatMarkerForHeadSha(comment.body, headSha))) {
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

/**
 * True when a marker-less QA/UAT comment can be attributed to us and is therefore
 * safe to adopt (upsert in place). A human- or third-party-authored comment with a
 * QA/UAT heading must NOT be adopted, or a deploy would overwrite it. Attribution is
 * by authorship: the comment's author must be our GitHub App bot (`<appSlug>[bot]`).
 * Marker-carrying comments are handled separately (they are always ours).
 */
export function isAdoptableLegacyQaUatComment(
  comment: { body?: string; authorLogin?: string },
  botLogin: string | undefined,
): boolean {
  if (!hasQaUatHeader(comment.body)) {
    return false;
  }
  if (!botLogin) {
    return false;
  }
  return (comment.authorLogin ?? "").toLowerCase() === botLogin.toLowerCase();
}
