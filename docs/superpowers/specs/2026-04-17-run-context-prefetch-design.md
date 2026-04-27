# Run Context Prefetch Design

## Goal

Add control-plane prefetch for runs linked to a work item so prompts receive current PR, CI, and Jira context before execution starts, regardless of runtime.

## Scope

This design applies to all runs with a non-empty `workItemId`.

v1 scope is runtime-agnostic:

- `kubernetes` runs must receive prefetched context through runner payload
- `local` and `docker` runs must receive the same prefetched context before pipeline execution starts

Prefetch behavior is conditional on linked external artifacts:

- If the work item has a GitHub PR, collect PR context.
- If the work item has a Jira issue key, collect Jira context.
- If neither exists, the run proceeds without prefetched external context.

## Core Rules

### Trigger

Prefetch runs for every run whose `workItemId` is set.

### Source-specific collection

If a PR exists for the work item, collect:

- PR description
- PR discussion comments
- PR review summaries
- Unresolved inline review comments / unresolved review threads only
- CI snapshot for the PR head SHA

If a Jira issue exists for the work item, collect:

- Jira description
- Jira comments

### Fail-closed policy

Prefetch is fail-closed only for sources that exist.

- If a PR exists and GitHub prefetch fails, the run must fail before runtime execution starts.
- If a Jira issue exists and Jira prefetch fails, the run must fail before runtime execution starts.
- If PR does not exist, GitHub prefetch is skipped and this is not an error.
- If Jira issue does not exist, Jira prefetch is skipped and this is not an error.

### Fresh snapshot per run

Each run performs a fresh prefetch from external systems.

- Do not reuse prefetched data from prior runs in the same work item as the source of truth.
- Store each run's snapshot in persistent run execution state, and mirror it into runner payloads where that runtime uses payload envelopes.
- Do not add cross-run caching in v1.

## Architecture

Use a dedicated control-plane service, `RunContextPrefetcher`, invoked by the control plane before backend dispatch.

The service is responsible for:

- resolving the work item linked to the run
- determining which external sources exist
- fetching and normalizing data from GitHub and Jira
- enforcing source-aware fail-closed behavior
- returning a compact normalized snapshot that becomes part of persisted run execution state and, for Kubernetes, part of the runner payload

This keeps runtime backends thin and avoids burying prefetch orchestration inside `kubernetes-backend.ts`.

## Proposed Components

### New service

Add `src/runtime/run-context-prefetcher.ts`.

Responsibilities:

- input: `run`
- load linked work item
- inspect whether GitHub PR and Jira issue are present
- fetch source-specific context
- normalize output into a stable payload shape
- throw typed errors when an existing required source cannot be fetched

### GitHub integration expansion

Extend `src/github.ts` with methods for:

- PR details
- PR discussion comments
- PR reviews
- unresolved inline review comments / unresolved review threads
- CI status for PR head SHA
- failed check runs only
- annotations for failed check runs only

The prefetcher should call `GitHubService` methods instead of using raw Octokit from multiple places.

### Jira integration

Add a small Jira client, preferably `src/jira.ts` or `src/work-items/jira-client.ts`.

Methods needed:

- fetch issue details / description
- fetch issue comments

The client should use the existing Jira configuration already present in app config.

### Payload integration

Keep existing payload fields unchanged and add a new top-level field:

```ts
payloadJson: {
  run: { ...existingRunFields },
  runnerConfig?: { ...existingRunnerConfig },
  prefetch?: { ...normalizedPrefetchContext }
}
```

Runner logic should remain simple: it consumes already prepared context and does not perform source discovery itself.

### Run record integration

Because `local` and `docker` backends do not use runner payload envelopes, prefetched context must also exist on the control-plane side as part of run execution state.

v1 should add a persisted run-level snapshot field, for example `prefetchContext`, to `RunRecord` storage.

That persisted snapshot becomes the single runtime-agnostic source used by:

- `local` / `docker` pipeline execution
- `kubernetes` envelope creation
- failure handling and audit trails

## Payload Shape

The v1 payload shape should be compact and explicit.

