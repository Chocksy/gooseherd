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
import { RunStore } from "../src/store.js";
import {
  GitHubWorkItemSync,
  parseGitHubWorkItemWebhookPayload,
  parseJiraIssueKey,
} from "../src/work-items/github-sync.js";

async function createGitHubSyncFixture(options: {
  githubService?: {
    getPullRequestCiSnapshot?: (repoSlug: string, headSha: string) => Promise<{
      headSha: string;
      conclusion: "success" | "failure" | "pending" | "no_ci";
      failedRuns?: Array<{ id: number; name: string; status: string; conclusion: string | null }>;
      failedAnnotations?: Array<{
        checkRunName: string;
        path: string;
        line: number;
        message: string;
        level: string;
      }>;
    }>;
    getPullRequest?: (repoSlug: string, prNumber: number) => Promise<{
      number: number;
      url: string;
      title: string;
      body: string;
      state: string;
      headSha?: string;
    }>;
  };
  resetEngineeringReviewOnNewCommits?: boolean;
  resetQaReviewOnNewCommits?: boolean;
  skipProductReview?: boolean;
  qaPreparationHandler?: (workItem: { id: string; state: string }) => Promise<void> | void;
  readyForMergeHandler?: (workItem: { id: string; state: string }) => Promise<void> | void;
} = {}) {
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
      qaPreparationHandler: options.qaPreparationHandler as never,
      readyForMergeHandler: options.readyForMergeHandler as never,
      resetEngineeringReviewOnNewCommits: options.resetEngineeringReviewOnNewCommits,
      resetQaReviewOnNewCommits: options.resetQaReviewOnNewCommits,
      skipProductReview: options.skipProductReview,
      ...(options.githubService ? ({ githubService: options.githubService } as never) : {}),
    } as never),
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
    jiraIssueKey?: string;
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

test("parseGitHubWorkItemWebhookPayload extracts head sha from check_suite payload", () => {
  const parsed = parseGitHubWorkItemWebhookPayload(
    { "x-github-event": "check_suite" },
    {
      action: "completed",
      repository: { full_name: "hubstaff/gooseherd" },
      check_suite: {
        conclusion: "failure",
        status: "completed",
        head_sha: "deadbeef",
        pull_requests: [{ number: 82 }],
      },
    },
  );

  assert.equal(parsed?.headSha, "deadbeef");
  assert.deepEqual(parsed?.pullRequestNumbers, [82]);
});

test("parseGitHubWorkItemWebhookPayload includes top-level label for labeled pull_request events", () => {
  const parsed = parseGitHubWorkItemWebhookPayload(
    { "x-github-event": "pull_request" },
    {
      action: "labeled",
      number: 83,
      label: { name: "ai:assist" },
      repository: { full_name: "hubstaff/gooseherd" },
      pull_request: {
        title: "Adopt from labeled webhook",
        body: "Refs HBL-583",
        html_url: "https://github.com/hubstaff/gooseherd/pull/83",
        base: { ref: "main" },
        head: { ref: "feature/adopt-from-label" },
        labels: [],
        user: { login: "github-author" },
      },
    },
  );

  assert.deepEqual(parsed?.labels, ["ai:assist"]);
});

test("parseGitHubWorkItemWebhookPayload does not re-add the removed top-level label for unlabeled pull_request events", () => {
  const parsed = parseGitHubWorkItemWebhookPayload(
    { "x-github-event": "pull_request" },
    {
      action: "unlabeled",
      number: 84,
      label: { name: "ai:assist" },
      repository: { full_name: "hubstaff/gooseherd" },
      pull_request: {
        title: "Unlabel should not adopt",
        body: "Refs HBL-584",
        html_url: "https://github.com/hubstaff/gooseherd/pull/84",
        base: { ref: "main" },
        head: { ref: "feature/unlabel" },
        labels: [],
        user: { login: "github-author" },
      },
    },
  );

  assert.deepEqual(parsed?.labels, []);
  assert.equal(parsed?.labelName, "ai:assist");
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
    headSha: "abc12345",
  });

  assert.ok(adopted);
  assert.equal(adopted?.workflow, "feature_delivery");
  assert.equal(adopted?.state, "auto_review");
  assert.equal(adopted?.jiraIssueKey, "HBL-404");
  assert.equal(adopted?.repo, "hubstaff/gooseherd");
  assert.equal(adopted?.githubPrNumber, 77);
  assert.equal(adopted?.githubPrBaseBranch, "main");
  assert.equal(adopted?.githubPrHeadBranch, "feature/hbl-404");
  assert.equal(adopted?.githubPrHeadSha, "abc12345");
  assert.ok(adopted?.flags.includes("pr_opened"));
  assert.ok(adopted?.flags.includes("github_pr_adopted"));
  assert.ok(adopted?.flags.includes("ai_assist_enabled"));

  const events = await db.select().from(workItemEvents).where(eq(workItemEvents.workItemId, adopted!.id));
  assert.ok(events.some((event) => event.eventType === "github.label_observed"));
  assert.ok(events.some((event) => event.eventType === "github.pr_adopted"));
});

