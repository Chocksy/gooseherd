# Progress — Gooseherd Pipeline Implementation

## Phase 14: Docker Container Isolation (Task 30) — COMPLETE

### Session: 2026-02-25

### Implementation
- [x] Phase 1: ContainerManager class (dockerode) — create/exec/destroy sandbox containers
- [x] Phase 2: shell.ts AsyncLocalStorage routing — concurrency-safe per-run sandbox context
- [x] Phase 3: Sandbox Dockerfile — node22 + goose + git + gitleaks + chromium
- [x] Phase 4: Config + env vars — SANDBOX_ENABLED, SANDBOX_IMAGE, SANDBOX_HOST_WORK_PATH, etc.
- [x] Phase 5: Pipeline engine wiring — sandbox lifecycle (create before, destroy in finally)
- [x] Phase 6: Dashboard artifacts API — `/api/runs/:id/artifacts/:filename`
- [x] Phase 7: Docker integration tests — 3 tests: ping, lifecycle, orphan cleanup
- [x] Phase 8: E2E sandbox run against epiccoders/pxls — screenshot in dashboard

### Codex Review Fixes
- [x] CRITICAL: Race condition on module-level sandbox ID → AsyncLocalStorage<SandboxContext>
- [x] CRITICAL: mapToContainerPath wrong base → compute relative to workRoot/runId
- [x] CRITICAL: Command-string paths unmapped → mapToContainerPath in 6 node handlers
- [x] HIGH: PipelineEngine shared-instance race → eventLogger + onDetail per-execution
- [x] HIGH: Fail-open sandbox routing → fail-closed (throw if sandbox set but no manager)
- [x] HIGH: Custom stream demux bug → dockerode modem.demuxStream()
- [x] HIGH: Gitleaks report reads host fs → route through shell (cat via sandbox)
- [x] HIGH: Container leak on partial start → try/catch + cleanup
- [x] HIGH: Timeout doesn't kill container process → best-effort kill -9 -1
- [x] CRITICAL: commit.ts git diff --quiet misses untracked → git status --porcelain
- [x] LOW: resolvesSandbox typo → resolveSandbox
- [x] Clone node rm(runDir) breaks bind mount → readdir+rm pattern

### Final State
- TypeScript: 0 errors
- Tests: 136+ pass (unit + integration)
- Docker integration tests: 3/3 pass
- E2E: Full pipeline in sandbox against epiccoders/pxls, screenshot visible in dashboard
- PR created: https://github.com/EpicCoders/pxls/pull/616

### New/Modified Files
- `src/sandbox/container-manager.ts` — Docker container lifecycle
- `src/sandbox/types.ts` — SandboxConfig, SandboxHandle, SandboxExecResult
- `src/pipeline/shell.ts` — AsyncLocalStorage sandbox routing, mapToContainerPath
- `src/pipeline/pipeline-engine.ts` — sandbox create/destroy, runInSandboxContext
- `src/pipeline/nodes/clone.ts` — readdir+rm, mapToContainerPath
- `src/pipeline/nodes/implement.ts` — mapToContainerPath template vars
- `src/pipeline/nodes/validate.ts` — mapToContainerPath template vars
- `src/pipeline/nodes/lint-fix.ts` — mapToContainerPath template vars
- `src/pipeline/nodes/fix-validation.ts` — mapToContainerPath template vars
- `src/pipeline/nodes/commit.ts` — git status --porcelain fix
- `src/pipeline/ci/fix-ci-node.ts` — mapToContainerPath template vars
- `src/pipeline/quality-gates/security-scan-node.ts` — read via shell
- `src/local-trigger.ts` — sandbox wiring
- `src/index.ts` — sandbox wiring
- `src/config.ts` — SANDBOX_* env vars
- `sandbox/Dockerfile` — sandbox container image
- `scripts/sandbox-dummy-agent.sh` — E2E test agent
- `tests/sandbox-integration.test.ts` — Docker integration tests

---

## Phase 13: Setup Wizard + GitHub App Auth + Team Tagging (Tasks 28, 32, 34) — COMPLETE

### Session: 2026-02-25

### Research
- [x] 4 parallel research agents analyzed remaining 4 tasks
- [x] Codex-investigator review: MODIFY verdict with 3 required + 5 recommended fixes
- [x] Created findings.md and task_plan.md with 5 phases