```ts
prefetch: {
  meta: {
    fetchedAt: string;
    sources: Array<"github_pr" | "github_ci" | "jira">;
  };
  workItem: {
    id: string;
    title: string;
    workflow: string;
    state?: string;
    jiraIssueKey?: string;
    githubPrUrl?: string;
    githubPrNumber?: number;
  };
  github?: {
    pr: {
      number: number;
      url: string;
      title: string;
      body: string;
      state: string;
      baseRef?: string;
      headRef?: string;
      headSha?: string;
      authorLogin?: string;
    };
    discussionComments: Array<{
      id: string;
      authorLogin?: string;
      createdAt?: string;
      body: string;
      url?: string;
    }>;
    reviews: Array<{
      id: string;
      authorLogin?: string;
      createdAt?: string;
      state?: string;
      body: string;
      url?: string;
    }>;
    reviewComments: Array<{
      id: string;
      authorLogin?: string;
      createdAt?: string;
      body: string;
      path?: string;
      line?: number;
      side?: string;
      url?: string;
      threadResolved: false;
    }>;
    ci: {
      headSha?: string;
      conclusion: "success" | "failure" | "pending" | "no_ci";
      failedRuns?: Array<{
        id: number;
        name: string;
        status: string;
        conclusion: string | null;
        detailsUrl?: string;
        startedAt?: string;
        completedAt?: string;
      }>;
      failedAnnotations?: Array<{
        checkRunName: string;
        path: string;
        line: number;
        message: string;
        level: string;
      }>;
    };
  };
  jira?: {
    issue: {
      key: string;
      url?: string;
      summary?: string;
      status?: string;
      description: string;
    };
    comments: Array<{
      id: string;
      authorDisplayName?: string;
      createdAt?: string;
      body: string;
    }>;
  };
}
```

## CI Data Rules

CI payload should stay intentionally small.

- If there are failed runs:
  - include failed runs only
  - include annotations for failed runs only
- If there are no failed runs:
  - include only `headSha` and aggregate `conclusion`
- Do not include full job logs in v1.
- Do not include complete step-by-step workflow traces in v1.

## Comment Collection Rules

### GitHub PR comments

Collect all human discussion from the PR in these categories:

- PR discussion comments
- review summaries
- unresolved inline review comments only

Do not collect resolved inline review threads in v1.

Do not collapse these categories into one array in storage. Keep them separate so prompt rendering can remain structured and predictable.

### Jira comments

Collect Jira issue comments in chronological order.

## Prompt Injection

Update `src/pipeline/nodes/hydrate-context.ts` to render prefetched context into explicit prompt sections when present:

- `## Work Item Context`
- `## PR Description`
- `## PR Discussion Comments`
- `## PR Review Summaries`
- `## PR Unresolved Inline Review Comments`
- `## CI Snapshot`
- `## Jira Description`
- `## Jira Comments`

Guidelines:

- render readable summaries, not raw JSON
- preserve source boundaries
- preserve chronological order where it matters
- show empty sections only when they add signal; otherwise omit them

## Data Path To Pipeline Nodes

The prefetched snapshot must have an explicit path from control plane to `hydrate_context`.

v1 data flow:

1. `RunManager` resolves the run and invokes `RunContextPrefetcher` before dispatching to a runtime backend.
2. On success, `RunManager` persists the normalized snapshot on the run record as `prefetchContext`.
3. For `kubernetes` runs, the backend mirrors `prefetchContext` into `payloadJson.prefetch` when creating the runner envelope.
4. For all runtimes, `PipelineEngine` seeds `ContextBag` with the prefetched snapshot, for example under `prefetchContext`.
5. `hydrate_context` reads the snapshot from `ContextBag`, not from the raw runner envelope.

This avoids coupling pipeline nodes to runner payload mechanics and makes prompt enrichment work consistently across `local`, `docker`, and `kubernetes`.

## Size Limits And Trimming

External text must be trimmed before payload storage and before prompt rendering.

v1 limits:

- trim each description/comment body to at most 2000 characters
- keep comments ordered oldest to newest
- keep at most the latest 12 comments per rendered prompt section
- keep at most the latest 50 failed annotations in rendered prompt output
- if a section is trimmed, include a note such as `Fetched 37 comments; showing latest 12`
- unresolved inline comments should be preferred over resolved review noise by filtering resolved threads out before trimming

## Failure Model

### Valid empty results

These are valid and must not fail a run:

- PR exists but has no discussion comments
- PR exists but has no unresolved review comments
- PR exists but CI has no failed runs
- Jira issue exists but has no comments

