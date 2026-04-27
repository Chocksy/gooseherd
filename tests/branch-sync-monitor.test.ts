import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createTestDb } from "./helpers/test-db.js";
import { teamMembers, teams, users } from "../src/db/schema.js";
import { WorkItemService } from "../src/work-items/service.js";
import { WorkItemStore } from "../src/work-items/store.js";
import { RunStore } from "../src/store.js";

async function createFeatureDeliveryFixture(initialFlags: string[] = []) {
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
  const workItem = await workItemService.createDeliveryFromJira({
    title: "Monitor stale PR branches",
    summary: "Queue rebases for long-lived PRs when they drift too far behind base.",
    ownerTeamId,
    homeChannelId: "C_CORE",
    homeThreadTs: "1740000000.702",
    jiraIssueKey: "HBL-406",
    repo: "hubstaff/gooseherd",
    githubPrNumber: 91,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/91",
    githubPrBaseBranch: "main",
    githubPrHeadBranch: "feature/hbl-406",
    createdByUserId: ownerUserId,
    initialState: "ready_for_merge",
    initialSubstate: "waiting_merge",
    flags: ["pr_opened", ...initialFlags],
  });

  return {
    db: testDb.db,
    cleanup: testDb.cleanup,
    workItem,
  };
}

async function createCancelledAiAssistFixture(initialFlags: string[] = []) {
  const testDb = await createTestDb();
  const ownerUserId = randomUUID();
  const ownerTeamId = randomUUID();

  await testDb.db.insert(users).values({
    id: ownerUserId,
    slackUserId: "U_CANCELLED",
    displayName: "Owner",
  });
  await testDb.db.insert(teams).values({
    id: ownerTeamId,
    name: "cancelled-core",
    slackChannelId: "C_CANCELLED",
  });

  const workItemService = new WorkItemService(testDb.db);
  const workItem = await workItemService.createDeliveryFromJira({
    title: "Paused automation",
    summary: "Automation paused because ai:assist was removed.",
    ownerTeamId,
    homeChannelId: "C_CANCELLED",
    homeThreadTs: "1740000000.703",
    jiraIssueKey: "HBL-407",
    repo: "hubstaff/gooseherd",
    githubPrNumber: 92,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/92",
    githubPrBaseBranch: "main",
    githubPrHeadBranch: "feature/hbl-407",
    createdByUserId: ownerUserId,
    initialState: "auto_review",
    initialSubstate: "waiting_ci",
    flags: ["pr_opened", "github_pr_adopted", "ai_assist_enabled", ...initialFlags],
  });

  const cancelled = await new WorkItemStore(testDb.db).updateState(workItem.id, {
    state: "cancelled",
    flagsToAdd: ["ai_assist_disabled"],
    flagsToRemove: ["ai_assist_enabled"],
  });

  return {
    db: testDb.db,
    cleanup: testDb.cleanup,
    workItem: cancelled,
  };
}

test("runBranchSyncMonitorCycle marks stale branches and queues branch-sync runs", async (t) => {
  const { db, cleanup, workItem } = await createFeatureDeliveryFixture(["engineering_review_done", "qa_review_done"]);
  t.after(cleanup);

  const { runBranchSyncMonitorCycle } = await import("../src/work-items/branch-sync-monitor.js");
  const queued: Array<{ workItemId: string; reason: string }> = [];

  const result = await runBranchSyncMonitorCycle({
    workItems: new WorkItemStore(db),
    runs: new RunStore(db),
    maxBehindCommits: 5,
    compareBranchRefs: async () => ({ aheadBy: 2, behindBy: 6 }),
    queueBranchSyncRun: async (workItemId, reason) => {
      queued.push({ workItemId, reason });
    },
  });

  const updated = await new WorkItemStore(db).getWorkItem(workItem.id);
  assert.equal(result.checked, 1);
  assert.equal(result.stale, 1);
  assert.equal(result.queued, 1);
  assert.ok(updated?.flags.includes("branch_stale"));
  assert.deepEqual(queued, [{ workItemId: workItem.id, reason: "periodic.branch_stale" }]);
});

test("runBranchSyncMonitorCycle clears branch_stale when the branch is fresh again", async (t) => {
  const { db, cleanup, workItem } = await createFeatureDeliveryFixture([
    "engineering_review_done",
    "qa_review_done",
    "branch_stale",
  ]);
  t.after(cleanup);

  const { runBranchSyncMonitorCycle } = await import("../src/work-items/branch-sync-monitor.js");

  const result = await runBranchSyncMonitorCycle({
    workItems: new WorkItemStore(db),
    runs: new RunStore(db),
    maxBehindCommits: 5,
    compareBranchRefs: async () => ({ aheadBy: 2, behindBy: 1 }),
    queueBranchSyncRun: async () => {
      throw new Error("fresh branches must not queue branch-sync runs");
    },
  });

  const updated = await new WorkItemStore(db).getWorkItem(workItem.id);
  assert.equal(result.checked, 1);
  assert.equal(result.stale, 0);
  assert.equal(result.queued, 0);
  assert.ok(!updated?.flags.includes("branch_stale"));
});