test("github sync adopts labeled PR when ai:assist is only in the top-level webhook label", async (t) => {
  const { cleanup, sync, db } = await createGitHubSyncFixture();
  t.after(cleanup);

  const parsed = parseGitHubWorkItemWebhookPayload(
    { "x-github-event": "pull_request" },
    {
      action: "labeled",
      number: 84,
      label: { name: "ai:assist" },
      repository: { full_name: "hubstaff/gooseherd" },
      pull_request: {
        title: "Adopt from webhook label",
        body: "Implements workflow support",
        html_url: "https://github.com/hubstaff/gooseherd/pull/84",
        base: { ref: "main" },
        head: { ref: "feature/adopt-webhook-label" },
        labels: [],
        user: { login: "github-author" },
      },
    },
  );

  assert.ok(parsed);
  const adopted = await sync.handleWebhookPayload(parsed);

  assert.ok(adopted);
  assert.equal(adopted?.workflow, "feature_delivery");
  assert.equal(adopted?.state, "auto_review");
  assert.equal(adopted?.substate, "pr_adopted");
  assert.equal(adopted?.repo, "hubstaff/gooseherd");
  assert.equal(adopted?.githubPrNumber, 84);
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

test("github sync does not adopt a PR when ai:assist was removed", async (t) => {
  const { cleanup, sync } = await createGitHubSyncFixture();
  t.after(cleanup);

  const parsed = parseGitHubWorkItemWebhookPayload(
    { "x-github-event": "pull_request" },
    {
      action: "unlabeled",
      number: 7800,
      label: { name: "ai:assist" },
      repository: { full_name: "hubstaff/gooseherd" },
      pull_request: {
        title: "Removed assist label",
        body: "Refs HBL-7800",
        html_url: "https://github.com/hubstaff/gooseherd/pull/7800",
        base: { ref: "main" },
        head: { ref: "feature/removed-assist-label" },
        labels: [],
        user: { login: "github-author" },
      },
    },
  );

  assert.ok(parsed);
  const adopted = await sync.handleWebhookPayload(parsed);

  assert.equal(adopted, undefined);
});

test("github sync cancels an existing delivery work item when ai:assist is removed", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixture();
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "Cancel removed assist label",
    summary: "Existing PR automation should stop",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.565",
    jiraIssueKey: "HBL-565",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 565,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/565",
    initialState: "auto_review",
    initialSubstate: "waiting_ci",
    flags: ["pr_opened", "github_pr_adopted", "ai_assist_enabled"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "unlabeled",
    repo: "hubstaff/gooseherd",
    prNumber: 565,
    prTitle: "Cancel removed assist label",
    prBody: "Refs HBL-565",
    prUrl: "https://github.com/hubstaff/gooseherd/pull/565",
    labelName: "ai:assist",
    labels: [],
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "cancelled");
  assert.equal(updated?.substate, undefined);
  assert.ok(updated?.flags.includes("ai_assist_disabled"));
  assert.ok(!updated?.flags.includes("ai_assist_enabled"));
});

test("github sync revives a cancelled delivery work item into auto review when ai:assist is restored", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId, reconcileCalls } = await createGitHubSyncFixture();
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "Restore assist label",
    summary: "Existing PR automation should restart",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.566",
    jiraIssueKey: "HBL-566",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 566,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/566",
    initialState: "auto_review",
    initialSubstate: "waiting_ci",
    flags: ["pr_opened", "github_pr_adopted", "ai_assist_enabled"],
  });

  const cancelled = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "unlabeled",
    repo: "hubstaff/gooseherd",
    prNumber: 566,
    prTitle: "Restore assist label",
    prBody: "Refs HBL-566",
    prUrl: "https://github.com/hubstaff/gooseherd/pull/566",
    labelName: "ai:assist",
    labels: [],
  });
  assert.equal(cancelled?.state, "cancelled");

  const revived = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "labeled",
    repo: "hubstaff/gooseherd",
    prNumber: 566,
    prTitle: "Restore assist label",
    prBody: "Refs HBL-566",
    prUrl: "https://github.com/hubstaff/gooseherd/pull/566",
    labels: ["ai:assist"],
  });

  assert.equal(revived?.id, delivery.id);
  assert.equal(revived?.state, "auto_review");
  assert.equal(revived?.substate, "pr_adopted");
  assert.ok(revived?.flags.includes("ai_assist_enabled"));
  assert.ok(!revived?.flags.includes("ai_assist_disabled"));
  assert.deepEqual(reconcileCalls, [{ workItemId: delivery.id, reason: "github.automation_restored" }]);
});

test("github sync creates a delivery for labeled PRs without a Jira issue key", async (t) => {
  const { cleanup, sync, db } = await createGitHubSyncFixture();
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

  assert.ok(adopted);
  assert.equal(adopted?.workflow, "feature_delivery");
  assert.equal(adopted?.state, "auto_review");
  assert.equal(adopted?.substate, "pr_adopted");
  assert.equal(adopted?.jiraIssueKey, undefined);
  assert.equal(adopted?.repo, "hubstaff/gooseherd");
  assert.equal(adopted?.githubPrNumber, 780);
  assert.equal(adopted?.title, "No Jira issue");
  assert.ok(adopted?.flags.includes("pr_opened"));

  const events = await db.select().from(workItemEvents).where(eq(workItemEvents.workItemId, adopted!.id));
  assert.ok(events.some((event) => event.eventType === "github.label_observed"));
  assert.ok(events.some((event) => event.eventType === "github.pr_adopted"));
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
    headSha: "feedface",
  });

  assert.equal(adopted?.id, existing.id);
  assert.equal(adopted?.state, "auto_review");
  assert.equal(adopted?.repo, "hubstaff/gooseherd");
  assert.equal(adopted?.githubPrNumber, 78);
  assert.equal(adopted?.githubPrBaseBranch, "main");
  assert.equal(adopted?.githubPrHeadBranch, "feature/hbl-499");
  assert.equal(adopted?.githubPrHeadSha, "feedface");
  assert.ok(adopted?.flags.includes("pr_opened"));
  assert.ok(adopted?.flags.includes("github_pr_adopted"));
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

test("github sync advances auto review item to engineering review after green aggregate CI", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId, db } = await createGitHubSyncFixture({
    githubService: {
      getPullRequestCiSnapshot: async () => ({ headSha: "green-head-sha", conclusion: "success" }),
    },
  });
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
    githubPrHeadSha: "green-head-sha",
    initialState: "auto_review",
    initialSubstate: "waiting_ci",
    flags: ["pr_opened", "self_review_done", "github_pr_adopted", "ai_assist_enabled"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "check_suite",
    action: "completed",
    repo: "hubstaff/gooseherd",
    conclusion: "success",
    status: "completed",
    headSha: "green-head-sha",
    pullRequestNumbers: [88],
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "engineering_review");
  assert.ok(updated?.flags.includes("ci_green"));

  const events = await db.select().from(workItemEvents).where(eq(workItemEvents.workItemId, delivery.id));
  assert.ok(events.some((event) => event.eventType === "github.ci_updated"));
});

