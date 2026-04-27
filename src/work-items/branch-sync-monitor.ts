import { logError } from "../logger.js";
import type { GitHubService, PullRequestDetails } from "../github.js";
import { RunStore } from "../store.js";
import { canAutoRebaseFeatureDeliveryBranch } from "./feature-delivery-policy.js";
import { WorkItemStore } from "./store.js";
import {
  AI_ASSIST_DISABLED_FLAG,
  AI_ASSIST_ENABLED_FLAG,
  type WorkItemRecord,
} from "./types.js";

const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "validating", "pushing", "awaiting_ci", "ci_fixing", "cancel_requested"]);
const DEFAULT_ADOPTION_LABELS = ["ai:assist"];

export interface BranchSyncMonitorCycleDeps {
  workItems: Pick<WorkItemStore, "listBranchSyncCandidateWorkItems" | "listWorkItems" | "setFlagState" | "updateState">;
  runs: Pick<RunStore, "listRunsForWorkItem">;
  maxBehindCommits: number;
  compareBranchRefs: Pick<GitHubService, "compareBranchRefs">["compareBranchRefs"];
  getPullRequest?: Pick<GitHubService, "getPullRequest">["getPullRequest"];
  adoptionLabels?: string[];
  queueBranchSyncRun: (workItemId: string, reason: string) => Promise<void> | void;
  reconcileWorkItem?: (workItemId: string, reason: string) => Promise<void> | void;
}

export interface BranchSyncCycleResult {
  checked: number;
  closed: number;
  restored: number;
  stale: number;
  queued: number;
}

function isEligibleForPullRequestStateSync(workItem: WorkItemRecord): workItem is WorkItemRecord & {
  repo: string;
  githubPrNumber: number;
} {
  return (
    workItem.workflow === "feature_delivery" &&
    workItem.state !== "done" &&
    (workItem.state !== "cancelled" || isAiAssistDisabledCancellation(workItem)) &&
    typeof workItem.repo === "string" &&
    workItem.repo.length > 0 &&
    typeof workItem.githubPrNumber === "number"
  );
}

function isEligibleForBranchSync(workItem: WorkItemRecord): boolean {
  return (
    workItem.workflow === "feature_delivery" &&
    workItem.state !== "done" &&
    workItem.state !== "cancelled" &&
    canAutoRebaseFeatureDeliveryBranch(workItem.flags) &&
    typeof workItem.repo === "string" &&
    workItem.repo.length > 0 &&
    typeof workItem.githubPrBaseBranch === "string" &&
    workItem.githubPrBaseBranch.length > 0 &&
    typeof workItem.githubPrHeadBranch === "string" &&
    workItem.githubPrHeadBranch.length > 0
  );
}

function isClosedPullRequest(pullRequest: PullRequestDetails): boolean {
  return pullRequest.state.toLowerCase() === "closed";
}

function normalizedAdoptionLabels(input: string[] | undefined): string[] {
  const labels = (input && input.length > 0 ? input : DEFAULT_ADOPTION_LABELS)
    .map((label) => label.trim().toLowerCase())
    .filter(Boolean);
  return labels.length > 0 ? labels : DEFAULT_ADOPTION_LABELS;
}

function hasAdoptionLabel(pullRequest: PullRequestDetails, adoptionLabels: string[]): boolean {
  const labels = new Set((pullRequest.labels ?? []).map((label) => label.trim().toLowerCase()));
  return adoptionLabels.some((label) => labels.has(label));
}

function isAiAssistDisabledCancellation(workItem: WorkItemRecord): boolean {
  return (
    workItem.state === "cancelled" &&
    workItem.flags.includes(AI_ASSIST_DISABLED_FLAG) &&
    !workItem.flags.includes("pr_closed")
  );
}

