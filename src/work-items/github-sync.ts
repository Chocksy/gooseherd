import type { Database } from "../db/index.js";
import type { GitHubService } from "../github.js";
import {
  shouldResetEngineeringReviewOnNewCommits,
  shouldResetQaReviewOnNewCommits,
} from "./feature-delivery-policy.js";
import { applyWorkItemDecision } from "./feature-delivery-decision.js";
import {
  reduceFeatureDelivery,
  type FeatureDeliveryDecision,
  type FeatureDeliveryReducerPolicy,
} from "./feature-delivery-reducer.js";
import { WorkItemEventsStore } from "./events-store.js";
import { logError } from "../logger.js";
import { RunStore } from "../store.js";
import { WorkItemService } from "./service.js";
import { WorkItemStore } from "./store.js";
import { isFeatureDeliveryAutoReviewOrRepairCiRun } from "../runs/run-intent.js";
import {
  AI_ASSIST_DISABLED_FLAG,
  AI_ASSIST_ENABLED_FLAG,
  GITHUB_PR_ADOPTED_FLAG,
  type WorkItemRecord,
} from "./types.js";

const ENGINEERING_REVIEW_PASSED_LABEL = "code review passed";
const QA_PASSED_LABEL = "qa passed";
const ACTIVE_WORK_ITEM_SYSTEM_RUN_STATUSES = new Set(["queued", "running", "validating", "pushing", "awaiting_ci", "ci_fixing"]);

export interface GitHubWorkItemWebhookPayload {
  eventType: "pull_request" | "pull_request_review" | "check_suite";
  action?: string;
  repo?: string;
  prNumber?: number;
  prTitle?: string;
  prBody?: string;
  prUrl?: string;
  authorLogin?: string;
  baseBranch?: string;
  headBranch?: string;
  headSha?: string;
  labels?: string[];
  reviewer?: string;
  state?: string;
  conclusion?: string;
  status?: string;
  pullRequestNumbers?: number[];
  merged?: boolean;
}

export interface GitHubWebhookHeaderLike {
  "x-github-event"?: string;
}

export interface DeliveryContextResolverResult {
  ownerTeamId: string;
  homeChannelId: string;
  homeThreadTs: string;
  createdByUserId: string;
  originChannelId?: string;
  originThreadTs?: string;
}

export interface GitHubWorkItemSyncOptions {
  adoptionLabels?: string[];
  githubService?: Pick<GitHubService, "getPullRequestCiSnapshot">;
  readyForMergeHandler?: (workItem: WorkItemRecord) => Promise<void> | void;
  resetEngineeringReviewOnNewCommits?: boolean;
  resetQaReviewOnNewCommits?: boolean;
  skipQaPreparation?: boolean;
  skipProductReview?: boolean;
  reconcileWorkItem?: (workItemId: string, reason: string) => Promise<void> | void;
  resolveDeliveryContext: (input: {
    jiraIssueKey?: string;
    repo?: string;
    prNumber?: number;
    prTitle?: string;
    prBody?: string;
    prUrl?: string;
    authorLogin?: string;
  }) => Promise<DeliveryContextResolverResult | undefined>;
}

export function parseJiraIssueKey(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const match = text.match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
  return match?.[1];
}

