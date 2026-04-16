import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "./helpers/test-db.js";
import { teamMembers, teams, users, workItemEvents } from "../src/db/schema.js";
import { WorkItemService } from "../src/work-items/service.js";
import { WorkItemIdentityStore } from "../src/work-items/identity-store.js";
import { UserDirectoryService } from "../src/user-directory/service.js";
import { WorkItemContextResolver } from "../src/work-items/context-resolver.js";
import {
  GitHubWorkItemSync,
  parseGitHubWorkItemWebhookPayload,
  parseJiraIssueKey,
} from "../src/work-items/github-sync.js";

async function createGitHubSyncFixture() {
  const testDb = await createTestDb();
  const pmUserId = randomUUID();
  const ownerTeamId = randomUUID();
  const reconcileCalls: Array<{ workItemId: string; reason: string }> = [];

  await testDb.db.insert(users).values({
    id: pmUserId,
    slackUserId: "U_PM",
    githubLogin: "pm-user",
    displayName: "PM",
  });
  await testDb.db.insert(teams).values({
    id: ownerTeamId,
    name: "growth",
    slackChannelId: "C_GROWTH",
  });

  const resolveDeliveryContext = async () => ({
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.500",
    createdByUserId: pmUserId,
  });

  return {
    db: testDb.db,
    cleanup: testDb.cleanup,
    ownerTeamId,
    pmUserId,
    reconcileCalls,
    service: new WorkItemService(testDb.db),
    sync: new GitHubWorkItemSync(testDb.db, {
      resolveDeliveryContext,
      reconcileWorkItem: async (workItemId, reason) => {
        reconcileCalls.push({ workItemId, reason });
      },
    }),
  };
}

async function createGitHubSyncFixtureWithThrowingReconcile() {
  const testDb = await createTestDb();
  const pmUserId = randomUUID();
  const ownerTeamId = randomUUID();

  await testDb.db.insert(users).values({
    id: pmUserId,
    slackUserId: "U_PM_THROW",
    githubLogin: "pm-throw",
    displayName: "PM Throw",
  });
  await testDb.db.insert(teams).values({
    id: ownerTeamId,
    name: "growth-throw",
    slackChannelId: "C_GROWTH_THROW",
  });

  const resolveDeliveryContext = async () => ({
    ownerTeamId,
    homeChannelId: "C_GROWTH_THROW",
    homeThreadTs: "1740000000.599",
    createdByUserId: pmUserId,
  });

  return {
    db: testDb.db,
    cleanup: testDb.cleanup,
    ownerTeamId,
    pmUserId,
    service: new WorkItemService(testDb.db),
    sync: new GitHubWorkItemSync(testDb.db, {
      resolveDeliveryContext,
      reconcileWorkItem: async () => {
        throw new Error("reconcile exploded");
      },
    }),
  };
}