test("runBranchSyncMonitorCycle ignores branch sync until engineering and QA reviews are complete", async (t) => {
  const { db, cleanup, workItem } = await createFeatureDeliveryFixture(["engineering_review_done", "branch_stale"]);
  t.after(cleanup);

  const { runBranchSyncMonitorCycle } = await import("../src/work-items/branch-sync-monitor.js");

  const result = await runBranchSyncMonitorCycle({
    workItems: new WorkItemStore(db),
    runs: new RunStore(db),
    maxBehindCommits: 5,
    compareBranchRefs: async () => {
      throw new Error("ineligible items must not be compared");
    },
    queueBranchSyncRun: async () => {
      throw new Error("ineligible items must not queue branch-sync runs");
    },
  });

  const updated = await new WorkItemStore(db).getWorkItem(workItem.id);
  assert.equal(result.checked, 0);
  assert.equal(result.stale, 0);
  assert.equal(result.queued, 0);
  assert.ok(!updated?.flags.includes("branch_stale"));
});

test("runBranchSyncMonitorCycle marks merged linked work items done before branch sync", async (t) => {
  const { db, cleanup, workItem } = await createFeatureDeliveryFixture(["engineering_review_done", "qa_review_done"]);
  t.after(cleanup);

  const { runBranchSyncMonitorCycle } = await import("../src/work-items/branch-sync-monitor.js");

  const result = await runBranchSyncMonitorCycle({
    workItems: new WorkItemStore(db),
    runs: new RunStore(db),
    maxBehindCommits: 5,
    getPullRequest: async () => ({
      number: 91,
      url: "https://github.com/hubstaff/gooseherd/pull/91",
      title: "Merged PR",
      body: "",
      state: "closed",
      merged: true,
    }),
    compareBranchRefs: async () => {
      throw new Error("closed PRs must not be checked for branch staleness");
    },
    queueBranchSyncRun: async () => {
      throw new Error("closed PRs must not queue branch-sync runs");
    },
  });

  const updated = await new WorkItemStore(db).getWorkItem(workItem.id);
  assert.equal(result.checked, 1);
  assert.equal(result.closed, 1);
  assert.equal(result.stale, 0);
  assert.equal(result.queued, 0);
  assert.equal(updated?.state, "done");
  assert.equal(updated?.substate, "merged");
  assert.ok(updated?.flags.includes("merged"));
});

test("runBranchSyncMonitorCycle cancels closed unmerged linked work items before branch sync", async (t) => {
  const { db, cleanup, workItem } = await createFeatureDeliveryFixture(["engineering_review_done", "qa_review_done"]);
  t.after(cleanup);

  const { runBranchSyncMonitorCycle } = await import("../src/work-items/branch-sync-monitor.js");

  const result = await runBranchSyncMonitorCycle({
    workItems: new WorkItemStore(db),
    runs: new RunStore(db),
    maxBehindCommits: 5,
    getPullRequest: async () => ({
      number: 91,
      url: "https://github.com/hubstaff/gooseherd/pull/91",
      title: "Closed PR",
      body: "",
      state: "closed",
      merged: false,
    }),
    compareBranchRefs: async () => {
      throw new Error("closed PRs must not be checked for branch staleness");
    },
    queueBranchSyncRun: async () => {
      throw new Error("closed PRs must not queue branch-sync runs");
    },
  });

  const updated = await new WorkItemStore(db).getWorkItem(workItem.id);
  assert.equal(result.checked, 1);
  assert.equal(result.closed, 1);
  assert.equal(result.stale, 0);
  assert.equal(result.queued, 0);
  assert.equal(updated?.state, "cancelled");
  assert.equal(updated?.substate, "closed_unmerged");
  assert.ok(updated?.flags.includes("pr_closed"));
});