export function parseGitHubWorkItemWebhookPayload(
  headers: GitHubWebhookHeaderLike,
  payload: Record<string, unknown>
): GitHubWorkItemWebhookPayload | undefined {
  const eventType = headers["x-github-event"];
  const repository = payload["repository"] as Record<string, unknown> | undefined;
  const repo = repository?.["full_name"] as string | undefined;

  if (eventType === "pull_request") {
    const pullRequest = payload["pull_request"] as Record<string, unknown> | undefined;
    if (!pullRequest) return undefined;
    const action = payload["action"] as string | undefined;
    const labels = Array.isArray(pullRequest["labels"])
      ? (pullRequest["labels"] as Array<Record<string, unknown>>)
          .map((label) => label["name"])
          .filter((name): name is string => typeof name === "string")
      : [];
    const webhookLabel = (payload["label"] as Record<string, unknown> | undefined)?.["name"];
    if (action === "labeled" && typeof webhookLabel === "string" && !labels.includes(webhookLabel)) {
      labels.push(webhookLabel);
    }

    return {
      eventType: "pull_request",
      action,
      repo,
      prNumber: payload["number"] as number | undefined,
      prTitle: pullRequest["title"] as string | undefined,
      prBody: pullRequest["body"] as string | undefined,
      prUrl: pullRequest["html_url"] as string | undefined,
      authorLogin: (pullRequest["user"] as Record<string, unknown> | undefined)?.["login"] as string | undefined,
      baseBranch: (pullRequest["base"] as Record<string, unknown> | undefined)?.["ref"] as string | undefined,
      headBranch: (pullRequest["head"] as Record<string, unknown> | undefined)?.["ref"] as string | undefined,
      headSha: (pullRequest["head"] as Record<string, unknown> | undefined)?.["sha"] as string | undefined,
      labels,
      merged: pullRequest["merged"] as boolean | undefined,
    };
  }

  if (eventType === "pull_request_review") {
    const review = payload["review"] as Record<string, unknown> | undefined;
    const pullRequest = payload["pull_request"] as Record<string, unknown> | undefined;
    if (!review || !pullRequest) return undefined;

    return {
      eventType: "pull_request_review",
      action: payload["action"] as string | undefined,
      repo,
      prNumber: typeof pullRequest["number"] === "number" ? pullRequest["number"] as number : undefined,
      reviewer: (review["user"] as Record<string, unknown> | undefined)?.["login"] as string | undefined,
      state: review["state"] as string | undefined,
    };
  }

  if (eventType === "check_suite") {
    const checkSuite = payload["check_suite"] as Record<string, unknown> | undefined;
    if (!checkSuite) return undefined;
    const pullRequests = Array.isArray(checkSuite["pull_requests"])
      ? checkSuite["pull_requests"] as Array<Record<string, unknown>>
      : [];

    return {
      eventType: "check_suite",
      action: payload["action"] as string | undefined,
      repo,
      conclusion: checkSuite["conclusion"] as string | undefined,
      status: checkSuite["status"] as string | undefined,
      headSha: checkSuite["head_sha"] as string | undefined,
      pullRequestNumbers: pullRequests
        .map((pullRequest) => pullRequest["number"])
        .filter((number): number is number => typeof number === "number"),
    };
  }

  return undefined;
}

export class GitHubWorkItemSync {
  private readonly workItems: WorkItemStore;
  private readonly workItemService: WorkItemService;
  private readonly events: WorkItemEventsStore;
  private readonly runs: RunStore;
  private readonly adoptionLabels: string[];
  private readonly githubService?: Pick<GitHubService, "getPullRequestCiSnapshot">;
  private readonly resolveDeliveryContext: GitHubWorkItemSyncOptions["resolveDeliveryContext"];
  private readonly skipQaPreparation: boolean;
  private readonly skipProductReview: boolean;
  private readonly resetEngineeringReviewOnNewCommits?: boolean;
  private readonly resetQaReviewOnNewCommits?: boolean;
  private readonly reconcileWorkItem?: GitHubWorkItemSyncOptions["reconcileWorkItem"];
  private readonly readyForMergeHandler?: GitHubWorkItemSyncOptions["readyForMergeHandler"];

  constructor(db: Database, options: GitHubWorkItemSyncOptions) {
    this.workItems = new WorkItemStore(db);
    this.workItemService = new WorkItemService(db, {
      readyForMergeHandler: options.readyForMergeHandler,
    });
    this.events = new WorkItemEventsStore(db);
    this.runs = new RunStore(db);
    this.adoptionLabels = (options.adoptionLabels ?? ["ai:assist"]).map((label) => label.trim().toLowerCase()).filter(Boolean);
    this.githubService = options.githubService;
    this.readyForMergeHandler = options.readyForMergeHandler;
    this.resolveDeliveryContext = options.resolveDeliveryContext;
    this.skipQaPreparation = options.skipQaPreparation ?? false;
    this.skipProductReview = options.skipProductReview ?? false;
    this.resetEngineeringReviewOnNewCommits = options.resetEngineeringReviewOnNewCommits;
    this.resetQaReviewOnNewCommits = options.resetQaReviewOnNewCommits;
    this.reconcileWorkItem = options.reconcileWorkItem;
  }

