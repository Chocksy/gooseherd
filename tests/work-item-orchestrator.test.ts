import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "./helpers/test-db.js";
import { teamMembers, teams, users, workItemEvents } from "../src/db/schema.js";
import { WorkItemService } from "../src/work-items/service.js";
import { WorkItemStore } from "../src/work-items/store.js";
import { RunStore } from "../src/store.js";

type AutoReviewSubstate = "pr_adopted" | "applying_review_feedback" | "ci_failed" | "ci_green_pending_self_review";

async function createAutoReviewFixture(substate: AutoReviewSubstate = "pr_adopted") {
  const testDb = await createTestDb();
  const ownerUserId = randomUUID();
  const ownerTeamId = randomUUID();

  await testDb.db.insert(users).values({
    id: ownerUserId,
    slackUserId: "U_OWNER",
    displayName: "Owner",
  });
  await testDb.db.insert(teams).values({
    id: ownerTeamId,
    name: "core",
    slackChannelId: "C_CORE",
  });
  await testDb.db.insert(teamMembers).values({
    teamId: ownerTeamId,
    userId: ownerUserId,
    functionalRoles: ["pm"],
  });

  const workItemService = new WorkItemService(testDb.db);
  const runStore = new RunStore(testDb.db);
  await runStore.init();

  const workItem = await workItemService.createDeliveryFromJira({
    title: "Add auto-review orchestration",
    summary: "Kick off the auto-review flow for adopted PRs.",
    ownerTeamId,
    homeChannelId: "C_CORE",
    homeThreadTs: "1740000000.700",
    jiraIssueKey: "HBL-404",
    repo: "hubstaff/gooseherd",
    githubPrNumber: 77,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/77",
    githubPrBaseBranch: "release/2026.04",
    githubPrHeadBranch: "feature/hbl-404",
    createdByUserId: ownerUserId,
    initialState: "auto_review",
    initialSubstate: substate,
    flags: ["pr_opened", "github_pr_adopted", "ai_assist_enabled"],
  });

  return {
    db: testDb.db,
    cleanup: testDb.cleanup,
    ownerUserId,
    ownerTeamId,
    workItemService,
    runStore,
    workItem,
  };
}

async function createFeatureDeliveryFixture(options: {
  state: "auto_review" | "engineering_review" | "qa_preparation" | "product_review" | "qa_review" | "ready_for_merge";
  substate?: string;
  flags?: string[];
}) {
  const testDb = await createTestDb();
  const ownerUserId = randomUUID();
  const ownerTeamId = randomUUID();

  await testDb.db.insert(users).values({
    id: ownerUserId,
    slackUserId: "U_OWNER",
    displayName: "Owner",
  });
  await testDb.db.insert(teams).values({
    id: ownerTeamId,
    name: "core",
    slackChannelId: "C_CORE",
  });
  await testDb.db.insert(teamMembers).values({
    teamId: ownerTeamId,
    userId: ownerUserId,
    functionalRoles: ["pm"],
  });

  const workItemService = new WorkItemService(testDb.db);
  const runStore = new RunStore(testDb.db);
  await runStore.init();

  const workItem = await workItemService.createDeliveryFromJira({
    title: "Maintain long-lived PR branch",
    summary: "Keep the feature branch rebased while the PR is waiting.",
    ownerTeamId,
    homeChannelId: "C_CORE",
    homeThreadTs: "1740000000.701",
    jiraIssueKey: "HBL-405",
    repo: "hubstaff/gooseherd",
    githubPrNumber: 90,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/90",
    githubPrBaseBranch: "release/2026.04",
    githubPrHeadBranch: "feature/hbl-405",
    createdByUserId: ownerUserId,
    initialState: options.state,
    initialSubstate: options.substate,
    flags: ["pr_opened", "github_pr_adopted", "ai_assist_enabled", ...(options.flags ?? [])],
  });

  return {
    db: testDb.db,
    cleanup: testDb.cleanup,
    workItem,
    runStore,
  };
}

async function createActiveLinkedRun(
  runStore: RunStore,
  workItemId: string,
  workItem: { homeChannelId: string; homeThreadTs: string; repo: string; title: string },
  status: "queued" | "running" = "running",
  requestedBy = "work-item:auto-review",
) {
  const run = await runStore.createRun(
    {
      repoSlug: workItem.repo,
      task: `Auto-review for ${workItem.title}`,
      baseBranch: "main",
      requestedBy,
      channelId: workItem.homeChannelId,
      threadTs: workItem.homeThreadTs,
      runtime: "local",
    },
    "gooseherd",
  );
  await runStore.linkToWorkItem(run.id, workItemId);
  return runStore.updateRun(run.id, {
    status,
    phase: "agent",
  });
}

