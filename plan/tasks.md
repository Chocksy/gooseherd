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

## HIGH — Core Features Are Stubs or Dead Code

These are features that were partially built but never connected, or exist as dead code.

### Task 4: Fix Per-Repo Pipeline Override (Dead Code)

**Severity:** HIGH
**Status:** Dead code — built but not wired
**Codex verified:** YES — finding #1: `repoConfigPipeline` set in context by clone.ts but never read by pipeline engine
**Source docs:**
- `docs/bulletproof_system_architecture_2026-02-21.md` — specifies `gooseherd.yml` per-repo config
- `docs/installation-tiers-research-2026-02-21.md` — central gooseherd.yml config

**Problem:** clone.ts reads `gooseherd.yml` from the cloned repo and sets `repoConfigPipeline` in the context bag. But RunManager always passes `this.config.pipelineFile` to the engine. The per-repo pipeline override is never used.

**What's needed:**
- Pipeline engine should check context bag for `repoConfigPipeline` before falling back to config
- Or: RunManager should read context bag after clone and switch pipeline file
- Either way: one line of wiring to activate already-built functionality

---

### Task 5: Wire Observer Approval Buttons

**Severity:** HIGH
**Status:** No-op — explicit TODO in code
**Codex verified:** YES — finding #2: explicit TODO in daemon.ts:255-257, no `app.action("observer_approve")` handler in slack-app.ts
**Source docs:**
- `docs/observer_system_research_2026-02-20.md` — Phase 2 approval flow, Slack interactive buttons
- `docs/bulletproof_system_architecture_2026-02-21.md` — approval gate backend

**Problem:** Observer posts Slack messages with approve/dismiss buttons but clicking them does nothing. No action handler is registered in slack-app.ts.

**What's needed:**
- Add `app.action("observer_approve")` and `app.action("observer_dismiss")` handlers in slack-app.ts
- On approve: call `runManager.enqueueRun()` with the trigger event data
- On dismiss: log dismissal, optionally snooze the trigger rule
- Handle timeout (30-minute window from research doc)

---

### Task 6: Wire Smart Triage Pipeline Hint

**Severity:** HIGH
**Status:** Dead field — parsed but unused
**Codex verified:** YES — finding #3: LLM returns pipeline hint, code parses it, nobody reads it
**Source docs:**
- `docs/observer_system_research_2026-02-20.md` — smart triage suggests pipeline complexity

**Problem:** The smart triage LLM returns a `suggestedPipeline` field. The code parses it out of the LLM response. But nothing downstream ever reads this field to select which pipeline YAML to use.

**What's needed:**
- Pass `suggestedPipeline` from triage result into the trigger event
- When observer enqueues a run, use the hint to select pipeline file (default, with-quality-gates, with-ci-feedback, full)
- Fallback to default if hint is absent or invalid

---

### Task 7: Wire Slack Channel Adapter to Bolt

**Severity:** HIGH
**Status:** Dead code — exists but not connected
**Codex verified:** YES (by Explore agent)
**Source docs:**
- `docs/observer_system_research_2026-02-20.md` — Phase 2: Slack channel observer

**Problem:** SlackChannelAdapter class exists as a source adapter but is NOT wired to the Slack Bolt app. No message listener feeds events to it. It's completely inert.

**What's needed:**
- Add a Bolt `app.message()` listener that feeds non-command messages to SlackChannelAdapter
- Filter: only channels in an observer watch list, ignore bot's own messages
- Route matched messages through safety pipeline → approval flow

---

### Task 8: Multi-MCP Extension Support

**Severity:** HIGH
**Status:** Single slot only
**Codex verified:** YES — finding #4: only `cemsMcpCommand` in config, one `--with-extension` flag
**Source docs:**
- `docs/minions_v2_deep_research_2026-02-20.md` — Gap 3 (NOT CLOSED): multi-MCP untouched
- `docs/bulletproof_system_architecture_2026-02-21.md` — specifies array of MCP extensions

