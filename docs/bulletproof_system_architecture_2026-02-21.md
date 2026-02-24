# Bulletproof Agent Orchestration System: Complete Architecture

Date: 2026-02-21
Scope: Comprehensive architecture design for a production-grade, multi-company AI agent orchestrator combining configurable pipelines, CI feedback loops, observer triggers, quality gates, and tiered enterprise onboarding.
Methodology: Council of 5 agents — 1 pipeline architect, 1 observer/trigger architect, 1 enterprise onboarding specialist, 2 codex-investigators (CI integration + quality gates).

---

## 1. Executive Summary

This document defines the complete architecture for evolving Gooseherd from a single-pipeline agent orchestrator into a **bulletproof, multi-company system**. The architecture combines:

1. **Configurable Pipeline Engine** — YAML-defined state machines mixing deterministic and agentic nodes (inspired by Stripe's Blueprints, GitHub Actions syntax, Temporal's durable execution)
2. **CI Feedback Loop** — Post-push polling of GitHub Actions, structured failure parsing, agent fix rounds (max 2), local pre-CI testing
3. **Observer/Trigger System** — Unified ingestion layer for Slack, Sentry, GitHub webhooks, cron, and custom webhooks, with safety throttling
4. **Quality Gates** — Diff size limits, forbidden file patterns, LLM-as-judge scope validation, security scanning, structured error re-prompting
5. **Three-Tier Onboarding** — Tier 0 (5 env vars, `docker compose up`), Tier 1 (adds CI + validation), Tier 2 (full enterprise config file)

The core architectural insight: **the pipeline is the universal abstraction**. Every trigger (manual or automatic) produces a run that flows through a configurable pipeline. Every quality check is a node in that pipeline. CI feedback is a loop within the pipeline. The system is one pipeline engine with pluggable nodes.

---

## 2. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                        TRIGGER LAYER                              │
│                                                                    │
│  Slack @mention ──┐                                                │
│  Slack observer ──┤                                                │
│  Sentry webhook ──┤──▸ TriggerEvent ──▸ Safety ──▸ Router ──┐    │
│  GitHub webhook ──┤     (normalize)     (dedup,    (select    │    │
│  Cron schedule  ──┤                      rate      pipeline)  │    │
│  Custom webhook ──┘                      limit,              │    │
│                                          budget)             │    │
│                                                              │    │
├──────────────────────────────────────────────────────────────┼────┤
│                        PIPELINE ENGINE                       │    │
│                                                              ▼    │
│  ┌──────────────────────────────────────────────────────────┐│    │
│  │              CONFIGURABLE PIPELINE (YAML)                ││    │
│  │                                                          ││    │
│  │  [clone] ──▸ [hydrate] ──▸ [implement] ──▸ [lint_fix]   ││    │
│  │                                               │          ││    │
│  │                                               ▼          ││    │
│  │  [diff_gate] ◂── [validate] ◂── [local_test]            ││    │
│  │       │                                                  ││    │
│  │       ▼                                                  ││    │
│  │  [scope_judge] ──▸ [security_scan] ──▸ [commit]          ││    │
│  │                                           │              ││    │
│  │                                           ▼              ││    │
│  │  [push] ──▸ [wait_ci] ──▸ [parse_ci] ──▸ CI pass?       ││    │
│  │                                           │    │         ││    │
│  │                                          yes   no        ││    │
│  │                                           │    │         ││    │
│  │                                           │  [fix_ci]    ││    │
│  │                                           │    │(max 2)  ││    │
│  │                                           │    └──▸push  ││    │
│  │                                           ▼              ││    │
│  │  [create_pr] ──▸ [browser_verify?] ──▸ [notify]          ││    │
│  └──────────────────────────────────────────────────────────┘│    │
│                                                              │    │
├──────────────────────────────────────────────────────────────┼────┤
│                     QUALITY GATES                            │    │
│                                                              │    │
│  Pre-Agent: task classify, repo readiness                    │    │
│  Pre-Push:  diff size, forbidden files, security, scope judge│    │
│  Post-CI:   check annotations, log parsing, failure dedup    │    │
│  Post-Deploy: smoke test, accessibility (optional)           │    │
└──────────────────────────────────────────────────────────────┘    │
```

---

## 3. Configurable Pipeline Engine

### 3.1 Design Philosophy

Four principles distilled from Stripe, Temporal, GitHub Actions, and Airflow:

1. **"The model does not run the system. The system runs the model."** (Stripe) — Deterministic nodes outnumber agentic nodes. The LLM only runs where human-like judgment is required.
2. **Workflows survive crashes** (Temporal) — Context bag is checkpointed after each node. Pipeline resumes from last checkpoint on restart.
3. **YAML configuration developers already know** (GitHub Actions) — `if` conditions, `needs` dependencies, `outputs` data passing.
4. **State machine with linear default, optional branches** — Not a full DAG. 95% of runs are linear. Conditional branches handle CI retry loops and optional browser verification.

### 3.2 Node Types

Every node is one of four categories:

| Category | Token Cost | Predictability | Duration | Examples |
|----------|-----------|---------------|----------|----------|
| **Deterministic** | Zero | 100% | Seconds | clone, lint, commit, push |
| **Agentic** | High | Unpredictable | Minutes | implement, fix CI, browser verify |
| **Conditional** | Zero | Deterministic | Instant | diff gate, file pattern check |
| **Async** | Zero | Deterministic | Minutes-hours | wait for CI, wait for review app |

### 3.3 Complete Node Catalog (19 nodes)

#### Core Required (5)

| Node | Category | Purpose | Inputs | Outputs |
|------|----------|---------|--------|---------|
| `clone` | Deterministic | Clone repo, create branch | repoSlug, baseBranch | repoDir, resolvedBaseBranch |
| `implement` | Agentic | Main coding agent | promptFile, repoDir | changedFiles |
| `commit` | Deterministic | git add + commit | repoDir, commitMsg | commitSha |
| `push` | Deterministic | git push to origin | repoDir, branchName | — |
| `create_pr` | Deterministic | GitHub PR creation | repoSlug, branchName, base | prUrl, prNumber |

#### Validation (4)

| Node | Category | Purpose |
|------|----------|---------|
| `lint_fix` | Deterministic | Auto-fix lint issues (rubocop -A, eslint --fix) |
| `local_test` | Deterministic | Run tests on changed files only (~30s) |
| `validate` | Deterministic | Run VALIDATION_COMMAND |
| `fix_validation` | Agentic | Re-run agent with structured error context |

#### Quality Gates (3)

| Node | Category | Purpose |
|------|----------|---------|
| `diff_quality_gate` | Conditional | Check diff size, file count, forbidden patterns |
| `scope_judge` | Agentic | LLM-as-judge reviews diff vs original task |
| `security_scan` | Deterministic | gitleaks + semgrep on staged changes |

#### CI Feedback (4)

| Node | Category | Purpose |
|------|----------|---------|
| `wait_for_ci` | Async | Poll GitHub check suites until complete |
| `parse_ci_results` | Deterministic | Extract annotations + log failures |
| `fix_ci` | Agentic | Agent fixes CI failures with structured context |
| `hydrate_context` | Deterministic | Pre-fetch ticket details, repo rules, related files |

#### Advanced (3)

| Node | Category | Purpose |
|------|----------|---------|
| `plan_task` | Agentic | Optional planner agent decomposes task |
| `browser_verify` | Agentic | Playwright against review app URL |
| `notify` | Deterministic | Slack/webhook notification |

### 3.4 Pipeline Configuration Format (YAML)

```yaml
# gooseherd-pipeline.yml
version: 1
name: "rails-enterprise"
description: "Full pipeline for Rails apps with RSpec CI and review apps"