async function createAwaitingCiLinkedRun(
  runStore: RunStore,
  workItemId: string,
  workItem: { homeChannelId: string; homeThreadTs: string; repo: string; title: string },
  requestedBy = "work-item:auto-review",
) {
  const run = await runStore.createRun(
    {
      repoSlug: workItem.repo,
      task: `Auto-review for ${workItem.title}`,
      baseBranch: "main",
      requestedBy,
      channelId: workItem.homeChannelId,
      threadTs: workItem.homeThreadTs,
      runtime: "local",
    },
    "gooseherd",
  );
  await runStore.linkToWorkItem(run.id, workItemId);
  return runStore.updateRun(run.id, {
    status: "awaiting_ci",
    phase: "awaiting_ci",
  });
}

test("orchestrator promotes auto_review pr_adopted work items into collecting_context and auto-launches one run", async (t) => {
  const { db, cleanup, workItem } = await createAutoReviewFixture();
  t.after(cleanup);
  const { reconcileWorkItem } = await import("../src/work-items/orchestrator.js");

  await reconcileWorkItem(db, workItem.id, "test-trigger", {
    config: { defaultBaseBranch: "release/2026.04", sandboxRuntime: "kubernetes" },
  });

  const workItemRow = await (new WorkItemService(db)).getWorkItem(workItem.id);
  assert.equal(workItemRow?.substate, "collecting_context");
  assert.equal(workItemRow?.state, "auto_review");

  const runRows = await (new RunStore(db)).listRunsForWorkItem(workItem.id);
  assert.equal(runRows.length, 1);
  assert.equal(runRows[0]?.workItemId, workItem.id);
  assert.equal(runRows[0]?.status, "queued");
  assert.equal(runRows[0]?.baseBranch, "release/2026.04");
  assert.equal(runRows[0]?.branchName, "feature/hbl-404");
  assert.equal(runRows[0]?.parentBranchName, "feature/hbl-404");
  assert.equal(runRows[0]?.runtime, "kubernetes");
  assert.equal(runRows[0]?.pipelineHint, "feature-delivery-self-review");
  assert.equal(runRows[0]?.intentKind, "feature_delivery.self_review");
  assert.equal(runRows[0]?.intent?.kind, "feature_delivery.self_review");
  assert.equal(runRows[0]?.autoReviewSourceSubstate, "pr_adopted");
  assert.equal(runRows[0]?.prUrl, "https://github.com/hubstaff/gooseherd/pull/77");
  assert.equal(runRows[0]?.prNumber, 77);

  const events = await db.select().from(workItemEvents).where(eq(workItemEvents.workItemId, workItem.id));
  assert.ok(events.some((event) => event.eventType === "run.auto_launched"));
});

test("orchestrator auto-launches one linked run for auto_review items applying review feedback", async (t) => {
  const { db, cleanup, workItem } = await createAutoReviewFixture("applying_review_feedback");
  t.after(cleanup);
  const { reconcileWorkItem } = await import("../src/work-items/orchestrator.js");

  await reconcileWorkItem(db, workItem.id);

  const runRows = await new RunStore(db).listRunsForWorkItem(workItem.id);
  assert.equal(runRows.length, 1);
  assert.equal(runRows[0]?.workItemId, workItem.id);
  assert.equal(runRows[0]?.status, "queued");
  assert.equal(runRows[0]?.autoReviewSourceSubstate, "applying_review_feedback");
  assert.equal(runRows[0]?.pipelineHint, "feature-delivery-review-feedback");
  assert.equal(runRows[0]?.intentKind, "feature_delivery.apply_review_feedback");
  assert.equal(runRows[0]?.intent?.kind, "feature_delivery.apply_review_feedback");
});