**Problem:** Config has a single `cemsMcpCommand` string. implement.ts, fix-validation.ts, and fix-ci-node.ts each pass one `--with-extension` flag. The bulletproof spec calls for an array of extensions per repo.

**What's needed:**
- Change config from single string to array: `mcpExtensions: string[]`
- Loop over array when building agent command flags
- Support per-repo MCP extension lists in gooseherd.yml
- Backwards-compatible: single string config still works

---

### Task 9: Enable CI Feedback in Default Pipeline

**Severity:** HIGH
**Status:** Exists but not in default pipeline
**Codex verified:** N/A (pipeline YAML config choice)
**Source docs:**
- `docs/bulletproof_system_architecture_2026-02-21.md` — CI as core feature
- `docs/minions_v2_deep_research_2026-02-20.md` — P1 (CI feedback) done but only in optional pipelines

**Problem:** wait_ci + fix_ci nodes are fully implemented but only available in `with-ci-feedback.yml` and `full.yml`. The default pipeline (`default.yml`) ships without them. Most users will never see CI feedback.

**What's needed:**
- Decision: should default pipeline include CI feedback? If so, add wait_ci + fix_ci nodes
- Or: make pipeline selection smarter (auto-detect if repo has CI configured)
- Or: document clearly which pipeline to use and why

---

### Task 10: Visual Screenshot/Preview Step in Slack

**Severity:** HIGH
**Status:** Not implemented — existing browser-verify is curl+pa11y only
**Codex verified:** YES — browser-verify-node.ts confirmed: smoke test (curl HTTP status) + accessibility (pa11y). No screenshot capture, no visual preview posted anywhere.
**Source docs:**
- `docs/bulletproof_system_architecture_2026-02-21.md` — browser verification step
- `docs/minions_v2_deep_research_2026-02-20.md` — browser verify node
**Inspired by:** Devin.ai — posts actual screenshot of deployed result to Slack thread

**Problem:** Our browser-verify node runs `curl` for HTTP status and `pa11y` for accessibility. It never takes a visual screenshot of the deployed page. Users can't see what their changes look like without manually opening the preview URL. Devin posts an actual screenshot embedded in the Slack thread so the user can visually verify the result without leaving Slack.

**What's needed:**
- Take a screenshot of the review app URL after PR creation (Playwright, Puppeteer, or headless Chrome)
- Upload screenshot to Slack thread as an image attachment
- Optional: generate before/after comparison if prior screenshot exists
- Keep lightweight: screenshot step should be opt-in (not all changes are visual)
- Consider integration with preview deployment services (Vercel, Netlify, Render) for auto-generated preview URLs

---

### Task 11: "Awaiting Instructions" Idle State in Slack

**Severity:** HIGH
**Status:** Not implemented
**Codex verified:** N/A
**Source docs:**
- `docs/slack-ux-issues.md` — UX polish
**Inspired by:** Devin.ai — shows "Devin is awaiting instructions" after run completes

**Problem:** After a run completes (success or failure), the bot posts a summary and goes silent. There's no explicit signal that the bot is ready for the next command. Users don't know if they can immediately ask for a follow-up or if something is still processing. Devin shows a clear "awaiting instructions" state that communicates readiness.

**What's needed:**
- After run completion summary, post a clean "ready for instructions" footer in the thread
- Show available actions: "Reply in this thread to continue, or start a new task"
- Distinguish between: idle (ready), processing (busy), waiting for approval (blocked)
- Update Slack status card to reflect current state (not just run progress)
- Consider: Slack bot presence/status indicator ("Online — ready" vs "Busy — running task")

---

## MEDIUM-HIGH — Adoption Blockers and Missing Polish

### Task 12: Change DRY_RUN Default to False

**Severity:** MEDIUM-HIGH
**Status:** Not implemented (defaults to true)
**Codex verified:** N/A (config.ts)
**Source docs:**
- `docs/installation-tiers-research-2026-02-21.md` — biggest adoption blocker
- `docs/bulletproof_system_architecture_2026-02-21.md` — DRY_RUN default to false