test("runBranchSyncMonitorCycle marks ai-assist-disabled cancelled work items done when the PR was merged", async (t) => {
  const { db, cleanup, workItem } = await createCancelledAiAssistFixture();
  t.after(cleanup);

  const { runBranchSyncMonitorCycle } = await import("../src/work-items/branch-sync-monitor.js");

  const result = await runBranchSyncMonitorCycle({
    workItems: new WorkItemStore(db),
    runs: new RunStore(db),
    maxBehindCommits: 5,
    getPullRequest: async () => ({
      number: 92,
      url: "https://github.com/hubstaff/gooseherd/pull/92",
      title: "Merged after pause",
      body: "",
      state: "closed",
      merged: true,
      labels: [],
    }),
    compareBranchRefs: async () => {
      throw new Error("closed PRs must not be checked for branch staleness");
    },
    queueBranchSyncRun: async () => {
      throw new Error("closed PRs must not queue branch-sync runs");
    },
  });

  const updated = await new WorkItemStore(db).getWorkItem(workItem.id);
  assert.equal(result.checked, 1);
  assert.equal(result.closed, 1);
  assert.equal(updated?.state, "done");
  assert.equal(updated?.substate, "merged");
  assert.ok(updated?.flags.includes("merged"));
});

test("runBranchSyncMonitorCycle restores ai-assist-disabled cancelled work items when the label is back", async (t) => {
  const { db, cleanup, workItem } = await createCancelledAiAssistFixture();
  t.after(cleanup);

  const { runBranchSyncMonitorCycle } = await import("../src/work-items/branch-sync-monitor.js");
  const reconciled: Array<{ workItemId: string; reason: string }> = [];

  const result = await runBranchSyncMonitorCycle({
    workItems: new WorkItemStore(db),
    runs: new RunStore(db),
    maxBehindCommits: 5,
    getPullRequest: async () => ({
      number: 92,
      url: "https://github.com/hubstaff/gooseherd/pull/92",
      title: "Label restored",
      body: "",
      state: "open",
      merged: false,
      labels: ["ai:assist"],
    }),
    compareBranchRefs: async () => {
      throw new Error("paused automation restored during PR sync must not branch-sync in the same cycle");
    },
    queueBranchSyncRun: async () => {
      throw new Error("paused automation restored during PR sync must not queue branch-sync runs");
    },
    reconcileWorkItem: async (workItemId, reason) => {
      reconciled.push({ workItemId, reason });
    },
  });

  const updated = await new WorkItemStore(db).getWorkItem(workItem.id);
  assert.equal(result.checked, 1);
  assert.equal(result.closed, 0);
  assert.equal(result.restored, 1);
  assert.equal(updated?.state, "auto_review");
  assert.equal(updated?.substate, "pr_adopted");
  assert.ok(updated?.flags.includes("ai_assist_enabled"));
  assert.ok(!updated?.flags.includes("ai_assist_disabled"));
  assert.deepEqual(reconciled, [{ workItemId: workItem.id, reason: "github.automation_restored_poll" }]);
});

test("startBranchSyncMonitor runs an initial cycle without waiting for the interval", async (t) => {
  const { startBranchSyncMonitor } = await import("../src/work-items/branch-sync-monitor.js");

  let cycleCount = 0;
  const queued: Array<{ workItemId: string; reason: string }> = [];
  const monitor = startBranchSyncMonitor({
    workItems: {
      listWorkItems: async () => [{
        id: "wi-1",
        workflow: "feature_delivery",
        state: "ready_for_merge",
        substate: "waiting_merge",
        flags: ["engineering_review_done", "qa_review_done"],
        title: "Stale PR",
        summary: "",
        ownerTeamId: "team-1",
        homeChannelId: "C1",
        homeThreadTs: "1.1",
        githubPrBaseBranch: "main",
        githubPrHeadBranch: "feature/stale",
        repo: "hubstaff/gooseherd",
        createdByUserId: "user-1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
      setFlagState: async () => {
        cycleCount += 1;
        return {
          id: "wi-1",
          workflow: "feature_delivery",
          state: "ready_for_merge",
          flags: ["branch_stale"],
          title: "Stale PR",
          summary: "",
          ownerTeamId: "team-1",
          homeChannelId: "C1",
          homeThreadTs: "1.1",
          createdByUserId: "user-1",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as Awaited<ReturnType<WorkItemStore["setFlagState"]>>;
      },
      updateState: async () => {
        throw new Error("open PRs must not be terminally updated");
      },
    },
    runs: {
      listRunsForWorkItem: async () => [],
    },
    maxBehindCommits: 5,
    intervalMs: 60_000,
    compareBranchRefs: async () => ({ aheadBy: 0, behindBy: 6 }),
    queueBranchSyncRun: async (workItemId, reason) => {
      queued.push({ workItemId, reason });
    },
  });
  t.after(() => monitor.stop());

  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(cycleCount, 1);
  assert.deepEqual(queued, [{ workItemId: "wi-1", reason: "periodic.branch_stale" }]);
});