# Shared context available to all nodes
context:
  max_ci_fix_rounds: 2
  max_validation_rounds: 2

nodes:
  - id: clone
    type: deterministic
    action: clone
    config:
      depth: 1  # shallow clone for large repos

  - id: hydrate
    type: deterministic
    action: hydrate_context
    config:
      sources:
        - type: memory_search  # CEMS
        - type: repo_rules     # .cursor/rules/ directory
        - type: related_files  # Find files related to task

  - id: plan
    type: agentic
    action: plan_task
    enabled: false  # opt-in
    config:
      model: "claude-sonnet-4-6"
      max_tokens: 4096

  - id: implement
    type: agentic
    action: implement
    config:
      command: "{{config.agentCommandTemplate}}"
      timeout: "{{config.agentTimeoutSeconds}}s"
      tools: [file_edit, terminal, memory_search, memory_add]
      system_prompt_additions:
        - "This is a {{task_type}} task."
        - "Focus on: {{task_focus_areas}}"

  - id: lint_fix
    type: deterministic
    action: lint_fix
    config:
      command: "{{config.lintFixCommand}}"
    if: "config.lintFixCommand != ''"

  - id: local_test
    type: deterministic
    action: local_test
    config:
      command: "cd {{ctx.repoDir}} && bundle exec rspec --fail-fast {{ctx.changedSpecFiles}}"
      timeout: 120
    if: "config.localTestCommand != ''"

  - id: validate
    type: deterministic
    action: validate
    config:
      command: "{{config.validationCommand}}"
    if: "config.validationCommand != ''"
    on_failure:
      action: loop
      agent_node: fix_validation
      max_rounds: "{{context.max_validation_rounds}}"
      until: "validate.exit_code == 0"

  - id: diff_gate
    type: conditional
    action: diff_quality_gate
    config:
      profile: "{{ctx.taskType}}"
      profiles:
        bugfix:  { soft_max_lines: 250, hard_max_lines: 600, soft_max_files: 12, hard_max_files: 25 }
        feature: { soft_max_lines: 600, hard_max_lines: 1500, soft_max_files: 25, hard_max_files: 60 }
        refactor: { soft_max_lines: 1000, hard_max_lines: 2500, soft_max_files: 40, hard_max_files: 120 }
        chore:   { soft_max_lines: 150, hard_max_lines: 400, soft_max_files: 8, hard_max_files: 20 }
    on_soft_fail: warn  # continue but add warning to PR
    on_hard_fail: fail_run

  - id: security_scan
    type: deterministic
    action: security_scan
    config:
      secrets_tool: gitleaks  # or "regex" if gitleaks unavailable
      sast_tool: semgrep      # optional
    on_failure: fail_run

  - id: scope_judge
    type: agentic
    action: scope_judge
    enabled: false  # opt-in, expensive
    config:
      model: "claude-haiku-4-5"
      min_pass_score: 60
      escalation_model: "claude-sonnet-4-6"
      escalate_below_confidence: 0.7

  - id: commit
    type: deterministic
    action: commit

  - id: push
    type: deterministic
    action: push

  - id: wait_ci
    type: async
    action: wait_for_ci
    if: "config.ciWaitEnabled"
    config:
      poll_interval: 30
      patience_timeout: 300   # 5 min for checks to appear
      max_wait: 1800          # 30 min total
      check_filter: []        # empty = all checks
    on_failure:
      action: loop
      agent_node: fix_ci
      max_rounds: "{{context.max_ci_fix_rounds}}"
      until: "wait_ci.conclusion == 'success'"
      on_exhausted: complete_with_warning  # don't discard work

  - id: create_pr
    type: deterministic
    action: create_pr

  - id: browser_verify
    type: agentic
    action: browser_verify
    if: "ctx.changedFiles matches 'views/**,app/javascript/**,*.css,*.scss,*.erb'"
    config:
      review_app_url: "{{ctx.reviewAppUrl}}"
      checks: [smoke_test, accessibility]
    enabled: false  # opt-in

  - id: notify
    type: deterministic
    action: notify
    config:
      target: slack