### Implementation
- [x] Phase 1: Setup Wizard (Task 28) — `scripts/setup.ts` with @clack/prompts, 4-step flow, `npm run setup`
- [x] Phase 2: GitHub App Auth (Task 32) — factory pattern `GitHubService.create()`, `@octokit/auth-app`, installation token refresh before push, tokenGetter wired through observer daemon
- [x] Phase 3: Team Tagging Level B (Task 34) — `teamId` on RunRecord/NewRunInput, `TEAM_CHANNEL_MAP` JSON config, `resolveTeamFromChannel`, store filtering, dashboard `?team=` param
- [x] Codex fixes: push.ts token refresh, daemon tokenGetter, classifyError messages, E2E skip conditions, test assertions
- [x] Tests: 53 new tests in phase13.test.ts covering all 3 features

### Final State
- TypeScript: 0 errors
- Tests: 466/466 pass (35 suites)
- New files: setup.ts, phase13.test.ts
- Remaining: Task 30 (Container Isolation) — deferred, no forcing function

---

## Phase 12: Security + Observability + Polish (Tasks 35, 33, 37, 36, 31, 28-lite, Housekeeping) — COMPLETE

### Session: 2026-02-24

### Research
- [x] 5 parallel research agents analyzed all 10 remaining tasks
- [x] Codex-investigator challenge: reprioritized tasks (35 elevated, 28 demoted)
- [x] Created findings.md with deep research per task
- [x] Created task_plan.md with 5 implementation phases

### Implementation
- [x] Phase 1: Dashboard Auth (Task 35) — DASHBOARD_TOKEN, Bearer/cookie auth, login page, logout, timing-safe compare
- [x] Phase 2: Token Usage Tracking (Task 33) — TokenUsage type, _tokenUsage_* context bag keys, aggregation, dashboard display
- [x] Phase 3: Help Command / App Home Tab (Task 37) — buildHelpBlocks(), app_home_opened event, manifest update
- [x] Phase 4: Clone Progress in Slack (Task 36) — onDetail callback, runShellWithProgress, git clone --progress parsing, throttled Slack updates
- [x] Phase 5: Run Events Log (Task 31) — EventLogger JSONL, pipeline event emission, /api/runs/:id/pipeline-events, dashboard timeline
- [x] Phase 6: .env.example + validate (Task 28 lite) — updated .env.example, scripts/validate-env.ts, npm run validate
- [x] Phase 7: Update architecture.md (Housekeeping) — test count 220→413, node count 18→20, file map updated, new feature docs

### Final State
- TypeScript: 0 errors
- Tests: 413/413 pass (20 suites)
- New files: event-logger.ts, validate-env.ts, phase12.test.ts

---

## Phase 11: Observer Completeness + Operational Maturity (Tasks 29, 24, 21, 23, 25, 27) — COMPLETE

### Session: 2026-02-24

### Implementation
- [x] Task 29: Notify Node — webhook POST dispatch, 7 tests
- [x] Task 24: Sentry Webhook Receiver — HMAC-SHA256 verification, issue/metric alert parsing, 17 tests
- [x] Task 21: Observer Learning Loop — RunManager terminal callbacks, rule outcome tracking in state store
- [x] Task 23: GitHub Actions Polling — github-poller.ts, cursor tracking, daemon lifecycle wiring
- [x] Task 25: Config Hot-Reload — SIGHUP handler, observer.reload(), fs.watch on trigger rules YAML
- [x] Task 27: Dashboard Observer Panel — state snapshot, event history ring buffer, 3 API routes, UI panel with rules/budget/events

### Final State
- TypeScript: 0 errors
- Tests: 387/388 pass (1 pre-existing flaky shell.test.ts)
- New files: sentry-webhook-adapter.ts, github-poller.ts, sentry-webhook.test.ts

---

## Phase 10: Quality Depth + Adoption (Tasks 7, 26, 19, 20, 22, 10) — COMPLETE

### Session: 2026-02-24

### Implementation
- [x] Task 7: Wire Slack Channel Adapter — `app.message()` handler, config for watched channels/bot allowlist
- [x] Task 26: Slack App Manifest — `slack-app-manifest.yml` with all scopes, events, socket mode
- [x] Task 19: Plan Task Node — LLM planning step (Haiku), registered in pipeline engine, wired into full.yml
- [x] Task 20: Local Test Node — runs LOCAL_TEST_COMMAND, fail loop to fix_validation, in default.yml + full.yml
- [x] Task 22: Observer Threshold Config — minOccurrences/minAgeMinutes/minUserCount in trigger rules + safety pipeline
- [x] Task 10: Screenshot Capture — Playwright screenshot in browser-verify-node, opt-in via SCREENSHOT_ENABLED
- [x] Tests: 10 new threshold tests, 7 new pipeline node tests, fixed pipeline-loader VALID_ACTIONS
- [x] Codex validation: all changes verified, eliminated duplicate IMPLEMENTED_ACTIONS set

