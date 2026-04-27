# Auto Review CI Fix Substates Design

**Date:** 2026-04-20
**Status:** Approved for implementation
**Context:** Refines the active `feature_delivery.auto_review` orchestration so CI failures stop re-entering generic self-review and instead take an explicit CI-fix path.

## Goal

Keep `WorkItem.state = auto_review` as the business lifecycle state while making the next system action explicit through typed `substate` values.

The immediate outcome is:

- review-driven rework remains distinct from CI-driven rework
- GitHub `ci_failed` transitions no longer launch a generic auto-review run
- CI failures launch the existing `fix_ci` behavior instead of another self-review pass
- PR adoption no longer misses the case where the current PR head is already red before the AI label is added

## Problem

The current implementation uses `WorkItem.substate` as free-form text and treats `applying_review_feedback` as both:

- "a human requested changes"
- "GitHub CI failed"

That conflation causes the orchestrator to auto-launch the same canonical auto-review task for both situations. In practice, a CI failure currently triggers another self-review run rather than a CI-debugging run.

This is why the second run for PR `#6` in `vsevolod/openai_bot` produced a no-op self-review summary instead of attempting to fix failing CI.

## Design Summary

1. Add explicit code-level enums for work-item substates.
2. Keep `feature_delivery.state = auto_review` for CI failure recovery.
3. Introduce a dedicated `auto_review` substate `ci_failed`.
4. Reserve `applying_review_feedback` for review-driven rework only.
5. Change auto-review orchestration so `ci_failed` launches a CI-fix pipeline instead of the generic auto-review pipeline.

## Scope

Included in this design:

- code-level `substate` typing for work items
- explicit `feature_delivery.auto_review` substates
- `github.ci_failed` mapping to `auto_review/ci_failed`
- adoption-time inspection of the current PR head CI snapshot
- dedicated orchestration path from `ci_failed` to `fix_ci`
- standalone CI-fix pipeline entrypoint for work-item launched runs
- PR-branch reuse guarantees for work-item launched CI-fix runs
- tests covering state transitions and CI-fix launch behavior

Not included in this design:

- adding a new top-level `WorkItem.state`
- introducing PostgreSQL enum columns in this iteration
- persisting `intentKind` or `triggerContext`
- redesigning the whole feature-delivery workflow
- changing review/QA/product-review state semantics outside the `auto_review` entry paths

## State Model

### Top-Level State

`WorkItem.state` remains the business process state:

- `auto_review` still means "the system owns the next coding or validation action for this PR"

No new top-level state such as `ci_fixing` is introduced.

### Typed Substates

The first implementation should introduce explicit TypeScript unions for substates instead of raw free-form strings.

Recommended shape:

```ts
type ProductDiscoverySubstate =
  | "collecting_context"
  | "waiting_review_responses"
  | "awaiting_pm_decision"
  | "applying_review_feedback";

type FeatureDeliveryAutoReviewSubstate =
  | "pr_adopted"
  | "collecting_context"
  | "waiting_ci"
  | "applying_review_feedback"
  | "ci_failed"
  | "revalidating_after_rebase";

type FeatureDeliveryReviewSubstate =
  | "waiting_engineering_review"
  | "preparing_review_app"
  | "waiting_product_review"
  | "waiting_qa_review"
  | "waiting_merge"
  | "merged";

type WorkItemSubstate =
  | ProductDiscoverySubstate
  | FeatureDeliveryAutoReviewSubstate
  | FeatureDeliveryReviewSubstate;
```

This remains a code-level enum only. The database column stays `text` for now.

### First PR Boundary

The first implementation PR does not need full centralized validation across every workflow and state combination.

Minimum required implementation:

- add explicit typed constants and unions for `feature_delivery.auto_review` substates
- update the active code paths that read or write `auto_review` substates
- add targeted guard rails for the new `ci_failed` path

Full centralized validation of all `(workflow, state, substate)` pairs may follow in a later PR.

### Why Code Enum, Not DB Enum

The current `substate` column is shared across multiple workflows and multiple top-level states. A PostgreSQL enum would add migration cost without solving the more important problem: state-specific validation rules.

The system immediately needs:

- compile-time typing in code
- consistent semantics in orchestrator and webhook handlers

That is sufficient for this iteration and keeps the change focused.

## Canonical `auto_review` Substates

For `feature_delivery.state = auto_review`, the canonical substates become:

- `pr_adopted`
  Meaning: PR entered the AI flow and needs the first self-review cycle.
