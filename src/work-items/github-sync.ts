import type { Database } from "../db/index.js";
import {
  nextFeatureDeliveryStateAfterAutoReview,
  nextFeatureDeliveryStateAfterEngineeringReview,
  nextFeatureDeliveryStateAfterProductReview,
  nextFeatureDeliveryStateAfterQaPreparation,
  nextFeatureDeliveryStateAfterQaReview,
  nextFeatureDeliveryStateAfterReadyForMergeRecovery,
  shouldResetEngineeringReviewOnNewCommits,
  shouldResetQaReviewOnNewCommits,
} from "./feature-delivery-policy.js";
import { WorkItemEventsStore } from "./events-store.js";
import { WorkItemService } from "./service.js";
import { WorkItemStore } from "./store.js";
import type { WorkItemRecord } from "./types.js";

export interface GitHubWorkItemWebhookPayload {
  eventType: "pull_request" | "pull_request_review" | "check_suite";
  action?: string;
  repo?: string;
  prNumber?: number;
  prTitle?: string;
  prBody?: string;
  prUrl?: string;
  baseBranch?: string;
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
  resetEngineeringReviewOnNewCommits?: boolean;
  resetQaReviewOnNewCommits?: boolean;
  resolveDeliveryContext: (input: {
    jiraIssueKey: string;
    repo?: string;
    prNumber?: number;
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
    const labels = Array.isArray(pullRequest["labels"])
      ? (pullRequest["labels"] as Array<Record<string, unknown>>)
          .map((label) => label["name"])
          .filter((name): name is string => typeof name === "string")
      : [];

    return {
      eventType: "pull_request",
      action: payload["action"] as string | undefined,
      repo,
      prNumber: payload["number"] as number | undefined,
      prTitle: pullRequest["title"] as string | undefined,
      prBody: pullRequest["body"] as string | undefined,
      prUrl: pullRequest["html_url"] as string | undefined,
      baseBranch: (pullRequest["base"] as Record<string, unknown> | undefined)?.["ref"] as string | undefined,
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
  private readonly adoptionLabels: string[];
  private readonly resolveDeliveryContext: GitHubWorkItemSyncOptions["resolveDeliveryContext"];
  private readonly resetEngineeringReviewOnNewCommits?: boolean;
  private readonly resetQaReviewOnNewCommits?: boolean;

  constructor(db: Database, options: GitHubWorkItemSyncOptions) {
    this.workItems = new WorkItemStore(db);
    this.workItemService = new WorkItemService(db);
    this.events = new WorkItemEventsStore(db);
    this.adoptionLabels = (options.adoptionLabels ?? ["ai_flow"]).map((label) => label.trim().toLowerCase()).filter(Boolean);
    this.resolveDeliveryContext = options.resolveDeliveryContext;
    this.resetEngineeringReviewOnNewCommits = options.resetEngineeringReviewOnNewCommits;
    this.resetQaReviewOnNewCommits = options.resetQaReviewOnNewCommits;
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
    if (!prNumber) {
      return undefined;
    }

    const existing = await this.workItems.findByGitHubPrNumber(prNumber);
    if (existing) {
      await this.events.append({
        workItemId: existing.id,
        eventType: "github.label_observed",
        actorUserId: existing.createdByUserId,
        payload: {
          action: payload.action,
          prNumber,
          labels: payload.labels ?? [],
          merged: payload.merged ?? false,
        },
      });
      if (payload.action === "closed" && payload.merged) {
        return this.markPullRequestMerged(existing, payload);
      }

      if (payload.action === "synchronize") {
        return this.handlePullRequestSynchronize(existing, payload);
      }

      return existing;
    }

    if (!this.hasAdoptionLabel(payload.labels)) {
      return undefined;
    }

    const jiraIssueKey = parseJiraIssueKey(payload.prBody);
    if (!jiraIssueKey) {
      return undefined;
    }

    const existingByJira = await this.workItems.findByJiraIssueKey(jiraIssueKey);
    if (existingByJira?.workflow === "feature_delivery") {
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
        githubPrNumber: prNumber,
        githubPrUrl: payload.prUrl,
      });
      const updated = await this.workItems.updateState(existingByJira.id, {
        state: "auto_review",
        substate: "pr_adopted",
        flagsToAdd: ["pr_opened"],
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
      return updated;
    }

    const context = await this.resolveDeliveryContext({
      jiraIssueKey,
      repo: payload.repo,
      prNumber,
    });
    if (!context) {
      return undefined;
    }

    const adopted = await this.workItemService.createDeliveryFromJira({
      title: payload.prTitle ?? jiraIssueKey,
      summary: payload.prBody,
      ownerTeamId: context.ownerTeamId,
      homeChannelId: context.homeChannelId,
      homeThreadTs: context.homeThreadTs,
      originChannelId: context.originChannelId,
      originThreadTs: context.originThreadTs,
      jiraIssueKey,
      createdByUserId: context.createdByUserId,
      githubPrNumber: prNumber,
      githubPrUrl: payload.prUrl,
      initialState: "auto_review",
      initialSubstate: "pr_adopted",
      flags: ["pr_opened"],
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

    return adopted;
  }

  private async handleCheckSuite(payload: GitHubWorkItemWebhookPayload): Promise<WorkItemRecord | undefined> {
    const workItem = await this.findWorkItemByPullRequestNumbers(payload.pullRequestNumbers);
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
        pullRequestNumbers: payload.pullRequestNumbers ?? [],
      },
    });

    const conclusion = payload.conclusion?.toLowerCase();
    if (conclusion === "success") {
      const nextState = workItem.state === "auto_review"
        ? nextFeatureDeliveryStateAfterAutoReview({
            ciGreen: true,
            selfReviewDone: workItem.flags.includes("self_review_done"),
            hasActiveAutoFixes: false,
          })
        : workItem.state === "qa_preparation"
          ? nextFeatureDeliveryStateAfterQaPreparation({
              productReviewRequired: workItem.flags.includes("product_review_required"),
              qaPrepFoundIssue: false,
            })
          : workItem.state;

      const updated = await this.workItems.updateState(workItem.id, {
        state: nextState,
        substate: nextFeatureDeliverySubstateForState(nextState, {
          fallback: workItem.substate,
          defaultValue: "waiting_ci",
        }),
        flagsToAdd: ["ci_green"],
      });

      await this.events.append({
        workItemId: updated.id,
        eventType: "github.ci_updated",
        payload: { conclusion, state: updated.state, prNumbers: payload.pullRequestNumbers ?? [] },
      });

      return updated;
    }

    if (conclusion === "failure" || conclusion === "timed_out") {
      const nextState = workItem.state === "ready_for_merge"
        ? nextFeatureDeliveryStateAfterReadyForMergeRecovery("ci_failed_after_rebase")
        : "auto_review";
      const updated = await this.workItems.updateState(workItem.id, {
        state: nextState,
        substate: workItem.state === "ready_for_merge" ? "revalidating_after_rebase" : "waiting_ci",
        flagsToRemove: ["ci_green"],
      });

      await this.events.append({
        workItemId: updated.id,
        eventType: "github.ci_updated",
        payload: { conclusion, state: updated.state, prNumbers: payload.pullRequestNumbers ?? [] },
      });

      return updated;
    }

    return undefined;
  }

  private async handlePullRequestReview(payload: GitHubWorkItemWebhookPayload): Promise<WorkItemRecord | undefined> {
    if (payload.action !== "submitted" || !payload.prNumber) {
      return undefined;
    }

    const workItem = await this.workItems.findByGitHubPrNumber(payload.prNumber);
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

    const currentState = workItem.state;
    if (!["engineering_review", "product_review", "qa_review"].includes(currentState)) {
      return undefined;
    }

    let nextState: WorkItemRecord["state"];
    let substate: string | undefined;
    let flagsToAdd: string[] = [];

    if (currentState === "engineering_review") {
      nextState = nextFeatureDeliveryStateAfterEngineeringReview(reviewState);
      substate = nextState === "qa_preparation" ? "preparing_review_app" : "applying_review_feedback";
      if (reviewState === "approved") flagsToAdd = ["engineering_review_done"];
    } else if (currentState === "product_review") {
      nextState = nextFeatureDeliveryStateAfterProductReview(reviewState);
      substate = nextState === "qa_review" ? "waiting_qa_review" : "applying_review_feedback";
      if (reviewState === "approved") flagsToAdd = ["product_review_done"];
    } else {
      nextState = nextFeatureDeliveryStateAfterQaReview(reviewState);
      substate = nextState === "ready_for_merge" ? "waiting_merge" : "applying_review_feedback";
      if (reviewState === "approved") flagsToAdd = ["qa_review_done"];
    }

    const updated = await this.workItems.updateState(workItem.id, {
      state: nextState,
      substate,
      flagsToAdd,
    });

    await this.events.append({
      workItemId: updated.id,
      eventType: "github.review_submitted",
      payload: {
        prNumber: payload.prNumber,
        reviewer: payload.reviewer,
        reviewState,
        state: updated.state,
      },
    });

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
    if (workItem.workflow !== "feature_delivery") {
      return workItem;
    }

    const flagsToRemove = ["ci_green"];
    let nextState = workItem.state;
    let substate = workItem.substate;

    if (workItem.state === "ready_for_merge") {
      nextState = "auto_review";
      substate = "waiting_ci";
      flagsToRemove.push("engineering_review_done", "product_review_done", "qa_review_done");
    } else if (workItem.state === "engineering_review") {
      if (this.shouldResetEngineeringReviewOnNewCommits()) {
        nextState = "auto_review";
        substate = "waiting_ci";
        flagsToRemove.push("engineering_review_done");
      } else {
        substate = "waiting_engineering_review";
      }
    } else if (workItem.state === "product_review") {
      nextState = "auto_review";
      substate = "waiting_ci";
      flagsToRemove.push("product_review_done");
    } else if (workItem.state === "qa_review") {
      if (this.shouldResetQaReviewOnNewCommits()) {
        nextState = "auto_review";
        substate = "waiting_ci";
        flagsToRemove.push("qa_review_done");
      } else {
        substate = "waiting_qa_review";
      }
    } else if (workItem.state === "qa_preparation" || workItem.state === "auto_review") {
      substate = "waiting_ci";
    } else {
      return workItem;
    }

    const updated = await this.workItems.updateState(workItem.id, {
      state: nextState,
      substate,
      flagsToRemove,
    });

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

  private async findWorkItemByPullRequestNumbers(prNumbers: number[] | undefined): Promise<WorkItemRecord | undefined> {
    for (const prNumber of prNumbers ?? []) {
      const workItem = await this.workItems.findByGitHubPrNumber(prNumber);
      if (workItem) {
        return workItem;
      }
    }
    return undefined;
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
}

function nextFeatureDeliverySubstateForState(
  state: WorkItemRecord["state"],
  input: { fallback?: string; defaultValue?: string } = {}
): string | undefined {
  switch (state) {
    case "engineering_review":
      return "waiting_engineering_review";
    case "qa_preparation":
      return "preparing_review_app";
    case "product_review":
      return "waiting_product_review";
    case "qa_review":
      return "waiting_qa_review";
    case "ready_for_merge":
      return "waiting_merge";
    case "auto_review":
      return input.defaultValue ?? "waiting_ci";
    default:
      return input.fallback;
  }
}