```

### 3.5 Pipeline Engine Architecture

**Execution model**: Linear state machine with loop constructs (not a full DAG).

```
PipelineEngine
  ├── loadPipeline(yamlPath) → Pipeline
  ├── execute(pipeline, run) → PipelineResult
  │     ├── for each node in pipeline.nodes:
  │     │     ├── evaluate `if` condition
  │     │     ├── resolve template variables from context bag
  │     │     ├── execute node via typed executor
  │     │     │     ├── DeterministicExecutor → shell command
  │     │     │     ├── AgenticExecutor → agent invocation
  │     │     │     ├── ConditionalExecutor → expression evaluator
  │     │     │     └── AsyncExecutor → poll/webhook wait
  │     │     ├── write outputs to context bag
  │     │     ├── checkpoint context bag to disk
  │     │     └── handle failure (retry, loop, abort)
  │     └── return PipelineResult
  └── resume(checkpointPath) → PipelineResult  # crash recovery
```

**Context bag**: Typed key-value store passed between nodes. Persisted as JSON after each step. Contains:
- `ctx.repoDir` — cloned repository path
- `ctx.resolvedBaseBranch` — actual base branch
- `ctx.changedFiles` — list of files changed by agent
- `ctx.changedSpecFiles` — derived test files for local testing
- `ctx.commitSha` — commit SHA after commit
- `ctx.prUrl` — PR URL after creation
- `ctx.prNumber` — PR number for CI correlation
- `ctx.taskType` — classified task type (bugfix/feature/refactor/chore)
- `ctx.reviewAppUrl` — review app URL if deployed
- `ctx.gateReport` — accumulated quality gate results

**Expression evaluator**: Safe recursive-descent parser for `if` conditions. NOT `eval()`. Supports: equality (`==`, `!=`), comparisons (`>`, `<`), boolean (`&&`, `||`), string matching (`matches`, `contains`), and context variable references.

### 3.6 Default Pipeline (ships out of the box)

Replicates EXACTLY the current `executor.ts` behavior in YAML:

```yaml
version: 1
name: "default"
nodes:
  - { id: clone, type: deterministic, action: clone }
  - { id: hydrate, type: deterministic, action: hydrate_context, config: { sources: [{ type: memory_search }] } }
  - { id: implement, type: agentic, action: implement }
  - { id: lint_fix, type: deterministic, action: lint_fix, if: "config.lintFixCommand != ''" }
  - { id: validate, type: deterministic, action: validate, if: "config.validationCommand != ''",
      on_failure: { action: loop, agent_node: fix_validation, max_rounds: 2, until: "validate.exit_code == 0" } }
  - { id: commit, type: deterministic, action: commit }
  - { id: push, type: deterministic, action: push }
  - { id: create_pr, type: deterministic, action: create_pr }
  - { id: notify, type: deterministic, action: notify }