test("github sync launches self review once after aggregate green CI when self review is still pending", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId, reconcileCalls } = await createGitHubSyncFixture({
    githubService: {
      getPullRequestCiSnapshot: async () => ({ headSha: "green-self-review-sha", conclusion: "success" }),
    },
  });
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "Green CI needs self review",
    summary: "Wait for aggregate green before re-running self review",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.6005",
    jiraIssueKey: "HBL-405G",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 880,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/880",
    githubPrHeadSha: "green-self-review-sha",
    initialState: "auto_review",
    initialSubstate: "waiting_ci",
    flags: ["pr_opened", "github_pr_adopted", "ai_assist_enabled"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "check_suite",
    action: "completed",
    repo: "hubstaff/gooseherd",
    conclusion: "success",
    status: "completed",
    headSha: "green-self-review-sha",
    pullRequestNumbers: [880],
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "auto_review");
  assert.equal(updated?.substate, "ci_green_pending_self_review");
  assert.ok(updated?.flags.includes("ci_green"));
  assert.ok(!updated?.flags.includes("self_review_done"));
  assert.deepEqual(reconcileCalls, [{ workItemId: delivery.id, reason: "github.ci_green_pending_self_review" }]);
});

test("github sync does not relaunch self review on repeated aggregate green CI after ci_green is already set", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId, reconcileCalls } = await createGitHubSyncFixture({
    githubService: {
      getPullRequestCiSnapshot: async () => ({ headSha: "green-self-review-sha", conclusion: "success" }),
    },
  });
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "Repeated green CI",
    summary: "Do not duplicate self review launches",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.6006",
    jiraIssueKey: "HBL-405H",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 881,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/881",
    githubPrHeadSha: "green-self-review-sha",
    initialState: "auto_review",
    initialSubstate: "ci_green_pending_self_review",
    flags: ["pr_opened", "ci_green", "github_pr_adopted", "ai_assist_enabled"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "check_suite",
    action: "completed",
    repo: "hubstaff/gooseherd",
    conclusion: "success",
    status: "completed",
    headSha: "green-self-review-sha",
    pullRequestNumbers: [881],
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "auto_review");
  assert.equal(updated?.substate, "ci_green_pending_self_review");
  assert.deepEqual(reconcileCalls, []);
});

test("github sync adopts a labeled PR with already failed current CI into ci_failed", async (t) => {
  const { cleanup, sync, reconcileCalls } = await createGitHubSyncFixture({
    githubService: {
      getPullRequestCiSnapshot: async () => ({
        headSha: "deadbeef",
        conclusion: "failure",
        failedRuns: [{ id: 1, name: "unit-tests", status: "completed", conclusion: "failure" }],
        failedAnnotations: [],
      }),
    },
  });
  t.after(cleanup);

  const adopted = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "labeled",
    repo: "hubstaff/gooseherd",
    prNumber: 77,
    prTitle: "Adopt from labeled webhook",
    prBody: "Fixes HBL-404",
    prUrl: "https://github.com/hubstaff/gooseherd/pull/77",
    baseBranch: "main",
    headBranch: "feature/hbl-404",
    headSha: "deadbeef",
    labels: ["ai:assist"],
  } as never);

  assert.equal(adopted?.state, "auto_review");
  assert.equal(adopted?.substate, "ci_failed");
  assert.deepEqual(reconcileCalls, [{ workItemId: adopted!.id, reason: "github.pr_adopted" }]);
});

test("github sync adopts a labeled PR with already green current CI into ci_green_pending_self_review", async (t) => {
  const { cleanup, sync, reconcileCalls } = await createGitHubSyncFixture({
    githubService: {
      getPullRequestCiSnapshot: async () => ({ headSha: "feedface", conclusion: "success" }),
    },
  });
  t.after(cleanup);

  const adopted = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "labeled",
    repo: "hubstaff/gooseherd",
    prNumber: 79,
    prTitle: "Adopt from labeled webhook",
    prBody: "Fixes HBL-406",
    prUrl: "https://github.com/hubstaff/gooseherd/pull/79",
    baseBranch: "main",
    headBranch: "feature/hbl-406",
    headSha: "feedface",
    labels: ["ai:assist"],
  } as never);

  assert.equal(adopted?.state, "auto_review");
  assert.equal(adopted?.substate, "ci_green_pending_self_review");
  assert.ok(adopted?.flags.includes("ci_green"));
  assert.deepEqual(reconcileCalls, [{ workItemId: adopted!.id, reason: "github.pr_adopted" }]);
});

test("github sync adopts a labeled PR with pending current CI into pr_adopted", async (t) => {
  const { cleanup, sync } = await createGitHubSyncFixture({
    githubService: {
      getPullRequestCiSnapshot: async () => ({ headSha: "cafebabe", conclusion: "pending" }),
    },
  });
  t.after(cleanup);

  const adopted = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "labeled",
    repo: "hubstaff/gooseherd",
    prNumber: 78,
    prTitle: "Adopt from labeled webhook",
    prBody: "Fixes HBL-405",
    prUrl: "https://github.com/hubstaff/gooseherd/pull/78",
    baseBranch: "main",
    headBranch: "feature/hbl-405",
    headSha: "cafebabe",
    labels: ["ai:assist"],
  } as never);

  assert.equal(adopted?.substate, "pr_adopted");
});

test("github sync returns auto_review items to ci_failed and reconciles on aggregate failed CI", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId, reconcileCalls } = await createGitHubSyncFixture({
    githubService: {
      getPullRequestCiSnapshot: async () => ({
        headSha: "failure-head-sha",
        conclusion: "failure",
        failedRuns: [{ id: 1, name: "unit-tests", status: "completed", conclusion: "failure" }],
        failedAnnotations: [],
      }),
    },
  });
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
    githubPrHeadSha: "failure-head-sha",
    initialState: "auto_review",
    initialSubstate: "waiting_ci",
    flags: ["pr_opened", "ci_green", "self_review_done", "github_pr_adopted", "ai_assist_enabled"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "check_suite",
    action: "completed",
    repo: "hubstaff/gooseherd",
    conclusion: "failure",
    status: "completed",
    headSha: "failure-head-sha",
    pullRequestNumbers: [89],
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "auto_review");
  assert.equal(updated?.substate, "ci_failed");
  assert.ok(!updated?.flags.includes("ci_green"));
  assert.deepEqual(reconcileCalls, [{ workItemId: delivery.id, reason: "github.ci_failed" }]);
});