test("orchestrator launches a standalone ci-fix run for auto_review ci_failed", async (t) => {
  const { db, cleanup, workItem } = await createAutoReviewFixture("ci_failed");
  t.after(cleanup);
  const { reconcileWorkItem } = await import("../src/work-items/orchestrator.js");

  await reconcileWorkItem(db, workItem.id, "github.ci_failed", {
    config: { defaultBaseBranch: "release/2026.04", sandboxRuntime: "kubernetes" },
  });

  const workItemRow = await (new WorkItemService(db)).getWorkItem(workItem.id);
  const runRows = await (new RunStore(db)).listRunsForWorkItem(workItem.id);

  assert.equal(workItemRow?.state, "auto_review");
  assert.equal(workItemRow?.substate, "ci_failed");
  assert.equal(runRows.length, 1);
  assert.equal(runRows[0]?.requestedBy, "work-item:ci-fix");
  assert.equal(runRows[0]?.pipelineHint, "ci-fix");
  assert.equal(runRows[0]?.intentKind, "feature_delivery.repair_ci");
  assert.equal(runRows[0]?.intent?.kind, "feature_delivery.repair_ci");
  assert.equal(runRows[0]?.branchName, "feature/hbl-404");
  assert.equal(runRows[0]?.parentBranchName, "feature/hbl-404");
  assert.equal(runRows[0]?.autoReviewSourceSubstate, "ci_failed");
  assert.equal(runRows[0]?.runtime, "kubernetes");
});

test("orchestrator launches a self-review run for auto_review ci_green_pending_self_review", async (t) => {
  const { db, cleanup, workItem } = await createAutoReviewFixture("ci_green_pending_self_review");
  t.after(cleanup);
  const { reconcileWorkItem } = await import("../src/work-items/orchestrator.js");

  await reconcileWorkItem(db, workItem.id, "github.ci_green_pending_self_review", {
    config: { defaultBaseBranch: "release/2026.04", sandboxRuntime: "kubernetes" },
  });

  const workItemRow = await (new WorkItemService(db)).getWorkItem(workItem.id);
  const runRows = await (new RunStore(db)).listRunsForWorkItem(workItem.id);

  assert.equal(workItemRow?.state, "auto_review");
  assert.equal(workItemRow?.substate, "collecting_context");
  assert.equal(runRows.length, 1);
  assert.equal(runRows[0]?.requestedBy, "work-item:auto-review");
  assert.equal(runRows[0]?.pipelineHint, "feature-delivery-self-review");
  assert.equal(runRows[0]?.intentKind, "feature_delivery.self_review");
  assert.equal(runRows[0]?.intent?.kind, "feature_delivery.self_review");
  assert.equal(runRows[0]?.branchName, "feature/hbl-404");
  assert.equal(runRows[0]?.parentBranchName, "feature/hbl-404");
  assert.equal(runRows[0]?.autoReviewSourceSubstate, "ci_green_pending_self_review");
  assert.equal(runRows[0]?.runtime, "kubernetes");
});

test("orchestrator does not auto-launch runs when ai:assist automation is disabled", async (t) => {
  const { db, cleanup, workItem } = await createAutoReviewFixture("ci_failed");
  t.after(cleanup);
  const workItemStore = new WorkItemStore(db);
  await workItemStore.updateState(workItem.id, {
    state: "auto_review",
    substate: "ci_failed",
    flagsToRemove: ["ai_assist_enabled"],
    flagsToAdd: ["ai_assist_disabled"],
  });
  const { reconcileWorkItem } = await import("../src/work-items/orchestrator.js");

  await reconcileWorkItem(db, workItem.id, "github.ci_failed");

  const workItemRow = await (new WorkItemService(db)).getWorkItem(workItem.id);
  const runRows = await (new RunStore(db)).listRunsForWorkItem(workItem.id);

  assert.equal(workItemRow?.substate, "ci_failed");
  assert.equal(runRows.length, 0);
});

test("orchestrator queues a standalone branch-sync run for stale ready_for_merge work items", async (t) => {
  const { db, cleanup, workItem } = await createFeatureDeliveryFixture({
    state: "ready_for_merge",
    substate: "waiting_merge",
    flags: ["ci_green", "engineering_review_done", "qa_review_done"],
  });
  t.after(cleanup);
  const { queueBranchSyncRun } = await import("../src/work-items/orchestrator.js");

  await queueBranchSyncRun(db, workItem.id, "periodic.branch_stale", {
    config: { defaultBaseBranch: "release/2026.04", sandboxRuntime: "kubernetes" },
  });

  const workItemRow = await (new WorkItemService(db)).getWorkItem(workItem.id);
  const runRows = await (new RunStore(db)).listRunsForWorkItem(workItem.id);

  assert.equal(workItemRow?.state, "ready_for_merge");
  assert.equal(workItemRow?.substate, "waiting_merge");
  assert.equal(runRows.length, 1);
  assert.equal(runRows[0]?.requestedBy, "work-item:branch-sync");
  assert.equal(runRows[0]?.pipelineHint, "branch-sync");
  assert.equal(runRows[0]?.intentKind, "feature_delivery.sync_branch");
  assert.equal(runRows[0]?.intent?.kind, "feature_delivery.sync_branch");
  assert.equal(runRows[0]?.prUrl, "https://github.com/hubstaff/gooseherd/pull/90");
  assert.equal(runRows[0]?.prNumber, 90);
  assert.equal(runRows[0]?.branchName, "feature/hbl-405");
  assert.equal(runRows[0]?.parentBranchName, "feature/hbl-405");
  assert.equal(runRows[0]?.autoReviewSourceSubstate, "waiting_merge");
  assert.equal(runRows[0]?.runtime, "kubernetes");
});