```

Zero config change needed. All existing env vars work unchanged.

---

## 4. CI Feedback Loop

### 4.1 What We Already Have

The `GitHubService` in `src/github.ts` wraps `@octokit/rest` v22. The installed package already includes all CI-related endpoints — no new dependencies needed:

| Method | Purpose |
|--------|---------|
| `checks.listForRef` | List check runs for commit SHA |
| `checks.listSuitesForRef` | List check suites for commit SHA |
| `checks.listAnnotations` | Structured error locations from CI |
| `actions.downloadJobLogsForWorkflowRun` | Raw job logs |

GitHub token needs `repo` scope (already required for PR creation).

### 4.2 Polling Strategy (v1, recommended over webhooks)

Polling works everywhere, requires no public endpoint, and is simpler:

```
Phase 1: Patience window (wait for check suites to appear)
  - Poll every 15 seconds for up to 5 minutes
  - If no suites appear → repo has no CI → treat as success

Phase 2: Completion wait
  - Poll every 30 seconds for up to 30 minutes
  - Track each check run's status individually

Phase 3: Evaluate
  - All "success" / "skipped" / "neutral" → CI passed
  - Any "failure" / "timed_out" → enter fix loop
  - "cancelled" → skip (user-cancelled)
```

### 4.3 CI Result Parsing (3 levels)

**Level 1 — Check Annotations (best)**: GitHub Actions auto-creates annotations from problem matchers. Pre-parsed with file, line, message. No log parsing needed.

**Level 2 — Job Logs (fallback)**: Download job log (plain text via redirect URL), extract last 3000 chars. Contains test framework summary.

**Level 3 — Agent interpretation**: The agent IS an LLM. Pass the raw failure context and it can interpret test output far better than any regex parser.

### 4.4 The Fix Loop

```
push → wait_ci → CI fails → parse failures → build fix prompt → agent fixes → commit → push → wait_ci again
                                                                                              │
                                                                    max 2 rounds reached ──▸ complete with warning
```

**Fix prompt structure**:
```markdown
CI has failed on your PR. Fix the following failures only.

## Check Run Annotations
- src/models/user.rb:47 — Expected 'active' but got nil
- spec/models/user_spec.rb:23 — NoMethodError: undefined method 'status'

## Failed Job Log (last 3000 chars)
[raw log tail]

## Your Changed Files
[list of files you modified]

## Instructions
- Fix only the CI failures shown above
- Do not refactor unrelated code
- Do not change test expectations unless the test is wrong
```

**Safety**: If fix attempt introduces MORE failures than previous round, abort immediately.

### 4.5 Local Pre-CI Testing

Before pushing, run tests on changed files only (~30 seconds vs 20 minutes):

```
git diff --name-only HEAD → changed files
├── app/models/user.rb → spec/models/user_spec.rb (convention mapping)
├── app/controllers/api/orders_controller.rb → spec/controllers/api/orders_controller_spec.rb
└── bundle exec rspec --fail-fast <spec_files>
```

Config: `LOCAL_TEST_COMMAND=cd {{repo_dir}} && bundle exec rspec --fail-fast {{changed_spec_files}}`

New template variable `{{changed_spec_files}}` computed by convention-based mapping.

### 4.6 New Config Values

```
CI_WAIT_ENABLED=false         # opt-in
CI_POLL_INTERVAL_SECONDS=30
CI_PATIENCE_TIMEOUT_SECONDS=300
CI_MAX_WAIT_SECONDS=1800
CI_CHECK_FILTER=              # empty = all checks
CI_MAX_FIX_ROUNDS=2
LOCAL_TEST_COMMAND=
```

### 4.7 New Types

```typescript
// Additions to types.ts
export type RunStatus = "queued" | "running" | "validating" | "pushing"
  | "awaiting_ci" | "ci_fixing" | "completed" | "failed";

