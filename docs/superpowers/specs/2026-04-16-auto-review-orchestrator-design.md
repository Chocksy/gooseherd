# Auto Review Orchestrator Design

**Date:** 2026-04-16

## Goal

Add a dedicated orchestration layer for `feature_delivery.auto_review` so work items can trigger the correct side effects after state transitions, especially automatic run launch.

The first iteration only covers `feature_delivery` items in `auto_review`.

## Problem

The current codebase has:

- workflow state validation in code
- webhook-driven state changes for GitHub events
- run execution infrastructure

But it does not have a single layer that owns:

- deciding whether a work item should launch a run after a transition
- updating orchestration-oriented substates before launch
- writing successful auto-review outcomes back into work-item flags and substates
- preventing duplicate launches when active processing already exists

As a result, a PR-backed work item can enter `auto_review` and remain there without any linked run.

## Scope

Included in this design:

- a single orchestration entrypoint for `feature_delivery.auto_review`
- automatic run launch on selected `auto_review` entry conditions
- a canonical auto-review run task builder
- coarse `substate` usage for orchestration checkpoints between runs and external callbacks
- explicit post-run writeback for successful auto-review execution
- protection against duplicate launches when an active run already exists

Not included in this design:

- a generalized orchestration engine for all workflows
- new pipeline nodes for CI inspection, PR comment fetching, or self-review
- intent metadata such as `intentKind` or `triggerContext` persisted on runs
- special handling for `qa_preparation`
- special recovery orchestration for `ready_for_merge` beyond existing behavior
- PR `headSha` persistence on runs or work items in this iteration

## Core Decision

Use a coarse orchestration model:

- `WorkItem.state` remains the source of truth for business lifecycle
- `WorkItem.substate` stores only stable orchestration checkpoints between runs and external events
- `Run.status` and `Run.phase` remain the source of truth for in-flight execution details

This avoids duplicating the execution state machine inside `work_items.substate`.

## State Model

For this iteration, `feature_delivery.auto_review` uses the following coarse substates:

- `pr_adopted`
- `collecting_context`
- `waiting_ci`
- `applying_review_feedback`
- `revalidating_after_rebase`

Only two of these substates are auto-launch entrypoints in v1:

- `pr_adopted`
- `applying_review_feedback`

The others are waiting or in-flight checkpoints:

- `collecting_context`: a run has been launched for the first auto-review cycle
- `waiting_ci`: the item is waiting for GitHub CI callbacks
- `revalidating_after_rebase`: retained as an existing checkpoint, but not actively orchestrated in this iteration

## Orchestration Boundary

The system responsibilities are split as follows.

### Work Item

`work_item.state` and `work_item.substate` answer:

- where the item is in the business flow
- what the next high-level system action should be

### Run

`run.status` and `run.phase` answer:

- what the currently active execution is doing right now

Examples:

- `queued`
- `running`
- `validating`
- `pushing`
- `awaiting_ci`
- `ci_fixing`

### Task

`run.task` answers:

- what the agent should accomplish for this PR during the current run

### Pipeline

`run.pipelineHint` answers:

- which pipeline configuration to use
- in which order the technical stages execute
- how push and CI waiting are handled

The first iteration keeps the existing standard pipeline and does not introduce special-purpose auto-review pipeline nodes.

## Standard Auto-Review Run

All auto-launched runs in this design use one canonical launch profile.

### Launch Fields

`enqueueRun(...)` should receive:

- `repoSlug = workItem.repo`
- `baseBranch = config.defaultBaseBranch`
- `requestedBy = "work-item:auto-review"`
- `channelId = workItem.homeChannelId`
- `threadTs = workItem.homeThreadTs`
- `pipelineHint = "pipeline"`

After the run is created, it must be linked back to the work item through the existing run-to-work-item association.

This linkage must be persisted atomically with run creation. The design must not rely on a later best-effort `attachRunToWorkItem(...)` step after `enqueueRun(...)` has already returned.

