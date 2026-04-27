# Work Item Run Visibility Design

## Goal

Show active run presence directly on `Work Item Board` cards and show linked runs in the work item detail panel, with links into the existing `Runs` dashboard.

## Scope

This change covers `feature_delivery` and `product_discovery` work items uniformly:

- add server-computed `activeRunCount` to work item list/detail payloads
- add a work-item-scoped runs endpoint for detail rendering
- show an active-run badge on board cards when `activeRunCount > 0`
- show linked runs in the detail panel with links to `#run/<short-id>`

This change does not change run orchestration or automatically enqueue runs.

## API Design

### Work Item Summary

Extend work item responses with:

- `activeRunCount: number`

Definition of active:

- `queued`
- `running`
- `validating`
- `pushing`
- `awaiting_ci`
- `ci_fixing`

### Work Item Runs Endpoint

Add:

- `GET /api/work-items/:id/runs`

Response shape:

- `runs: Array<{ id, status, phase, title, repoSlug, createdAt, startedAt, finishedAt }>`

The endpoint returns runs already linked via `runs.work_item_id`, ordered newest first.

## UI Design

### Board Card

When `activeRunCount > 0`, show a compact circular badge near the work item key/substate row.

Rules:

- hidden when count is `0`
- shows only the number
- uses subtle pulse styling instead of a GIF/spinner

### Detail Panel

Add a `Runs` section between `Review Requests` and `Events`.

Each run row shows:

- run title when present, otherwise short run id
- status chip
- repo / relative time metadata
- `Open run` link

The link switches the UI to `Runs` view and navigates to the selected run via hash.

Empty state:

- `No runs linked to this work item yet.`

## Server Responsibilities

- compute `activeRunCount` centrally in the dashboard work-item source
- expose linked runs through a dedicated route
- keep work item board rendering independent from raw run status logic on the client

## Testing

- dashboard route test for `GET /api/work-items/:id/runs`
- dashboard route test that `activeRunCount` is present and counts only active runs
- board HTML test for the new detail section and client fetch hook