  async handleWebhookPayload(payload: GitHubWorkItemWebhookPayload): Promise<WorkItemRecord | undefined> {
    switch (payload.eventType) {
      case "pull_request":
        return this.handlePullRequest(payload);
      case "check_suite":
        return this.handleCheckSuite(payload);
      case "pull_request_review":
        return this.handlePullRequestReview(payload);
      default:
        return undefined;
    }
  }

  private async handlePullRequest(payload: GitHubWorkItemWebhookPayload): Promise<WorkItemRecord | undefined> {
    const prNumber = payload.prNumber;
    if (!prNumber || !payload.repo) {
      return undefined;
    }

    const existing = await this.findExistingWorkItemForPullRequest(payload.repo, prNumber, payload.prUrl);
    if (existing) {
      const automationWasEnabled = this.isAiAssistAutomationEnabled(existing);
      let current = await this.syncStoredPullRequestContext(existing, {
        repo: payload.repo,
        githubPrUrl: payload.prUrl,
        githubPrBaseBranch: payload.baseBranch,
        githubPrHeadBranch: payload.headBranch,
        githubPrHeadSha: payload.headSha,
      });
      current = await this.syncAiAssistAutomationFlag(current, payload.labels);
      if (payload.action !== "synchronize") {
        current = await this.syncReviewFlagsFromPullRequestLabels(current, payload.labels);
      }
      await this.events.append({
        workItemId: current.id,
        eventType: "github.label_observed",
        actorUserId: current.createdByUserId,
        payload: {
          action: payload.action,
          prNumber,
          labels: payload.labels ?? [],
          merged: payload.merged ?? false,
        },
      });
      if (payload.action === "closed" && payload.merged) {
        return this.markPullRequestMerged(current, payload);
      }

      if (payload.action === "synchronize") {
        return this.handlePullRequestSynchronize(current, payload);
      }

      if (!automationWasEnabled && this.isAiAssistAutomationEnabled(current) && current.state === "auto_review") {
        await this.reconcileIfConfigured(current.id, "github.automation_enabled");
      }

      return this.handleReadyForMergeIfNeeded(current);
    }

    if (!this.hasAdoptionLabel(payload.labels)) {
      return undefined;
    }

    const jiraIssueKey = parseJiraIssueKey(payload.prBody);
    const initialAutoReviewStatus = await this.resolveInitialAutoReviewStatus(payload);
    if (jiraIssueKey) {
      const adoptionCandidates = await this.workItems.listFeatureDeliveryAdoptionCandidatesByJiraIssueKey(jiraIssueKey);
      if (adoptionCandidates.length === 1) {
        const existingByJira = adoptionCandidates[0]!;
        await this.events.append({
          workItemId: existingByJira.id,
          eventType: "github.label_observed",
          actorUserId: existingByJira.createdByUserId,
          payload: {
            action: payload.action,
            prNumber,
            labels: payload.labels ?? [],
          },
        });
        await this.workItems.linkPullRequest(existingByJira.id, {
          repo: payload.repo,
          githubPrNumber: prNumber,
          githubPrUrl: payload.prUrl,
          githubPrBaseBranch: payload.baseBranch,
          githubPrHeadBranch: payload.headBranch,
          githubPrHeadSha: payload.headSha,
        });
        const updated = await this.workItems.updateState(existingByJira.id, {
          state: "auto_review",
          substate: initialAutoReviewStatus.substate,
          flagsToAdd: [
            "pr_opened",
            GITHUB_PR_ADOPTED_FLAG,
            AI_ASSIST_ENABLED_FLAG,
            ...initialAutoReviewStatus.flagsToAdd,
            ...this.reviewFlagsFromLabels(payload.labels),
          ],
          flagsToRemove: [AI_ASSIST_DISABLED_FLAG],
        });
        await this.events.append({
          workItemId: updated.id,
          eventType: "github.pr_adopted_existing",
          actorUserId: updated.createdByUserId,
          payload: {
            repo: payload.repo,
            prNumber,
            jiraIssueKey,
            labels: payload.labels ?? [],
          },
        });
        await this.reconcileIfConfigured(updated.id, "github.pr_adopted");
        return updated;
      }

      if (adoptionCandidates.length > 1) {
        for (const candidate of adoptionCandidates) {
          await this.events.append({
            workItemId: candidate.id,
            eventType: "github.pr_adoption_ambiguous",
            actorUserId: candidate.createdByUserId,
            payload: {
              action: payload.action,
              repo: payload.repo,
              prNumber,
              jiraIssueKey,
              candidateCount: adoptionCandidates.length,
            },
          });
        }
        return undefined;
      }
    }

    const context = await this.resolveDeliveryContext({
      jiraIssueKey,
      repo: payload.repo,
      prNumber,
      prTitle: payload.prTitle,
      prBody: payload.prBody,
      prUrl: payload.prUrl,
      authorLogin: payload.authorLogin,
    });
    if (!context) {
      return undefined;
    }

    const title = payload.prTitle ?? jiraIssueKey ?? `PR #${String(prNumber)}`;
    const adopted = jiraIssueKey
      ? await this.workItemService.createDeliveryFromJira({
          title,
          summary: payload.prBody,
          ownerTeamId: context.ownerTeamId,
          homeChannelId: context.homeChannelId,
          homeThreadTs: context.homeThreadTs,
          originChannelId: context.originChannelId,
          originThreadTs: context.originThreadTs,
          jiraIssueKey,
          repo: payload.repo,
          createdByUserId: context.createdByUserId,
          githubPrNumber: prNumber,
          githubPrUrl: payload.prUrl,
          githubPrBaseBranch: payload.baseBranch,
          githubPrHeadBranch: payload.headBranch,
          githubPrHeadSha: payload.headSha,
          initialState: "auto_review",
          initialSubstate: initialAutoReviewStatus.substate,
          flags: [
            "pr_opened",
            GITHUB_PR_ADOPTED_FLAG,
            AI_ASSIST_ENABLED_FLAG,
            ...initialAutoReviewStatus.flagsToAdd,
            ...this.reviewFlagsFromLabels(payload.labels),
          ],
        })
      : await this.workItemService.createDeliveryFromPullRequest({
          title,
          summary: payload.prBody,
          ownerTeamId: context.ownerTeamId,
          homeChannelId: context.homeChannelId,
          homeThreadTs: context.homeThreadTs,
          originChannelId: context.originChannelId,
          originThreadTs: context.originThreadTs,
          repo: payload.repo,
          createdByUserId: context.createdByUserId,
          githubPrNumber: prNumber,
          githubPrUrl: payload.prUrl,
          githubPrBaseBranch: payload.baseBranch,
          githubPrHeadBranch: payload.headBranch,
          githubPrHeadSha: payload.headSha,
          initialState: "auto_review",
          initialSubstate: initialAutoReviewStatus.substate,
          flags: [
            "pr_opened",
            GITHUB_PR_ADOPTED_FLAG,
            AI_ASSIST_ENABLED_FLAG,
            ...initialAutoReviewStatus.flagsToAdd,
            ...this.reviewFlagsFromLabels(payload.labels),
          ],
        });

    await this.events.append({
      workItemId: adopted.id,
      eventType: "github.label_observed",
      actorUserId: context.createdByUserId,
      payload: {
        action: payload.action,
        prNumber,
        labels: payload.labels ?? [],
      },
    });

    await this.events.append({
      workItemId: adopted.id,
      eventType: "github.pr_adopted",
      actorUserId: context.createdByUserId,
      payload: {
        repo: payload.repo,
        prNumber,
        jiraIssueKey,
        labels: payload.labels ?? [],
      },
    });

    await this.reconcileIfConfigured(adopted.id, "github.pr_adopted");
    return adopted;
  }

