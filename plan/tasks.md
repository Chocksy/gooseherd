# Gooseherd — Implementation Tasks

> Generated from 13-agent gap analysis across all docs/ research.
> Each task includes severity, source docs, and codex verification status.
> Completed tasks are removed — git history has the full original list (35 remaining).

---

## Document Reference Map

| Doc | Type | Notes |
|-----|------|-------|
| `docs/architecture.md` | Living reference | Stale in places — needs update |
| `docs/bulletproof_system_architecture_2026-02-21.md` | Vision (authoritative) | Most complete spec, 15 unimplemented features |
| `docs/hubble_expansion_research_2026-02-18.md` | Research | CEMS/memory gaps, feedback loop, deployment |
| `docs/hubble_system_blueprint_2026-02-17.md` | Research (descoped) | Enterprise blueprint, deliberately simplified |
| `docs/installation-tiers-research-2026-02-21.md` | Research | Adoption blockers, config, DX |
| `docs/minion_system_research_2026-02-17.md` | Research (oldest) | License analysis, runner substrate decision |
| `docs/minions_v2_deep_research_2026-02-20.md` | Research | Priority tracking, 2 of 6 still open |
| `docs/observer_system_research_2026-02-20.md` | Research | Most detailed gap list, phases 4-5 incomplete |
| `docs/slack-ux-issues.md` | Issue tracker | 4 open issues |
| `docs/findings_original_mvp.md` | Historical | MVP decisions, tech debt noted |
| `docs/progress_original_mvp.md` | Historical | No actionable items |
| `docs/task_plan_original_mvp.md` | Historical | Definition of Done still valid |

---

## ~~CRITICAL — The Agent Is Blind and Dumb~~ DONE

All 3 critical tasks completed. Agent now has codebase context, task-type-specific prompts, and output analysis with garbage detection.

---

## ~~HIGH — Core Features Are Stubs or Dead Code~~ MOSTLY DONE

~~Task 4~~, ~~Task 5~~, ~~Task 6~~, ~~Task 8~~, ~~Task 9~~, ~~Task 11~~ — all completed (Phases 8-9).

~~Remaining HIGH: Task 7 (Slack channel adapter), Task 10 (screenshots).~~ **ALL DONE**

---

### ~~Task 7: Wire Slack Channel Adapter to Bolt~~ DONE
### ~~Task 8: Multi-MCP Extension Support~~ DONE
### ~~Task 9: Enable CI Feedback in Default Pipeline~~ DONE
### ~~Task 10: Visual Screenshot/Preview Step in Slack~~ DONE

---

### ~~Task 11: "Awaiting Instructions" Idle State in Slack~~ DONE

---

## ~~MEDIUM-HIGH — Adoption Blockers and Missing Polish~~ ALL DONE

~~Task 12~~ (DRY_RUN default), ~~Task 13~~ (agent default detection), ~~Task 14~~ (dashboard URL), ~~Task 15~~ (error classifier), ~~Task 16~~ (enriched memory), ~~Task 17~~ (CEMS team ID), ~~Task 18~~ (follow-up diffs) — all completed (Phases 8-9).

---

## MEDIUM — Missing Features From Vision Docs

### ~~Task 19: Plan Task Node (LLM Planning Before Implementation)~~ DONE
### ~~Task 20: Local Test Node (Run Tests Before Push)~~ DONE

---

### ~~Task 21: Observer Learning Loop (Phase 5)~~ DONE

---

### ~~Task 22: Observer Threshold Configuration~~ DONE

---

### ~~Task 23: GitHub Observer — Actions API Polling~~ DONE

---

### ~~Task 24: Sentry Webhook Receiver~~ DONE

---

### ~~Task 25: Config Hot-Reload~~ DONE

---

### ~~Task 26: Slack App Manifest~~ DONE

---

### ~~Task 27: Dashboard Observer Panel~~ DONE

---

### ~~Task 28: Create-Gooseherd Setup Wizard~~ DONE (Phase 13)

Interactive CLI wizard (`scripts/setup.ts`) using @clack/prompts. 4-step flow: Slack tokens, GitHub auth, Agent/LLM, Runtime. `npm run setup` to run.