async function createGitHubPrFirstFixture() {
  const testDb = await createTestDb();
  const defaultTeamId = randomUUID();
  const ownerTeamId = randomUUID();
  const existingUserId = randomUUID();
  const createdHomeThreads: Array<{ channelId: string; text: string }> = [];

  await testDb.db.insert(teams).values([
    {
      id: defaultTeamId,
      name: "default",
      slackChannelId: "C_DEFAULT",
      isDefault: true,
    },
    {
      id: ownerTeamId,
      name: "growth",
      slackChannelId: "C_GROWTH",
    },
  ]);

  await testDb.db.insert(users).values({
    id: existingUserId,
    slackUserId: "U_EXISTING",
    githubLogin: "existing-gh",
    displayName: "Existing GitHub User",
    primaryTeamId: ownerTeamId,
  });
  await testDb.db.insert(teamMembers).values({
    teamId: ownerTeamId,
    userId: existingUserId,
    functionalRoles: ["pm"],
  });

  const identityStore = new WorkItemIdentityStore(testDb.db);
  const userDirectory = new UserDirectoryService(testDb.db);
  const contextResolver = new WorkItemContextResolver(testDb.db);

  const resolveDeliveryContext = async (input: {
    jiraIssueKey: string;
    repo?: string;
    prNumber?: number;
    prTitle?: string;
    prBody?: string;
    prUrl?: string;
    authorLogin?: string;
  }) => {
    const githubLogin = input.authorLogin?.trim();
    const defaultTeam = await identityStore.getDefaultTeam();
    if (!defaultTeam || !githubLogin) {
      return undefined;
    }

    let actor = await identityStore.getUserByGitHubLogin(githubLogin);
    if (!actor) {
      const created = await userDirectory.createUser({
        displayName: githubLogin,
        slackUserId: null,
        githubLogin,
        jiraAccountId: null,
        primaryTeamId: null,
        isActive: true,
      });
      await identityStore.ensureUserTeamMembership(created.id, defaultTeam.id, "default_team", true);
      actor = await userDirectory.updateUser(created.id, {
        displayName: created.displayName,
        slackUserId: created.slackUserId ?? null,
        githubLogin: created.githubLogin,
        jiraAccountId: created.jiraAccountId ?? null,
        primaryTeamId: defaultTeam.id,
        isActive: created.isActive,
      });
    } else if (!(await identityStore.getPrimaryTeamForUser(actor.id))) {
      await identityStore.ensureUserTeamMembership(actor.id, defaultTeam.id, "default_team", true);
      actor = await userDirectory.updateUser(actor.id, {
        displayName: actor.displayName,
        slackUserId: actor.slackUserId ?? null,
        githubLogin: actor.githubLogin ?? null,
        jiraAccountId: null,
        primaryTeamId: defaultTeam.id,
        isActive: actor.isActive,
      });
    }

    const ownerTeam = (await identityStore.getPrimaryTeamForUser(actor.id)) ?? defaultTeam;
    return contextResolver.resolveDeliveryContext({
      createdByUserId: actor.id,
      ownerTeamId: ownerTeam.id,
      title: input.prTitle ?? input.jiraIssueKey,
      createHomeThread: async (threadInput) => {
        createdHomeThreads.push(threadInput);
        return "1740000001.100";
      },
    });
  };

  return {
    db: testDb.db,
    cleanup: testDb.cleanup,
    defaultTeamId,
    ownerTeamId,
    existingUserId,
    createdHomeThreads,
    identityStore,
    userDirectory,
    sync: new GitHubWorkItemSync(testDb.db, { resolveDeliveryContext }),
  };
}

test("parseJiraIssueKey extracts issue key from PR body", () => {
  assert.equal(parseJiraIssueKey("Implements feature.\n\nJira: HBL-404"), "HBL-404");
  assert.equal(parseJiraIssueKey("no issue here"), undefined);
});

test("parseGitHubWorkItemWebhookPayload extracts author login from PR payload", () => {
  const parsed = parseGitHubWorkItemWebhookPayload(
    { "x-github-event": "pull_request" },
    {
      action: "opened",
      number: 82,
      repository: { full_name: "hubstaff/gooseherd" },
      pull_request: {
        title: "PR author login",
        body: "Refs HBL-582",
        html_url: "https://github.com/hubstaff/gooseherd/pull/82",
        base: { ref: "main" },
        head: { ref: "feature/pr-author-login" },
        labels: [],
        user: { login: "github-author" },
      },
    },
  );

  assert.equal(parsed?.authorLogin, "github-author");
  assert.equal(parsed?.baseBranch, "main");
  assert.equal(parsed?.headBranch, "feature/pr-author-login");
});