test("github sync clears ci_green but suppresses ci-fix launch when aggregate CI fails during an active system run", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId, reconcileCalls, db } = await createGitHubSyncFixture({
    githubService: {
      getPullRequestCiSnapshot: async () => ({
        headSha: "failure-active-sha",
        conclusion: "failure",
        failedRuns: [{ id: 1, name: "unit-tests", status: "completed", conclusion: "failure" }],
        failedAnnotations: [],
      }),
    },
  });
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "CI failure while active run is already processing",
    summary: "Do not launch ci-fix twice",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.6011",
    jiraIssueKey: "HBL-405I",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 892,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/892",
    githubPrHeadSha: "failure-active-sha",
    initialState: "auto_review",
    initialSubstate: "ci_green_pending_self_review",
    flags: ["pr_opened", "ci_green", "github_pr_adopted", "ai_assist_enabled"],
  });

  const runStore = new RunStore(db);
  await runStore.init();
  const activeRun = await runStore.createRun(
    {
      repoSlug: delivery.repo!,
      task: "Existing system run",
      baseBranch: "main",
      requestedBy: "work-item:auto-review",
      channelId: delivery.homeChannelId,
      threadTs: delivery.homeThreadTs,
      runtime: "local",
      workItemId: delivery.id,
      autoReviewSourceSubstate: "ci_green_pending_self_review",
    },
    "gooseherd",
    delivery.githubPrHeadBranch,
  );
  await runStore.updateRun(activeRun.id, {
    status: "running",
    phase: "agent",
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "check_suite",
    action: "completed",
    repo: "hubstaff/gooseherd",
    conclusion: "failure",
    status: "completed",
    headSha: "failure-active-sha",
    pullRequestNumbers: [892],
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "auto_review");
  assert.equal(updated?.substate, "ci_green_pending_self_review");
  assert.ok(!updated?.flags.includes("ci_green"));
  assert.deepEqual(reconcileCalls, []);
});

test("github sync suppresses failed-CI reconcile for active intent-based self-review and repair-ci runs", async (t) => {
  for (const intentKind of ["feature_delivery.self_review", "feature_delivery.repair_ci"] as const) {
    await t.test(intentKind, async (t) => {
      const { cleanup, service, sync, ownerTeamId, pmUserId, reconcileCalls, db } = await createGitHubSyncFixture({
        githubService: {
          getPullRequestCiSnapshot: async () => ({
            headSha: `active-${intentKind}`,
            conclusion: "failure",
            failedRuns: [{ id: 1, name: "unit-tests", status: "completed", conclusion: "failure" }],
            failedAnnotations: [],
          }),
        },
      });
      t.after(cleanup);

      const delivery = await service.createDeliveryFromJira({
        title: `Intent active ${intentKind}`,
        summary: "Do not launch ci-fix twice",
        ownerTeamId,
        homeChannelId: "C_GROWTH",
        homeThreadTs: `1740000000.${intentKind === "feature_delivery.self_review" ? "701" : "702"}`,
        jiraIssueKey: intentKind === "feature_delivery.self_review" ? "HBL-701" : "HBL-702",
        createdByUserId: pmUserId,
        repo: "hubstaff/gooseherd",
        githubPrNumber: intentKind === "feature_delivery.self_review" ? 701 : 702,
        githubPrUrl: `https://github.com/hubstaff/gooseherd/pull/${intentKind === "feature_delivery.self_review" ? 701 : 702}`,
        githubPrHeadSha: `active-${intentKind}`,
        initialState: "auto_review",
        initialSubstate: "ci_green_pending_self_review",
        flags: ["pr_opened", "ci_green", "github_pr_adopted", "ai_assist_enabled"],
      });

      const runStore = new RunStore(db);
      await runStore.init();
      const activeRun = await runStore.createRun(
        {
          repoSlug: delivery.repo!,
          task: "Existing intent system run",
          baseBranch: "main",
          requestedBy: "manual:dashboard",
          channelId: delivery.homeChannelId,
          threadTs: delivery.homeThreadTs,
          runtime: "local",
          workItemId: delivery.id,
          prUrl: delivery.githubPrUrl,
          prNumber: delivery.githubPrNumber,
          intent: intentKind === "feature_delivery.self_review"
            ? {
                version: 1,
                kind: "feature_delivery.self_review",
                source: "work_item",
                workItemId: delivery.id,
                repo: delivery.repo!,
                prNumber: delivery.githubPrNumber!,
                prUrl: delivery.githubPrUrl!,
                sourceSubstate: "ci_green_pending_self_review",
              }
            : {
                version: 1,
                kind: "feature_delivery.repair_ci",
                source: "work_item",
                workItemId: delivery.id,
                repo: delivery.repo!,
                prNumber: delivery.githubPrNumber!,
                prUrl: delivery.githubPrUrl!,
                sourceSubstate: "ci_failed",
              },
        },
        "gooseherd",
        delivery.githubPrHeadBranch,
      );
      await runStore.updateRun(activeRun.id, { status: "running", phase: "agent" });

      const updated = await sync.handleWebhookPayload({
        eventType: "check_suite",
        action: "completed",
        repo: "hubstaff/gooseherd",
        conclusion: "failure",
        status: "completed",
        headSha: `active-${intentKind}`,
        pullRequestNumbers: [delivery.githubPrNumber!],
      });

      assert.equal(updated?.substate, "ci_green_pending_self_review");
      assert.deepEqual(reconcileCalls, []);
    });
  }
});

