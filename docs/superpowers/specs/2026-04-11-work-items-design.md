# Work Items V1 Design

**Date:** 2026-04-11  
**Status:** Draft approved in conversation, written for review  
**Base branch for implementation:** `feat/kubernetes-runtime`

## Goal

Introduce a high-level `WorkItem` domain model above `Run`, with workflow-specific lifecycle/state, review coordination, and a Kanban board UI.

The first version should support two managed workflows:

- `product_discovery`
- `feature_delivery`

The design must remain extensible for future workflows such as:

- `bugfix_delivery`
- `incident_response`
- `bug_bounty_program`

## Why This Exists

Today Gooseherd is centered around `Run`, which is a single execution attempt. That works for ad-hoc Slack requests, but it does not model a full task lifecycle with:

- discovery and specification
- ownership by team
- multiple review participants
- QA preparation and validation
- PR-driven delivery state
- explicit managed flow distinct from casual conversation

`WorkItem` becomes the source of truth for managed work. `Run` remains the execution primitive underneath it.

## V1 Scope

Included in v1:

- first-class `WorkItem`
- workflow-specific state machine in code
- `Run` to `WorkItem` association
- first-class `ReviewRequest`
- team/user/role targeting for reviews
- Slack + Dashboard hybrid review UX
- Kanban board per workflow
- adoption of existing GitHub PRs into `feature_delivery`

Explicitly not included in v1:

- `Session` as a first-class product entity
- fully dynamic workflow definitions stored in DB/YAML/JSON
- configurable transition engines
- multi-PR delivery items
- post-merge validation as an active workflow state
- consensus review policies

## Domain Model

### WorkItem

`WorkItem` is the main managed-flow entity.

Core fields:

- `id`
- `workflow`: `product_discovery | feature_delivery`
- `state`
- `substate?`
- `flags[]`
- `title`
- `summary`
- `ownerTeamId`
- `homeChannelId`
- `homeThreadTs`
- `originChannelId?`
- `originThreadTs?`
- `jiraIssueKey?`
- `githubPrNumber?`
- `githubPrUrl?`
- `sourceWorkItemId?`
- `createdByUserId`
- `createdAt`
- `updatedAt`
- `completedAt?`

Rules:

- `feature_delivery` must always have `jiraIssueKey`
- `product_discovery` may exist without Jira until Jira creation time
- `product_discovery -> feature_delivery` is always `1:1` in v1
- `WorkItem` is always the source of truth for managed lifecycle

Display identifier rules:

- if `jiraIssueKey` exists, it is the primary identifier shown in UI and Slack
- otherwise show short `WorkItem ID`
- for `feature_delivery`, primary display identity is always `Jira key`

### Run

`Run` remains a single execution attempt.

Rules:

- a `Run` may exist without `WorkItem`
- if attached to managed flow, `Run` gets `workItemId`
- current run chain behavior remains valid:
  - `parentRunId`
  - `rootRunId`
  - `chainIndex`

This preserves today's Slack ad-hoc flow while allowing managed work to sit above it.

### ReviewRequest

`ReviewRequest` is a first-class review/approval entity associated with a `WorkItem`.

Core fields:

- `id`
- `workItemId`
- `reviewRound`
- `type`: `review | approval`
- `targetType`: `user | team | team_role | org_role`
- `targetRef`
- `status`: `pending | completed | cancelled | superseded`
- `outcome`: `approved | changes_requested | commented | no_response`
- `title`
- `requestMessage`
- `focusPoints[]`
- `requestedByUserId`
- `requestedAt`
- `resolvedAt?`

Rules:

- multiple review requests may be active in parallel
- team-targeted requests are satisfied by one responder in v1
- requests retain history even after cancellation/supersession

### ReviewRequestComment

Stores reviewer discussion and decision notes.

Core fields:

- `id`
- `reviewRequestId`
- `authorUserId`
- `source`: `slack | dashboard | system`
- `body`
- `createdAt`

### WorkItemEvent

Append-only audit/event log for state changes and external signal ingestion.

Representative event types:

- `work_item.created`
- `work_item.state_changed`
- `work_item.substate_changed`
- `work_item.flags_updated`
- `work_item.team_changed`
- `run.attached`
- `run.completed`
- `review_request.created`
- `review_request.completed`
- `review_request.comment_added`
- `jira.issue_created`
- `github.pr_linked`
- `github.ci_updated`
- `github.review_submitted`
- `github.label_observed`
- `slack.message_observed`
- `slack.action_observed`
- `override.requested`
- `override.applied`

### Identity And Ownership

#### User

Core fields:

- `id`
- `slackUserId`
- `githubLogin?`
- `jiraAccountId?`
- `displayName`
- `isActive`

#### Team

Core fields:

- `id`
- `name`
- `slackChannelId`

#### TeamMember

Links users to teams and captures functional role within a team.

Core fields:

- `teamId`
- `userId`
- `functionalRoles[]`

Examples of `functionalRoles`:

- `engineer`
- `qa`
- `pm`

#### OrgRoleAssignment

Captures cross-team organizational roles.

Examples:

- `cto`
- `devops`