// Additions to RunRecord
ciFixAttempts?: number;
ciConclusion?: string;
prNumber?: number;
```

---

## 5. Observer / Trigger System

### 5.1 Unified Trigger Architecture

Every trigger source produces a `TriggerEvent` that flows through safety checks and routing into the existing `RunManager.enqueueRun()`:

```
Sentry webhook ───┐
GitHub webhook ───┤
Slack observer ───┤──▸ TriggerEvent ──▸ [dedup] ──▸ [rate limit] ──▸ [budget] ──▸ [approval?] ──▸ Router ──▸ enqueueRun()
Cron schedule  ───┤
Custom webhook ───┘
```

**Key insight**: `RunManager.enqueueRun()` is source-agnostic. It accepts a `NewRunInput` and doesn't care how it was created. The observer system is purely an ingestion layer.

### 5.2 TriggerEvent Interface

```typescript
interface TriggerEvent {
  id: string;                              // unique, for deduplication
  source: TriggerSource;                   // slack_mention | sentry_alert | github_webhook | cron | custom_webhook
  timestamp: string;
  repoSlug?: string;                       // may need resolution (Sentry has project, not repo)
  suggestedTask?: string;
  baseBranch?: string;
  priority: "low" | "medium" | "high" | "critical";
  rawPayload: unknown;
  pipelineHint?: string;                   // "bugfix" | "chore" | "follow-up"
  notificationTarget: { type: "slack" | "dashboard_only"; channelId?: string };
}
```

### 5.3 How Each Source Becomes a Run

**Sentry alert → run:**
1. POST to `/webhooks/sentry`, verify `Sentry-Hook-Signature` (HMAC-SHA256)
2. Extract error title, stack frames (`in_app: true` only), culprit
3. Resolve repo via configured `sentry-project -> owner/repo` mapping (Sentry payloads do NOT include repo)
4. Compose task: `"Fix error: ${title}. Stack trace: ${filePaths.join(', ')}"`
5. Route to `bugfix` pipeline

**GitHub CI failure → run:**
1. POST to `/webhooks/github`, verify `X-Hub-Signature-256`
2. Check `event: check_suite`, `action: completed`, `conclusion: failure`
3. Extract `repository.full_name`, `check_suite.head_branch`, failed check names
4. Compose task: `"Fix CI failure on ${branch}: ${failedChecks.join(', ')}"`
5. Route to `bugfix` pipeline

**GitHub PR review → run:**
1. `event: pull_request_review`, `action: submitted`, `state: changes_requested`
2. Extract review body, PR branch, repo
3. Compose task: `"Address PR review feedback: ${review.body}"`
4. Route to `follow-up` pipeline (continues on existing branch)

**Slack observer → run:**
1. Subscribe to `message` events in watched channels (works with existing Bolt/Socket Mode)
2. Match messages against configured patterns (regex or keyword sets)
3. Optional: LLM classifies message — "is this a request for a code fix?"
4. If actionable, compose TriggerEvent

**Cron → run:**
1. Built-in scheduler (node-cron or setInterval)
2. Config: `{ cron: "0 9 * * MON", repoSlug: "owner/repo", task: "Update dependencies" }`
3. TriggerEvent created directly

### 5.4 Safety & Throttling

**Rate limits** (per source, sliding window):

| Source | Per Minute | Per Hour | Per Day |
|--------|-----------|----------|---------|
| sentry_alert | 2 | 10 | 30 |
| github_webhook | 3 | 15 | 50 |
| slack_observer | 1 | 5 | 20 |
| cron | 1 | 6 | 24 |

**Deduplication keys**:
- Sentry: `sentry:${projectSlug}:${fingerprint[0]}` (60 min window)
- GitHub check_suite: `gh:check:${repo}:${branch}:${sha}` (30 min window)
- GitHub PR review: `gh:review:${repo}:${prNumber}:${reviewId}` (no window, unique)

**Approval gates** (configurable per trigger rule):
```
TriggerEvent → requiresApproval?
  → yes → Post to Slack: "[Approve] [Reject] [Modify]" → wait (30 min timeout)
  → no → enqueueRun() directly
```

**Global daily budget**: `maxAutoTriggeredRunsPerDay: 50` (manual triggers exempt).

**Cooldown**: After a run completes for a dedup key, block re-triggering for configurable period (default 60 min).

### 5.5 Trigger Rules Config

```yaml
trigger_rules:
  - id: sentry-critical
    source: sentry_alert
    conditions:
      - field: rawPayload.data.event.level
        operator: equals
        value: "fatal"
    pipeline: bugfix
    requiresApproval: false
    notificationChannel: "#agent-alerts"
    cooldownMinutes: 60
    maxRunsPerHour: 5

  - id: github-ci-main
    source: github_webhook
    conditions:
      - field: rawPayload.check_suite.head_branch
        operator: equals
        value: "main"
    pipeline: bugfix
    requiresApproval: true
    cooldownMinutes: 30

  - id: weekly-deps
    source: cron
    pipeline: chore
    schedule: "0 9 * * MON"
    repoSlug: "owner/repo"
    task: "Update dependencies"