test("github sync does not suppress failed-CI reconcile for active sync-branch or finalize-pr intents", async (t) => {
  for (const intentKind of ["feature_delivery.sync_branch", "feature_delivery.finalize_pr"] as const) {
    await t.test(intentKind, async (t) => {
      const { cleanup, service, sync, ownerTeamId, pmUserId, reconcileCalls, db } = await createGitHubSyncFixture({
        githubService: {
          getPullRequestCiSnapshot: async () => ({
            headSha: `nonblocking-${intentKind}`,
            conclusion: "failure",
            failedRuns: [{ id: 1, name: "unit-tests", status: "completed", conclusion: "failure" }],
            failedAnnotations: [],
          }),
        },
      });
      t.after(cleanup);

      const prNumber = intentKind === "feature_delivery.sync_branch" ? 703 : 704;
      const delivery = await service.createDeliveryFromJira({
        title: `Nonblocking ${intentKind}`,
        summary: "CI failure should still reconcile",
        ownerTeamId,
        homeChannelId: "C_GROWTH",
        homeThreadTs: `1740000000.${prNumber}`,
        jiraIssueKey: `HBL-${prNumber}`,
        createdByUserId: pmUserId,
        repo: "hubstaff/gooseherd",
        githubPrNumber: prNumber,
        githubPrUrl: `https://github.com/hubstaff/gooseherd/pull/${prNumber}`,
        githubPrHeadSha: `nonblocking-${intentKind}`,
        initialState: "auto_review",
        initialSubstate: "ci_green_pending_self_review",
        flags: ["pr_opened", "ci_green", "github_pr_adopted", "ai_assist_enabled"],
      });

      const runStore = new RunStore(db);
      await runStore.init();
      const activeRun = await runStore.createRun(
        {
          repoSlug: delivery.repo!,
          task: "Existing nonblocking intent run",
          baseBranch: "main",
          requestedBy: "manual:dashboard",
          channelId: delivery.homeChannelId,
          threadTs: delivery.homeThreadTs,
          runtime: "local",
          workItemId: delivery.id,
          prUrl: delivery.githubPrUrl,
          prNumber: delivery.githubPrNumber,
          intent: intentKind === "feature_delivery.sync_branch"
            ? {
                version: 1,
                kind: "feature_delivery.sync_branch",
                source: "work_item",
                workItemId: delivery.id,
                repo: delivery.repo!,
                prNumber: delivery.githubPrNumber!,
                prUrl: delivery.githubPrUrl!,
                maxBehindCommits: 5,
              }
            : {
                version: 1,
                kind: "feature_delivery.finalize_pr",
                source: "work_item",
                workItemId: delivery.id,
                repo: delivery.repo!,
                prNumber: delivery.githubPrNumber!,
                prUrl: delivery.githubPrUrl!,
                strategy: "squash",
              },
        },
        "gooseherd",
        delivery.githubPrHeadBranch,
      );
      await runStore.updateRun(activeRun.id, { status: "running", phase: "agent" });

      const updated = await sync.handleWebhookPayload({
        eventType: "check_suite",
        action: "completed",
        repo: "hubstaff/gooseherd",
        conclusion: "failure",
        status: "completed",
        headSha: `nonblocking-${intentKind}`,
        pullRequestNumbers: [delivery.githubPrNumber!],
      });

      assert.equal(updated?.substate, "ci_failed");
      assert.deepEqual(reconcileCalls, [{ workItemId: delivery.id, reason: "github.ci_failed" }]);
    });
  }
});

test("github sync ignores stale failed CI for an older head sha", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId, reconcileCalls } = await createGitHubSyncFixture({
    githubService: {
      getPullRequest: async () => ({
        number: 89,
        url: "https://github.com/hubstaff/gooseherd/pull/89",
        title: "Auto-review CI failed",
        body: "Fresh auto-review run is required",
        state: "open",
        headSha: "new-head-sha",
      }),
    },
  });
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
    githubPrHeadSha: "new-head-sha",
    initialState: "auto_review",
    initialSubstate: "waiting_ci",
    flags: ["pr_opened", "ci_green", "self_review_done", "github_pr_adopted", "ai_assist_enabled"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "check_suite",
    action: "completed",
    repo: "hubstaff/gooseherd",
    conclusion: "failure",
    status: "completed",
    headSha: "old-head-sha",
    pullRequestNumbers: [89],
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "auto_review");
  assert.equal(updated?.substate, "waiting_ci");
  assert.ok(updated?.flags.includes("ci_green"));
  assert.deepEqual(reconcileCalls, []);
});

test("github sync handles check_suite using stored head sha without fetching the pull request", async (t) => {
  let getPullRequestCalls = 0;
  const { cleanup, service, sync, ownerTeamId, pmUserId, reconcileCalls } = await createGitHubSyncFixture({
    githubService: {
      getPullRequestCiSnapshot: async () => ({
        headSha: "current-head-sha",
        conclusion: "failure",
        failedRuns: [{ id: 1, name: "unit-tests", status: "completed", conclusion: "failure" }],
        failedAnnotations: [],
      }),
      getPullRequest: async () => {
        getPullRequestCalls += 1;
        throw new Error("check_suite should not fetch pull request details");
      },
    },
  });
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "Stored head SHA is sufficient",
    summary: "Avoid network calls in the webhook callback path",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.601",
    jiraIssueKey: "HBL-405C",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 91,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/91",
    githubPrHeadSha: "current-head-sha",
    initialState: "auto_review",
    initialSubstate: "waiting_ci",
    flags: ["pr_opened", "ci_green", "self_review_done", "github_pr_adopted", "ai_assist_enabled"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "check_suite",
    action: "completed",
    repo: "hubstaff/gooseherd",
    conclusion: "failure",
    status: "completed",
    headSha: "current-head-sha",
    pullRequestNumbers: [91],
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "auto_review");
  assert.equal(updated?.substate, "ci_failed");
  assert.ok(!updated?.flags.includes("ci_green"));
  assert.equal(getPullRequestCalls, 0);
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
    flags: ["pr_opened", "ci_green", "self_review_done", "engineering_review_done", "qa_review_done"],
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
  const { cleanup, db, service, sync, ownerTeamId, pmUserId, reconcileCalls } = await createGitHubSyncFixture();
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
    flags: ["pr_opened", "ci_green", "self_review_done", "github_pr_adopted", "ai_assist_enabled"],
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
  const reviewEvents = await db.select().from(workItemEvents).where(eq(workItemEvents.workItemId, changesRequestedItem.id));
  assert.equal(reviewEvents.filter((event) => event.eventType === "github.review_submitted").length, 1);
  assert.equal(reviewEvents.filter((event) => event.eventType === "github.review_transitioned").length, 1);

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
    flags: ["pr_opened", "ci_green", "self_review_done", "github_pr_adopted", "ai_assist_enabled"],
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

test("github sync routes product review approvals back into delivery flow", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixture();
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "Product review webhook handling",
    summary: "Product review should move to QA review",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.7012",
    jiraIssueKey: "HBL-407PR",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 1000,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/1000",
    initialState: "product_review",
    initialSubstate: "waiting_product_review",
    flags: ["pr_opened", "ci_green", "self_review_done", "engineering_review_done", "product_review_required"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "pull_request_review",
    action: "submitted",
    repo: "hubstaff/gooseherd",
    prNumber: 1000,
    state: "approved",
    reviewer: "reviewer-product",
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "qa_review");
  assert.equal(updated?.substate, "waiting_qa_review");
  assert.ok(updated?.flags.includes("product_review_done"));
});

test("github sync triggers ready_for_merge handler when qa review approval moves work item to ready_for_merge", async (t) => {
  const calls: Array<{ id: string; state: string }> = [];
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixture({
    readyForMergeHandler: async (workItem) => {
      calls.push({ id: workItem.id, state: workItem.state });
    },
  });
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "QA approval webhook handling",
    summary: "QA approval should become merge-ready",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.7013",
    jiraIssueKey: "HBL-407QA",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 10001,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/10001",
    initialState: "qa_review",
    initialSubstate: "waiting_qa_review",
    flags: ["pr_opened", "ci_green", "self_review_done", "engineering_review_done"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "pull_request_review",
    action: "submitted",
    repo: "hubstaff/gooseherd",
    prNumber: 10001,
    state: "approved",
    reviewer: "reviewer-qa",
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "ready_for_merge");
  assert.equal(updated?.substate, "waiting_merge");
  assert.ok(updated?.flags.includes("qa_review_done"));
  assert.deepEqual(calls, [{ id: delivery.id, state: "ready_for_merge" }]);
});

test("github sync advances engineering review when code review passed label is present", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixture();
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "Review labels sync",
    summary: "PR labels should unlock branch sync gating",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.7015",
    jiraIssueKey: "HBL-407A",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 1001,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/1001",
    initialState: "engineering_review",
    initialSubstate: "waiting_engineering_review",
    flags: ["pr_opened", "ci_green", "self_review_done"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "labeled",
    repo: "hubstaff/gooseherd",
    prNumber: 1001,
    prUrl: "https://github.com/hubstaff/gooseherd/pull/1001",
    labels: ["code review passed", "QA passed"],
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "qa_preparation");
  assert.equal(updated?.substate, "preparing_review_app");
  assert.ok(updated?.flags.includes("engineering_review_done"));
  assert.ok(updated?.flags.includes("qa_review_done"));
});

