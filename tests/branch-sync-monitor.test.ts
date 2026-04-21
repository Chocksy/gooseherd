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