test("github sync adopts labeled PR into delivery work item", async (t) => {
  const { cleanup, sync, db } = await createGitHubSyncFixture();
  t.after(cleanup);

  const adopted = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "labeled",
    repo: "hubstaff/gooseherd",
    prNumber: 77,
    prTitle: "Automate work item handling",
    prBody: "Implements workflow support\n\nRefs HBL-404",
    prUrl: "https://github.com/hubstaff/gooseherd/pull/77",
    labels: ["ai:assist"],
    baseBranch: "main",
    headBranch: "feature/hbl-404",
  });

  assert.ok(adopted);
  assert.equal(adopted?.workflow, "feature_delivery");
  assert.equal(adopted?.state, "auto_review");
  assert.equal(adopted?.jiraIssueKey, "HBL-404");
  assert.equal(adopted?.repo, "hubstaff/gooseherd");
  assert.equal(adopted?.githubPrNumber, 77);
  assert.equal(adopted?.githubPrBaseBranch, "main");
  assert.equal(adopted?.githubPrHeadBranch, "feature/hbl-404");
  assert.ok(adopted?.flags.includes("pr_opened"));

  const events = await db.select().from(workItemEvents).where(eq(workItemEvents.workItemId, adopted!.id));
  assert.ok(events.some((event) => event.eventType === "github.label_observed"));
  assert.ok(events.some((event) => event.eventType === "github.pr_adopted"));
});

test("github sync ignores unrelated label", async (t) => {
  const { cleanup, sync } = await createGitHubSyncFixture();
  t.after(cleanup);

  const adopted = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "labeled",
    repo: "hubstaff/gooseherd",
    prNumber: 779,
    prTitle: "Unrelated label should not adopt",
    prBody: "Implements workflow support\n\nRefs HBL-410",
    prUrl: "https://github.com/hubstaff/gooseherd/pull/779",
    labels: ["legacy-assist"],
    baseBranch: "main",
  });

  assert.equal(adopted, undefined);
});

test("github sync ignores labeled PRs without a Jira issue key", async (t) => {
  const { cleanup, sync } = await createGitHubSyncFixture();
  t.after(cleanup);

  const adopted = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "labeled",
    repo: "hubstaff/gooseherd",
    prNumber: 780,
    prTitle: "No Jira issue",
    prBody: "Just a PR body",
    prUrl: "https://github.com/hubstaff/gooseherd/pull/780",
    labels: ["ai:assist"],
    baseBranch: "main",
    authorLogin: "github-author",
  });

  assert.equal(adopted, undefined);
});

test("github sync links labeled PR to existing delivery item with same jira key", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId, reconcileCalls } = await createGitHubSyncFixture();
  t.after(cleanup);

  const existing = await service.createDeliveryFromJira({
    title: "Existing delivery",
    summary: "Created from Jira before PR adoption",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.550",
    jiraIssueKey: "HBL-499",
    createdByUserId: pmUserId,
  });

  const adopted = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "labeled",
    repo: "hubstaff/gooseherd",
    prNumber: 78,
    prTitle: "Manual PR for existing delivery",
    prBody: "Continues work\n\nRefs HBL-499",
    prUrl: "https://github.com/hubstaff/gooseherd/pull/78",
    labels: ["ai:assist"],
    baseBranch: "main",
    headBranch: "feature/hbl-499",
  });

  assert.equal(adopted?.id, existing.id);
  assert.equal(adopted?.state, "auto_review");
  assert.equal(adopted?.repo, "hubstaff/gooseherd");
  assert.equal(adopted?.githubPrNumber, 78);
  assert.equal(adopted?.githubPrBaseBranch, "main");
  assert.equal(adopted?.githubPrHeadBranch, "feature/hbl-499");
  assert.ok(adopted?.flags.includes("pr_opened"));
  assert.deepEqual(reconcileCalls, [{ workItemId: existing.id, reason: "github.pr_adopted" }]);
});

test("github sync keeps PR adoption mutation when reconcile callback throws", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixtureWithThrowingReconcile();
  t.after(cleanup);

  const existing = await service.createDeliveryFromJira({
    title: "Existing delivery with failing reconcile",
    summary: "Reconcile should not break adoption",
    ownerTeamId,
    homeChannelId: "C_GROWTH_THROW",
    homeThreadTs: "1740000000.551",
    jiraIssueKey: "HBL-1499",
    createdByUserId: pmUserId,
  });

  const adopted = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "labeled",
    repo: "hubstaff/gooseherd",
    prNumber: 781,
    prTitle: "Adoption survives reconcile failure",
    prBody: "Continues work\n\nRefs HBL-1499",
    prUrl: "https://github.com/hubstaff/gooseherd/pull/781",
    labels: ["ai:assist"],
    baseBranch: "main",
  });

  assert.equal(adopted?.id, existing.id);
  assert.equal(adopted?.state, "auto_review");
  assert.equal(adopted?.substate, "pr_adopted");
  assert.equal(adopted?.githubPrNumber, 781);
});