test("github sync keeps qa_preparation when QA passed is already present at qa review entry", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixture({
    skipProductReview: true,
  });
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "Review labels sync with skips",
    summary: "PR labels should respect direct-to-QA routing",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.70155",
    jiraIssueKey: "HBL-407AA",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 10011,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/10011",
    initialState: "engineering_review",
    initialSubstate: "waiting_engineering_review",
    flags: ["pr_opened", "ci_green", "self_review_done", "product_review_required"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "labeled",
    repo: "hubstaff/gooseherd",
    prNumber: 10011,
    prUrl: "https://github.com/hubstaff/gooseherd/pull/10011",
    labels: ["code review passed", "QA passed"],
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "qa_preparation");
  assert.equal(updated?.substate, "preparing_review_app");
  assert.ok(updated?.flags.includes("engineering_review_done"));
  assert.ok(updated?.flags.includes("qa_review_done"));
});

test("github sync removes review result flags when the corresponding label is removed", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixture();
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "Review labels unsync",
    summary: "Removing a PR label should remove the matching delivery flag",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.7016",
    jiraIssueKey: "HBL-407B",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 1002,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/1002",
    initialState: "engineering_review",
    initialSubstate: "waiting_engineering_review",
    flags: ["pr_opened", "engineering_review_done", "qa_review_done", "ai_assist_enabled"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "unlabeled",
    repo: "hubstaff/gooseherd",
    prNumber: 1002,
    prUrl: "https://github.com/hubstaff/gooseherd/pull/1002",
    labels: ["QA passed"],
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "engineering_review");
  assert.equal(updated?.substate, "waiting_engineering_review");
  assert.ok(!updated?.flags.includes("engineering_review_done"));
  assert.ok(updated?.flags.includes("qa_review_done"));
  assert.ok(!updated?.flags.includes("ai_assist_enabled"));
  assert.ok(updated?.flags.includes("ai_assist_disabled"));
});

test("github sync advances qa review when QA passed label is present", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixture();
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "QA label sync",
    summary: "QA label should move the work item to merge-ready",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.70165",
    jiraIssueKey: "HBL-407BQ",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 10021,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/10021",
    initialState: "qa_review",
    initialSubstate: "waiting_qa_review",
    flags: ["pr_opened", "engineering_review_done"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "labeled",
    repo: "hubstaff/gooseherd",
    prNumber: 10021,
    prUrl: "https://github.com/hubstaff/gooseherd/pull/10021",
    labels: ["code review passed", "QA passed"],
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "ready_for_merge");
  assert.equal(updated?.substate, "waiting_merge");
  assert.ok(updated?.flags.includes("qa_review_done"));
});

test("github sync triggers ready_for_merge handler once when QA passed label moves work item to ready_for_merge", async (t) => {
  const calls: Array<{ id: string; state: string }> = [];
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixture({
    readyForMergeHandler: async (workItem) => {
      calls.push({ id: workItem.id, state: workItem.state });
    },
  });
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "QA label sync with handler",
    summary: "QA label should move the work item to merge-ready exactly once",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.70166",
    jiraIssueKey: "HBL-407BQQ",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 10022,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/10022",
    initialState: "qa_review",
    initialSubstate: "waiting_qa_review",
    flags: ["pr_opened", "engineering_review_done"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "labeled",
    repo: "hubstaff/gooseherd",
    prNumber: 10022,
    prUrl: "https://github.com/hubstaff/gooseherd/pull/10022",
    labels: ["code review passed", "QA passed"],
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "ready_for_merge");
  assert.deepEqual(calls, [{ id: delivery.id, state: "ready_for_merge" }]);
});