**Problem:** First-time users get a system that does nothing visible. DRY_RUN=true means no push, no PR. Confusing first experience.

**What's needed:**
- Change default in config.ts from `true` to `false`
- Update .env.example with clear comment explaining DRY_RUN
- Consider a startup warning if DRY_RUN is true ("Running in dry-run mode — no PRs will be created")

---

### Task 13: Ship a Real Agent Default

**Severity:** MEDIUM-HIGH
**Status:** Not implemented (dummy-agent.sh)
**Codex verified:** N/A (config)
**Source docs:**
- `docs/installation-tiers-research-2026-02-21.md` — no real Goose default
- `docs/bulletproof_system_architecture_2026-02-21.md` — real Goose agent default

**Problem:** Ships with `scripts/dummy-agent.sh` as default agent. No Goose binary detection, no provider auto-detect. Users must manually configure the agent command.

**What's needed:**
- Detect if `goose` binary is on PATH; if so, use it as default
- Provide clear error message if no agent is configured and dummy is still default
- Document minimum agent requirements (what CLI interface the agent must expose)

---

### Task 14: Add Dashboard Public URL Config

**Severity:** MEDIUM-HIGH
**Status:** Not implemented — localhost only
**Codex verified:** YES — finding #6: Slack card URL uses `${dashboardHost}:${dashboardPort}`
**Source docs:**
- `docs/slack-ux-issues.md` — open issue: dashboard URL localhost
- `docs/hubble_expansion_research_2026-02-18.md` — deployment gaps

**Problem:** Slack status cards link to `http://localhost:3001/runs/...`. Broken in any non-localhost deployment (Docker, cloud, Tailscale).

**What's needed:**
- Add `DASHBOARD_PUBLIC_URL` env var (e.g., `https://gooseherd.example.com`)
- Use it when constructing Slack card URLs
- Fallback to `${dashboardHost}:${dashboardPort}` for local dev

---

### Task 15: User-Friendly Error Messages in Slack

**Severity:** MEDIUM-HIGH
**Status:** Not implemented
**Codex verified:** N/A
**Source docs:**
- `docs/slack-ux-issues.md` — open issue: raw error messages (Medium)

**Problem:** Pipeline failures show raw stack traces in Slack. Not helpful for non-technical users requesting tasks.

**What's needed:**
- Classify errors into user-friendly categories (clone failed, lint failed, tests failed, agent crashed, etc.)
- Show summary in Slack, full details in dashboard
- Include actionable suggestions ("Try running `npm test` locally to reproduce")

---

### Task 16: Richer Memory Storage (Not Flat Text)

**Severity:** MEDIUM-HIGH
**Status:** Flat text only
**Codex verified:** YES — finding #5: `onRunComplete` stores one-liner, positive feedback discarded
**Source docs:**
- `docs/hubble_expansion_research_2026-02-18.md` — structured memory, feedback loop

**Problem:** `onRunComplete` saves "Completed task on X: [task]. Changed files: [list]". No structured data. Positive feedback from Slack thumbs-up is not stored in memory at all.

**What's needed:**
- Store structured run data: task type, files changed, diff summary, duration, outcome, error category
- Save Slack feedback (thumbs up/down) to memory with run context
- Tag memories with repo, task type, outcome for better retrieval
- Differentiate memory categories (not just flat `category: "gooseherd"`)

---

### Task 17: Fix CEMS x-team-id Header

**Severity:** MEDIUM-HIGH
**Status:** Not implemented
**Codex verified:** YES (by Explore agent)
**Source docs:**
- `docs/hubble_expansion_research_2026-02-18.md` — x-team-id required for shared memory

**Problem:** CemsProvider never sends the `x-team-id` header. Shared cross-agent memory won't work — all memories are siloed to the individual agent.

**What's needed:**
- Add `CEMS_TEAM_ID` to config
- Include `x-team-id` header in all CEMS API calls
- Ensure shared scope memories are accessible across agents in the same team

---

### Task 18: Inject Actual Diff in Follow-Up Prompts