- `collecting_context`
  Meaning: a self-review run has been launched and is actively gathering context.
- `waiting_ci`
  Meaning: self-review work is done for the current cycle and the item is waiting for GitHub CI.
- `applying_review_feedback`
  Meaning: a human review requested changes and the next cycle is review-driven rework.
- `ci_failed`
  Meaning: GitHub CI failed for the current PR head and the next cycle must be CI-fix, not generic self-review.
- `revalidating_after_rebase`
  Meaning: recovery path from `ready_for_merge` after branch drift or CI failure on a revalidated branch.

## Transition Rules

### Entering `auto_review`

`auto_review` may be entered through multiple sources, but the substate must identify the reason:

- PR adoption with non-failed current CI -> `auto_review / pr_adopted`
- PR adoption with already failed current CI on the current PR head -> `auto_review / ci_failed`
- engineering/product/QA `changes_requested` -> `auto_review / applying_review_feedback`
- CI failure while already in `auto_review` -> `auto_review / ci_failed`
- `ready_for_merge` recovery after failed revalidation -> `auto_review / revalidating_after_rebase`

### Adoption With Existing Failed CI

When a PR is adopted into the AI flow, the system must not assume the next step is a generic self-review.

Required behavior:

- inspect the current PR head SHA during adoption
- inspect the current CI snapshot for that head
- if the current head already has failed CI, set `state = auto_review` and `substate = ci_failed`
- otherwise keep the existing adoption behavior and set `substate = pr_adopted`

This closes the gap where `ai:assist` is added after CI has already gone red and no fresh `check_suite` failure webhook is guaranteed to arrive afterward.

### Adoption-Time CI Snapshot Boundary

This rule is about control-plane routing, not about the standalone `fix_ci` node bootstrap.

Acceptable first-iteration behavior:

- parse the current PR head SHA from the `pull_request` webhook payload or equivalent PR metadata already available during adoption
- use the existing GitHub CI snapshot query capability to inspect the current head before choosing the initial `auto_review` substate
- if the snapshot cannot be determined because GitHub data is temporarily unavailable, fail open to `pr_adopted` rather than blocking adoption entirely

This design does not require persisting head SHA on the work item in this iteration.

### CI Success

When CI succeeds for an item in `auto_review`:

- preserve the existing policy
- if `self_review_done` is already present, the item may advance to `engineering_review`
- otherwise keep the item in `auto_review / waiting_ci`

This design does not change the current `ci_green + self_review_done` rule.

### CI Failure

When GitHub reports failed CI for an item currently in `auto_review`:

- keep `state = auto_review`
- set `substate = ci_failed`
- remove `ci_green`
- reconcile the work item

This replaces the current behavior that writes `applying_review_feedback` on CI failure.

### Review Changes Requested

When GitHub review events move an item back into `auto_review`:

- keep using `substate = applying_review_feedback`
- do not map these review callbacks to `ci_failed`

This is the key semantic split in the design.

## Orchestrator Behavior

The reconciler must stop treating all `auto_review` entrypoints the same.

### Launchable Entry Substates

The orchestrator should consider these `auto_review` substates launchable:

- `pr_adopted`
- `applying_review_feedback`
- `ci_failed`

### Launch Routing

Routing must be substate-specific:

- `pr_adopted` -> launch standard auto-review run
- `applying_review_feedback` -> launch standard auto-review run
- `ci_failed` -> launch standalone CI-fix run

`collecting_context`, `waiting_ci`, and `revalidating_after_rebase` remain non-launchable waiting or in-flight checkpoints in this iteration.

### In-Flight Substate Update

For standard auto-review launches:

- `pr_adopted` should still become `collecting_context` before the run is queued

For CI-fix launches:

- the work item should remain in `auto_review / ci_failed` while the run is active
- `Run.status` and `Run.phase` remain the source of truth for in-flight execution details

This avoids inventing another transient substate only for CI-fix execution.

### Run Identity

CI-fix runs should not masquerade as standard auto-review runs.

Required shape:

- standard self-review runs keep `requestedBy = "work-item:auto-review"`
- CI-fix runs use `requestedBy = "work-item:ci-fix"`

The active-processing guard must treat both run kinds as launch blockers for the same work item.

### Branch Reuse

A work-item launched CI-fix run must reuse the existing PR head branch.

Required behavior:

- `run.branchName` must resolve to `WorkItem.githubPrHeadBranch`
- `run.parentBranchName` must resolve to `WorkItem.githubPrHeadBranch` when the persisted run model uses branch reuse semantics
- the run must not create a new PR branch
- the run must not create a new PR

This is mandatory for `ci_failed`, because the goal is to repair CI on the current PR, not fork the work onto a new branch.

## Pipeline Design

### Standard Auto-Review Pipeline

The existing `pipeline` remains the entrypoint for:

- `pr_adopted`
- `applying_review_feedback`

This path keeps the current self-review behavior.

### New CI-Fix Pipeline

Add a dedicated built-in pipeline `pipelines/ci-fix.yml` that starts directly with CI-fix semantics.

Required shape:

```yaml
version: 1
name: "ci-fix"
description: "Standalone CI-fix pipeline for work-item launched CI recovery"

context:
  max_ci_fix_rounds: 1

nodes:
  - id: clone
    type: deterministic
    action: clone

  - id: setup_sandbox
    type: deterministic
    action: setup_sandbox
    if: "config.sandboxEnabled"

  - id: classify_task
    type: deterministic
    action: classify_task

  - id: hydrate
    type: deterministic
    action: hydrate_context

  - id: fix_ci
    type: agentic
    action: fix_ci

  - id: wait_ci
    type: async
    action: wait_ci
    on_failure:
      action: loop
      agent_node: fix_ci
      max_rounds: 1
      on_exhausted: fail_run

  - id: notify
    type: deterministic
    action: notify
```

Behavior:

- `fix_ci` runs first, using CI failure context from prefetched GitHub data
- if it pushes a fix, `wait_ci` waits on the new commit
- if CI passes, the work item returns to the normal `auto_review / waiting_ci` checkpoint and the CI-fix writeback path refreshes `self_review_done`
- if CI remains red after the configured retry loop, the run fails rather than completing with warnings

## `fix_ci` Adaptation

The current `fix_ci` node exists, but it assumes it is entered from the `wait_ci` loop inside the standard pipeline. That is not enough for work-item-driven CI-fix runs.

### Required Changes

1. `fix_ci` must be usable as a standalone first-class pipeline node.
2. If `ctx.ciAnnotations` is absent, derive it from `run.prefetchContext.github.ci.failedAnnotations`.
3. If `ctx.ciLogTail` is absent, treat it as optional in this iteration.
4. If the agent makes no changes in CI-fix mode, the node must return `failure`, not `success`.

### CI Context Boundary

The current `RunPrefetchContext.github.ci` includes:

- `headSha`
- `conclusion`
- `failedRuns`
- `failedAnnotations`

It does not include a failed log tail.

Therefore:

- standalone `fix_ci` may derive annotations from prefetched CI data
- standalone `fix_ci` may use failed run names from prefetched CI data
- standalone `fix_ci` must not invent `ciLogTail`
- standalone `fix_ci` must not require a fresh GitHub fetch just to function in the first iteration

If the prefetch model later grows a `failedLogTail` field, `fix_ci` may consume it, but that is out of scope for this patch.

### Why No-Op Must Fail

Today `fix_ci` returns success on "agent made no changes". That is acceptable inside some loop contexts, but wrong for a standalone CI-fix run.

If standalone `fix_ci` returns success without a new commit:

- `wait_ci` will see no `commitSha`
- the run will appear successful without actually addressing CI

This design explicitly disallows that behavior.

## Post-Run Writeback

CI-fix runs are a different launch path, but they still represent successful system-owned work on the PR branch.

### Required Writeback Rule

When a `work-item:ci-fix` run successfully reaches `awaiting_ci` or completes without further waiting:

- set `substate = waiting_ci`
- ensure `self_review_done` is present for the latest pushed branch state

This mirrors the existing writeback contract for standard auto-review runs, but it must not depend on `requestedBy = "work-item:auto-review"` anymore.

### Hard Requirement On Checkpoint Detection

`writebackWorkItem(...)` must treat both requester values as successful system-owned checkpoints:

```ts
const WORK_ITEM_SYSTEM_RUN_REQUESTERS = new Set([
  "work-item:auto-review",
  "work-item:ci-fix",
]);

function isSuccessfulWorkItemCheckpoint(run: { status: string; requestedBy: string }): boolean {
  return (
    WORK_ITEM_SYSTEM_RUN_REQUESTERS.has(run.requestedBy) &&
    (run.status === "awaiting_ci" || run.status === "completed")
  );
}
```

The final implementation does not need to use this exact helper name, but it must implement this exact behavior.