test("github sync creates a new delivery when a second PR arrives for a Jira issue with an already linked delivery", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixture();
  t.after(cleanup);

  const linked = await service.createDeliveryFromJira({
    title: "Already linked delivery",
    summary: "Existing PR should stay attached",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.561",
    jiraIssueKey: "HBL-561",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 77,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/77",
  });

  const adopted = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "labeled",
    repo: "hubstaff/gooseherd",
    prNumber: 78,
    prTitle: "Second PR should not hijack",
    prBody: "Continues work\n\nRefs HBL-561",
    prUrl: "https://github.com/hubstaff/gooseherd/pull/78",
    labels: ["ai:assist"],
    baseBranch: "main",
  });

  assert.ok(adopted);
  assert.notEqual(adopted?.id, linked.id);
  assert.equal(linked.githubPrNumber, 77);
  assert.equal(linked.repo, "hubstaff/gooseherd");
  assert.equal(adopted?.githubPrNumber, 78);
  assert.equal(adopted?.repo, "hubstaff/gooseherd");
});

test("github sync logs ambiguity when multiple unlinked delivery candidates exist for a Jira issue", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId, db } = await createGitHubSyncFixture();
  t.after(cleanup);

  const candidateA = await service.createDeliveryFromJira({
    title: "Candidate A",
    summary: "First open delivery candidate",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.562",
    jiraIssueKey: "HBL-562",
    createdByUserId: pmUserId,
  });

  const candidateB = await service.createDeliveryFromJira({
    title: "Candidate B",
    summary: "Second open delivery candidate",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.563",
    jiraIssueKey: "HBL-562",
    createdByUserId: pmUserId,
  });

  const adopted = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "labeled",
    repo: "hubstaff/gooseherd",
    prNumber: 79,
    prTitle: "Ambiguous adoption",
    prBody: "Multiple candidates\n\nRefs HBL-562",
    prUrl: "https://github.com/hubstaff/gooseherd/pull/79",
    labels: ["ai:assist"],
    baseBranch: "main",
  });

  assert.equal(adopted, undefined);
  assert.equal((await service.getWorkItem(candidateA.id))?.githubPrNumber, undefined);
  assert.equal((await service.getWorkItem(candidateB.id))?.githubPrNumber, undefined);

  const eventsA = await db.select().from(workItemEvents).where(eq(workItemEvents.workItemId, candidateA.id));
  const eventsB = await db.select().from(workItemEvents).where(eq(workItemEvents.workItemId, candidateB.id));
  assert.ok(eventsA.some((event) => event.eventType === "github.pr_adoption_ambiguous"));
  assert.ok(eventsB.some((event) => event.eventType === "github.pr_adoption_ambiguous"));
});

test("github sync creates a PR-first delivery for an existing GitHub author using their primary team", async (t) => {
  const { cleanup, sync, db, existingUserId, ownerTeamId } = await createGitHubPrFirstFixture();
  t.after(cleanup);

  const adopted = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "labeled",
    repo: "hubstaff/gooseherd",
    prNumber: 83,
    prTitle: "Primary team adoption",
    prBody: "Feature work\n\nRefs HBL-583",
    prUrl: "https://github.com/hubstaff/gooseherd/pull/83",
    labels: ["ai:assist"],
    baseBranch: "main",
    authorLogin: "existing-gh",
  });

  assert.ok(adopted);
  assert.equal(adopted?.createdByUserId, existingUserId);
  assert.equal(adopted?.ownerTeamId, ownerTeamId);
  assert.equal(adopted?.state, "auto_review");
  assert.equal(adopted?.substate, "pr_adopted");
  assert.equal(adopted?.repo, "hubstaff/gooseherd");
  assert.equal(adopted?.githubPrNumber, 83);
  assert.equal(adopted?.jiraIssueKey, "HBL-583");
});