test("orchestrator queues a standalone ready-for-merge run for multi-commit PR work items", async (t) => {
  const { db, cleanup, workItem } = await createFeatureDeliveryFixture({
    state: "ready_for_merge",
    substate: "waiting_merge",
    flags: ["ci_green", "engineering_review_done", "qa_review_done"],
  });
  t.after(cleanup);
  const { queueReadyForMergeRun } = await import("../src/work-items/orchestrator.js");

  await queueReadyForMergeRun(db, workItem.id, "ready_for_merge.entered", {
    config: { defaultBaseBranch: "release/2026.04", sandboxRuntime: "kubernetes" },
  });

  const workItemRow = await (new WorkItemService(db)).getWorkItem(workItem.id);
  const runRows = await (new RunStore(db)).listRunsForWorkItem(workItem.id);
  const events = await db.select().from(workItemEvents).where(eq(workItemEvents.workItemId, workItem.id));

  assert.equal(workItemRow?.state, "ready_for_merge");
  assert.equal(workItemRow?.substate, "waiting_merge");
  assert.equal(runRows.length, 1);
  assert.equal(runRows[0]?.requestedBy, "work-item:ready-for-merge");
  assert.equal(runRows[0]?.pipelineHint, "ready-for-merge");
  assert.equal(runRows[0]?.intentKind, "feature_delivery.finalize_pr");
  assert.equal(runRows[0]?.intent?.kind, "feature_delivery.finalize_pr");
  assert.equal(runRows[0]?.prUrl, "https://github.com/hubstaff/gooseherd/pull/90");
  assert.equal(runRows[0]?.prNumber, 90);
  assert.equal(runRows[0]?.branchName, "feature/hbl-405");
  assert.equal(runRows[0]?.parentBranchName, "feature/hbl-405");
  assert.equal(runRows[0]?.autoReviewSourceSubstate, "waiting_merge");
  assert.equal(runRows[0]?.runtime, "kubernetes");
  assert.ok(events.some((event) => event.eventType === "run.ready_for_merge_launched"));
});

test("orchestrator queues a standalone QA preparation run for qa_preparation work items", async (t) => {
  const { db, cleanup, workItem } = await createFeatureDeliveryFixture({
    state: "qa_preparation",
    substate: "waiting_qa_preparation",
    flags: ["ci_green", "engineering_review_done"],
  });
  t.after(cleanup);
  const { queueQaPreparationRun } = await import("../src/work-items/orchestrator.js");

  await queueQaPreparationRun(db, workItem.id, "qa_preparation.entered", {
    config: { defaultBaseBranch: "release/2026.04", sandboxRuntime: "kubernetes" },
  });

  const workItemRow = await (new WorkItemService(db)).getWorkItem(workItem.id);
  const runRows = await (new RunStore(db)).listRunsForWorkItem(workItem.id);
  const events = await db.select().from(workItemEvents).where(eq(workItemEvents.workItemId, workItem.id));

  assert.equal(workItemRow?.state, "qa_preparation");
  assert.equal(runRows.length, 1);
  assert.equal(runRows[0]?.requestedBy, "work-item:qa-preparation");
  assert.equal(runRows[0]?.pipelineHint, "feature-delivery-qa-preparation");
  assert.equal(runRows[0]?.intentKind, "feature_delivery.qa_preparation");
  assert.equal(runRows[0]?.intent?.kind, "feature_delivery.qa_preparation");
  assert.equal(runRows[0]?.prUrl, "https://github.com/hubstaff/gooseherd/pull/90");
  assert.equal(runRows[0]?.prNumber, 90);
  assert.equal(runRows[0]?.branchName, "feature/hbl-405");
  assert.equal(runRows[0]?.parentBranchName, "feature/hbl-405");
  assert.equal(runRows[0]?.runtime, "kubernetes");
  assert.ok(events.some((event) => event.eventType === "run.qa_preparation_launched"));
});

