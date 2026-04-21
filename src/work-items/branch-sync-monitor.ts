import { logError } from "../logger.js";
import type { GitHubService } from "../github.js";
import { RunStore } from "../store.js";
import { canAutoRebaseFeatureDeliveryBranch } from "./feature-delivery-policy.js";
import { WorkItemStore } from "./store.js";
import type { WorkItemRecord } from "./types.js";

const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "validating", "pushing", "awaiting_ci", "ci_fixing", "cancel_requested"]);

export interface BranchSyncMonitorCycleDeps {
  workItems: Pick<WorkItemStore, "listWorkItems" | "setFlagState">;
  runs: Pick<RunStore, "listRunsForWorkItem">;
  maxBehindCommits: number;
  compareBranchRefs: Pick<GitHubService, "compareBranchRefs">["compareBranchRefs"];
  queueBranchSyncRun: (workItemId: string, reason: string) => Promise<void> | void;
}

export interface BranchSyncCycleResult {
  checked: number;
  stale: number;
  queued: number;
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

export async function runBranchSyncMonitorCycle(
  deps: BranchSyncMonitorCycleDeps,
): Promise<BranchSyncCycleResult> {
  const workItems = await deps.workItems.listWorkItems();
  let checked = 0;
  let stale = 0;
  let queued = 0;

  for (const workItem of workItems) {
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

  return { checked, stale, queued };
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