test("github sync auto-creates a GitHub author on the default team when none exists", async (t) => {
  const { cleanup, sync, db, defaultTeamId, identityStore, userDirectory, createdHomeThreads } = await createGitHubPrFirstFixture();
  t.after(cleanup);

  const adopted = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "labeled",
    repo: "hubstaff/gooseherd",
    prNumber: 84,
    prTitle: "New GitHub author",
    prBody: "Feature work\n\nRefs HBL-584",
    prUrl: "https://github.com/hubstaff/gooseherd/pull/84",
    labels: ["ai:assist"],
    baseBranch: "main",
    authorLogin: "new-github-author",
  });

  assert.ok(adopted);
  assert.equal(createdHomeThreads.length, 1);

  const createdUser = await identityStore.getUserByGitHubLogin("new-github-author");
  assert.ok(createdUser);
  assert.equal(createdUser?.primaryTeamId, defaultTeamId);

  const defaultTeam = await identityStore.getDefaultTeam();
  assert.equal(defaultTeam?.id, defaultTeamId);
  const memberships = await db.select().from(teamMembers).where(eq(teamMembers.userId, createdUser!.id));
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0]?.teamId, defaultTeamId);
});

test("github sync self-heals a unique legacy repo-null PR row on the next webhook", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixture();
  t.after(cleanup);

  const legacy = await service.createDeliveryFromJira({
    title: "Legacy PR row",
    summary: "Created before repo existed",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.564",
    jiraIssueKey: "HBL-564",
    createdByUserId: pmUserId,
    githubPrNumber: 81,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/81",
  });

  const existing = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "opened",
    repo: "hubstaff/gooseherd",
    prNumber: 81,
    prTitle: "Legacy row lookup",
    prBody: "No adoption needed",
    prUrl: "https://github.com/hubstaff/gooseherd/pull/81",
  });

  assert.equal(existing?.id, legacy.id);
  const stored = await service.getWorkItem(legacy.id);
  assert.equal(stored?.githubPrNumber, 81);
  assert.equal(stored?.repo, "hubstaff/gooseherd");
});

test("github sync keeps same PR number isolated by repo", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixture();
  t.after(cleanup);

  const gooseherdDelivery = await service.createDeliveryFromJira({
    title: "Gooseherd PR 77",
    summary: "First repo",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.560",
    jiraIssueKey: "HBL-560",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 77,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/77",
  });

  const otherRepoDelivery = await service.createDeliveryFromJira({
    title: "Other repo PR 77",
    summary: "Second repo",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.561",
    jiraIssueKey: "HBL-561",
    createdByUserId: pmUserId,
    repo: "hubstaff/another-repo",
    githubPrNumber: 77,
    githubPrUrl: "https://github.com/hubstaff/another-repo/pull/77",
  });

  const gooseherdUpdated = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "opened",
    repo: "hubstaff/gooseherd",
    prNumber: 77,
    prTitle: "Existing gooseherd PR",
    prBody: "No-op",
    prUrl: "https://github.com/hubstaff/gooseherd/pull/77",
  });

  const otherRepoUpdated = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "opened",
    repo: "hubstaff/another-repo",
    prNumber: 77,
    prTitle: "Existing other repo PR",
    prBody: "No-op",
    prUrl: "https://github.com/hubstaff/another-repo/pull/77",
  });

  assert.equal(gooseherdUpdated?.id, gooseherdDelivery.id);
  assert.equal(gooseherdUpdated?.repo, "hubstaff/gooseherd");
  assert.equal(otherRepoUpdated?.id, otherRepoDelivery.id);
  assert.equal(otherRepoUpdated?.repo, "hubstaff/another-repo");
});