export async function runBranchSyncMonitorCycle(
  deps: BranchSyncMonitorCycleDeps,
): Promise<BranchSyncCycleResult> {
  const workItems = typeof deps.workItems.listBranchSyncCandidateWorkItems === "function"
    ? await deps.workItems.listBranchSyncCandidateWorkItems()
    : await deps.workItems.listWorkItems();
  const adoptionLabels = normalizedAdoptionLabels(deps.adoptionLabels);
  let checked = 0;
  let closed = 0;
  let restored = 0;
  let stale = 0;
  let queued = 0;

  for (const workItem of workItems) {
    if (deps.getPullRequest && isEligibleForPullRequestStateSync(workItem)) {
      try {
        const pullRequest = await deps.getPullRequest(workItem.repo, workItem.githubPrNumber);
        if (isClosedPullRequest(pullRequest)) {
          checked += 1;
          await deps.workItems.updateState(workItem.id, pullRequest.merged
            ? {
                state: "done",
                substate: "merged",
                flagsToAdd: ["merged"],
              }
            : {
                state: "cancelled",
                substate: "closed_unmerged",
                flagsToAdd: ["pr_closed"],
              });
          closed += 1;
          continue;
        }
        if (isAiAssistDisabledCancellation(workItem)) {
          checked += 1;
          if (hasAdoptionLabel(pullRequest, adoptionLabels)) {
            const restoredWorkItem = await deps.workItems.updateState(workItem.id, {
              state: "auto_review",
              substate: "pr_adopted",
              flagsToAdd: [AI_ASSIST_ENABLED_FLAG],
              flagsToRemove: [AI_ASSIST_DISABLED_FLAG],
            });
            restored += 1;
            await deps.reconcileWorkItem?.(restoredWorkItem.id, "github.automation_restored_poll");
          }
          continue;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown";
        logError("Branch sync monitor could not sync pull request state", {
          workItemId: workItem.id,
          repo: workItem.repo,
          prNumber: workItem.githubPrNumber,
          error: message,
        });
      }
    }

    if (!isEligibleForBranchSync(workItem)) {
      if (workItem.flags.includes("branch_stale")) {
        try {
          await deps.workItems.setFlagState(workItem.id, "branch_stale", false);
        } catch (error) {
          const message = error instanceof Error ? error.message : "unknown";
          logError("Branch sync monitor could not clear stale flag", {
            workItemId: workItem.id,
            error: message,
          });
        }
      }
      continue;
    }

    checked += 1;

    try {
      const comparison = await deps.compareBranchRefs(
        workItem.repo!,
        workItem.githubPrBaseBranch!,
        workItem.githubPrHeadBranch!,
      );
      const isStale = comparison.behindBy > deps.maxBehindCommits;
      await deps.workItems.setFlagState(workItem.id, "branch_stale", isStale);

      if (!isStale) {
        continue;
      }

      stale += 1;

      const runs = await deps.runs.listRunsForWorkItem(workItem.id);
      if (runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status))) {
        continue;
      }

      await deps.queueBranchSyncRun(workItem.id, "periodic.branch_stale");
      queued += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      logError("Branch sync monitor cycle failed for work item", {
        workItemId: workItem.id,
        error: message,
      });
    }
  }

  return { checked, closed, restored, stale, queued };
}

export function startBranchSyncMonitor(input: BranchSyncMonitorCycleDeps & { intervalMs: number }): { stop(): void } {
  let running = false;

  const tick = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      await runBranchSyncMonitorCycle(input);
    } finally {
      running = false;
    }
  };

  const interval = setInterval(() => {
    tick().catch((error) => {
      const message = error instanceof Error ? error.message : "unknown";
      logError("Branch sync monitor tick failed", { error: message });
    });
  }, input.intervalMs);
  interval.unref?.();
  tick().catch((error) => {
    const message = error instanceof Error ? error.message : "unknown";
    logError("Branch sync monitor initial tick failed", { error: message });
  });

  return {
    stop() {
      clearInterval(interval);
    },
  };
}