```

### 5.6 Smart Observer (Optional)

Instead of dumb webhook-to-run mapping, an LLM triages incoming events:

```typescript
interface ObserverDecision {
  action: "trigger" | "discard" | "defer" | "escalate";
  confidence: number;     // 0-1
  task?: string;          // refined task description
  pipeline?: string;      // suggested pipeline
  priority?: string;
  reason: string;         // for auditing
}
```

Use a small/fast model (Claude Haiku). Strict 5-second timeout. Fallback to rule-based routing on timeout. Skipped for high-confidence triggers (cron, configured webhooks).

---

## 6. Quality Gates

### 6.1 Gate Taxonomy

| Phase | Gate | Type | Default |
|-------|------|------|---------|
| Pre-Agent | Task classification | Deterministic | Enabled |
| Pre-Agent | Base branch CI status | Deterministic | Warn only |
| Pre-Push | Diff size | Conditional | Enabled |
| Pre-Push | Forbidden files | Conditional | Enabled |
| Pre-Push | Security scan (secrets) | Deterministic | Enabled |
| Pre-Push | Security scan (SAST) | Deterministic | Disabled |
| Pre-Push | Scope judge (LLM) | Agentic | Disabled |
| Post-CI | CI check results | Async | Disabled (opt-in) |
| Post-Deploy | Smoke test | Deterministic | Disabled |
| Post-Deploy | Accessibility | Deterministic | Disabled |

### 6.2 Diff Size Gate

Profile-based thresholds:

| Profile | Soft Max Lines | Hard Max Lines | Soft Max Files | Hard Max Files |
|---------|---:|---:|---:|---:|
| bugfix | 250 | 600 | 12 | 25 |
| feature | 600 | 1500 | 25 | 60 |
| refactor | 1000 | 2500 | 40 | 120 |
| chore | 150 | 400 | 8 | 20 |

Measured via `git diff --cached --numstat --find-renames` after `git add -A`.

- **Soft exceed**: Warn, continue. Add warning to PR body.
- **Hard exceed**: Give agent one "shrink scope" fix round. If still exceeded, fail.

### 6.3 Forbidden File Patterns

**Deny (hard block, always)**:
- `**/.env*` — environment files with secrets
- `**/*.{pem,key,p12,pfx}` — certificates/keys
- `**/secrets/**`, `**/credentials/**`

**Guarded (soft-fail unless task explicitly mentions)**:
- `.github/workflows/**` — CI config
- `**/migrations/**` — DB migrations
- `**/*lock*` without corresponding manifest change (lockfile-without-manifest rule)

### 6.4 LLM-as-Judge Scope Check

Calibrated prompt biasing toward PASS (Spotify vetoes ~25%):

```
SYSTEM: You are ScopeJudge. Determine if the diff matches the original task.
CALIBRATION: Prefer PASS unless clear evidence of off-scope changes.
Test updates, import adjustments, and necessary wiring are IN-SCOPE.
Only FAIL for: unrelated refactoring, files not connected to the task,
deleting/weakening tests, security risks, config changes without justification.
```

Output: JSON with `decision` (pass/soft_fail/hard_fail), `score` (0-100), `violations[]` array with file + message + fix_hint.

### 6.5 Structured Error Re-Prompting

Replace the current raw stderr dump (`executor.ts:364-377`) with parsed, categorized, deduplicated errors:

**Current** (bad):
```
Validation failed (retry 1/2).
Fix the following errors.
```<raw 2000 chars of stderr>```
```

**Proposed** (good):
```markdown
Found 7 errors across 3 categories. Fix in priority order:

## TYPE ERRORS (2) — fix first, may resolve test failures
1. src/services/calculator.ts:47 [TS2345]: 'string' not assignable to 'number'
2. src/services/calculator.ts:52 [TS2322]: 'undefined' not assignable to 'Rate'

## TEST FAILURES (4) — 3 likely caused by type errors above
3. spec/calculator.spec.ts:23: Expected 1.5, got NaN
   (2 similar failures omitted — same root cause)

## LINT (1)
5. src/services/calculator.ts:10 [no-unused-vars]: 'oldHelper' unused

## Strategy
Fix type errors in calculator.ts first — they likely cascade into test failures.
```

**Parsing strategy**: Prefer JSON output formats (`eslint -f json`, `rspec --format json`, `rubocop --format json`) which are stable across versions. Fallback to generic `file:line: error` regex.

**Context budget**: Max 12 root cause issues, max 6000 chars, priority order: security > type/build > test > lint > style.

### 6.6 Security Scanning

**Secrets detection** (blocking): gitleaks on staged changes:
```bash
gitleaks git --staged --report-format json --report-path /tmp/gitleaks.json
```
Fallback: regex patterns for common token formats (ghp_, sk-, AKIA, xox[bporas]-).

**SAST** (optional, advisory): semgrep with `p/security-audit` ruleset on changed files only.

---

## 7. Three-Tier Enterprise Onboarding

### 7.1 Tier 0 — "Just Works" (5 env vars)

| Variable | Purpose |
|----------|---------|
| `SLACK_BOT_TOKEN` | Slack connection |
| `SLACK_APP_TOKEN` | Slack socket mode |
| `SLACK_SIGNING_SECRET` | Request verification |
| `GITHUB_TOKEN` | PR creation + repo access |
| `OPENROUTER_API_KEY` | LLM provider for Goose |

**Key changes needed**:
- `AGENT_COMMAND_TEMPLATE` gets a real default (working Goose invocation, auto-detecting LLM key)
- `DRY_RUN` defaults to `false`
- Pre-built Slack App Manifest (paste YAML into Slack's "Create from Manifest")
- Published Docker image at `ghcr.io/chocksy/gooseherd:latest`

**Pipeline**: Default (clone → agent → commit → push → PR). No CI integration, no validation.

**Time to first PR**: < 15 minutes.

### 7.2 Tier 1 — "Production Ready" (+5 env vars)

Adds to Tier 0:

| Variable | Purpose |
|----------|---------|
| `VALIDATION_COMMAND` | Local validation (lint, type check) |
| `LINT_FIX_COMMAND` | Auto-fix lint issues |
| `CI_WAIT_ENABLED=true` | Enable CI feedback loop |
| `CEMS_ENABLED=true` | Enable agent memory |
| `CEMS_API_URL` | Memory API endpoint |
| `REPO_ALLOWLIST` | Restrict which repos the bot can access |

**Pipeline**: Default + lint_fix + validate + ci_wait.

### 7.3 Tier 2 — "Enterprise" (config file)

Adds `gooseherd.yml`:

```yaml
version: 1

