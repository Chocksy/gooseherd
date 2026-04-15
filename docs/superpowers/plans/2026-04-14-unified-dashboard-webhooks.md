# Unified Dashboard Webhooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve observer webhook routes from the dashboard HTTP server so Gooseherd can run behind one public port.

**Architecture:** Keep webhook logic inside the observer module, but expose it as a reusable HTTP handler. The dashboard server delegates `/webhooks/*` before auth, and the observer daemon only starts a dedicated webhook listener when the dashboard server is unavailable.

**Tech Stack:** Node HTTP server, TypeScript, node:test

---

### Task 1: Add failing auth and routing tests

**Files:**
- Modify: `tests/phase12.test.ts`
- Modify: `tests/dashboard-auth-routes.test.ts`

- [ ] Add a failing auth test proving `/webhooks/github` bypasses dashboard auth.
- [ ] Add a failing dashboard-server test proving webhook requests can be served on `DASHBOARD_PORT`.
- [ ] Run the targeted tests and confirm failure matches the missing unified-routing behavior.

### Task 2: Reuse webhook routing from the dashboard server

**Files:**
- Modify: `src/observer/webhook-server.ts`
- Modify: `src/dashboard-server.ts`
- Modify: `src/dashboard/auth.ts`

- [ ] Export a reusable webhook request handler from `src/observer/webhook-server.ts`.
- [ ] Wire dashboard routing so `/webhooks/*` is delegated before `checkAuth()`.
- [ ] Keep `/api/*` and dashboard HTML auth behavior unchanged.
- [ ] Run the targeted tests and confirm they pass.

### Task 3: Remove the extra listener when dashboard is enabled

**Files:**
- Modify: `src/observer/daemon.ts`
- Modify: `tests/phase13.test.ts`

- [ ] Add a failing test proving `ObserverDaemon.start()` does not bind `OBSERVER_WEBHOOK_PORT` when `dashboardEnabled=true`.
- [ ] Update `ObserverDaemon` startup logic to skip the dedicated webhook listener in dashboard mode while preserving standalone webhook mode.
- [ ] Run the targeted tests and confirm they pass.

### Task 4: Tighten docs and local verification

**Files:**
- Modify: `README.md`
- Modify: `kubernetes/local/gooseherd-service.yaml`
- Modify: `tests/kubernetes-local-manifests.test.ts`

- [ ] Update local deployment docs to use a single public port for dashboard and webhook traffic.
- [ ] Update the local service manifest if the second public service port is no longer needed.
- [ ] Run the relevant tests and a final targeted suite.
