# Feature Delivery PR-Centric Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `feature_delivery` PR-centric by allowing multiple delivery cards per Jira issue, adding `repo`-scoped PR identity, bootstrapping a default team, auto-creating GitHub users, and creating/binding delivery cards from GitHub PR webhooks.

**Architecture:** Extend the existing work-item model instead of adding a parallel PR entity. Keep `product_discovery` Jira-centric and workflow-scoped, then rewrite GitHub adoption to operate on `0 / 1 / many` delivery candidates using local identity resolution (`github_login -> user -> primary_team_id -> team channel -> Slack thread`). Default team bootstrap becomes part of startup and serves as the safe fallback for auto-created users.

**Tech Stack:** TypeScript, Node.js, Drizzle ORM, PostgreSQL, existing dashboard server, Slack Web API integration, GitHub webhook observer layer

---

## File Map

**Create**

- `drizzle/0013_feature_delivery_pr_identity.sql`
- `src/work-items/default-team-bootstrap.ts`
- `tests/default-team-bootstrap.test.ts`

**Modify**

- `src/db/schema.ts`
- `drizzle/meta/_journal.json`
- `src/config.ts`
- `src/index.ts`
- `src/work-items/types.ts`
- `src/work-items/store.ts`
- `src/work-items/service.ts`
- `src/work-items/github-sync.ts`
- `src/work-items/identity-store.ts`
- `src/user-directory/service.ts`
- `src/user-directory/store.ts`
- `README.md`
- `docs/installation-kubernetes.md`
- `tests/config.test.ts`
- `tests/work-item-store.test.ts`
- `tests/work-item-github-sync.test.ts`
- `tests/work-item-jira-sync.test.ts`
- `tests/work-item-context-resolver.test.ts`
- `tests/user-directory-service.test.ts`

**Test Commands**

- `node --test --import tsx tests/config.test.ts`
- `node --test --import tsx tests/default-team-bootstrap.test.ts`
- `node --test --import tsx tests/work-item-store.test.ts`
- `node --test --import tsx tests/user-directory-service.test.ts`
- `node --test --import tsx tests/work-item-github-sync.test.ts`
- `node --test --import tsx tests/work-item-jira-sync.test.ts`
- `node --test --import tsx tests/work-item-context-resolver.test.ts`
- `npm test -- --test-name-pattern="drizzle"`

## Task 1: Add Schema Support For PR-Scoped Delivery Identity

**Files:**
- Create: `drizzle/0013_feature_delivery_pr_identity.sql`
- Modify: `src/db/schema.ts`
- Modify: `drizzle/meta/_journal.json`
- Test: `tests/work-item-store.test.ts`
- Test: `tests/work-item-jira-sync.test.ts`

- [ ] **Step 1: Add failing schema/store tests for multiple delivery rows per Jira**

Extend `tests/work-item-store.test.ts` with cases that expect:

- two `feature_delivery` rows may share the same `jiraIssueKey`
- two `feature_delivery` rows may share the same `sourceWorkItemId`
- two rows with `githubPrNumber = null` are allowed
- duplicate `(repo, githubPrNumber)` is rejected

Add a regression to `tests/work-item-jira-sync.test.ts` asserting that `product_discovery` lookup remains singular while delivery lookup becomes plural.

Run:

```bash
node --test --import tsx tests/work-item-store.test.ts tests/work-item-jira-sync.test.ts
```

Expected: FAIL because schema and store still assume global/singular Jira and PR identity.

- [ ] **Step 2: Update Drizzle schema for work item identity**

Modify `src/db/schema.ts`:

- add `repo: text("repo")`
- add `primaryTeamId: uuid("primary_team_id")` to `users`
- add `isDefault: boolean("is_default").notNull().default(false)` to `teams`
- remove `work_items_feature_delivery_jira_issue_key_idx`
- remove `work_items_feature_delivery_source_work_item_id_idx`
- replace `work_items_github_pr_number_idx` with partial unique `(repo, github_pr_number)` where both are present
- add partial unique index for `teams.is_default = true`