test("github sync advances auto review item to engineering review after green CI", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId, db } = await createGitHubSyncFixture();
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "Adopt CI success",
    summary: "Waiting for CI",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.600",
    jiraIssueKey: "HBL-405",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 88,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/88",
    initialState: "auto_review",
    initialSubstate: "waiting_ci",
    flags: ["pr_opened", "self_review_done"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "check_suite",
    action: "completed",
    repo: "hubstaff/gooseherd",
    conclusion: "success",
    status: "completed",
    pullRequestNumbers: [88],
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "engineering_review");
  assert.ok(updated?.flags.includes("ci_green"));

  const events = await db.select().from(workItemEvents).where(eq(workItemEvents.workItemId, delivery.id));
  assert.ok(events.some((event) => event.eventType === "github.ci_updated"));
});

test("github sync returns auto_review items to applying_review_feedback and reconciles on failed CI", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId, reconcileCalls } = await createGitHubSyncFixture();
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "Auto-review CI failed",
    summary: "Fresh auto-review run is required",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.601",
    jiraIssueKey: "HBL-405A",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 89,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/89",
    initialState: "auto_review",
    initialSubstate: "waiting_ci",
    flags: ["pr_opened", "ci_green", "self_review_done"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "check_suite",
    action: "completed",
    repo: "hubstaff/gooseherd",
    conclusion: "failure",
    status: "completed",
    pullRequestNumbers: [89],
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "auto_review");
  assert.equal(updated?.substate, "applying_review_feedback");
  assert.ok(!updated?.flags.includes("ci_green"));
  assert.deepEqual(reconcileCalls, [{ workItemId: delivery.id, reason: "github.ci_failed" }]);
});

test("github sync preserves ready_for_merge revalidation behavior on failed CI without reconciling", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId, reconcileCalls } = await createGitHubSyncFixture();
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "Ready for merge CI failed",
    summary: "Should revalidate after rebase",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.602",
    jiraIssueKey: "HBL-405B",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 90,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/90",
    initialState: "ready_for_merge",
    initialSubstate: "waiting_merge",
    flags: ["pr_opened", "ci_green", "engineering_review_done", "qa_review_done"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "check_suite",
    action: "completed",
    repo: "hubstaff/gooseherd",
    conclusion: "timed_out",
    status: "completed",
    pullRequestNumbers: [90],
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "auto_review");
  assert.equal(updated?.substate, "revalidating_after_rebase");
  assert.ok(!updated?.flags.includes("ci_green"));
  assert.deepEqual(reconcileCalls, []);
});

test("github sync routes engineering review outcomes back into delivery flow", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId, reconcileCalls } = await createGitHubSyncFixture();
  t.after(cleanup);

  const changesRequestedItem = await service.createDeliveryFromJira({
    title: "Review webhook handling",
    summary: "PR awaits review",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.700",
    jiraIssueKey: "HBL-406",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 99,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/99",
    initialState: "engineering_review",
    flags: ["pr_opened", "ci_green", "self_review_done"],
  });

  const sentBack = await sync.handleWebhookPayload({
    eventType: "pull_request_review",
    action: "submitted",
    repo: "hubstaff/gooseherd",
    prNumber: 99,
    state: "changes_requested",
    reviewer: "reviewer-a",
  });

  assert.equal(sentBack?.id, changesRequestedItem.id);
  assert.equal(sentBack?.state, "auto_review");
  assert.deepEqual(reconcileCalls, [{ workItemId: changesRequestedItem.id, reason: "github.review_changes_requested" }]);

  const approvedItem = await service.createDeliveryFromJira({
    title: "Approved review webhook handling",
    summary: "PR awaits approval",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.701",
    jiraIssueKey: "HBL-407",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 100,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/100",
    initialState: "engineering_review",
    flags: ["pr_opened", "ci_green", "self_review_done"],
  });

  const approved = await sync.handleWebhookPayload({
    eventType: "pull_request_review",
    action: "submitted",
    repo: "hubstaff/gooseherd",
    prNumber: 100,
    state: "approved",
    reviewer: "reviewer-a",
  });

  assert.equal(approved?.id, approvedItem.id);
  assert.equal(approved?.state, "qa_preparation");
});

