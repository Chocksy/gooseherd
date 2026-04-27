import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "./helpers/test-db.js";
import { teamMembers, teams, users, workItemEvents } from "../src/db/schema.js";
import { WorkItemStore } from "../src/work-items/store.js";
import { WorkItemContextResolver } from "../src/work-items/context-resolver.js";
import { JiraWorkItemSync, parseJiraWorkItemWebhookPayload } from "../src/work-items/jira-sync.js";

async function createJiraSyncFixture() {
  const testDb = await createTestDb();
  const pmUserId = randomUUID();
  const teamId = randomUUID();

  await testDb.db.insert(users).values({
    id: pmUserId,
    slackUserId: "U_PM",
    jiraAccountId: "JIRA_PM",
    displayName: "PM",
  });
  await testDb.db.insert(teams).values({
    id: teamId,
    name: "growth",
    slackChannelId: "C_GROWTH",
  });
  await testDb.db.insert(teamMembers).values({
    teamId,
    userId: pmUserId,
    functionalRoles: ["pm"],
  });

  const resolver = new WorkItemContextResolver(testDb.db);
  const createdHomeThreads: Array<{ channelId: string; text: string }> = [];
  const jiraSync = new JiraWorkItemSync(testDb.db, {
    resolveDiscoveryContext: (input) => resolver.resolveDiscoveryContext({
      ...input,
      createHomeThread: async (threadInput) => {
        createdHomeThreads.push(threadInput);
        return "1740000001.000";
      },
    }),
    resolveDeliveryContext: (input) => resolver.resolveDeliveryContext({
      ...input,
      createHomeThread: async (threadInput) => {
        createdHomeThreads.push(threadInput);
        return "1740000001.000";
      },
    }),
  });

  return {
    db: testDb.db,
    cleanup: testDb.cleanup,
    workItems: new WorkItemStore(testDb.db),
    jiraSync,
    createdHomeThreads,
    pmUserId,
    teamId,
  };
}

test("jira sync creates discovery work item for automation-labeled issue", async (t) => {
  const { cleanup, jiraSync, workItems, createdHomeThreads, teamId } = await createJiraSyncFixture();
  t.after(cleanup);

  const workItem = await jiraSync.handleWebhookPayload({
    issueKey: "HBL-801",
    title: "Investigate managed discovery flow",
    summary: "Create the spec draft",
    labels: ["automation"],
    actorJiraAccountId: "JIRA_PM",
    ownerTeamId: teamId,
    originChannelId: "C_RANDOM",
    originThreadTs: "1740000000.100",
  });

  assert.ok(workItem);
  assert.equal(workItem?.workflow, "product_discovery");
  assert.equal(workItem?.state, "backlog");
  assert.equal(workItem?.jiraIssueKey, "HBL-801");
  assert.equal(workItem?.homeChannelId, "C_GROWTH");
  assert.equal(workItem?.homeThreadTs, "1740000001.000");
  assert.equal(createdHomeThreads.length, 1);

  const stored = await workItems.findByJiraIssueKey("HBL-801");
  assert.equal(stored?.workflow, "product_discovery");
});

test("jira sync creates delivery work item for ai:delivery-labeled issue and records event", async (t) => {
  const { cleanup, jiraSync, workItems, db, teamId } = await createJiraSyncFixture();
  t.after(cleanup);

  const workItem = await jiraSync.handleWebhookPayload({
    issueKey: "HBL-802",
    title: "Ship managed delivery",
    summary: "Ready for implementation",
    labels: ["ai:delivery"],
    actorJiraAccountId: "JIRA_PM",
    ownerTeamId: teamId,
    originChannelId: "C_GROWTH",
    originThreadTs: "1740000000.200",
  });

  assert.ok(workItem);
  assert.equal(workItem?.workflow, "feature_delivery");
  assert.equal(workItem?.state, "backlog");
  assert.equal(workItem?.homeThreadTs, "1740000000.200");

  const stored = await workItems.findByJiraIssueKey("HBL-802");
  assert.equal(stored?.workflow, "feature_delivery");

  const events = await db.select().from(workItemEvents).where(eq(workItemEvents.workItemId, workItem!.id));
  assert.ok(events.some((event) => event.eventType === "jira.issue_created"));
});