### Final State
- TypeScript: 0 errors
- Tests: 363/363 pass

---

## Phase 9: Intelligence + UX (Tasks 9, 17, 13, 18, 16, 15) — COMPLETE

### Session: 2026-02-24

### Implementation
- [x] Task 9: CI feedback loop in default pipeline (wait_ci + fix_ci after create_pr)
- [x] Task 17: CEMS team ID header (CEMS_TEAM_ID env → x-team-id header for cross-agent memory)
- [x] Task 13: Agent default detection (warn if using dummy-agent but goose is on PATH)
- [x] Task 18: Follow-up diff injection (inject actual git diff into follow-up prompts, 3KB cap)
- [x] Task 16: Enriched memory hooks (duration, file count, follow-up status, positive feedback)
- [x] Task 15: Error classifier (7 regex patterns → friendly error + suggestion in Slack failure summary)
- [x] Tests: 10 new classifyError tests + integration test for classified failure summary
- [x] Codex validation: all changes verified, clone regex expanded per recommendation

### Final State
- TypeScript: 0 errors
- Tests: 344/344 pass

---

## Phase 8: Wire Dead Code + Quick Wins (Tasks 4, 5, 6, 8, 11, 12, 14) — COMPLETE

### Session: 2026-02-24

### Research (complete)
- [x] Read all 8 HIGH priority tasks from plan/tasks.md
- [x] Read key source files: pipeline-engine, run-manager, config, slack-app, observer daemon, clone, create-pr, repo-config, smart-triage, fix-validation, fix-ci-node, slack-channel-adapter
- [x] Brainstormed batching: grouped by effort + dependency
- [x] Created findings.md with detailed analysis of each task
- [x] Created task_plan.md with 6 phases

### Implementation
- [x] Phase 1: Quick Wins (Tasks 4, 12, 14) — per-repo pipeline override, DRY_RUN default, dashboard public URL
- [x] Phase 2: Observer Approval Buttons (Task 5) — approve/reject action handlers in slack-app.ts
- [x] Phase 3: Wire Smart Triage Pipeline Hint (Task 6) — daemon → run-composer → store → run-manager → engine
- [x] Phase 4: Multi-MCP Extension Support (Task 8) — buildMcpFlags helper, MCP_EXTENSIONS env var
- [x] Phase 5: "Awaiting Instructions" Idle State (Task 11) — separator + prefix in summary footer
- [x] Phase 6: Tests + Validation — 10 new tests, codex-investigator audit, pipelineHint path traversal fix

### Final State
- TypeScript: 0 errors
- Tests: 334/334 pass

---

## Phase 7: Tasks 1-3 "Make Agent Not Blind and Dumb" — COMPLETE

### Session: 2026-02-24

### Implementation
- [x] Task 3: Classify task → task-type-specific prompts (pipeline YAML + hydrate-context.ts)
- [x] Task 1: Inject codebase context (buildRepoSummary in hydrate-context.ts)
- [x] Task 2: Analyze agent output (shell.ts timeout + analyzeAgentOutput + PR body)
- [x] Tests: shell.test.ts, implement.test.ts, hydrate-context.test.ts, create-pr.test.ts
- [x] Fixed 10 test failures (login shell pollution, git diff untracked, logfile pollution)
- [x] Codex validation: all changes correct

### Final State
- TypeScript: 0 errors
- Tests: 324/324 pass
- Committed: `refactor: remove legacy executor, pipeline engine is the single execution path`

---

## Phase 6: Slack UX Improvements — COMPLETE (Session: 2026-02-24)
- Bot name override, run completion summary, Slack + RunManager tests
- 259/259 pass

## Phase 5: Advanced Features — COMPLETE (Session: 2026-02-24)
- Scope judge, smart triage, browser verify, per-repo config
- 201/201 pass

## Phase 4: Observer/Trigger System — COMPLETE (Session: 2026-02-24)
## Phase 3: CI Feedback Loop — COMPLETE (Session: 2026-02-24)
## Phase 2: Quality Gates — COMPLETE (Session: 2026-02-23/24)
## Phase 1: Pipeline Foundation — COMPLETE (Session: 2026-02-23)