This allows review targeting to work both inside and outside the owner team.

## Managed vs Unmanaged Work

The system has four conceptual layers:

- `Conversation`
- `WorkItem`
- `Run`
- future/internal `Session`

Rules for v1:

- ordinary PM questions remain plain conversation, without `WorkItem`
- `Discovery WorkItem` is created only:
  - by explicit PM intent such as "make spec" / "formalize task"
  - by Jira callback for issues marked for AI-managed flow
- `feature_delivery` starts only from:
  - completed `product_discovery`
  - Jira callback
  - GitHub PR adoption flow

No ad-hoc run is automatically promoted into managed delivery in v1.

## Slack Thread Model

Each `WorkItem` has one canonical Slack `home thread`.

Rules:

- if the origin thread is already in the correct team channel, `origin thread == home thread`
- otherwise the system creates a new `home thread` and links back to the origin thread
- review requests may notify users or teams elsewhere, but the `home thread` remains the canonical thread for the work item

## Home Channel Selection

`home channel` is derived from the selected owner team.

Rules:

- PM has access to one or more teams
- each team has a configured Slack channel
- when creating discovery:
  - if PM has one team, choose it automatically
  - if PM has multiple teams, prompt for team choice
- owner team may be changed only before `feature_delivery` is created
- changing owner team does not rewrite already-created review requests

## Workflow: product_discovery

### States

- `backlog`
- `in_progress`
- `waiting_for_review`
- `waiting_for_pm_confirmation`
- `done`
- `cancelled`

### Typical Substates

- `collecting_context`
- `drafting_spec`
- `creating_jira`
- `waiting_review_responses`
- `applying_review_feedback`
- `awaiting_pm_decision`

### Typical Flags

- `spec_draft_ready`
- `jira_created`
- `all_required_reviews_received`
- `pm_approved`
- `delivery_work_item_created`

### State Transitions

- `backlog -> in_progress`
  - explicit start of discovery work
- `in_progress -> waiting_for_review`
  - at least one required review request created
- `waiting_for_review -> in_progress`
  - any required request in the current review round resolves as `changes_requested`
- `waiting_for_review -> waiting_for_pm_confirmation`
  - all required requests in the current review round are completed without `changes_requested`
- `waiting_for_pm_confirmation -> in_progress`
  - PM asks for more changes
- `waiting_for_pm_confirmation -> done`
  - PM confirms final result
- any non-terminal state -> `cancelled`
  - only through guarded action

### Review Round Rules

Discovery review is round-based.

Rules:

- each transition into `waiting_for_review` creates a new `reviewRound`
- all requests in that round are evaluated together
- if one required request resolves as `changes_requested`:
  - `WorkItem` returns to `in_progress`
  - other `pending` requests from that same round become `superseded`
- if PM later sends the item back to `in_progress`, a future review pass must create a new round

This avoids mixing approvals from one draft with edits made after feedback.

### Completion Rule

`product_discovery.done` means:

- PM has confirmed the result
- Jira issue exists
- exactly one `feature_delivery` work item is created from it

## Workflow: feature_delivery

### States

- `backlog`
- `in_progress`
- `auto_review`
- `engineering_review`
- `qa_preparation`
- `product_review`
- `qa_review`
- `ready_for_merge`
- `done`
- `cancelled`

### Typical Substates

- `planning_implementation`
- `opening_pr`
- `waiting_ci`
- `running_self_review`
- `applying_review_feedback`
- `preparing_review_app`
- `applying_seed`
- `determining_e2e_scope`
- `writing_e2e`
- `running_e2e`
- `recording_demo`
- `waiting_merge`
- `rebasing`
- `resolving_conflicts`
- `revalidating_after_rebase`

### Typical Flags

- `pr_opened`
- `ci_green`
- `self_review_done`
- `engineering_review_done`
- `review_app_ready`
- `seed_applied`
- `e2e_required`
- `e2e_added`
- `e2e_passed`
- `artifacts_attached`
- `product_review_required`
- `product_review_done`
- `qa_review_done`
- `merged`

### State Transitions

- `backlog -> in_progress`
  - start implementation
- `in_progress -> auto_review`
  - PR opened or delivery reaches post-PR automation phase
- `auto_review -> engineering_review`
  - CI green, self-review complete, no active auto-fix work
- `engineering_review -> auto_review`
  - engineering review requests changes
- `engineering_review -> qa_preparation`
  - engineering review completed successfully
- `qa_preparation -> auto_review`
  - QA prep or E2E discovers a fix-worthy issue
- `qa_preparation -> product_review`
  - only when `product_review_required`
- `qa_preparation -> qa_review`
  - when product review is not required
- `product_review -> auto_review`
  - product review requests changes
- `product_review -> qa_review`
  - product review approved
- `qa_review -> auto_review`
  - QA requests changes
- `qa_review -> ready_for_merge`
  - QA approved
- `ready_for_merge -> auto_review`
  - branch stale, rebase required, conflicts appear, or post-rebase CI fails
- `ready_for_merge -> done`
  - PR merged
- any non-terminal state -> `cancelled`
  - only through guarded action

### Review Policy

Default v1 policy:

- `engineering_review` is always required
- `qa_review` is always required
- `product_review` is optional and enabled by `product_review_required`

### Approval Reset Policy

Whether approvals are invalidated by new commits is controlled by environment flags:

- `FEATURE_DELIVERY_RESET_ENGINEERING_REVIEW_ON_NEW_COMMITS=true|false`
- `FEATURE_DELIVERY_RESET_QA_REVIEW_ON_NEW_COMMITS=true|false`

These policies are required in v1, but they are implemented in code, not dynamically configured at runtime.

### Done Definition

For v1:

- `feature_delivery.done = PR merged`

Future versions may insert post-merge validation states before final `done`.

## Entry Paths Into feature_delivery

### 1. From product_discovery

When a discovery item is completed, it creates exactly one delivery item.

### 2. From Jira callback

If Jira issue is created or updated with the workflow-enabling label, Gooseherd may create a `feature_delivery` item directly.

### 3. PR adoption flow

If a developer opens a PR manually and marks it for AI-managed continuation, Gooseherd should adopt it.

Rules:

- GitHub webhook detects PR label such as `ai:assist`
- if no active delivery item exists for that PR:
  - parse Jira key from PR description
  - create `feature_delivery`
  - link existing PR
  - start from `auto_review`
- old approvals are not trusted automatically
- current PR/CI context is loaded as input context only

## Review UX

V1 review UX is hybrid.

### Slack

Used for:

- review notifications
- short summaries
- fast actions:
  - approve
  - request changes

### Dashboard / WorkItem View

Used for:

- full work item context
- spec or delivery summary
- review request details
- focus points
- comment history
- longer responses

Review requests are not simple notifications. They carry:

- `title`
- `requestMessage`
- `focusPoints[]`

## Board UX

The current run-focused dashboard remains and should be reframed as a runs screen, for example `Runs Dashboard`.

Separately, v1 introduces a Kanban board.

Rules:

- the board displays work items, not runs
- only one workflow/type is shown at a time
- columns depend on the selected workflow
- the board does not attempt to mix all workflows into one universal column set

## Event And Policy Model

### Source Of Truth

`WorkItem` is the only source of truth for managed state.

External systems do not own lifecycle state:

- GitHub labels are secondary
- GitHub reviews are external signals
- GitHub CI is an external signal
- Slack actions/messages are external signals
- Jira callbacks are external signals

### Event Processing Rule

Any external signal must first be recorded as a `WorkItemEvent`.  
Then workflow-specific policy code decides whether to change:

- `state`
- `substate`
- `flags`
- `review requests`

### What Usually Changes flags/substate Only

- CI started/passed/failed
- PR opened
- review app ready
- seed applied
- E2E required/added/passed
- observed GitHub labels
- branch stale / mergeability checks

### What Usually Changes Main state

- creation of required review requests
- review round completion
- PM confirmation
- progression from auto review into engineering review
- completion of QA preparation
- review outcomes
- PR merge
- guarded cancel/override

## Guarded Override

There is no unrestricted manual state transition in v1.

Instead, v1 supports `guarded override`.

Rules:

- active processing must be stopped first
- override is allowed only through a whitelist of valid transitions
- override must include actor and reason
- every override is logged as a `WorkItemEvent`

This preserves the state machine while still allowing operational recovery.

## Authorization Model

Identity is sourced from Slack/Jira/GitHub, but authorization is internal to Gooseherd.

V1 authorization may remain code-based rather than fully policy-driven.

Examples:

- who may create discovery items
- who may change owner team
- who may answer review requests
- who may apply guarded override

## Internal Implementation Shape

Transition rules and policies are part of v1, but are implemented in code rather than configurable data.

Suggested code shape:

- `work-items/product-discovery-policy.ts`
- `work-items/feature-delivery-policy.ts`
- `work-items/github-sync.ts`
- `work-items/slack-actions.ts`
- `work-items/jira-sync.ts`

This keeps v1 explicit and testable without prematurely building a generic process engine.

## Migration / Compatibility

The design must coexist with today's run-first model.

Compatibility rules:

- existing ad-hoc Slack `Run` flow keeps working without `WorkItem`
- managed flow uses `WorkItem`
- `Run` is still the primitive execution unit
- current run-chain semantics remain valid

## Future V2 Direction

Not in v1, but explicitly planned:

- `post_merge_validation` inserted after merge and before final `done`
- possible substates:
  - `waiting_stage_deploy`
  - `stage_check_running`
  - `waiting_prod_deploy`
  - `prod_check_running`
  - `feature_toggle_check_running`
- possible flags:
  - `stage_deployed`
  - `stage_checked`
  - `prod_deployed`
  - `prod_checked`
  - `feature_toggle_enabled`
- additional workflows:
  - `bugfix_delivery`
  - `incident_response`
  - `bug_bounty_program`
- possible internal/future `Session` concept as bounded orchestration cycle inside a work item

## Open Naming Decisions

Still intentionally flexible for implementation:

- exact GitHub/Jira labels such as `automation`, `ai:assist`, `ai:delivery`
- final human-facing board titles
- exact display wording for some substates and flags

These do not block the v1 architecture.