test("jira sync keeps discovery lookup singular while delivery lookup can return multiple rows", async (t) => {
  const { cleanup, jiraSync, workItems, teamId, pmUserId } = await createJiraSyncFixture();
  t.after(cleanup);

  const discovery = await jiraSync.handleWebhookPayload({
    issueKey: "HBL-804",
    title: "Investigate managed discovery flow",
    summary: "Create the spec draft",
    labels: ["automation"],
    actorJiraAccountId: "JIRA_PM",
    ownerTeamId: teamId,
    originChannelId: "C_RANDOM",
    originThreadTs: "1740000000.300",
  });

  assert.ok(discovery);
  assert.equal((await workItems.findProductDiscoveryByJiraIssueKey("HBL-804"))?.id, discovery?.id);

  const delivery = await workItems.createWorkItem({
    workflow: "feature_delivery",
    state: "backlog",
    title: "Delivery for same Jira issue",
    summary: "Competes with discovery lookup",
    ownerTeamId: teamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.305",
    createdByUserId: pmUserId,
    jiraIssueKey: "HBL-804",
  });

  const discoveryLookup = await jiraSync.handleWebhookPayload({
    issueKey: "HBL-804",
    title: "Investigate managed discovery flow",
    summary: "Create the spec draft",
    labels: ["automation"],
    actorJiraAccountId: "JIRA_PM",
    ownerTeamId: teamId,
    originChannelId: "C_RANDOM",
    originThreadTs: "1740000000.300",
  });

  assert.equal(discoveryLookup?.id, discovery.id);
  assert.equal(discoveryLookup?.workflow, "product_discovery");
  assert.equal((await workItems.listFeatureDeliveriesByJiraIssueKey("HBL-804"))[0]?.id, delivery.id);

  await workItems.createWorkItem({
    workflow: "feature_delivery",
    state: "backlog",
    title: "Delivery A",
    summary: "First delivery",
    ownerTeamId: teamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.301",
    createdByUserId: pmUserId,
    jiraIssueKey: "HBL-805",
  });

  await workItems.createWorkItem({
    workflow: "feature_delivery",
    state: "backlog",
    title: "Delivery B",
    summary: "Second delivery",
    ownerTeamId: teamId,
    homeChannelId: "C_GROWTH",
    homeThreadTs: "1740000000.302",
    createdByUserId: pmUserId,
    jiraIssueKey: "HBL-805",
  });

  const deliveryRows = await workItems.listFeatureDeliveriesByJiraIssueKey("HBL-805");
  assert.equal(deliveryRows.length, 2);
});

test("jira sync ignores unrelated delivery label", async (t) => {
  const { cleanup, jiraSync, teamId } = await createJiraSyncFixture();
  t.after(cleanup);

  const workItem = await jiraSync.handleWebhookPayload({
    issueKey: "HBL-803",
    title: "Unrelated label should not create delivery",
    summary: "Ready for implementation",
    labels: ["legacy-delivery"],
    actorJiraAccountId: "JIRA_PM",
    ownerTeamId: teamId,
    originChannelId: "C_GROWTH",
    originThreadTs: "1740000000.201",
  });

  assert.equal(workItem, undefined);
});

test("jira webhook parser extracts summary text from Jira Cloud ADF descriptions", () => {
  const parsed = parseJiraWorkItemWebhookPayload({
    issue: {
      key: "HBL-804",
      fields: {
        summary: "ADF-backed issue",
        labels: ["automation"],
        description: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Investigate" },
                { type: "hardBreak" },
                { type: "text", text: "managed flow" },
              ],
            },
            {
              type: "bulletList",
              content: [
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "Keep review history" }],
                    },
                  ],
                },
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "mention", attrs: { text: "@pm" } }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    },
  });

  assert.equal(parsed?.summary, "Investigate\nmanaged flow\nKeep review history\n@pm");
});