pipelines:
  bugfix: ./pipelines/bugfix.yml
  feature: ./pipelines/feature.yml
  chore: ./pipelines/chore.yml

quality_gates:
  diff_size: { enabled: true, profile: auto }
  forbidden_files: { enabled: true }
  security_scan: { enabled: true }
  scope_judge: { enabled: true, model: "claude-haiku-4-5" }

observers:
  sentry:
    enabled: true
    secret: ${SENTRY_WEBHOOK_SECRET}
    project_mapping:
      my-sentry-project: owner/repo
  github:
    enabled: true
    secret: ${GITHUB_WEBHOOK_SECRET}
  cron:
    schedules:
      - { cron: "0 9 * * MON", repo: "owner/repo", task: "Update dependencies" }

mcp_extensions:
  - cems
  - sentry
  - browser
```

**Priority order**: env vars > gooseherd.yml > built-in defaults. Env vars from Tier 0/1 continue to work at Tier 2.

### 7.4 Upgrade Path

```
Tier 0 → Tier 1: Add 5 env vars. Zero breaking changes.
Tier 1 → Tier 2: Create gooseherd.yml. Optionally run `npx gooseherd migrate --from-env-to-config`.
                  Env vars continue to work. Config file is purely additive.
```

### 7.5 Per-Repo Configuration

Repos can self-configure via `.gooseherd.yml` in the repo root:

```yaml
# .gooseherd.yml (in repo root)
pipeline: bugfix  # override default pipeline for this repo
quality_gates:
  diff_size:
    profile: feature  # higher thresholds for this repo
  forbidden_files:
    guarded_additions:
      - "db/schema.rb"  # repo-specific guarded file
```

Deployment-level `deny` patterns cannot be relaxed by repo config.

---

## 8. Real-World Pipeline Examples

### 8.1 Startup (Next.js + Jest + Vercel Previews)

```yaml
version: 1
name: "nextjs-startup"
nodes:
  - { id: clone, type: deterministic, action: clone }
  - { id: hydrate, type: deterministic, action: hydrate_context }
  - { id: implement, type: agentic, action: implement }
  - { id: lint_fix, type: deterministic, action: lint_fix,
      config: { command: "cd {{ctx.repoDir}} && npx eslint --fix . && npx prettier --write ." } }
  - { id: local_test, type: deterministic, action: local_test,
      config: { command: "cd {{ctx.repoDir}} && npx jest --findRelatedTests {{ctx.changedFiles}}" } }
  - { id: diff_gate, type: conditional, action: diff_quality_gate }
  - { id: commit, type: deterministic, action: commit }
  - { id: push, type: deterministic, action: push }
  - { id: wait_ci, type: async, action: wait_for_ci, config: { max_wait: 600 } }
  - { id: create_pr, type: deterministic, action: create_pr }
```

### 8.2 Enterprise Rails (RSpec + AWS Review Apps)

```yaml
version: 1
name: "rails-enterprise"
nodes:
  - { id: clone, type: deterministic, action: clone, config: { depth: 1 } }
  - { id: hydrate, type: deterministic, action: hydrate_context,
      config: { sources: [{ type: memory_search }, { type: repo_rules }, { type: related_files }] } }
  - { id: plan, type: agentic, action: plan_task, enabled: true }
  - { id: implement, type: agentic, action: implement }
  - { id: lint_fix, type: deterministic, action: lint_fix,
      config: { command: "cd {{ctx.repoDir}} && bundle exec rubocop -A --fail-level error" } }
  - { id: local_test, type: deterministic, action: local_test,
      config: { command: "cd {{ctx.repoDir}} && bundle exec rspec --fail-fast {{ctx.changedSpecFiles}}", timeout: 120 } }
  - { id: validate, type: deterministic, action: validate,
      on_failure: { action: loop, agent_node: fix_validation, max_rounds: 2 } }
  - { id: diff_gate, type: conditional, action: diff_quality_gate }
  - { id: security_scan, type: deterministic, action: security_scan }
  - { id: scope_judge, type: agentic, action: scope_judge }
  - { id: commit, type: deterministic, action: commit }
  - { id: push, type: deterministic, action: push }
  - { id: wait_ci, type: async, action: wait_for_ci,
      config: { max_wait: 1800, check_filter: ["rspec", "rubocop"] },
      on_failure: { action: loop, agent_node: fix_ci, max_rounds: 2 } }
  - { id: create_pr, type: deterministic, action: create_pr }
  - { id: browser_verify, type: agentic, action: browser_verify,
      if: "ctx.changedFiles matches '**/*.erb,**/*.html,**/*.css,**/*.js'",
      config: { review_app_url: "{{ctx.reviewAppUrl}}", checks: [smoke_test, accessibility] } }
  - { id: notify, type: deterministic, action: notify }