### Task Template

The run task is built from a built-in template with variable substitution from the work item.

Template variables:

- `repo`
- `prNumber`
- `prUrl`
- `jiraIssueKey`
- `title`

The template instructs the agent to:

- collect current PR and work-item context
- inspect CI status and identify failing jobs
- review actionable PR comments from other reviewers and the author when relevant
- perform a self-review of the current diff
- apply minimal fixes for discovered problems
- validate and push when there are actual code changes
- avoid merging the PR

The template defines work priorities. The pipeline still owns technical execution order such as validation, push, and CI wait.

## Post-Run Writeback

Successful auto-review execution must write its result back into the work item. Launching runs without writeback would leave items stuck in `auto_review` because the existing policy also requires `self_review_done`.

### Successful Writeback Rule

When an auto-review run has successfully completed the agent/fix portion of the flow, it must write back:

- `flagsToAdd: ["self_review_done"]`
- `substate = "waiting_ci"`

The writeback point is:

- when the run transitions into `awaiting_ci`, or
- when the run completes successfully without requiring a new CI wait

This timing matters because GitHub CI success may arrive before the run reaches terminal status. The system cannot wait until a fully terminal callback to set `self_review_done`.

### Policy Re-Evaluation After Writeback

Immediately after setting `self_review_done`, the system must re-evaluate the existing feature-delivery policy for `auto_review`.

Rules:

- if `ci_green` is already present and there are no active auto-fixes, the item may advance to `engineering_review`
- otherwise the item remains in `auto_review` with `substate = waiting_ci`

This closes the ordering gap where CI may already be green before the run writes back `self_review_done`.

## Reconciler

Introduce a dedicated work-item reconciler for orchestration decisions.

Proposed interface:

```ts
reconcileWorkItem(workItemId: string, reason: string): Promise<void>
```

Responsibilities:

- acquire an atomic launch claim for the work item
- load the current work item state inside that claim
- exit unless `workflow === "feature_delivery"`
- exit unless `state === "auto_review"`
- exit if the item already has an active run
- determine whether the current `substate` requires auto-launch
- update the coarse `substate` when needed
- create a queued run already linked to the work item
- append an orchestration event
- queue the persisted run for execution after the transaction commits

### Atomic Launch Claim

The design requires an atomic mechanism that prevents duplicate run creation when two webhook paths reconcile the same work item concurrently.

A plain read-then-enqueue guard is not sufficient because run creation and run-to-work-item linking are currently separate operations.

Required behavior:

- only one reconciler may win the right to create an auto-review run for a given work item at a time
- losing reconcilers must observe the claimed or already-linked queued run and exit without launching another one

Required implementation shape:

- perform reconciliation inside a database transaction
- take a row-level claim on the work item, or use an equivalent compare-and-swap mechanism
- re-read the linked runs inside the transaction
- if launchable, persist the new queued run already linked via `runs.work_item_id`
- update `work_item.substate` in the same transaction
- append the `run.auto_launched` event in the same transaction
- only after commit, ask the run manager to process the persisted run

The implementation may split persistence from execution scheduling:

- transaction step: create queued run row linked to the work item
- post-commit step: `requeueExistingRun(runId)` or equivalent scheduling hook

### Active Processing Guard

Inside the launch claim, the reconciler must check whether the work item already has an active run.

Active run statuses:

- `queued`
- `running`
- `validating`
- `pushing`
- `awaiting_ci`
- `ci_fixing`

If any linked run is active, the reconciler must not launch another run.

## Trigger Rules

The reconciler is invoked after state-changing events that can affect `feature_delivery.auto_review`.

### PR Adopted Into Auto Review

Condition:

- item is in `feature_delivery.auto_review`
- `substate = pr_adopted`
- no active run exists

Action:

- update `substate` to `collecting_context`
- launch the standard auto-review run

### Review Changes Requested

Condition:

- a GitHub review callback moves the item back into `auto_review`
- the sync layer sets `substate = applying_review_feedback`
- no active run exists

Action:

- launch the standard auto-review run

### CI Failure While In Auto Review

Condition:

- a GitHub CI callback with `failure` or `timed_out` arrives for an item currently in `auto_review`
- the sync layer sets `substate = applying_review_feedback`
- no active run exists

Action:

- launch the standard auto-review run

### Waiting For CI

Condition:

- `substate = waiting_ci`

Action:

- do not launch a run
- wait for GitHub CI callbacks

### CI Success

Condition:

- GitHub CI callback reports success for an item in `auto_review`

Action:

- do not launch a run
- let the existing feature-delivery policy decide whether the item can move to `engineering_review`

## Freshness Rule For New Commits

This iteration does not persist PR `headSha`, so freshness must be enforced by a coarser rule.

### External Synchronize Reset

When GitHub delivers an external `pull_request.synchronize` event for a `feature_delivery` work item, the sync layer must clear stale auto-review completion state.

At minimum it must remove:

- `ci_green`
- `self_review_done`

This rule applies even when the item remains in `auto_review`.

Without this reset, a newly pushed commit could inherit an old self-review result and advance to `engineering_review` on the next green CI callback.

### Existing Review-Done Reset Rules

Existing review-done reset behavior remains in place:

- `engineering_review_done`
- `product_review_done`
- `qa_review_done`

Those flags continue to follow the current workflow-specific synchronize rules and environment gates. The new requirement in this design is that `self_review_done` must also be treated as stale on external new commits.

## Integration Points

The GitHub sync layer remains responsible for interpreting webhook payloads and updating work item state.

After updating the work item, the sync layer should invoke the reconciler when the outcome may require auto-launch.

The first iteration should wire reconciliation into these cases:

- PR adoption into `auto_review`
- CI failure or timeout while the item is in `auto_review`
- review `changes_requested` that returns the item to `auto_review`

The first iteration should also wire writeback and freshness handling into these cases:

- successful auto-review run reaches the `awaiting_ci` checkpoint
- successful auto-review run completes without needing a new CI wait
- external GitHub `pull_request.synchronize` on a delivery item

This keeps orchestration decisions centralized instead of spreading run launch logic across webhook handlers.

## Events

When the reconciler launches a run, it should append a dedicated work-item event.

Suggested event type:

- `run.auto_launched`

Suggested payload:

- `reason`
- `substate`
- `runId`

This event is for auditability and UI visibility. It does not replace the existing `run.attached` event.

## Testing

### Reconciler Tests

Add focused tests for the orchestration layer:

- launches a run for `auto_review + pr_adopted`
- changes `pr_adopted -> collecting_context` before launch
- does not launch when an active run already exists
- does not launch a duplicate run under concurrent reconcile attempts
- launches a run for `auto_review + applying_review_feedback`
- does nothing for non-`auto_review` states

### GitHub Sync Integration Tests

Extend webhook-driven tests to verify orchestration integration:

- PR adoption creates a linked run
- `changes_requested` review returns item to `auto_review` and launches a run when none is active
- CI `failure` or `timed_out` in `auto_review` launches a run when none is active
- external `synchronize` clears `self_review_done`

### Writeback Tests

Add focused tests for successful auto-review writeback:

- successful auto-review run adds `self_review_done`
- successful auto-review run sets `substate = waiting_ci`
- if `ci_green` is already present when `self_review_done` is written, the item advances to `engineering_review`

### Task Builder Tests

Add a small test for the task builder to verify variable substitution for:

- repo
- PR number and URL
- Jira key
- title

## Non-Goals And Follow-Ups

This design intentionally stops short of a full workflow engine.

Likely follow-up work:

- explicit run intent metadata
- orchestration support for `qa_preparation`
- richer recovery handling for `ready_for_merge`
- optional dedicated pipeline presets for auto-review stages
- rendering the auto-launch reason directly in the UI