Also update TypeScript row mappings to expose:

```ts
repo?: string;
primaryTeamId?: string;
isDefault: boolean;
```

- [ ] **Step 3: Write migration `0013_feature_delivery_pr_identity.sql`**

Migration should:

- add `repo` to `work_items`
- add `primary_team_id` to `users`
- add `is_default` to `teams`
- drop old feature-delivery-only Jira/source unique indexes
- drop old global `github_pr_number` unique index
- create new partial unique `(repo, github_pr_number)`
- create partial unique default-team index

Do not backfill `primary_team_id` yet; later tasks will set it explicitly.

- [ ] **Step 4: Update Drizzle journal**

Append `0013_feature_delivery_pr_identity.sql` to `drizzle/meta/_journal.json`.

- [ ] **Step 5: Run schema/store tests**

Run:

```bash
npm test -- --test-name-pattern="drizzle"
node --test --import tsx tests/work-item-store.test.ts tests/work-item-jira-sync.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts drizzle/0013_feature_delivery_pr_identity.sql drizzle/meta/_journal.json tests/work-item-store.test.ts tests/work-item-jira-sync.test.ts
git commit -m "feat: add PR-scoped delivery identity schema"
```

## Task 2: Add Config And Bootstrap For Default Team

**Files:**
- Create: `src/work-items/default-team-bootstrap.ts`
- Modify: `src/config.ts`
- Modify: `src/index.ts`
- Test: `tests/config.test.ts`
- Test: `tests/default-team-bootstrap.test.ts`

- [ ] **Step 1: Add failing config/bootstrap tests**

Extend `tests/config.test.ts` with assertions that:

- `DEFAULT_TEAM_SLACK_CHANNEL_ID` is parsed
- `DEFAULT_TEAM_NAME` defaults to `"default"`
- `DEFAULT_TEAM_SLACK_CHANNEL_NAME` defaults to `"#general"`

Create `tests/default-team-bootstrap.test.ts` covering:

- missing `DEFAULT_TEAM_SLACK_CHANNEL_ID` throws
- bootstrap creates default team when absent
- bootstrap updates existing default team from env
- second default team cannot be created because of unique constraint

Run:

```bash
node --test --import tsx tests/config.test.ts tests/default-team-bootstrap.test.ts
```

Expected: FAIL because config keys and bootstrap helper do not exist.

- [ ] **Step 2: Add config fields**

Modify `src/config.ts` to expose:

```ts
defaultTeamName: parsed.DEFAULT_TEAM_NAME?.trim() || "default",
defaultTeamSlackChannelId: parsed.DEFAULT_TEAM_SLACK_CHANNEL_ID?.trim() || "",
defaultTeamSlackChannelName: parsed.DEFAULT_TEAM_SLACK_CHANNEL_NAME?.trim() || "#general",
```

Add startup validation that `defaultTeamSlackChannelId` is required when work-item identity/bootstrap is enabled.

- [ ] **Step 3: Implement default-team bootstrap helper**

Create `src/work-items/default-team-bootstrap.ts` with one focused function:

```ts
export async function ensureDefaultTeam(db: Database, input: {
  name: string;
  slackChannelId: string;
  slackChannelName: string;
}): Promise<{ id: string; name: string; slackChannelId: string }> { /* ... */ }
```

Behavior:

- load team with `is_default = true`
- create it if missing
- otherwise update `name` and `slackChannelId`
- store `slackChannelName` only if an existing metadata field is available; otherwise keep it config-only for now

- [ ] **Step 4: Call bootstrap during startup**

Modify `src/index.ts` so startup order becomes:

- init DB
- run bootstrap helper before creating services that depend on default team
- fail fast before observer/dashboard starts if bootstrap config is invalid

- [ ] **Step 5: Run config/bootstrap tests**

Run:

```bash
node --test --import tsx tests/config.test.ts tests/default-team-bootstrap.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/index.ts src/work-items/default-team-bootstrap.ts tests/config.test.ts tests/default-team-bootstrap.test.ts
git commit -m "feat: bootstrap default team from config"
```

## Task 3: Make User Identity Team-Aware With Primary Team Semantics

**Files:**
- Modify: `src/work-items/identity-store.ts`
- Modify: `src/user-directory/store.ts`
- Modify: `src/user-directory/service.ts`
- Test: `tests/user-directory-service.test.ts`
- Test: `tests/work-item-context-resolver.test.ts`

- [ ] **Step 1: Add failing identity tests**

Extend `tests/user-directory-service.test.ts` with cases for:

- creating user with `primaryTeamId`
- rejecting `primaryTeamId` when membership does not exist
- switching `primaryTeamId` after adding a new membership

Extend `tests/work-item-context-resolver.test.ts` with a case showing a user with `primaryTeamId` resolves that team directly.

Run:

```bash
node --test --import tsx tests/user-directory-service.test.ts tests/work-item-context-resolver.test.ts
```

Expected: FAIL because user directory and identity store do not understand `primaryTeamId`.

- [ ] **Step 2: Extend user-directory DTOs and store**

Modify `src/user-directory/store.ts` and `src/user-directory/service.ts` so user records include:

```ts
primaryTeamId: string | null;
```

Normalize it like other optional identities and persist it on create/update.

- [ ] **Step 3: Add membership-aware validation**

In `src/user-directory/service.ts`, before accepting `primaryTeamId`, verify that the user has a matching `team_members` row.

For updates, use this rule:

- if `primaryTeamId` is provided and membership is missing -> throw
- do not auto-create memberships here; auto-creation belongs to the GitHub adoption path

- [ ] **Step 4: Extend `WorkItemIdentityStore`**

Add focused helpers:

```ts
async getUserByGitHubLogin(githubLogin: string): Promise<IdentityUserRecord | undefined>
async getDefaultTeam(): Promise<IdentityTeamRecord | undefined>
async getPrimaryTeamForUser(userId: string): Promise<IdentityTeamRecord | undefined>
async ensureUserTeamMembership(userId: string, teamId: string, membershipSource: string): Promise<void>
```

These helpers will be consumed by PR-first delivery context creation.

- [ ] **Step 5: Run identity tests**

Run:

```bash
node --test --import tsx tests/user-directory-service.test.ts tests/work-item-context-resolver.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/work-items/identity-store.ts src/user-directory/store.ts src/user-directory/service.ts tests/user-directory-service.test.ts tests/work-item-context-resolver.test.ts
git commit -m "feat: add primary team user identity support"
```

## Task 4: Scope Work-Item Lookups By Workflow And PR Identity

**Files:**
- Modify: `src/work-items/types.ts`
- Modify: `src/work-items/store.ts`
- Test: `tests/work-item-store.test.ts`

- [ ] **Step 1: Add failing store tests for scoped lookups**

Extend `tests/work-item-store.test.ts` with expectations for:

- `findProductDiscoveryByJiraIssueKey("HUB-1")` returns only the discovery row
- `listFeatureDeliveryByJiraIssueKey("HUB-1")` returns multiple rows
- `listFeatureDeliveryAdoptionCandidatesByJiraIssueKey("HUB-1")` excludes done/cancelled/PR-linked items
- `findByRepoAndGitHubPrNumber("vsevolod/openai_bot", 2)` matches uniquely

Run:

```bash
node --test --import tsx tests/work-item-store.test.ts
```

Expected: FAIL because store only exposes singular/global Jira and PR lookups.

- [ ] **Step 2: Extend work-item types**

Modify `src/work-items/types.ts` to include:

```ts
repo?: string;
```

Add `repo?: string` to `CreateWorkItemInput` and `WorkItemRecord`.

- [ ] **Step 3: Replace global lookup helpers**

Modify `src/work-items/store.ts` to add:

```ts
findByRepoAndGitHubPrNumber(repo: string, githubPrNumber: number)
findProductDiscoveryByJiraIssueKey(jiraIssueKey: string)
listFeatureDeliveryByJiraIssueKey(jiraIssueKey: string)
listFeatureDeliveryAdoptionCandidatesByJiraIssueKey(jiraIssueKey: string)
```

Update `linkPullRequest` to persist `repo` together with PR identity:

```ts
async linkPullRequest(id: string, input: { repo: string; githubPrNumber: number; githubPrUrl?: string })
```

Retire direct use of `findByJiraIssueKey` and `findByGitHubPrNumber` from new code paths.

- [ ] **Step 4: Run store tests**

Run:

```bash
node --test --import tsx tests/work-item-store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/work-items/types.ts src/work-items/store.ts tests/work-item-store.test.ts
git commit -m "feat: add workflow-scoped work item lookups"
```

## Task 5: Support PR-First Delivery Context Resolution And Auto-Created Users

**Files:**
- Modify: `src/work-items/github-sync.ts`
- Modify: `src/index.ts`
- Modify: `src/work-items/service.ts`
- Modify: `src/work-items/identity-store.ts`
- Modify: `src/user-directory/service.ts`
- Test: `tests/work-item-github-sync.test.ts`

- [ ] **Step 1: Add failing GitHub sync tests for PR-first creation**

Extend `tests/work-item-github-sync.test.ts` with cases for:

- `0 candidates` + known GitHub user -> creates new delivery item in `auto_review`
- `0 candidates` + unknown GitHub user -> auto-creates user, assigns default team, creates delivery item
- existing Jira-backed card binds PR without overwriting title/summary
- ambiguity (`>1 candidates`) appends conflict events to each candidate and creates no item
- PR without Jira key is ignored in v1

Run:

```bash
node --test --import tsx tests/work-item-github-sync.test.ts
```

Expected: FAIL because current GitHub sync uses singular Jira lookups and cannot auto-create users/PR-first items.

- [ ] **Step 2: Expand GitHub webhook payload for author login**

Modify `parseGitHubWorkItemWebhookPayload(...)` in `src/work-items/github-sync.ts` to include:

```ts
authorLogin?: string;
```

Read it from `pull_request.user.login`.

- [ ] **Step 3: Replace `resolveDeliveryContext` contract**

Change `GitHubWorkItemSyncOptions` in `src/work-items/github-sync.ts` to accept a richer resolver:

```ts
resolveDeliveryContext: (input: {
  jiraIssueKey: string;
  repo?: string;
  prNumber?: number;
  prTitle?: string;
  prBody?: string;
  prUrl?: string;
  authorLogin?: string;
}) => Promise<DeliveryContextResolverResult | undefined>;
```

Update `src/index.ts` to implement this resolver by:

- finding or auto-creating user by `github_login`
- loading default team
- ensuring membership in default team for auto-created users
- resolving primary team, then fallback team
- creating the initial Slack thread when needed

- [ ] **Step 4: Add a PR-first creation path**

Modify `handlePullRequest(...)` in `src/work-items/github-sync.ts` to use the new branches:

- existing PR by `(repo, prNumber)` -> existing behavior
- no adoption label -> return
- no Jira key -> return
- exactly one candidate -> bind PR to existing item
- zero candidates -> create new item from PR context
- multiple candidates -> append ambiguity events to each candidate and return

When creating a new item, pass:

```ts
await this.workItemService.createDeliveryFromJira({
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
  repo: payload.repo,
})
```

Also ensure the existing-card branch leaves `title` and `summary` untouched.

- [ ] **Step 5: Extend service input with `repo`**

Modify `src/work-items/service.ts` so `createDeliveryFromJira(...)` accepts:

```ts
repo?: string;
```

and passes it into `createWorkItem(...)`.

- [ ] **Step 6: Run GitHub sync tests**

Run:

```bash
node --test --import tsx tests/work-item-github-sync.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/work-items/github-sync.ts src/index.ts src/work-items/service.ts src/work-items/identity-store.ts src/user-directory/service.ts tests/work-item-github-sync.test.ts
git commit -m "feat: adopt delivery items from PR webhooks"
```

## Task 6: Preserve Jira Sync Semantics With Workflow-Scoped Lookup

**Files:**
- Modify: `src/work-items/jira-sync.ts`
- Modify: `tests/work-item-jira-sync.test.ts`

- [ ] **Step 1: Add failing Jira sync regression tests**

Extend `tests/work-item-jira-sync.test.ts` with:

- delivery webhook creates one discovery-linked delivery row
- a second delivery row with the same Jira key does not break discovery lookup
- Jira sync still treats discovery creation as singular

Run:

```bash
node --test --import tsx tests/work-item-jira-sync.test.ts
```

Expected: FAIL because Jira sync still uses the generic singular Jira lookup.

- [ ] **Step 2: Switch Jira sync to workflow-scoped lookup**

Modify `src/work-items/jira-sync.ts` so:

- delivery path checks `listFeatureDeliveryByJiraIssueKey(...)` or an equivalent delivery-scoped existence query
- discovery path uses `findProductDiscoveryByJiraIssueKey(...)`

This keeps discovery singular while allowing multiple delivery rows.

- [ ] **Step 3: Run Jira sync tests**

Run:

```bash
node --test --import tsx tests/work-item-jira-sync.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/work-items/jira-sync.ts tests/work-item-jira-sync.test.ts
git commit -m "fix: scope Jira work item lookup by workflow"
```

## Task 7: Document Required Config And Operational Behavior

**Files:**
- Modify: `README.md`
- Modify: `docs/installation-kubernetes.md`
- Test: none

- [ ] **Step 1: Update README**

Document:

- `DEFAULT_TEAM_NAME`
- `DEFAULT_TEAM_SLACK_CHANNEL_ID` as required
- `DEFAULT_TEAM_SLACK_CHANNEL_NAME`
- PR-first adoption summary
- ambiguity behavior (`>1 candidates` -> no bind, event + logs only)

- [ ] **Step 2: Update Kubernetes installation doc**

Add `DEFAULT_TEAM_SLACK_CHANNEL_ID` to required env sections and deployment examples.

Clarify startup behavior:

- app fails fast if default-team bootstrap config is missing
- app bootstraps the default team on startup

- [ ] **Step 3: Commit**

```bash
git add README.md docs/installation-kubernetes.md
git commit -m "docs: add default team bootstrap configuration"
```

## Task 8: Run Final Verification Sweep

**Files:**
- Modify: none
- Test: `tests/config.test.ts`
- Test: `tests/default-team-bootstrap.test.ts`
- Test: `tests/work-item-store.test.ts`
- Test: `tests/user-directory-service.test.ts`
- Test: `tests/work-item-context-resolver.test.ts`
- Test: `tests/work-item-github-sync.test.ts`
- Test: `tests/work-item-jira-sync.test.ts`

- [ ] **Step 1: Run targeted verification**

Run:

```bash
node --test --import tsx \
  tests/config.test.ts \
  tests/default-team-bootstrap.test.ts \
  tests/work-item-store.test.ts \
  tests/user-directory-service.test.ts \
  tests/work-item-context-resolver.test.ts \
  tests/work-item-github-sync.test.ts \
  tests/work-item-jira-sync.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run migration/journal verification**

Run:

```bash
npm test -- --test-name-pattern="drizzle"
```

Expected: PASS.

- [ ] **Step 3: Inspect resulting diff for accidental schema/API drift**

Run:

```bash
git diff --stat HEAD~7..HEAD
```

Expected: only planned files are touched; no unrelated changes.

- [ ] **Step 4: Commit verification if any final fixes were needed**

```bash
git add -A
git commit -m "test: verify PR-centric delivery adoption"
```