  private async handleCheckSuite(payload: GitHubWorkItemWebhookPayload): Promise<WorkItemRecord | undefined> {
    const workItem = await this.findWorkItemByPullRequestNumbers(payload.repo, payload.pullRequestNumbers);
    if (!workItem) {
      return undefined;
    }

    await this.events.append({
      workItemId: workItem.id,
      eventType: "github.ci_updated",
      actorUserId: workItem.createdByUserId,
      payload: {
        action: payload.action,
        status: payload.status,
        conclusion: payload.conclusion,
        headSha: payload.headSha,
        pullRequestNumbers: payload.pullRequestNumbers ?? [],
      },
    });

    if (payload.headSha && workItem.githubPrHeadSha && payload.headSha !== workItem.githubPrHeadSha) {
      return workItem;
    }

    if (payload.status !== "completed" && payload.action !== "completed") {
      return undefined;
    }

    const conclusion = await this.resolveCheckSuiteConclusion(payload, workItem);
    const automationEnabled = this.isAiAssistAutomationEnabled(workItem);
    if (conclusion === "success" || conclusion === "failure") {
      const hasActiveSystemRun = workItem.state === "auto_review"
        ? await this.hasActiveSystemRun(workItem.id)
        : false;
      const decision = reduceFeatureDelivery(
        workItem,
        {
          type: "github.ci_completed",
          conclusion,
          hasActiveSystemRun,
          automationEnabled,
        },
        this.reducerPolicy(),
      );
      const updated = await applyWorkItemDecision(this.workItems, workItem, decision);

      await this.events.append({
        workItemId: updated.id,
        eventType: "github.ci_updated",
        payload: { conclusion, state: updated.state, prNumbers: payload.pullRequestNumbers ?? [] },
      });

      const handledReadyForMerge = await this.executeFeatureDeliveryCommands(updated, decision);
      if (!handledReadyForMerge && conclusion === "success") {
        return this.handleReadyForMergeIfNeeded(updated);
      }

      return updated;
    }

    return undefined;
  }

