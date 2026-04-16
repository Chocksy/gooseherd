import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "./helpers/test-db.js";
import { teamMembers, teams, users, workItemEvents } from "../src/db/schema.js";
import { WorkItemService } from "../src/work-items/service.js";
import { WorkItemStore } from "../src/work-items/store.js";
import { RunStore } from "../src/store.js";

type AutoReviewSubstate = "pr_adopted" | "applying_review_feedback";

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
    flags: ["pr_opened"],
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
  assert.equal(runRows[0]?.pipelineHint, "pipeline");

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