```

### 8.3 Python ML (pytest + mypy)

```yaml
version: 1
name: "python-ml"
nodes:
  - { id: clone, type: deterministic, action: clone }
  - { id: hydrate, type: deterministic, action: hydrate_context }
  - { id: implement, type: agentic, action: implement }
  - { id: lint_fix, type: deterministic, action: lint_fix,
      config: { command: "cd {{ctx.repoDir}} && ruff check --fix . && black . && isort ." } }
  - { id: validate, type: deterministic, action: validate,
      config: { command: "cd {{ctx.repoDir}} && mypy . --ignore-missing-imports" } }
  - { id: local_test, type: deterministic, action: local_test,
      config: { command: "cd {{ctx.repoDir}} && pytest -x {{ctx.changedTestFiles}}" } }
  - { id: diff_gate, type: conditional, action: diff_quality_gate }
  - { id: commit, type: deterministic, action: commit }
  - { id: push, type: deterministic, action: push }
  - { id: wait_ci, type: async, action: wait_for_ci }
  - { id: create_pr, type: deterministic, action: create_pr }
```

---

## 9. Implementation Phases

### Phase 1: Foundation (Pipeline Engine + Structured Errors)
- Extract current executor logic into standalone node implementations
- Build pipeline engine that reads YAML, executes nodes in order
- Implement context bag with checkpoint/resume
- Replace raw stderr dump with structured error parsing
- Gate behind `PIPELINE_ENGINE_ENABLED` flag

### Phase 2: Quality Gates
- Diff size gate (profile-based thresholds)
- Forbidden file patterns (deny + guarded + lockfile-without-manifest)
- Security scanning (gitleaks integration)
- Task type classification (keyword matcher → profile selection)

### Phase 3: CI Feedback Loop
- Add `CIMonitor` class with GitHub check polling
- Add `awaiting_ci` / `ci_fixing` phases to executor
- Implement CI fix loop (max 2 rounds, structured failure context)
- Add `LOCAL_TEST_COMMAND` with `{{changed_spec_files}}` template variable
- Heartbeat updates during CI wait

### Phase 4: Observer/Trigger System
- Webhook receiver (separate HTTP server, public-facing)
- Source adapters: Sentry, GitHub, custom
- Safety pipeline: dedup, rate limiting, budget, cooldown
- Approval gates via Slack interactive messages
- Trigger rules config

### Phase 5: Advanced
- LLM-as-judge scope validation
- Smart observer (LLM triage for incoming events)
- Browser verification via review app Playwright
- Per-repo `.gooseherd.yml` config
- `npx create-gooseherd` setup wizard
- Dashboard trigger log + gate visualization

---

## 10. Key Architectural Decisions

### Pipeline engine vs current executor?
**Both, with migration path.** Gate the pipeline engine behind a flag. Default pipeline replicates exact current behavior. Phase out `RunExecutor` once pipeline engine is proven.

### Polling vs webhooks for CI?
**Polling for v1.** Works everywhere, no public endpoint needed, simpler. Webhooks for v2 when performance matters.

### Webhook receiver: same server as dashboard?
**Separate server.** Dashboard is internal/trusted. Webhook receiver faces the internet. Different security posture.

### Where does CI polling live?
**Inside the executor** (or pipeline engine). The executor already handles the full lifecycle. Adding CI wait here keeps the linear flow intact.

### Should TriggerEvents be persisted?
**Yes.** Store in JSON file or SQLite. Enables: auditing, dedup across restarts, dashboard display, debugging.

### Manual vs auto-triggered priority?
**Manual always wins.** Manual triggers get higher priority in the queue. Auto-triggered runs are budget-limited.

---

## 11. Source References

### Detailed Research Documents (in this repo)
- `.research/pipeline-engine/configurable-pipeline-engine-research.md` — 750-line deep dive on pipeline node types, YAML format, engine architecture, real-world examples
- `docs/installation-tiers-research-2026-02-21.md` — Complete tier design, setup wizard, config management, multi-tenant architecture
- `docs/minions_v2_deep_research_2026-02-20.md` — Stripe Minions Parts 1+2, Gooseherd gap analysis, implementation priorities
- `docs/observer_system_research_2026-02-20.md` — Observer system design for auto-triggering from Sentry/Slack/GitHub

### External References
- Stripe Engineering Blog: "How we built Minions" (Parts 1 & 2, 2026)
- Spotify Engineering: "How Honk reduced development time by 33%"
- Aider: Prompt engineering benchmark findings
- Anthropic: Context engineering documentation
- Temporal.io: Durable execution model
- GitHub Actions: Workflow syntax reference
- Renovate: Self-hosted bot configuration patterns
- Dependabot: Per-repo config file patterns
