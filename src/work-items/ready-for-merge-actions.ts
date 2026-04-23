import type { GitHubService } from "../github.js";
import { logError } from "../logger.js";
import { sleep } from "../utils/sleep.js";
import type { WorkItemRecord } from "./types.js";

const AUTOMERGE_LABEL = "automerge";
const READY_FOR_MERGE_GITHUB_MAX_ATTEMPTS = 3;
const READY_FOR_MERGE_GITHUB_RETRY_DELAY_MS = 50;

interface ReadyForMergeActionsDeps {
  githubService: Pick<GitHubService, "getPullRequest" | "addPullRequestLabels">;
  queueReadyForMergeRun: (workItemId: string, reason?: string) => Promise<unknown>;
}

export class ReadyForMergeActions {
  constructor(private readonly deps: ReadyForMergeActionsDeps) {}

  async handleEntry(workItem: WorkItemRecord): Promise<void> {
    if (workItem.workflow !== "feature_delivery" || workItem.state !== "ready_for_merge") {
      return;
    }

    if (!workItem.repo || !workItem.githubPrNumber) {
      throw new Error(`Ready-for-merge actions require a linked GitHub pull request for work item ${workItem.id}`);
    }

    try {
      const pullRequest = await retryGitHubAction(() =>
        this.deps.githubService.getPullRequest(workItem.repo!, workItem.githubPrNumber!),
      );
      if (pullRequest.state !== "open") {
        return;
      }

      if ((pullRequest.commitsCount ?? 0) > 1) {
        await this.deps.queueReadyForMergeRun(workItem.id, "ready_for_merge.entered");
        return;
      }

      const labels = new Set((pullRequest.labels ?? []).map((label) => label.trim().toLowerCase()));
      if (labels.has(AUTOMERGE_LABEL)) {
        return;
      }

      await retryGitHubAction(() => this.deps.githubService.addPullRequestLabels({
        repoSlug: workItem.repo!,
        prNumber: workItem.githubPrNumber!,
        labels: [AUTOMERGE_LABEL],
      }));
    } catch (error) {
      logError("Ready-for-merge actions failed", {
        workItemId: workItem.id,
        repo: workItem.repo,
        prNumber: workItem.githubPrNumber,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function retryGitHubAction<T>(action: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= READY_FOR_MERGE_GITHUB_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (attempt === READY_FOR_MERGE_GITHUB_MAX_ATTEMPTS) {
        break;
      }
      await sleep(READY_FOR_MERGE_GITHUB_RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