  private async resolveInitialAutoReviewStatus(
    payload: GitHubWorkItemWebhookPayload,
  ): Promise<{
    substate: "pr_adopted" | "ci_failed" | "ci_green_pending_self_review";
    flagsToAdd: string[];
  }> {
    if (!payload.repo || !payload.headSha || !this.githubService?.getPullRequestCiSnapshot) {
      return { substate: "pr_adopted", flagsToAdd: [] };
    }

    try {
      const snapshot = await this.githubService.getPullRequestCiSnapshot(
        payload.repo,
        payload.headSha,
        undefined,
        { prNumber: payload.prNumber },
      );
      // getPullRequestCiSnapshot() normalizes failed check suites, including timed_out, to "failure".
      if (snapshot.conclusion === "failure") {
        return { substate: "ci_failed", flagsToAdd: [] };
      }
      if (snapshot.conclusion === "success") {
        return { substate: "ci_green_pending_self_review", flagsToAdd: ["ci_green"] };
      }
      return { substate: "pr_adopted", flagsToAdd: [] };
    } catch (error) {
      logError("Failed to resolve PR adoption CI snapshot", {
        repo: payload.repo,
        headSha: payload.headSha,
        error: error instanceof Error ? error.message : String(error),
      });
      return { substate: "pr_adopted", flagsToAdd: [] };
    }
  }