**Severity:** MEDIUM-HIGH
**Status:** Not implemented
**Codex verified:** N/A
**Source docs:**
- `docs/hubble_expansion_research_2026-02-18.md` — diff-based feedback loop

**Problem:** Follow-up runs get the previous task text and file list but NOT the actual diff content. The agent can't see what was previously changed, only file names.

**What's needed:**
- On follow-up runs, include the parent run's diff (or a summary of it) in the prompt
- Truncate large diffs to key sections (keep the diff under token limits)
- This dramatically improves follow-up quality — agent knows exactly what to build on

---

## MEDIUM — Missing Features From Vision Docs

### Task 19: Plan Task Node (LLM Planning Before Implementation)

**Severity:** MEDIUM
**Status:** Not implemented
**Codex verified:** N/A
**Source docs:**
- `docs/bulletproof_system_architecture_2026-02-21.md` — `plan_task` node in pipeline

**Problem:** Bulletproof spec calls for an LLM step that creates an implementation plan before the agent runs. This would catch scope issues early and give better instructions to the agent.

**What's needed:**
- New pipeline node: `plan_task` — calls LLM to break task into steps
- Output: structured plan that feeds into implement node's prompt
- Optional: present plan to user for approval before proceeding

---

### Task 20: Local Test Node (Run Tests Before Push)

**Severity:** MEDIUM
**Status:** Not implemented
**Codex verified:** N/A
**Source docs:**
- `docs/bulletproof_system_architecture_2026-02-21.md` — `local_test` node in pipeline

**Problem:** Currently tests only run through CI after push. No local test execution in the pipeline. Agent changes that break tests are discovered late.

**What's needed:**
- New pipeline node: `local_test` — runs configured test command in workspace
- Position: after validate, before commit
- Fail the pipeline if tests fail (with structured error output for fix_validation)

---

### Task 21: Observer Learning Loop (Phase 5)

**Severity:** MEDIUM
**Status:** Not started
**Codex verified:** N/A
**Source docs:**
- `docs/observer_system_research_2026-02-20.md` — Phase 5: Learning system

**Problem:** Observer has no feedback loop. It doesn't learn from successful/failed runs to adjust triage rules or confidence thresholds.

**What's needed:**
- Track observer trigger → run outcome correlation
- Adjust triage confidence thresholds based on success rates
- Auto-disable trigger rules that consistently produce failed runs
- Surface learning insights in dashboard

---

### Task 22: Observer Threshold Configuration

**Severity:** MEDIUM
**Status:** Not implemented
**Codex verified:** N/A
**Source docs:**
- `docs/observer_system_research_2026-02-20.md` — occurrence, age, user-count thresholds

**Problem:** Observer trigger rules lack the threshold configuration described in research: minimum occurrence count, issue age, affected user count before triggering.

**What's needed:**
- Add threshold fields to trigger rule YAML: `minOccurrences`, `minAge`, `minUserCount`
- Safety pipeline checks thresholds before allowing trigger
- Prevents premature triggering on one-off errors

---

### Task 23: GitHub Observer — Actions API Polling and Dependabot

**Severity:** MEDIUM
**Status:** Partial — webhook only
**Codex verified:** N/A
**Source docs:**
- `docs/observer_system_research_2026-02-20.md` — Phase 3: GitHub sources

**Problem:** GitHub observer only works via webhooks. No proactive polling of GitHub Actions failures. No Dependabot alert integration.

**What's needed:**
- Poll GitHub Actions API for failed workflow runs
- Parse Dependabot security alerts as trigger events
- Both feed into existing safety pipeline

---

### Task 24: Sentry Webhook Receiver

**Severity:** MEDIUM
**Status:** Not implemented
**Codex verified:** N/A
**Source docs:**
- `docs/bulletproof_system_architecture_2026-02-21.md` — Sentry webhook
- `docs/observer_system_research_2026-02-20.md` — real-time webhook alternative to polling