test("orchestrator does not queue branch-sync runs until engineering and QA reviews are complete", async (t) => {
  const { db, cleanup, workItem } = await createFeatureDeliveryFixture({
    state: "ready_for_merge",
    substate: "waiting_merge",
    flags: ["ci_green", "engineering_review_done"],
  });
  t.after(cleanup);
  const { queueBranchSyncRun } = await import("../src/work-items/orchestrator.js");

  await queueBranchSyncRun(db, workItem.id, "periodic.branch_stale", {
    config: { defaultBaseBranch: "release/2026.04", sandboxRuntime: "kubernetes" },
  });

  const runRows = await (new RunStore(db)).listRunsForWorkItem(workItem.id);
  assert.equal(runRows.length, 0);
});

test("orchestrator does not queue branch-sync runs when ai:assist automation is disabled", async (t) => {
  const { db, cleanup, workItem } = await createFeatureDeliveryFixture({
    state: "ready_for_merge",
    substate: "waiting_merge",
    flags: ["ci_green", "engineering_review_done", "qa_review_done", "ai_assist_disabled"],
  });
  t.after(cleanup);
  const workItemStore = new WorkItemStore(db);
  await workItemStore.updateState(workItem.id, {
    state: "ready_for_merge",
    flagsToRemove: ["ai_assist_enabled"],
  });
  const { queueBranchSyncRun } = await import("../src/work-items/orchestrator.js");

  await queueBranchSyncRun(db, workItem.id, "periodic.branch_stale", {
    config: { defaultBaseBranch: "release/2026.04", sandboxRuntime: "kubernetes" },
  });

  const runRows = await (new RunStore(db)).listRunsForWorkItem(workItem.id);
  assert.equal(runRows.length, 0);
});

test("orchestrator writeback marks self_review_done when auto-review run reaches awaiting_ci", async (t) => {
  const { db, cleanup, workItem, runStore } = await createAutoReviewFixture("applying_review_feedback");
  t.after(cleanup);
  const run = await createAwaitingCiLinkedRun(runStore, workItem.id, workItem);
  const { writebackWorkItem } = await import("../src/work-items/orchestrator.js");

  await writebackWorkItem(db, run.id);

  const workItemRow = await (new WorkItemService(db)).getWorkItem(workItem.id);
  assert.equal(workItemRow?.state, "auto_review");
  assert.equal(workItemRow?.substate, "waiting_ci");
  assert.ok(workItemRow?.flags.includes("self_review_done"));
});

test("orchestrator writeback advances auto_review to engineering_review when ci_green is already present", async (t) => {
  const { db, cleanup, workItem, runStore } = await createAutoReviewFixture("applying_review_feedback");
  t.after(cleanup);

  await (new WorkItemStore(db)).updateState(workItem.id, {
    state: "auto_review",
    flagsToAdd: ["ci_green"],
  });
  const run = await createAwaitingCiLinkedRun(runStore, workItem.id, workItem);
  const { writebackWorkItem } = await import("../src/work-items/orchestrator.js");

  await writebackWorkItem(db, run.id);

  const workItemRow = await (new WorkItemService(db)).getWorkItem(workItem.id);
  assert.equal(workItemRow?.state, "engineering_review");
});

test("orchestrator writeback skips engineering_review when it is already marked done", async (t) => {
  const { db, cleanup, workItem, runStore } = await createAutoReviewFixture("applying_review_feedback");
  t.after(cleanup);

  await (new WorkItemStore(db)).updateState(workItem.id, {
    state: "auto_review",
    flagsToAdd: ["ci_green", "engineering_review_done"],
  });
  const run = await createAwaitingCiLinkedRun(runStore, workItem.id, workItem);
  const { writebackWorkItem } = await import("../src/work-items/orchestrator.js");

  await writebackWorkItem(db, run.id);

  const workItemRow = await (new WorkItemService(db)).getWorkItem(workItem.id);
  assert.equal(workItemRow?.state, "qa_preparation");
  assert.equal(workItemRow?.substate, "preparing_review_app");
});

