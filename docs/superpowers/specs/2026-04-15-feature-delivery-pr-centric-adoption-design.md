# Feature Delivery PR-Centric Adoption Design

**Date:** 2026-04-15  
**Status:** Proposed  
**Context:** Extends `WorkItem v1` so `feature_delivery` can start from Jira-backed items before PR exists, then become PR-centric once a PR appears.

## Goal

Make `feature_delivery` operate around PRs without breaking the earlier Jira-backed stages.

Desired behavior:

- `product_discovery` remains Jira-centric
- `feature_delivery` can exist before PR creation, backed only by `jiraIssueKey`
- once a PR appears, the delivery item becomes PR-backed
- multiple PRs for the same Jira issue become multiple delivery cards
- GitHub webhook adoption can create the first delivery item automatically when none exists yet

## Core Decisions

### Workflow Identity

- `product_discovery` keeps unique `jiraIssueKey`
- `feature_delivery` no longer treats `jiraIssueKey` as unique
- `feature_delivery` cards may share the same `jiraIssueKey`
- after PR adoption, the operational identity of a delivery card is `repo + githubPrNumber`

### Required Identifiers For Feature Delivery

For `feature_delivery`, at least one identity source must exist:

- `jiraIssueKey`
- `githubPrNumber` together with `repo`

This supports:

- pre-PR cards in `backlog` and `in_progress`
- PR-backed cards in `auto_review` and later stages

### Multiple PRs Per Jira Issue

One Jira issue may produce multiple `feature_delivery` cards.

Rules:

- the first PR may bind to an existing Jira-backed delivery card
- a later PR for the same Jira issue becomes a separate card
- `jiraIssueKey` is a reference/grouping field for `feature_delivery`, not a uniqueness key

## Data Model Changes

### Work Items

For `feature_delivery`:

- add `repo`
- drop unique constraint/index that enforces unique `jiraIssueKey`
- drop unique constraint/index that enforces unique `sourceWorkItemId` for `feature_delivery`
- add a partial unique index on `(repo, github_pr_number)` where `github_pr_number is not null`
- allow multiple rows with `github_pr_number = null`
- add a validation rule that `feature_delivery` must have `jiraIssueKey` or `(repo + githubPrNumber)`

For `sourceWorkItemId`:

- it remains an optional provenance link
- it is no longer unique for `feature_delivery`
- multiple delivery cards may point to the same upstream discovery card

For `product_discovery`:

- `jiraIssueKey` should become unique within `product_discovery`
- discovery lookups by Jira key stay singular
- delivery lookups by Jira key become plural

The current generic “find by Jira key” assumption should be replaced by workflow-scoped methods such as:

- `findProductDiscoveryByJiraIssueKey(...)`
- `listFeatureDeliveryByJiraIssueKey(...)`
- `listFeatureDeliveryAdoptionCandidatesByJiraIssueKey(...)`

### Users

Add:

- `users.primary_team_id`

This is the user's main routing team for work-item creation.

Rationale:

- primary team is a property of the user, not of a membership row
- it enforces “one primary team per user” naturally
- runtime context resolution becomes a direct lookup

Invariant:

- if `users.primary_team_id` is set, the user must also have a corresponding `team_members` row for that team
- writes that change `primary_team_id` must enforce or create the matching membership

### Teams

Add:

- `teams.is_default boolean not null default false`

There must be exactly one default team used for fallback routing and auto-created users.

This should be enforced with:

- a partial unique index on `teams.is_default` where `is_default = true`
- bootstrap logic that creates the row if missing

## Default Team Bootstrap

### New Environment Variables

- `DEFAULT_TEAM_NAME`
- `DEFAULT_TEAM_SLACK_CHANNEL_ID`
- `DEFAULT_TEAM_SLACK_CHANNEL_NAME`

`DEFAULT_TEAM_SLACK_CHANNEL_ID` is required.

### Bootstrap Rules

During application startup, after migrations and before accepting work-item creation traffic, Gooseherd must run `ensureDefaultTeam()`.

Behavior:

- find team where `is_default = true`
- if missing, create it from env
- if present, sync mutable fields from env
- if `DEFAULT_TEAM_SLACK_CHANNEL_ID` is missing, fail fast

This requirement must be documented in:

- `README`
- `docs/installation-kubernetes.md`

### Team Membership Policy

Auto-created users are always added to the default team.

Later manual routing works like this:

- user remains a member of the default team
- `primary_team_id` moves to the manually assigned working team
- default team is only the fallback when no better team is known

## PR-First Context Resolution

When GitHub webhook adoption needs to create a new `feature_delivery` item, context comes from local identity data, not from an existing work item.

### Inputs From GitHub Webhook

Use:

- `repo`
- `prNumber`
- `prTitle`
- `prBody`
- `prUrl`
- `pull_request.user.login`
- labels

The webhook also parses `jiraIssueKey` from PR body.

In v1, GitHub webhook adoption remains Jira-dependent:

- the schema allows `feature_delivery` items that are PR-only
- but the `pull_request` webhook adoption path requires a parsed `jiraIssueKey`
- if PR body has no Jira key, adoption does not create a delivery item automatically

This keeps webhook routing deterministic for the first iteration.

### User Resolution

Resolve user by `users.github_login = pull_request.user.login`.

If no user exists:

- create user automatically
- use GitHub login as the initial identity
- use a safe display name derived from the login
- set `primary_team_id = default_team.id`
- add membership in default team

User merge/identity cleanup is explicitly out of scope for this design and can happen later.

### Team Resolution

Team resolution order:

1. `users.primary_team_id`
2. default team

If `primary_team_id` is not set, the default team is used.

If `primary_team_id` points to a team without a matching membership row, that is invalid data and should be repaired or rejected by the writer path rather than tolerated in runtime resolution.

### Home Channel

`homeChannelId` comes from the resolved team's `slack_channel_id`.

If the team has no Slack channel, context resolution fails.

### Home Thread

If a new delivery item is created from PR webhook and there is no existing home thread:

- Gooseherd posts a new message into `homeChannelId`
- returned Slack `ts` becomes `homeThreadTs`

This message initializes the managed delivery thread for that card.

## GitHub PR Adoption Rules

PR adoption starts from a GitHub webhook with adoption label, currently `ai:assist`.

### Candidate Search

After parsing `jiraIssueKey`, the system searches for candidate delivery cards:

- `workflow = feature_delivery`
- matching `jiraIssueKey`
- open / not completed
- `githubPrNumber is null`

### Adoption Outcomes

#### Case 1: Exactly One Candidate

Bind PR to that existing delivery card.

Actions:

- set `repo`
- set `githubPrNumber`
- set `githubPrUrl`
- move state to `auto_review`
- set substate to `pr_adopted`
- add `pr_opened`
- do not overwrite existing `title` or `summary` in v1

Rationale:

- an existing Jira-backed delivery card already has its business-facing title and summary
- PR metadata is attached through PR fields and events instead of rewriting card content

#### Case 2: No Candidates

Create a new `feature_delivery` item directly from the PR.

Creation context:

- `createdByUserId` from GitHub login -> local user resolution
- `ownerTeamId` from `primary_team_id` or default team
- `homeChannelId` from team
- `homeThreadTs` from new Slack thread creation

Initial delivery state:

- `state = auto_review`
- `substate = pr_adopted`
- `flags += pr_opened`

#### Case 3: More Than One Candidate

Do not auto-bind.

Instead:

- append the same ambiguity `work_item_event` to each candidate card
- log the conflict
- leave the PR unadopted for now

There is no synthetic/global work-item event stream in v1, so ambiguity is recorded on each candidate plus regular application logs.

No dashboard UI or Slack alert is required in v1.

## Relationship To Product Discovery

`product_discovery` remains the upstream Jira-centric workflow.

This design does not require `feature_delivery` creation to depend on a discovery card at runtime.

That is intentional:

- it keeps PR-first automation self-contained
- it supports future AI-driven delivery flows
- it avoids blocking on missing prior synchronization

Discovery and delivery may still be linked by shared `jiraIssueKey`, but delivery creation does not require a pre-existing discovery row.

When discovery linkage exists:

- `sourceWorkItemId` may point from delivery to discovery
- multiple delivery cards may share the same `sourceWorkItemId`

## Failure Handling

The system should fail explicitly, not silently, in these conditions:

- missing `jiraIssueKey` in PR body for adoption path
- ambiguous candidate delivery cards
- Slack thread creation failure
- missing default team bootstrap config

The system should self-heal or auto-create in these conditions:

- unknown GitHub user
- user missing `primary_team_id`

## Non-Goals

This design does not include:

- user merge workflows
- dashboard UI for ambiguity resolution
- Slack notifications for ambiguity conflicts
- automatic reconciliation of wrongly bound PR history across cards
- support for multiple PRs on one delivery card

## Implementation Direction

Implementation should proceed in these areas:

1. schema changes for `users`, `teams`, and `work_items`
2. startup bootstrap for default team
3. identity resolution helpers for GitHub login and fallback team routing
4. GitHub delivery adoption rewrite to support `0 / 1 / many` candidate branches
5. Slack thread bootstrap for newly created PR-first delivery cards
6. tests covering:
   - default team bootstrap
   - auto-created user path
   - unique PR identity
   - multiple delivery cards per Jira issue
   - ambiguity conflict logging