### Invalid results

These must fail the run when the relevant source exists:

- PR exists but PR details cannot be fetched
- PR exists but comment fetch fails
- PR exists but CI snapshot fetch fails
- Jira issue exists but issue details cannot be fetched
- Jira issue exists but comment fetch fails

The failure should happen before runtime execution begins so no backend starts with incomplete required context.

## Work Item State Recovery

Auto-review work items must not get stuck in `collecting_context` when prefetch fails before job start.

v1 rule:

- if the run was auto-launched from `pr_adopted`, a prefetch failure may restore the work item substate back to `pr_adopted`
- if the run was auto-launched from `applying_review_feedback`, a prefetch failure may restore the work item substate back to `applying_review_feedback`
- the run should still be recorded as failed with a clear prefetch-specific error
- the work item recovery must happen automatically as part of the same control-plane failure path

To support deterministic rollback, the orchestrator must persist the source auto-review substate on the run record when launching the run, for example as `autoReviewSourceSubstate`.

Rollback must use compare-and-swap semantics.

Rollback is allowed only when all of these conditions hold:

- the work item is still in `state=auto_review`
- the work item is still in `substate=collecting_context`
- the failed run is still the latest relevant auto-review launch for that work item
- no newer work-item transition or newer linked auto-review run has superseded this launch

If any of those checks fail, the control plane must leave the work item untouched and only mark the run failed.

This prevents prefetch failure recovery from overwriting fresher transitions such as GitHub webhook-driven moves to `waiting_ci`.

v1 does not rely on relaunching directly from `collecting_context`.

## Integration Point

The prefetch call belongs in control-plane run dispatch, not in a runtime-specific backend.

Execution order:

1. load the latest run record
2. resolve linked work item context
3. call `RunContextPrefetcher`
4. if successful, persist `prefetchContext` on the run record
5. if required fetch fails, fail the run before backend execution and trigger work-item rollback when applicable
6. dispatch to the selected runtime backend
7. for `kubernetes`, include `prefetchContext` in `payloadJson.prefetch` during envelope creation
8. for all runtimes, ensure `PipelineEngine` exposes the snapshot to pipeline nodes through `ContextBag`

This keeps behavior consistent across supported runtimes and removes the spec contradiction between scope and integration point.

## Auto-Review Task Simplification

Once control-plane prefetch is in place, the auto-review task prompt should stop telling the agent to gather context that the control plane already provides.

Update `src/work-items/auto-review-task.ts` to remove these task steps:

- `Collect current PR/work-item context before changing code.`
- `Inspect CI and identify failing jobs or other active signals that matter for the self-review.`

The task should continue to instruct the agent to:

- review actionable PR comments
- perform self-review of the diff and branch state
- apply minimal fixes
- validate and push when needed
- avoid merging the PR

## Testing Strategy

Add unit tests for:

- trigger behavior based on `workItemId`
- source detection for PR present / Jira present / both / neither
- fail-closed behavior per source
- fresh snapshot behavior per run
- propagation from persisted `prefetchContext` into `ContextBag`
- payload normalization
- unresolved-only filtering for inline review comments
- CI compacting logic for failed-only runs and annotations
- prompt rendering from prefetched context
- rollback from `collecting_context` to `pr_adopted` on prefetch failure
- rollback from `collecting_context` to `applying_review_feedback` on prefetch failure
- auto-review task no longer instructs the agent to collect PR/work-item context or inspect CI

Add integration coverage for:

- run dispatch aborts before backend execution on required prefetch failure
- successful prefetch is persisted on the run and embedded in Kubernetes envelope payload
- runner prompt contains structured prefetched sections

## Non-Goals For v1

- cross-run caching
- full GitHub Actions log ingestion
- artifact ingestion from CI
- resolved review thread history
- generic source plugin architecture

## Open Decisions Resolved In This Spec

- use dedicated `RunContextPrefetcher` service instead of embedding prefetch logic directly in backend
- prefetch runs for every run with `workItemId`
- PR collection is conditional on PR existence
- Jira collection is conditional on Jira issue existence
- fail-closed applies only to sources that exist
- CI payload includes failed runs and failed annotations only when failures exist
- GitHub discussion comments are included
- inline review comments are included only when unresolved
- every run gets a fresh external snapshot