  private async handlePullRequestReview(payload: GitHubWorkItemWebhookPayload): Promise<WorkItemRecord | undefined> {
    if (payload.action !== "submitted" || !payload.prNumber) {
      return undefined;
    }

    const workItem = payload.repo
      ? await this.findExistingWorkItemForPullRequest(payload.repo, payload.prNumber)
      : undefined;
    if (!workItem) {
      return undefined;
    }

    await this.events.append({
      workItemId: workItem.id,
      eventType: "github.review_submitted",
      actorUserId: workItem.createdByUserId,
      payload: {
        prNumber: payload.prNumber,
        reviewer: payload.reviewer,
        reviewState: payload.state?.toLowerCase(),
        action: payload.action,
      },
    });

    const reviewState = payload.state?.toLowerCase();
    if (reviewState !== "approved" && reviewState !== "changes_requested") {
      return undefined;
    }
    const decision = reduceFeatureDelivery(
      workItem,
      {
        type: "github.review_submitted",
        reviewState,
        automationEnabled: this.isAiAssistAutomationEnabled(workItem),
      },
      this.reducerPolicy(),
    );
    if (decision.patches.length === 0 && decision.commands.length === 0) {
      return undefined;
    }

    const updated = await applyWorkItemDecision(this.workItems, workItem, decision);

    await this.events.append({
      workItemId: updated.id,
      eventType: "github.review_transitioned",
      payload: {
        prNumber: payload.prNumber,
        reviewer: payload.reviewer,
        reviewState,
        previousState: workItem.state,
        nextState: updated.state,
      },
    });

    const handledReadyForMerge = await this.executeFeatureDeliveryCommands(updated, decision);
    if (!handledReadyForMerge) {
      return this.handleReadyForMergeIfNeeded(updated);
    }

    return updated;
  }

  private async markPullRequestMerged(
    workItem: WorkItemRecord,
    payload: GitHubWorkItemWebhookPayload
  ): Promise<WorkItemRecord> {
    const updated = await this.workItems.updateState(workItem.id, {
      state: "done",
      substate: "merged",
      flagsToAdd: ["merged"],
    });

    await this.events.append({
      workItemId: updated.id,
      eventType: "github.pr_merged",
      payload: {
        repo: payload.repo,
        prNumber: payload.prNumber,
        prUrl: payload.prUrl,
      },
    });

    return updated;
  }

  private async handlePullRequestSynchronize(
    workItem: WorkItemRecord,
    payload: GitHubWorkItemWebhookPayload
  ): Promise<WorkItemRecord> {
    const decision = reduceFeatureDelivery(
      workItem,
      { type: "github.pr_synchronized" },
      this.reducerPolicy(),
    );
    if (decision.patches.length === 0 && decision.commands.length === 0) {
      return workItem;
    }
    const updated = await applyWorkItemDecision(this.workItems, workItem, decision);

    await this.events.append({
      workItemId: updated.id,
      eventType: "github.pr_synchronized",
      payload: {
        repo: payload.repo,
        prNumber: payload.prNumber,
        previousState: workItem.state,
        nextState: updated.state,
      },
    });

    return updated;
  }

  private hasAdoptionLabel(labels: string[] | undefined): boolean {
    const normalized = (labels ?? []).map((label) => label.trim().toLowerCase());
    return normalized.some((label) => this.adoptionLabels.includes(label));
  }

  private reviewFlagsFromLabels(labels: string[] | undefined): string[] {
    const normalized = new Set((labels ?? []).map((label) => label.trim().toLowerCase()));
    const flags: string[] = [];

    if (normalized.has(ENGINEERING_REVIEW_PASSED_LABEL)) {
      flags.push("engineering_review_done");
    }
    if (normalized.has(QA_PASSED_LABEL)) {
      flags.push("qa_review_done");
    }

    return flags;
  }

  private async syncAiAssistAutomationFlag(
    workItem: WorkItemRecord,
    labels: string[] | undefined,
  ): Promise<WorkItemRecord> {
    const hasAdoptionLabel = this.hasAdoptionLabel(labels);
    const automationEnabled = this.isAiAssistAutomationEnabled(workItem);

    if (hasAdoptionLabel && automationEnabled && !workItem.flags.includes(AI_ASSIST_DISABLED_FLAG)) {
      return workItem;
    }

    if (!hasAdoptionLabel && !automationEnabled && workItem.flags.includes(AI_ASSIST_DISABLED_FLAG)) {
      return workItem;
    }

    return this.workItems.updateState(workItem.id, {
      state: workItem.state,
      substate: workItem.substate,
      flagsToAdd: hasAdoptionLabel ? [AI_ASSIST_ENABLED_FLAG] : [AI_ASSIST_DISABLED_FLAG],
      flagsToRemove: hasAdoptionLabel ? [AI_ASSIST_DISABLED_FLAG] : [AI_ASSIST_ENABLED_FLAG],
    });
  }