test("orchestrator writeback enters qa preparation when engineering_review is already marked done", async (t) => {
  const { db, cleanup, workItem, runStore } = await createAutoReviewFixture("applying_review_feedback");
  t.after(cleanup);

  await (new WorkItemStore(db)).updateState(workItem.id, {
    state: "auto_review",
    flagsToAdd: ["ci_green", "engineering_review_done"],
  });
  const run = await createAwaitingCiLinkedRun(runStore, workItem.id, workItem);
  const { writebackWorkItem } = await import("../src/work-items/orchestrator.js");

  await writebackWorkItem(db, run.id, {
    config: {
      defaultBaseBranch: "release/2026.04",
      featureDeliverySkipProductReview: true,
    },
  });

  const workItemRow = await (new WorkItemService(db)).getWorkItem(workItem.id);
  assert.equal(workItemRow?.state, "qa_preparation");
  assert.equal(workItemRow?.substate, "preparing_review_app");
});

test("orchestrator writeback advances directly to ready_for_merge when qa review is already marked done", async (t) => {
  const { db, cleanup, workItem, runStore } = await createAutoReviewFixture("applying_review_feedback");
  t.after(cleanup);

  await (new WorkItemStore(db)).updateState(workItem.id, {
    state: "auto_review",
    flagsToAdd: ["ci_green", "engineering_review_done", "qa_review_done"],
  });
  const run = await createAwaitingCiLinkedRun(runStore, workItem.id, workItem);
  const { writebackWorkItem } = await import("../src/work-items/orchestrator.js");

  await writebackWorkItem(db, run.id, {
    config: {
      defaultBaseBranch: "release/2026.04",
      featureDeliverySkipProductReview: true,
    },
  });

  const workItemRow = await (new WorkItemService(db)).getWorkItem(workItem.id);
  assert.equal(workItemRow?.state, "ready_for_merge");
  assert.equal(workItemRow?.substate, "waiting_merge");
});

test("orchestrator writeback triggers ready_for_merge handler when entering ready_for_merge", async (t) => {
  const { db, cleanup, workItem, runStore } = await createAutoReviewFixture("applying_review_feedback");
  t.after(cleanup);

  await (new WorkItemStore(db)).updateState(workItem.id, {
    state: "auto_review",
    flagsToAdd: ["ci_green", "engineering_review_done", "qa_review_done"],
  });
  const run = await createAwaitingCiLinkedRun(runStore, workItem.id, workItem);
  const { writebackWorkItem } = await import("../src/work-items/orchestrator.js");
  const calls: Array<{ id: string; state: string }> = [];

  await writebackWorkItem(db, run.id, {
    config: {
      defaultBaseBranch: "release/2026.04",
      featureDeliverySkipProductReview: true,
    },
    readyForMergeHandler: async (updatedWorkItem) => {
      calls.push({ id: updatedWorkItem.id, state: updatedWorkItem.state });
    },
  });

  assert.deepEqual(calls, [{ id: workItem.id, state: "ready_for_merge" }]);
});

test("orchestrator writeback marks self_review_done when auto-review run completes without awaiting_ci", async (t) => {
  const { db, cleanup, workItem, runStore } = await createAutoReviewFixture("applying_review_feedback");
  t.after(cleanup);

  const run = await createAwaitingCiLinkedRun(runStore, workItem.id, workItem);
  await runStore.updateRun(run.id, {
    status: "completed",
    phase: "completed",
  });

  const { writebackWorkItem } = await import("../src/work-items/orchestrator.js");
  await writebackWorkItem(db, run.id);

  const workItemRow = await (new WorkItemService(db)).getWorkItem(workItem.id);
  assert.equal(workItemRow?.state, "auto_review");
  assert.equal(workItemRow?.substate, "waiting_ci");
  assert.ok(workItemRow?.flags.includes("self_review_done"));
});

test("orchestrator writeback accepts successful work-item:ci-fix checkpoints", async (t) => {
  const { db, cleanup, workItem, runStore } = await createAutoReviewFixture("ci_failed");
  t.after(cleanup);
  const run = await createAwaitingCiLinkedRun(runStore, workItem.id, workItem, "work-item:ci-fix");
  const { writebackWorkItem } = await import("../src/work-items/orchestrator.js");

  await writebackWorkItem(db, run.id);

  const workItemRow = await (new WorkItemService(db)).getWorkItem(workItem.id);
  assert.equal(workItemRow?.state, "auto_review");
  assert.equal(workItemRow?.substate, "waiting_ci");
  assert.ok(workItemRow?.flags.includes("self_review_done"));
});