**Problem:** Observer only polls Sentry REST API on an interval. Bulletproof spec also wants a real-time Sentry webhook endpoint for instant event processing.

**What's needed:**
- Add `/webhooks/sentry` endpoint to webhook server
- Verify Sentry webhook signatures
- Parse Sentry webhook payload into TriggerEvent
- Route through existing safety pipeline

---

### Task 25: Config Hot-Reload

**Severity:** MEDIUM
**Status:** Not implemented
**Codex verified:** YES — finding #8: config loaded once at startup
**Source docs:**
- `docs/installation-tiers-research-2026-02-21.md` — config hot-reload

**Problem:** Config is loaded once at startup. Changing env vars or trigger rules requires a full restart.

**What's needed:**
- Watch config files (trigger rules YAML, gooseherd.yml) with fs.watch
- Reload on change without restarting the process
- Env var changes still require restart (standard behavior)

---

### Task 26: Slack App Manifest

**Severity:** MEDIUM
**Status:** Not implemented
**Codex verified:** N/A
**Source docs:**
- `docs/installation-tiers-research-2026-02-21.md` — one-click Slack setup
- `docs/bulletproof_system_architecture_2026-02-21.md` — Slack App Manifest

**Problem:** Users must manually create a Slack app, configure scopes, enable socket mode, etc. Tedious and error-prone.

**What's needed:**
- Create `slack-app-manifest.yml` with all required scopes, events, and interactive components
- Users can import manifest directly into Slack API portal
- Document the one-click setup flow

---

### Task 27: Dashboard Observer Panel

**Severity:** MEDIUM
**Status:** Not implemented
**Codex verified:** N/A
**Source docs:**
- `docs/observer_system_research_2026-02-20.md` — dashboard visualization
- `docs/bulletproof_system_architecture_2026-02-21.md` — trigger/gate visualization

**Problem:** Dashboard shows runs only. Zero observer awareness — no trigger log, no event queue, no triage decisions, no approval status.

**What's needed:**
- Add observer events feed to dashboard
- Show trigger → triage → approval → run flow
- Display active trigger rules and their hit counts
- Show pending approvals

---

### Task 28: Create-Gooseherd Setup Wizard

**Severity:** MEDIUM
**Status:** Not implemented
**Codex verified:** N/A
**Source docs:**
- `docs/installation-tiers-research-2026-02-21.md` — npx create-gooseherd
- `docs/bulletproof_system_architecture_2026-02-21.md` — setup wizard

**Problem:** Installation is manual .env configuration. No guided setup experience.

**What's needed:**
- Interactive CLI wizard: detect available tools, ask for tokens, generate .env
- Auto-detect: Goose binary, GitHub token validity, Slack app existence
- Generate minimal config for "just works" experience

---

### Task 29: Activate Notify Node (Currently Stub)

**Severity:** MEDIUM
**Status:** Intentional stub
**Codex verified:** YES — finding #7: documented placeholder, returns immediate success
**Source docs:**
- `docs/architecture.md` — notify node described as placeholder

**Problem:** Notify node exists in the pipeline but does nothing. Currently notification is handled externally by RunManager's Slack card updates. No webhook, email, or external notification support.

**What's needed:**
- Define what notifications should go here vs RunManager (avoid duplication)
- Options: webhook callback, email notification, custom notification plugins
- Or: formalize it as intentionally handled by RunManager and remove from pipeline

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

### Task 31: Run Events Log and Artifacts Storage

**Severity:** LOW
**Status:** Not implemented
**Codex verified:** N/A
**Source docs:**
- `docs/hubble_system_blueprint_2026-02-17.md` — run_events, run_artifacts tables

**Problem:** No structured event log for run lifecycle. No content-addressed artifact storage for diffs, logs, agent output.

---

### Task 32: GitHub App Auth (Replace PAT)

**Severity:** LOW
**Status:** Not implemented
**Codex verified:** N/A
**Source docs:**
- `docs/hubble_system_blueprint_2026-02-17.md` — GitHub App over PAT
- `docs/installation-tiers-research-2026-02-21.md` — GitHub App auth