test("github sync keeps changes_requested mutation when reconcile callback throws", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixtureWithThrowingReconcile();
  t.after(cleanup);

  const changesRequestedItem = await service.createDeliveryFromJira({
    title: "Changes requested with failing reconcile",
    summary: "State mutation should survive callback failure",
    ownerTeamId,
    homeChannelId: "C_GROWTH_THROW",
    homeThreadTs: "1740000000.701",
    jiraIssueKey: "HBL-1406",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 991,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/991",
    initialState: "engineering_review",
    flags: ["pr_opened", "ci_green", "self_review_done"],
  });

  const sentBack = await sync.handleWebhookPayload({
    eventType: "pull_request_review",
    action: "submitted",
    repo: "hubstaff/gooseherd",
    prNumber: 991,
    state: "changes_requested",
    reviewer: "reviewer-a",
  });

  assert.equal(sentBack?.id, changesRequestedItem.id);
  assert.equal(sentBack?.state, "auto_review");
  assert.equal(sentBack?.substate, "applying_review_feedback");
});

test("github sync advances qa preparation to qa review after green CI when product review is not required", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixture();
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "QA prep completes",
    summary: "Ready for QA review",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.702",
    jiraIssueKey: "HBL-408",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 101,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/101",
    initialState: "qa_preparation",
    initialSubstate: "running_e2e",
    flags: ["pr_opened", "engineering_review_done"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "check_suite",
    action: "completed",
    repo: "hubstaff/gooseherd",
    conclusion: "success",
    status: "completed",
    pullRequestNumbers: [101],
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "qa_review");
  assert.equal(updated?.substate, "waiting_qa_review");
  assert.ok(updated?.flags.includes("ci_green"));
});

test("github sync advances qa preparation to product review when required", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixture();
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "QA prep with product review",
    summary: "Needs product sign-off",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.703",
    jiraIssueKey: "HBL-409",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 102,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/102",
    initialState: "qa_preparation",
    initialSubstate: "running_e2e",
    flags: ["pr_opened", "engineering_review_done", "product_review_required"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "check_suite",
    action: "completed",
    repo: "hubstaff/gooseherd",
    conclusion: "success",
    status: "completed",
    pullRequestNumbers: [102],
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "product_review");
  assert.equal(updated?.substate, "waiting_product_review");
});

test("github sync marks delivery done when linked pull request is merged", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixture();
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "Merged PR",
    summary: "Ready to close",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.704",
    jiraIssueKey: "HBL-410",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 103,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/103",
    initialState: "ready_for_merge",
    initialSubstate: "waiting_merge",
    flags: ["pr_opened", "engineering_review_done", "qa_review_done"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "closed",
    repo: "hubstaff/gooseherd",
    prNumber: 103,
    prUrl: "https://github.com/hubstaff/gooseherd/pull/103",
    merged: true,
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "done");
  assert.equal(updated?.substate, "merged");
  assert.ok(updated?.flags.includes("merged"));
});

test("github sync resets ready_for_merge to auto review on synchronize", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixture();
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "Branch updated before merge",
    summary: "Fresh commits landed",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.705",
    jiraIssueKey: "HBL-411",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 104,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/104",
    initialState: "ready_for_merge",
    initialSubstate: "waiting_merge",
    flags: ["pr_opened", "ci_green", "engineering_review_done", "qa_review_done"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "synchronize",
    repo: "hubstaff/gooseherd",
    prNumber: 104,
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "auto_review");
  assert.equal(updated?.substate, "waiting_ci");
  assert.ok(!updated?.flags.includes("ci_green"));
});

test("github sync clears ci_green and self_review_done on synchronize for auto_review items", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixture();
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "New commits on auto review PR",
    summary: "Auto-review needs a fresh run",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.706",
    jiraIssueKey: "HBL-412",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 105,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/105",
    initialState: "auto_review",
    initialSubstate: "waiting_ci",
    flags: ["pr_opened", "ci_green", "self_review_done"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "synchronize",
    repo: "hubstaff/gooseherd",
    prNumber: 105,
  });

  assert.ok(!updated?.flags.includes("ci_green"));
  assert.ok(!updated?.flags.includes("self_review_done"));
});