test("orchestrator reconcile does not duplicate an existing active linked run", async (t) => {
  const { db, cleanup, workItem, runStore } = await createAutoReviewFixture();
  t.after(cleanup);
  const existing = await createActiveLinkedRun(runStore, workItem.id, workItem, "queued");
  const { reconcileWorkItem } = await import("../src/work-items/orchestrator.js");

  await reconcileWorkItem(db, workItem.id);

  const runRows = await runStore.listRunsForWorkItem(workItem.id);
  assert.equal(runRows.length, 1);
  assert.equal(runRows[0]?.id, existing.id);
  assert.equal(runRows[0]?.status, "queued");
});

test("orchestrator reconcile ignores unrelated active linked runs when auto-review launch is needed", async (t) => {
  const { db, cleanup, workItem, runStore } = await createAutoReviewFixture();
  t.after(cleanup);

  await createActiveLinkedRun(runStore, workItem.id, workItem, "queued", "manual:dashboard");
  const { reconcileWorkItem } = await import("../src/work-items/orchestrator.js");

  await reconcileWorkItem(db, workItem.id);

  const runRows = await runStore.listRunsForWorkItem(workItem.id);
  assert.equal(runRows.length, 2);
  assert.ok(runRows.some((run) => run.requestedBy === "manual:dashboard" && run.status === "queued"));
  assert.ok(runRows.some((run) => run.requestedBy === "work-item:auto-review" && run.status === "queued"));
});

test("orchestrator reconcile does not treat active branch-sync run as active auto-review automation", async (t) => {
  const { db, cleanup, workItem, runStore } = await createAutoReviewFixture("ci_failed");
  t.after(cleanup);

  const branchSync = await runStore.createRun(
    {
      repoSlug: workItem.repo,
      task: `Sync branch for ${workItem.title}`,
      baseBranch: "main",
      requestedBy: "work-item:branch-sync",
      channelId: workItem.homeChannelId,
      threadTs: workItem.homeThreadTs,
      runtime: "local",
      workItemId: workItem.id,
      prUrl: workItem.githubPrUrl,
      prNumber: workItem.githubPrNumber,
      intent: {
        version: 1,
        kind: "feature_delivery.sync_branch",
        source: "work_item",
        workItemId: workItem.id,
        repo: workItem.repo,
        prNumber: workItem.githubPrNumber!,
        prUrl: workItem.githubPrUrl!,
        maxBehindCommits: 5,
      },
    },
    "gooseherd",
    workItem.githubPrHeadBranch,
  );
  await runStore.updateRun(branchSync.id, { status: "running", phase: "agent" });

  const { reconcileWorkItem } = await import("../src/work-items/orchestrator.js");
  await reconcileWorkItem(db, workItem.id, "github.ci_failed");

  const runRows = await runStore.listRunsForWorkItem(workItem.id);
  assert.equal(runRows.length, 2);
  assert.ok(runRows.some((run) => run.intent?.kind === "feature_delivery.sync_branch"));
  assert.ok(runRows.some((run) => run.intent?.kind === "feature_delivery.repair_ci"));
});

test("orchestrator reconcile does not duplicate an existing active work-item:ci-fix run", async (t) => {
  const { db, cleanup, workItem, runStore } = await createAutoReviewFixture("ci_failed");
  t.after(cleanup);
  const existing = await createActiveLinkedRun(runStore, workItem.id, workItem, "queued", "work-item:ci-fix");
  const { reconcileWorkItem } = await import("../src/work-items/orchestrator.js");

  await reconcileWorkItem(db, workItem.id, "github.ci_failed");

  const runRows = await runStore.listRunsForWorkItem(workItem.id);
  assert.equal(runRows.length, 1);
  assert.equal(runRows[0]?.id, existing.id);
});

test("orchestrator reconcile claims auto-launch atomically under concurrent calls", async (t) => {
  const { db, cleanup, workItem } = await createAutoReviewFixture();
  t.after(cleanup);
  const { reconcileWorkItem } = await import("../src/work-items/orchestrator.js");

  await Promise.all([
    reconcileWorkItem(db, workItem.id),
    reconcileWorkItem(db, workItem.id),
    reconcileWorkItem(db, workItem.id),
    reconcileWorkItem(db, workItem.id),
  ]);

  const runRows = await new RunStore(db).listRunsForWorkItem(workItem.id);
  assert.equal(runRows.length, 1);
  assert.equal(runRows[0]?.workItemId, workItem.id);
});