test("github sync keeps ready_for_merge safety net for pull_request events without label transitions", async (t) => {
  const calls: Array<{ id: string; state: string }> = [];
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixture({
    readyForMergeHandler: async (workItem) => {
      calls.push({ id: workItem.id, state: workItem.state });
    },
  });
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "Ready-for-merge safety net",
    summary: "A plain PR webhook should still invoke the handler",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.70167",
    jiraIssueKey: "HBL-407BQR",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 10023,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/10023",
    initialState: "ready_for_merge",
    initialSubstate: "waiting_merge",
    flags: ["pr_opened", "engineering_review_done", "qa_review_done", "ai_assist_enabled"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "edited",
    repo: "hubstaff/gooseherd",
    prNumber: 10023,
    prUrl: "https://github.com/hubstaff/gooseherd/pull/10023",
    labels: ["ai:assist", "code review passed", "QA passed"],
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "ready_for_merge");
  assert.deepEqual(calls, [{ id: delivery.id, state: "ready_for_merge" }]);
});

test("github sync does not launch self review after green CI when ai:assist automation is disabled", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId, reconcileCalls } = await createGitHubSyncFixture({
    githubService: {
      getPullRequestCiSnapshot: async () => ({ headSha: "green-disabled-sha", conclusion: "success" }),
    },
  });
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "Green CI while automation is disabled",
    summary: "Keep status in sync without launching self review",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.7017",
    jiraIssueKey: "HBL-407C",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 1003,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/1003",
    githubPrHeadSha: "green-disabled-sha",
    initialState: "auto_review",
    initialSubstate: "waiting_ci",
    flags: ["pr_opened", "github_pr_adopted", "ai_assist_disabled"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "check_suite",
    action: "completed",
    repo: "hubstaff/gooseherd",
    conclusion: "success",
    status: "completed",
    headSha: "green-disabled-sha",
    pullRequestNumbers: [1003],
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "auto_review");
  assert.equal(updated?.substate, "ci_green_pending_self_review");
  assert.ok(updated?.flags.includes("ci_green"));
  assert.deepEqual(reconcileCalls, []);
});

test("github sync does not auto-launch follow-up review when changes are requested and ai:assist automation is disabled", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId, reconcileCalls } = await createGitHubSyncFixture();
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "Review requested while automation is disabled",
    summary: "Do not auto-launch a new review run",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.7018",
    jiraIssueKey: "HBL-407D",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 1004,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/1004",
    initialState: "engineering_review",
    flags: ["pr_opened", "ci_green", "self_review_done", "github_pr_adopted", "ai_assist_disabled"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "pull_request_review",
    action: "submitted",
    repo: "hubstaff/gooseherd",
    prNumber: 1004,
    state: "changes_requested",
    reviewer: "reviewer-a",
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "auto_review");
  assert.equal(updated?.substate, "applying_review_feedback");
  assert.deepEqual(reconcileCalls, []);
});

test("github sync re-enables automation for an existing linked PR when ai:assist is added back", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId, reconcileCalls } = await createGitHubSyncFixture();
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "Re-enable automation",
    summary: "Adding ai:assist back should resume auto review",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.7019",
    jiraIssueKey: "HBL-407E",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 1005,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/1005",
    initialState: "auto_review",
    initialSubstate: "ci_green_pending_self_review",
    flags: ["pr_opened", "ci_green", "github_pr_adopted", "ai_assist_disabled"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "labeled",
    repo: "hubstaff/gooseherd",
    prNumber: 1005,
    prUrl: "https://github.com/hubstaff/gooseherd/pull/1005",
    labels: ["ai:assist"],
  });

  assert.equal(updated?.id, delivery.id);
  assert.ok(updated?.flags.includes("ai_assist_enabled"));
  assert.ok(!updated?.flags.includes("ai_assist_disabled"));
  assert.deepEqual(reconcileCalls, [{ workItemId: delivery.id, reason: "github.automation_enabled" }]);
});

test("github sync ignores review callbacks for pull requests without a linked work item", async (t) => {
  const { cleanup, sync } = await createGitHubSyncFixture();
  t.after(cleanup);

  const ignored = await sync.handleWebhookPayload({
    eventType: "pull_request_review",
    action: "submitted",
    repo: "hubstaff/gooseherd",
    prNumber: 4242,
    state: "changes_requested",
    reviewer: "reviewer-a",
  });

  assert.equal(ignored, undefined);
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

test("github sync advances engineering approval to qa preparation", async (t) => {
  const qaPreparationCalls: Array<{ id: string; state: string }> = [];
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixture({
    skipProductReview: true,
    qaPreparationHandler: async (workItem) => {
      qaPreparationCalls.push({ id: workItem.id, state: workItem.state });
    },
  });
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "Prepare QA",
    summary: "Go to QA preparation",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.704",
    jiraIssueKey: "HBL-410",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 103,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/103",
    initialState: "engineering_review",
    initialSubstate: "waiting_engineering_review",
    flags: ["pr_opened", "ci_green", "self_review_done", "product_review_required"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "pull_request_review",
    action: "submitted",
    repo: "hubstaff/gooseherd",
    prNumber: 103,
    state: "approved",
    reviewer: "reviewer-a",
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "qa_preparation");
  assert.equal(updated?.substate, "preparing_review_app");
  assert.ok(updated?.flags.includes("engineering_review_done"));
  assert.deepEqual(qaPreparationCalls, [{ id: delivery.id, state: "qa_preparation" }]);
});

test("github sync skips product review after qa preparation when configured", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixture({
    skipProductReview: true,
  });
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "Skip product review",
    summary: "Green QA prep should go to QA review",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.705",
    jiraIssueKey: "HBL-411",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 104,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/104",
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
    pullRequestNumbers: [104],
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "qa_review");
  assert.equal(updated?.substate, "waiting_qa_review");
  assert.ok(updated?.flags.includes("ci_green"));
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

test("github sync marks auto review delivery done when linked pull request is merged", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixture();
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "Merged during auto review",
    summary: "Merged before automation finished",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.7041",
    jiraIssueKey: "HBL-4101",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 1031,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/1031",
    initialState: "auto_review",
    initialSubstate: "ci_green_pending_self_review",
    flags: ["pr_opened", "ci_green"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "closed",
    repo: "hubstaff/gooseherd",
    prNumber: 1031,
    prUrl: "https://github.com/hubstaff/gooseherd/pull/1031",
    merged: true,
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "done");
  assert.equal(updated?.substate, "merged");
  assert.ok(updated?.flags.includes("merged"));
});

test("github sync cancels auto review delivery when linked pull request is closed without merge", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixture();
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "Closed during auto review",
    summary: "Closed before automation finished",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.7042",
    jiraIssueKey: "HBL-4102",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 1032,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/1032",
    initialState: "auto_review",
    initialSubstate: "ci_failed",
    flags: ["pr_opened"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "closed",
    repo: "hubstaff/gooseherd",
    prNumber: 1032,
    prUrl: "https://github.com/hubstaff/gooseherd/pull/1032",
    merged: false,
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "cancelled");
  assert.equal(updated?.substate, "closed_unmerged");
  assert.ok(updated?.flags.includes("pr_closed"));
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
    flags: ["pr_opened", "ci_green", "self_review_done", "engineering_review_done", "qa_review_done"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "synchronize",
    repo: "hubstaff/gooseherd",
    prNumber: 104,
    labels: ["code review passed", "QA passed"],
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "auto_review");
  assert.equal(updated?.substate, "waiting_ci");
  assert.ok(!updated?.flags.includes("ci_green"));
  assert.ok(updated?.flags.includes("self_review_done"));
  assert.ok(updated?.flags.includes("engineering_review_done"));
  assert.ok(updated?.flags.includes("qa_review_done"));
});