  private async syncReviewFlagsFromPullRequestLabels(
    workItem: WorkItemRecord,
    labels: string[] | undefined
  ): Promise<WorkItemRecord> {
    const reviewFlags = this.reviewFlagsFromLabels(labels);
    const decision = reduceFeatureDelivery(
      workItem,
      {
        type: "github.review_labels_synced",
        engineeringReviewDone: reviewFlags.includes("engineering_review_done"),
        qaReviewDone: reviewFlags.includes("qa_review_done"),
      },
      this.reducerPolicy(),
    );
    if (decision.patches.length === 0 && decision.commands.length === 0) {
      return workItem;
    }
    return applyWorkItemDecision(this.workItems, workItem, decision);
  }

  private async findWorkItemByPullRequestNumbers(
    repo: string | undefined,
    prNumbers: number[] | undefined
  ): Promise<WorkItemRecord | undefined> {
    if (!repo) {
      return undefined;
    }
    for (const prNumber of prNumbers ?? []) {
      const workItem = await this.findExistingWorkItemForPullRequest(repo, prNumber);
      if (workItem) {
        return workItem;
      }
    }
    return undefined;
  }

  private async findExistingWorkItemForPullRequest(
    repo: string,
    prNumber: number,
    prUrl?: string
  ): Promise<WorkItemRecord | undefined> {
    const exact = await this.workItems.findByRepoAndGitHubPrNumber(repo, prNumber);
    if (exact) {
      return exact;
    }

    const legacy = await this.workItems.findUniqueLegacyByGitHubPrNumber(prNumber);
    if (!legacy) {
      return undefined;
    }

    return this.workItems.linkPullRequest(legacy.id, {
      repo,
      githubPrNumber: prNumber,
      githubPrUrl: prUrl ?? legacy.githubPrUrl,
      githubPrBaseBranch: legacy.githubPrBaseBranch,
      githubPrHeadBranch: legacy.githubPrHeadBranch,
      githubPrHeadSha: legacy.githubPrHeadSha,
    });
  }

  private async syncStoredPullRequestContext(
    workItem: WorkItemRecord,
    input: {
      repo?: string;
      githubPrUrl?: string;
      githubPrBaseBranch?: string;
      githubPrHeadBranch?: string;
      githubPrHeadSha?: string;
    }
  ): Promise<WorkItemRecord> {
    if (!workItem.githubPrNumber) {
      return workItem;
    }

    const nextRepo = input.repo ?? workItem.repo;
    const nextUrl = input.githubPrUrl ?? workItem.githubPrUrl;
    const nextBaseBranch = input.githubPrBaseBranch ?? workItem.githubPrBaseBranch;
    const nextHeadBranch = input.githubPrHeadBranch ?? workItem.githubPrHeadBranch;
    const nextHeadSha = input.githubPrHeadSha ?? workItem.githubPrHeadSha;

    if (
      nextRepo === workItem.repo &&
      nextUrl === workItem.githubPrUrl &&
      nextBaseBranch === workItem.githubPrBaseBranch &&
      nextHeadBranch === workItem.githubPrHeadBranch &&
      nextHeadSha === workItem.githubPrHeadSha
    ) {
      return workItem;
    }

    return this.workItems.linkPullRequest(workItem.id, {
      repo: nextRepo,
      githubPrNumber: workItem.githubPrNumber,
      githubPrUrl: nextUrl,
      githubPrBaseBranch: nextBaseBranch,
      githubPrHeadBranch: nextHeadBranch,
      githubPrHeadSha: nextHeadSha,
    });
  }

  private shouldResetEngineeringReviewOnNewCommits(): boolean {
    if (typeof this.resetEngineeringReviewOnNewCommits === "boolean") {
      return this.resetEngineeringReviewOnNewCommits;
    }
    return shouldResetEngineeringReviewOnNewCommits();
  }