test("orchestrator writeback ignores unrelated linked successful runs", async (t) => {
  const { db, cleanup, workItem, runStore } = await createAutoReviewFixture("applying_review_feedback");
  t.after(cleanup);

  const run = await createAwaitingCiLinkedRun(runStore, workItem.id, workItem, "manual:dashboard");
  const { writebackWorkItem } = await import("../src/work-items/orchestrator.js");

  await writebackWorkItem(db, run.id);

  const afterAwaitingCi = await (new WorkItemService(db)).getWorkItem(workItem.id);
  assert.equal(afterAwaitingCi?.substate, "applying_review_feedback");
  assert.ok(!afterAwaitingCi?.flags.includes("self_review_done"));

  await runStore.updateRun(run.id, {
    status: "completed",
    phase: "completed",
  });
  await writebackWorkItem(db, run.id);

  const afterCompleted = await (new WorkItemService(db)).getWorkItem(workItem.id);
  assert.equal(afterCompleted?.substate, "applying_review_feedback");
  assert.ok(!afterCompleted?.flags.includes("self_review_done"));
});

test("orchestrator rolls collecting_context back to the source substate for the latest failed auto-review launch", async (t) => {
  const { db, cleanup, workItem, runStore } = await createAutoReviewFixture();
  t.after(cleanup);
  const { reconcileWorkItem, handlePrefetchFailure } = await import("../src/work-items/orchestrator.js");

  await reconcileWorkItem(db, workItem.id);

  const [launchedRun] = await runStore.listRunsForWorkItem(workItem.id);
  assert.equal(launchedRun?.autoReviewSourceSubstate, "pr_adopted");
  await runStore.updateRun(launchedRun!.id, {
    status: "failed",
    phase: "failed",
    error: "GitHub prefetch failed for work item test",
  });

  const rolledBack = await handlePrefetchFailure(db, launchedRun!.id);
  assert.equal(rolledBack?.state, "auto_review");
  assert.equal(rolledBack?.substate, "pr_adopted");

  const updated = await (new WorkItemService(db)).getWorkItem(workItem.id);
  assert.equal(updated?.substate, "pr_adopted");
});

test("orchestrator does not overwrite newer work-item state during prefetch rollback", async (t) => {
  const { db, cleanup, workItem, runStore } = await createAutoReviewFixture();
  t.after(cleanup);
  const { reconcileWorkItem, handlePrefetchFailure } = await import("../src/work-items/orchestrator.js");

  await reconcileWorkItem(db, workItem.id);

  const [launchedRun] = await runStore.listRunsForWorkItem(workItem.id);
  await runStore.updateRun(launchedRun!.id, {
    status: "failed",
    phase: "failed",
    error: "Jira prefetch failed for work item test",
  });
  await (new WorkItemStore(db)).updateState(workItem.id, {
    state: "auto_review",
    substate: "waiting_ci",
  });

  const rolledBack = await handlePrefetchFailure(db, launchedRun!.id);
  assert.equal(rolledBack, undefined);

  const updated = await (new WorkItemService(db)).getWorkItem(workItem.id);
  assert.equal(updated?.substate, "waiting_ci");
});

test("orchestrator does not roll back superseded auto-review launches", async (t) => {
  const { db, cleanup, workItem, runStore } = await createAutoReviewFixture();
  t.after(cleanup);
  const { reconcileWorkItem, handlePrefetchFailure } = await import("../src/work-items/orchestrator.js");

  await reconcileWorkItem(db, workItem.id);
  const [firstRun] = await runStore.listRunsForWorkItem(workItem.id);
  await runStore.updateRun(firstRun!.id, {
    status: "failed",
    phase: "failed",
    error: "GitHub prefetch failed for work item test",
  });

  await runStore.createRun(
    {
      repoSlug: workItem.repo,
      task: `Auto-review retry for ${workItem.title}`,
      baseBranch: "main",
      requestedBy: "work-item:auto-review",
      channelId: workItem.homeChannelId,
      threadTs: workItem.homeThreadTs,
      runtime: "local",
      workItemId: workItem.id,
      autoReviewSourceSubstate: "pr_adopted",
    },
    "gooseherd",
    workItem.githubPrHeadBranch,
  );

  const rolledBack = await handlePrefetchFailure(db, firstRun!.id);
  assert.equal(rolledBack, undefined);

  const updated = await (new WorkItemService(db)).getWorkItem(workItem.id);
  assert.equal(updated?.substate, "collecting_context");
});