**Problem:** Uses personal access token. GitHub App would provide better security, per-repo permissions, and higher rate limits.

---

### Task 33: Token Usage Tracking

**Severity:** LOW
**Status:** Not implemented
**Codex verified:** N/A
**Source docs:**
- `docs/installation-tiers-research-2026-02-21.md` — token/cost tracking

**Problem:** No visibility into LLM token consumption per run. Can't track costs or set budgets.

---

### Task 34: Multi-Tenant Team Support

**Severity:** LOW
**Status:** Not implemented
**Codex verified:** N/A
**Source docs:**
- `docs/installation-tiers-research-2026-02-21.md` — multi-tenant teams

**Problem:** Single-tenant only. No team isolation, no per-team config, no team-scoped runs.

---

### Task 35: Dashboard Authentication

**Severity:** LOW
**Status:** Not implemented
**Codex verified:** N/A
**Source docs:**
- `docs/installation-tiers-research-2026-02-21.md` — dashboard auth

**Problem:** Dashboard is open to anyone who can reach the URL. No auth, no access control.

---

### Task 36: Clone Progress Indicator in Slack

**Severity:** LOW
**Status:** Not implemented
**Codex verified:** N/A
**Source docs:**
- `docs/slack-ux-issues.md` — open issue (Low)

**Problem:** Large repo clones can take minutes with no feedback. User sees "Queued" then nothing until implementation starts.

---

### Task 37: Help Command Discoverability (App Home Tab)

**Severity:** LOW
**Status:** Not implemented
**Codex verified:** N/A
**Source docs:**
- `docs/slack-ux-issues.md` — open issue (Low)

**Problem:** Users must know to type `@bot help`. No Slack App Home tab with documentation and quick-start guide.

---

## Housekeeping Task: Update architecture.md

**Severity:** LOW (but should be done alongside any implementation)
**Source:** `docs/architecture.md` agent findings

**Stale items to fix:**
- Test count: says 220, reality is 259
- 3 test file names are incorrect
- Memory architecture doesn't reflect MemoryProvider refactor
- File map missing: `logger.ts`, `local-trigger.ts`, `error-parser.ts`, `gate-report.ts`, `hooks/run-lifecycle.ts`, `memory/provider.ts`

---

## Summary Stats

| Severity | Count | Description |
|----------|-------|-------------|
| ~~CRITICAL~~ | ~~3~~ | ~~Agent is blind, mute, and generic~~ **DONE** |
| HIGH | 8 | Dead code, stubs, missing wiring, visual feedback, idle state |
| MEDIUM-HIGH | 7 | Adoption blockers, missing polish |
| MEDIUM | 11 | Vision features not yet built |
| LOW | 8 | Nice-to-haves, long-term |
| Housekeeping | 1 | Doc staleness |
| **Remaining** | **35** | |

---

## Codex-Verified Findings Cross-Reference

These gaps were confirmed by reading actual source code (not just docs):

| Codex # | Task # | What Was Found |
|---------|--------|----------------|
| #1 | Task 4 | Per-repo pipeline override: `repoConfigPipeline` set but never read |
| #2 | Task 5 | Observer approval buttons: TODO in daemon.ts:255-257, no handler |
| #3 | Task 6 | Smart triage pipeline hint: parsed by code, read by nobody |
| #4 | Task 8 | Single MCP slot: one `--with-extension` flag only |
| #5 | Task 16 | Memory: flat one-liner, feedback discarded |
| #6 | Task 14 | Dashboard URL: `localhost:port` hardcoded pattern |
| #7 | Task 29 | Notify node: intentional stub, returns success |
| #8 | Task 25 | Config: loaded once at startup, no hot-reload |
| #9 | ~~Task 2~~ | ~~Agent output: unconditional success on exit 0~~ **FIXED** |
| #10 | N/A | Follow-up template: WORKS CORRECTLY (no gap) |
| N/A | Task 10 | Browser-verify confirmed: curl+pa11y only, no screenshot capture |