  private shouldResetQaReviewOnNewCommits(): boolean {
    if (typeof this.resetQaReviewOnNewCommits === "boolean") {
      return this.resetQaReviewOnNewCommits;
    }
    return shouldResetQaReviewOnNewCommits();
  }

  private reducerPolicy(): FeatureDeliveryReducerPolicy {
    return {
      skipQaPreparation: this.skipQaPreparation,
      skipProductReview: this.skipProductReview,
      resetEngineeringReviewOnNewCommits: this.shouldResetEngineeringReviewOnNewCommits(),
      resetQaReviewOnNewCommits: this.shouldResetQaReviewOnNewCommits(),
    };
  }

  private async handleReadyForMergeIfNeeded(workItem: WorkItemRecord): Promise<WorkItemRecord> {
    if (!this.readyForMergeHandler || workItem.workflow !== "feature_delivery" || workItem.state !== "ready_for_merge") {
      return workItem;
    }

    await this.readyForMergeHandler(workItem);
    return workItem;
  }

  private async executeFeatureDeliveryCommands(
    workItem: WorkItemRecord,
    decision: FeatureDeliveryDecision,
  ): Promise<boolean> {
    let handledReadyForMerge = false;

    for (const command of decision.commands) {
      if (command.type === "reconcile_work_item") {
        await this.reconcileIfConfigured(workItem.id, command.reason);
        continue;
      }

      if (command.type === "ready_for_merge_entered") {
        await this.handleReadyForMergeIfNeeded(workItem);
        handledReadyForMerge = true;
      }
    }

    return handledReadyForMerge;
  }

  private async reconcileIfConfigured(workItemId: string, reason: string): Promise<void> {
    if (!this.reconcileWorkItem) {
      return;
    }

    try {
      await this.reconcileWorkItem(workItemId, reason);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      logError("GitHub work item reconcile callback failed", { workItemId, reason, error: message });
    }
  }

  private async hasActiveSystemRun(workItemId: string): Promise<boolean> {
    const runs = await this.runs.listRunsForWorkItem(workItemId);
    return runs.some((run) =>
      isFeatureDeliveryAutoReviewOrRepairCiRun(run) &&
      ACTIVE_WORK_ITEM_SYSTEM_RUN_STATUSES.has(run.status)
    );
  }

  private isAiAssistAutomationEnabled(workItem: Pick<WorkItemRecord, "flags">): boolean {
    if (workItem.flags.includes(AI_ASSIST_DISABLED_FLAG)) {
      return false;
    }

    return workItem.flags.includes(AI_ASSIST_ENABLED_FLAG) || workItem.flags.includes(GITHUB_PR_ADOPTED_FLAG);
  }

  private async resolveCheckSuiteConclusion(
    payload: GitHubWorkItemWebhookPayload,
    workItem: WorkItemRecord,
  ): Promise<"success" | "failure" | "pending" | "no_ci" | undefined> {
    const currentHeadSha = workItem.githubPrHeadSha ?? payload.headSha;
    if (payload.repo && currentHeadSha && this.githubService?.getPullRequestCiSnapshot) {
      try {
        const snapshot = await this.githubService.getPullRequestCiSnapshot(
          payload.repo,
          currentHeadSha,
          undefined,
          { prNumber: payload.prNumber ?? payload.pullRequestNumbers?.[0] },
        );
        return snapshot.conclusion;
      } catch (error) {
        logError("Failed to resolve aggregate CI snapshot for check_suite", {
          repo: payload.repo,
          headSha: currentHeadSha,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return normalizeCheckSuiteConclusion(payload.conclusion);
  }
}

function normalizeCheckSuiteConclusion(
  conclusion: string | undefined,
): "success" | "failure" | "pending" | "no_ci" | undefined {
  switch (conclusion?.toLowerCase()) {
    case "success":
      return "success";
    case "failure":
    case "timed_out":
      return "failure";
    case "pending":
      return "pending";
    case "no_ci":
      return "no_ci";
    default:
      return undefined;
  }
}