test("github sync clears downstream sticky approvals on ready_for_merge synchronize when engineering reset is enabled", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixture({
    resetEngineeringReviewOnNewCommits: true,
  });
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "Branch updated after approval",
    summary: "Engineering reset should invalidate downstream sticky approvals too",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.7051",
    jiraIssueKey: "HBL-411A",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 1041,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/1041",
    initialState: "ready_for_merge",
    initialSubstate: "waiting_merge",
    flags: [
      "pr_opened",
      "ci_green",
      "self_review_done",
      "engineering_review_done",
      "product_review_done",
      "qa_review_done",
    ],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "synchronize",
    repo: "hubstaff/gooseherd",
    prNumber: 1041,
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "auto_review");
  assert.equal(updated?.substate, "waiting_ci");
  assert.ok(!updated?.flags.includes("ci_green"));
  assert.ok(updated?.flags.includes("self_review_done"));
  assert.ok(!updated?.flags.includes("engineering_review_done"));
  assert.ok(!updated?.flags.includes("product_review_done"));
  assert.ok(!updated?.flags.includes("qa_review_done"));
});

test("github sync clears only sticky QA approval on ready_for_merge synchronize when QA reset is enabled", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixture({
    resetQaReviewOnNewCommits: true,
  });
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "Branch updated after QA sign-off",
    summary: "Only sticky QA approval should be invalidated",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.7052",
    jiraIssueKey: "HBL-411B",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 1042,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/1042",
    initialState: "ready_for_merge",
    initialSubstate: "waiting_merge",
    flags: [
      "pr_opened",
      "ci_green",
      "self_review_done",
      "engineering_review_done",
      "product_review_done",
      "qa_review_done",
    ],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "pull_request",
    action: "synchronize",
    repo: "hubstaff/gooseherd",
    prNumber: 1042,
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "auto_review");
  assert.equal(updated?.substate, "waiting_ci");
  assert.ok(!updated?.flags.includes("ci_green"));
  assert.ok(updated?.flags.includes("self_review_done"));
  assert.ok(updated?.flags.includes("engineering_review_done"));
  assert.ok(updated?.flags.includes("product_review_done"));
  assert.ok(!updated?.flags.includes("qa_review_done"));
});

test("github sync clears ci_green but preserves self_review_done on synchronize for auto_review items", async (t) => {
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

  assert.equal(updated?.state, "auto_review");
  assert.equal(updated?.substate, "waiting_ci");
  assert.ok(!updated?.flags.includes("ci_green"));
  assert.ok(updated?.flags.includes("self_review_done"));
});

test("github sync returns sticky reviewed auto_review work items to ready_for_merge after green CI", async (t) => {
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixture();
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "Squashed branch passed CI",
    summary: "The PR only needs green CI to become merge-ready again",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.707",
    jiraIssueKey: "HBL-413",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 106,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/106",
    initialState: "auto_review",
    initialSubstate: "waiting_ci",
    flags: ["pr_opened", "self_review_done", "engineering_review_done", "qa_review_done"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "check_suite",
    action: "completed",
    repo: "hubstaff/gooseherd",
    status: "completed",
    conclusion: "success",
    pullRequestNumbers: [106],
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "ready_for_merge");
  assert.equal(updated?.substate, "waiting_merge");
  assert.ok(updated?.flags.includes("ci_green"));
});

test("github sync triggers ready_for_merge handler when green ci moves auto_review work into ready_for_merge", async (t) => {
  const calls: Array<{ id: string; state: string }> = [];
  const { cleanup, service, sync, ownerTeamId, pmUserId } = await createGitHubSyncFixture({
    readyForMergeHandler: async (workItem) => {
      calls.push({ id: workItem.id, state: workItem.state });
    },
  });
  t.after(cleanup);

  const delivery = await service.createDeliveryFromJira({
    title: "Squashed branch passed CI with handler",
    summary: "The PR only needs green CI to become merge-ready again",
    ownerTeamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.7071",
    jiraIssueKey: "HBL-413A",
    createdByUserId: pmUserId,
    repo: "hubstaff/gooseherd",
    githubPrNumber: 1061,
    githubPrUrl: "https://github.com/hubstaff/gooseherd/pull/1061",
    initialState: "auto_review",
    initialSubstate: "waiting_ci",
    flags: ["pr_opened", "self_review_done", "engineering_review_done", "qa_review_done"],
  });

  const updated = await sync.handleWebhookPayload({
    eventType: "check_suite",
    action: "completed",
    repo: "hubstaff/gooseherd",
    status: "completed",
    conclusion: "success",
    pullRequestNumbers: [1061],
  });

  assert.equal(updated?.id, delivery.id);
  assert.equal(updated?.state, "ready_for_merge");
  assert.deepEqual(calls, [{ id: delivery.id, state: "ready_for_merge" }]);
});