---

### ~~Task 29: Activate Notify Node~~ DONE

---

## LOW — Nice-to-Haves and Long-Term Vision

### Task 30: Container Isolation for Agent Runs

**Severity:** LOW
**Status:** Not implemented — open decision from earliest research
**Codex verified:** N/A
**Source docs:**
- `docs/minion_system_research_2026-02-17.md` — runner substrate decision unresolved

**Problem:** Agent runs execute directly on host. No sandboxing, no resource limits, no isolation between concurrent runs.

---

### ~~Task 31: Run Events Log~~ DONE (Phase 12)

EventLogger JSONL, pipeline event emission, dashboard timeline, `/api/runs/:id/pipeline-events`.

---

### ~~Task 32: GitHub App Auth (Replace PAT)~~ DONE (Phase 13)

Factory pattern (`GitHubService.create`), `@octokit/auth-app`, installation token refresh before push, tokenGetter wired through observer daemon.

---

### ~~Task 33: Token Usage Tracking~~ DONE (Phase 12)

TokenUsage type, `_tokenUsage_*` context bag keys, aggregation, dashboard display.

---

### ~~Task 34: Multi-Tenant Team Support (Level B)~~ DONE (Phase 13)

`teamId` on RunRecord, `TEAM_CHANNEL_MAP` JSON config, `resolveTeamFromChannel`, store filtering, dashboard `?team=` param.

---

### ~~Task 35: Dashboard Authentication~~ DONE (Phase 12)

DASHBOARD_TOKEN, Bearer/cookie auth, login page, timing-safe compare.

---

### ~~Task 36: Clone Progress Indicator in Slack~~ DONE (Phase 12)

onDetail callback, runShellWithProgress, git clone --progress parsing, throttled Slack updates.

---

### ~~Task 37: Help Command Discoverability (App Home Tab)~~ DONE (Phase 12)

buildHelpBlocks(), app_home_opened event, manifest update.

---

## ~~Housekeeping Task: Update architecture.md~~ DONE (Phase 12)

Test count 220→413, node count 18→20, file map updated, new feature docs.

---

## Summary Stats

| Severity | Count | Description |
|----------|-------|-------------|
| ~~CRITICAL~~ | ~~3~~ | ~~Agent is blind, mute, and generic~~ **DONE** |
| ~~HIGH~~ | ~~8~~ | ~~Dead code, stubs, missing wiring~~ **ALL DONE** |
| ~~MEDIUM-HIGH~~ | ~~7~~ | ~~Adoption blockers, missing polish~~ **ALL DONE** |
| MEDIUM | 11 → 0 | Vision features not yet built **ALL DONE** |
| LOW | 8 → 1 | Nice-to-haves, long-term |
| ~~Housekeeping~~ | ~~1~~ | ~~Doc staleness~~ **DONE** |
| **Completed** | **40** | |
| **Remaining** | **1** | (Task 30 — Container Isolation, deferred) |

---

## Codex-Verified Findings Cross-Reference

These gaps were confirmed by reading actual source code (not just docs):

| Codex # | Task # | What Was Found | Status |
|---------|--------|----------------|--------|
| #1 | ~~Task 4~~ | Per-repo pipeline override | **FIXED** |
| #2 | ~~Task 5~~ | Observer approval buttons | **FIXED** |
| #3 | ~~Task 6~~ | Smart triage pipeline hint | **FIXED** |
| #4 | ~~Task 8~~ | Single MCP slot | **FIXED** |
| #5 | ~~Task 16~~ | Memory: flat one-liner | **FIXED** |
| #6 | ~~Task 14~~ | Dashboard URL: localhost | **FIXED** |
| #7 | ~~Task 29~~ | Notify node: intentional stub | **FIXED** |
| #8 | ~~Task 25~~ | Config: loaded once at startup | **FIXED** |
| #9 | ~~Task 2~~ | Agent output analysis | **FIXED** |
| #10 | N/A | Follow-up template | No gap |
| N/A | ~~Task 10~~ | Browser-verify: no screenshots | **FIXED** |
