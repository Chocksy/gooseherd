# Work Item Run Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show active run counts on work item board cards and linked runs in the work item detail panel.

**Architecture:** Extend dashboard work-item responses with server-computed `activeRunCount`, add a dedicated work-item runs endpoint, then render a compact badge on cards and a linked run list in the board detail panel. Reuse existing `RunStore.listRunsForWorkItem(...)` and existing `Runs` dashboard hash routing.

**Tech Stack:** Node.js, TypeScript, dashboard HTML renderer, dashboard HTTP routes, node:test

---

### Task 1: Add failing dashboard route tests

**Files:**
- Modify: `tests/dashboard-work-items.test.ts`

- [ ] Add a test asserting `GET /api/work-items` returns `activeRunCount` and counts only active statuses.
- [ ] Add a test asserting `GET /api/work-items/:id/runs` returns linked runs newest first.
- [ ] Run targeted dashboard route tests and verify the new assertions fail first.

### Task 2: Add failing dashboard HTML test

**Files:**
- Modify: `tests/dashboard-board-ui.test.ts`

- [ ] Add assertions for the new `Runs` detail section container and `/api/work-items/:id/runs` fetch hook.
- [ ] Run the targeted HTML test and verify it fails first.

### Task 3: Implement server-side work item run data

**Files:**
- Modify: `src/dashboard-server.ts`
- Modify: `src/index.ts`
- Modify: `src/work-items/types.ts`

- [ ] Extend dashboard work item source contracts with `activeRunCount` on work items and a `listRunsForWorkItem(...)` method.
- [ ] Implement server-side active run counting using linked runs and the active-status set.
- [ ] Add `GET /api/work-items/:id/runs`.
- [ ] Re-run the dashboard route tests until they pass.

### Task 4: Implement board UI run indicators

**Files:**
- Modify: `src/dashboard/html.ts`

- [ ] Add card badge rendering for `activeRunCount > 0`.
- [ ] Add board detail state, fetch, and rendering for linked runs.
- [ ] Add `Open run` links that switch to `Runs` view and select the run by hash.
- [ ] Re-run the HTML test and any affected dashboard tests until they pass.

### Task 5: Verify the complete change

**Files:**
- No file changes required

- [ ] Run targeted test commands for dashboard routes and board HTML.
- [ ] Review the UI strings and empty states for clarity.
- [ ] Summarize outcomes and residual risks.