### Why `self_review_done` Must Be Refreshed

A CI-fix run may push a new commit. After that push, the prior `self_review_done` flag is stale unless the successful CI-fix path explicitly renews it for the new branch state.

Without this refresh:

- the item may remain stuck in `auto_review / waiting_ci`, or
- a later green CI callback may still be reasoning over stale flag semantics

The writeback should therefore treat a successful CI-fix run as the latest successful system-owned review/fix checkpoint for that branch state.

## Task / Prompt Semantics

Two different run tasks now exist operationally:

### Standard Auto-Review Task

Used for:

- `pr_adopted`
- `applying_review_feedback`

Intent:

- inspect the diff
- review relevant comments
- perform self-review
- make minimal code fixes when warranted

### CI-Fix Task

Used for:

- `ci_failed`

Intent:

- inspect failed GitHub checks
- use failed annotations and failed run names as primary evidence
- use failed log tail when available, but do not require it in this iteration
- identify the concrete CI failure
- apply the smallest code change required to make CI pass

The CI-fix task should not be framed as another generic self-review pass.

## Active-Run Guard

The reconciler must refuse duplicate launches when the work item already has an active system-owned run.

Hard requirement:

- if a work item already has an active `work-item:auto-review` run, do not launch another one
- if a work item already has an active `work-item:ci-fix` run, do not launch another one

Active statuses remain:

- `queued`
- `running`
- `validating`
- `pushing`
- `awaiting_ci`
- `ci_fixing`

The implementation should use a shared predicate rather than separate ad hoc checks for the two requester values.

## Validation Strategy

For the first PR, do not block delivery on full centralized validation of every `(workflow, state, substate)` combination.

Minimum required typing for this patch:

```ts
export const FEATURE_DELIVERY_AUTO_REVIEW_SUBSTATES = [
  "pr_adopted",
  "collecting_context",
  "waiting_ci",
  "applying_review_feedback",
  "ci_failed",
  "revalidating_after_rebase",
] as const;

export type FeatureDeliveryAutoReviewSubstate =
  typeof FEATURE_DELIVERY_AUTO_REVIEW_SUBSTATES[number];
```

This gives the first PR enough structure to implement the new CI-fix path without spending time normalizing every historical fixture.

## Backward Compatibility

This design intentionally preserves:

- top-level `WorkItem.state` values
- the existing `ci_green + self_review_done -> engineering_review` rule
- the existing `fix_ci` node implementation concept
- existing run phases such as `awaiting_ci` and `ci_fixing`

This design intentionally changes:

- CI failure no longer maps to `applying_review_feedback`
- `ci_failed` becomes a first-class `auto_review` substate
- `ci_failed` launches CI-fix instead of standard self-review
- PR adoption may now choose `ci_failed` instead of `pr_adopted` when the current head is already red

## Testing Requirements

Implementation must cover at least:

1. `github.ci_failed` on `auto_review` writes `substate = ci_failed`.
2. PR adoption with already failed current CI writes `substate = ci_failed`.
3. review `changes_requested` still writes `substate = applying_review_feedback`.
4. orchestrator launches standard auto-review runs for `pr_adopted`.
5. orchestrator launches standard auto-review runs for `applying_review_feedback`.
6. orchestrator launches CI-fix runs for `ci_failed`.
7. CI-fix runs reuse the existing PR head branch and do not create a new PR.
8. standalone `fix_ci` can build its prompt from prefetched CI annotations and failed run names.
9. standalone `fix_ci` treats missing `ciLogTail` as optional.
10. standalone `fix_ci` fails on no-op.
11. `writebackWorkItem(...)` treats both `work-item:auto-review` and `work-item:ci-fix` as successful checkpoints.
12. active-run guard blocks duplicate launches for both requester types.

## Non-Goals

- adding head SHA persistence in this patch
- changing review reset flags on synchronize
- redesigning `ready_for_merge` recovery
- introducing a new domain entity for run intent
- database enum migration for `substate`

## Relationship To Existing Designs

This document narrows and activates one part of earlier deferred run-intent thinking:

- keep `auto_review` as the business state
- distinguish CI-driven rework from review-driven rework
- route CI failure into a CI-fix behavior instead of generic rework

It supersedes the current active assumption from [2026-04-16-auto-review-orchestrator-design.md](./2026-04-16-auto-review-orchestrator-design.md) that only `pr_adopted` and `applying_review_feedback` are launchable `auto_review` entrypoints.
