import { logError, logInfo } from "../logger.js";
import type { GitHubService, PullRequestDetails } from "../github.js";
import { RunStore } from "../store.js";
import {
  canAutoRebaseFeatureDeliveryBranch,
  isAiAssistAutomationEnabled,
} from "./feature-delivery-policy.js";
import { WorkItemStore } from "./store.js";
import {
  AI_ASSIST_DISABLED_FLAG,
  AI_ASSIST_ENABLED_FLAG,
  type WorkItemRecord,
} from "./types.js";

const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "validating", "pushing", "awaiting_ci", "ci_fixing", "cancel_requested"]);
const DEFAULT_ADOPTION_LABELS = ["ai:assist"];
const CI_INTERVENTION_INTENT_KINDS = new Set([
  "feature_delivery.repair_ci",
  "feature_delivery.triage_ci",
]);
const DEFAULT_MAX_REPAIR_CI_ATTEMPTS = 3;
const DEFAULT_CI_REPAIR_COOLDOWN_MS = 30 * 60 * 1000;

export interface BranchSyncMonitorCycleDeps {
  workItems: Pick<WorkItemStore, "listBranchSyncCandidateWorkItems" | "listWorkItems" | "setFlagState" | "updateState">;
  runs: Pick<RunStore, "listRunsForWorkItem">;
  maxBehindCommits: number;
  compareBranchRefs: Pick<GitHubService, "compareBranchRefs">["compareBranchRefs"];
  getPullRequest?: Pick<GitHubService, "getPullRequest">["getPullRequest"];
  adoptionLabels?: string[];
  queueBranchSyncRun: (workItemId: string, reason: string) => Promise<void> | void;
  reconcileWorkItem?: (workItemId: string, reason: string) => Promise<void> | void;
  ciRepairMaxAttempts?: number;
  ciRepairCooldownMs?: number;
  now?: () => number;
}

export interface BranchSyncCycleResult {
  checked: number;
  closed: number;
  restored: number;
  stale: number;
  queued: number;
  ciRecovered: number;
  ciRepairBudgetExhausted: number;
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

function isStuckOnCiFailure(workItem: WorkItemRecord): boolean {
  if (
    workItem.workflow !== "feature_delivery" ||
    workItem.state !== "auto_review" ||
    workItem.substate !== "ci_failed" ||
    !isAiAssistAutomationEnabled(workItem)
  ) {
    return false;
  }
  return typeof workItem.githubPrHeadBranch === "string" && workItem.githubPrHeadBranch.length > 0;
}

export async function runBranchSyncMonitorCycle(
  deps: BranchSyncMonitorCycleDeps,
): Promise<BranchSyncCycleResult> {
  const workItems = typeof deps.workItems.listBranchSyncCandidateWorkItems === "function"
    ? await deps.workItems.listBranchSyncCandidateWorkItems()
    : await deps.workItems.listWorkItems();
  const adoptionLabels = normalizedAdoptionLabels(deps.adoptionLabels);
  const maxRepairCiAttempts = deps.ciRepairMaxAttempts ?? DEFAULT_MAX_REPAIR_CI_ATTEMPTS;
  const ciRepairCooldownMs = deps.ciRepairCooldownMs ?? DEFAULT_CI_REPAIR_COOLDOWN_MS;
  const now = deps.now ?? Date.now;
  let checked = 0;
  let closed = 0;
  let restored = 0;
  let stale = 0;
  let queued = 0;
  let ciRecovered = 0;
  let ciRepairBudgetExhausted = 0;

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

    if (deps.reconcileWorkItem && isStuckOnCiFailure(workItem)) {
      try {
        const runs = await deps.runs.listRunsForWorkItem(workItem.id);
        if (!runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status))) {
          const interventionAttempts = countCiInterventionAttempts(runs);
          const lastFinishedAt = lastCiInterventionFinishedAt(runs);
          const cooldownRemainingMs = lastFinishedAt === undefined
            ? 0
            : Math.max(0, ciRepairCooldownMs - (now() - lastFinishedAt));

          if (interventionAttempts >= maxRepairCiAttempts) {
            ciRepairBudgetExhausted += 1;
            logError("Branch sync monitor skipped CI recovery — automated CI intervention budget exhausted", {
              workItemId: workItem.id,
              attempts: interventionAttempts,
              maxAttempts: maxRepairCiAttempts,
            });
          } else if (cooldownRemainingMs > 0) {
            logInfo("Branch sync monitor deferring CI recovery — CI intervention cooldown active", {
              workItemId: workItem.id,
              attempts: interventionAttempts,
              cooldownRemainingMs,
            });
          } else {
            await deps.reconcileWorkItem(workItem.id, "periodic.ci_failed_recovery");
            ciRecovered += 1;
            logInfo("Branch sync monitor recovered stuck CI failure", {
              workItemId: workItem.id,
              attempts: interventionAttempts,
            });
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown";
        logError("Branch sync monitor could not recover stuck CI failure", {
          workItemId: workItem.id,
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

  if (ciRecovered > 0 || ciRepairBudgetExhausted > 0 || closed > 0 || restored > 0 || queued > 0) {
    logInfo("Branch sync monitor cycle complete", {
      checked,
      closed,
      restored,
      stale,
      queued,
      ciRecovered,
      ciRepairBudgetExhausted,
    });
  }

  return { checked, closed, restored, stale, queued, ciRecovered, ciRepairBudgetExhausted };
}

function isCiInterventionRun(run: { intentKind?: string; intent?: { kind?: string } }): boolean {
  return (
    (typeof run.intentKind === "string" && CI_INTERVENTION_INTENT_KINDS.has(run.intentKind))
    || (typeof run.intent?.kind === "string" && CI_INTERVENTION_INTENT_KINDS.has(run.intent.kind))
  );
}

function countCiInterventionAttempts(
  runs: Array<{ intentKind?: string; intent?: { kind?: string } }>,
): number {
  return runs.filter(isCiInterventionRun).length;
}

function lastCiInterventionFinishedAt(
  runs: Array<{ intentKind?: string; intent?: { kind?: string }; finishedAt?: string }>,
): number | undefined {
  let latest: number | undefined;
  for (const run of runs) {
    if (!isCiInterventionRun(run) || !run.finishedAt) {
      continue;
    }
    const finishedAt = Date.parse(run.finishedAt);
    if (!Number.isFinite(finishedAt)) {
      continue;
    }
    if (latest === undefined || finishedAt > latest) {
      latest = finishedAt;
    }
  }
  return latest;
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
