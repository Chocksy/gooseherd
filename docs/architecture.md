# Gooseherd Architecture

> How the system works, what each pipeline does, and how the pieces fit together.

## System Overview

Gooseherd is a **pipeline engine for AI coding agents** — think GitHub Actions, but instead of building/testing code, it orchestrates an AI agent to write code, validate it, and ship a PR.

```
                         ┌─────────────────────────────────────────┐
                         │            TRIGGER LAYER                │
                         │                                         │
  Slack @mention ───────▶│  ┌──────────┐                           │
  Sentry alert ─────────▶│  │ Observer  │──▶ Safety Pipeline ──┐   │
  GitHub webhook ───────▶│  │ Daemon    │   (dedup, rate limit │   │
  Slack channel msg ────▶│  └──────────┘    budget, cooldown)  │   │
                         │        │                             │   │
                         │        ▼                             │   │
                         │  ┌──────────┐    Smart Triage        │   │
                         │  │   LLM    │◀── (classify event) ──┘   │
                         │  │  Triage  │                           │
                         │  └──────────┘                           │
                         └────────────┬────────────────────────────┘
                                      │
                                      ▼
                         ┌─────────────────────────────────────────┐
                         │          ORCHESTRATION LAYER             │
                         │                                         │
                         │  ┌──────────────────────────────────┐   │
                         │  │          Run Manager             │   │
                         │  │  (queue, status, checkpoints)    │   │
                         │  └──────────────┬───────────────────┘   │
                         │                 │                       │
                         │                 ▼                       │
                         │  ┌──────────────────────────────────┐   │
                         │  │        Pipeline Engine           │   │
                         │  │  (loads YAML, walks nodes,       │   │
                         │  │   checkpoints context, loops)    │   │
                         │  └──────────────┬───────────────────┘   │
                         │                 │                       │
                         └─────────────────┼───────────────────────┘
                                           │
                  ┌────────────────────────┼────────────────────────┐
                  │                        │                        │
                  ▼                        ▼                        ▼
         ┌───────────────┐    ┌────────────────────┐    ┌─────────────────┐
         │  CORE NODES   │    │  QUALITY GATES     │    │  CI FEEDBACK    │
         │               │    │                    │    │                 │
         │  clone        │    │  classify_task     │    │  wait_ci        │
         │  hydrate      │    │  diff_gate         │    │  fix_ci         │
         │  implement    │    │  forbidden_files   │    │                 │
         │  lint_fix     │    │  security_scan     │    └─────────────────┘
         │  validate     │    │  scope_judge (LLM) │
         │  fix_valid.   │    │  browser_verify    │
         │  commit       │    │                    │
         │  push         │    └────────────────────┘
         │  create_pr    │
         │  notify       │
         └───────────────┘

                  ┌────────────────────────────────────────────────┐
                  │              OUTPUT LAYER                       │
                  │                                                │
                  │  Slack thread ◀── live status card + updates   │
                  │  GitHub PR    ◀── branch + PR + gate report    │
                  │  Dashboard    ◀── run inspector + logs + diff  │
                  └────────────────────────────────────────────────┘
```

## The Pipeline = YAML Workflow

Just like GitHub Actions uses `.github/workflows/*.yml`, Gooseherd uses `pipelines/*.yml`. Each pipeline is a list of **nodes** (steps) that the engine executes in order.

```yaml
# pipelines/full.yml — the kitchen sink
version: 1
name: "full"

nodes:
  - id: clone          # deterministic — clone the repo
  - id: hydrate        # deterministic — load context into the bag
  - id: classify_task  # deterministic — detect bugfix/feature/chore
  - id: implement      # agentic — AI agent writes the code
  - id: lint_fix       # deterministic — auto-fix lint (if configured)
  - id: validate       # deterministic — run tests (with retry loop)
  - id: diff_gate      # conditional — check diff size limits
  - id: forbidden_files # conditional — block sensitive file changes
  - id: security_scan  # deterministic — scan for secrets/vulns
  - id: scope_judge    # agentic — LLM compares diff vs task
  - id: commit         # deterministic — git commit
  - id: push           # deterministic — git push
  - id: create_pr      # deterministic — open GitHub PR
  - id: wait_ci        # async — poll CI checks (with fix loop)
  - id: browser_verify # agentic — smoke test + accessibility
  - id: notify         # deterministic — post results to Slack
```

### Pipeline Presets

You pick which pipeline to use via the `PIPELINE_FILE` env var. Think of these as increasing levels of strictness:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        PIPELINE PRESETS                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  default.yml              Bare minimum. Clone → Agent → Push → PR.     │
│  ─────────────            Like running Goose manually, but automated.  │
│  9 nodes                                                                │
│                                                                         │
│  with-quality-gates.yml   Adds pre-push checks: diff size, forbidden   │
│  ────────────────────     files, security scan, task classification.    │
│  12 nodes                 Catches obvious problems before pushing.      │
│                                                                         │
│  with-ci-feedback.yml     Adds CI loop: waits for CI to pass after     │
│  ──────────────────       PR, auto-fixes failures (up to 2 rounds).    │
│  14 nodes                 The agent iterates until CI is green.         │
│                                                                         │
│  full.yml                 Everything above + scope judge (LLM verifies │
│  ────────                 diff matches task) + browser verification     │
│  16 nodes                 (smoke test + accessibility scan). Maximum    │
│                           confidence before merging.                    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Node Types

Each node has a **type** that tells the engine how to handle it:

| Type | Behavior | Examples |
|------|----------|---------|
| `deterministic` | Runs a shell command or pure logic. Pass/fail. | clone, commit, push, lint_fix |
| `agentic` | Invokes an AI agent (Goose, LLM API). | implement, scope_judge, browser_verify |
| `conditional` | Evaluates a gate. Can soft-fail (warn) or hard-fail (abort). | diff_gate, forbidden_files |
| `async` | Polls an external service. May take minutes. | wait_ci |

### Retry Loops

Nodes can declare `on_failure` to create automatic retry loops — the engine re-runs a "fixer" agent and then re-checks:

```
┌──────────┐     fail     ┌──────────────┐     ┌──────────┐
│ validate ├─────────────▶│ fix_validation├────▶│ validate │──▶ (up to 2 rounds)
└──────────┘              └──────────────┘     └──────────┘

┌─────────┐      fail     ┌────────┐           ┌─────────┐
│ wait_ci ├──────────────▶│ fix_ci ├──────────▶│ wait_ci │──▶ (up to 2 rounds)
└─────────┘               └────────┘           └─────────┘
```

## The 20 Node Handlers

Every node maps to a handler function. Here's what each one does:

### Core Pipeline (the delivery spine)

| Node | What it does |
|------|-------------|
| `clone` | Clones the repo, creates a working branch, loads `.gooseherd.yml` per-repo config. Reports clone progress to Slack via `onDetail`. |
| `hydrate_context` | Fills the context bag with task, repo info, branch, config values |
| `plan_task` | LLM plans the implementation approach before the agent runs. Tracks token usage. |
| `implement` | Runs the AI agent (Goose) with the task prompt. The agent writes code. |
| `local_test` | Runs a local test command (if configured) before validation. Quick smoke test. |
| `lint_fix` | Runs the configured lint/format command (e.g. `rubocop -A`, `prettier --write`) |
| `validate` | Runs the validation command (e.g. `rspec`, `npm test`). Retries via fix_validation loop. |
| `fix_validation` | AI agent reads test failures and fixes the code. Then validate re-runs. |
| `commit` | Stages changes, writes a commit message, runs `git commit` |
| `push` | Pushes the branch to GitHub |
| `create_pr` | Opens a GitHub PR with title, body, and gate report summary |
| `notify` | Posts final results to Slack (success/failure card with PR link) |

### Quality Gates (pre-push verification)

| Node | What it does |
|------|-------------|
| `classify_task` | Detects if the task is a bugfix, feature, refactor, or chore. Sets diff size profile. |
| `diff_gate` | Checks that the diff isn't suspiciously large (configurable per task type) |
| `forbidden_files` | Blocks changes to sensitive files (migrations, CI config, lockfiles, etc.) |
| `security_scan` | Scans for hardcoded secrets, credentials, API keys in the diff |
| `scope_judge` | LLM-as-judge: sends diff + task to Claude, scores if the changes match the request |
| `browser_verify` | Smoke tests the review app URL (HTTP 200) + runs pa11y accessibility scan |

### CI Feedback (post-push iteration)

| Node | What it does |
|------|-------------|
| `wait_ci` | Polls GitHub check runs until CI completes. Extracts annotations + logs on failure. |
| `fix_ci` | AI agent reads CI failure details and fixes the code. Commits, pushes, loops back to wait_ci. |

## Observer System (Auto-Triggers)

The observer watches external sources and auto-creates runs when events match rules:

```
┌──────────────────┐
│  External Source  │
│                   │
│  Sentry alert     │──┐
│  GitHub webhook   │──┤
│  Slack message    │──┘
└──────────────────┘
          │
          ▼
┌──────────────────┐     ┌──────────────────┐
│  Match Trigger   │────▶│  Smart Triage     │
│  Rules (YAML)    │     │  (LLM classifies  │
│                  │     │   trigger/discard/ │
│  observer-rules/ │     │   defer/escalate)  │
│  default.yml     │     └────────┬───────────┘
└──────────────────┘              │
                                  ▼
                       ┌──────────────────┐
                       │  Safety Pipeline  │
                       │                  │
                       │  ✓ Deduplication │
                       │  ✓ Rate limiting  │
                       │  ✓ Budget check   │
                       │  ✓ Cooldown       │
                       │  ✓ Repo allowlist │
                       └────────┬─────────┘
                                │
                                ▼
                       ┌──────────────────┐
                       │  RunManager      │
                       │  .enqueueRun()   │
                       │                  │
                       │  → Pipeline      │
                       │    Engine runs   │
                       └──────────────────┘
```

## Context Bag

Data flows between nodes via a **Context Bag** — a typed key-value store that gets checkpointed to disk after each step. If the process crashes, it can resume from the last checkpoint.

```
┌──────────────────────────────────────────────────────────────┐
│                       Context Bag                             │
│                                                              │
│  repoDir: "/work/abc123/epiccoders-pxls"                    │
│  branch:  "gooseherd/fix-footer-width-abc12"                │
│  task:    "make footer full width"                           │
│  taskType: "bugfix"                                          │
│  commitSha: "a1b2c3d"                                       │
│  prNumber: 42                                                │
│  gateReport: [ {gate: "diff_gate", verdict: "pass"}, ... ]  │
│  ...                                                         │
└──────────────────────────────────────────────────────────────┘
```

## Run Lifecycle Signals

Gooseherd keeps three run lifecycle signals separate:

| Signal | Purpose | Example |
|--------|---------|---------|
| `Run.status` | Coarse execution state for queues, dashboards, retries, and terminal handling. | `queued`, `running`, `completed`, `failed` |
| `Run.phase` | Technical progress inside the selected pipeline/runtime. | `cloning`, `agent`, `pushing`, `awaiting_ci`, `ci_fixing` |
| `run_checkpoints` | Persisted, idempotent milestones that external automation may consume. | `run.waiting_external_ci`, `run.completed_without_external_wait` |

`awaiting_ci` is a phase, not a business status for new runs. When the `wait_ci` node starts waiting on GitHub checks, the run remains `status=running`, `phase=awaiting_ci`, and emits a `run.waiting_external_ci` checkpoint. Feature-delivery WorkItems consume these checkpoints through the reducer instead of advancing directly from status changes.

## Per-Repo Config

Repos can include a `.gooseherd.yml` at their root to customize pipeline behavior:

```yaml
# .gooseherd.yml — loaded from base branch (not PR branch, for security)
pipeline: with-ci-feedback        # override which pipeline to use
quality_gates:
  diff_size:
    profile: feature              # allow larger diffs
  forbidden_files:
    guarded_additions:            # extra files to guard
      - "db/schema.rb"
  scope_judge:
    enabled: true                 # opt-in to LLM scope verification
  browser_verify:
    enabled: true
    review_app_url: "https://pr-{{prNumber}}.staging.example.com"
```

## Run Lifecycle (End-to-End)

Here's what happens when you type `@gooseherd run epiccoders/pxls@master | Fix the footer width`:

```
 Slack @mention
      │
      ▼
 ┌─ RunManager ──────────────────────────────────────────────────────┐
 │  1. Parse command (repo=epiccoders/pxls, branch=master, task=...) │
 │  2. Post seed Slack message (status card)                         │
 │  3. Enqueue run                                                    │
 └────┬──────────────────────────────────────────────────────────────┘
      │
      ▼
 ┌─ Pipeline Engine (reads pipelines/default.yml) ──────────────────┐
 │                                                                   │
 │  [clone]      → git clone epiccoders/pxls, checkout master,       │
 │                 create branch gooseherd/fix-footer-abc12           │
 │                                                                   │
 │  [hydrate]    → fill context bag with task, repo info, config     │
 │                                                                   │
 │  [implement]  → run Goose agent: "Fix the footer width"           │
 │                 agent edits files in the working copy              │
 │                                                                   │
 │  [lint_fix]   → rubocop -A / prettier --write (if configured)     │
 │                                                                   │
 │  [validate]   → npm test / rspec (if configured)                  │
 │                 └─ on fail → [fix_validation] → retry validate    │
 │                                                                   │
 │  [commit]     → git add + git commit -m "gooseherd: fix footer"   │
 │                                                                   │
 │  [push]       → git push origin gooseherd/fix-footer-abc12        │
 │                                                                   │
 │  [create_pr]  → POST /repos/epiccoders/pxls/pulls                 │
 │                                                                   │
 │  [notify]     → update Slack card: "PR #42 opened ✅"             │
 │                                                                   │
 └───────────────────────────────────────────────────────────────────┘
```

## Analogy: GitHub Actions vs Gooseherd

| GitHub Actions | Gooseherd |
|---------------|-----------|
| `.github/workflows/ci.yml` | `pipelines/full.yml` |
| `uses: actions/checkout@v4` | `action: clone` |
| `uses: actions/setup-node@v4` | `action: hydrate_context` |
| `run: npm test` | `action: validate` |
| Reusable workflows | Pipeline presets (default, with-quality-gates, ...) |
| Workflow dispatch / webhooks | Observer daemon (Sentry, GitHub, Slack) |
| Matrix strategy | Retry loops (`on_failure: { action: loop }`) |
| `if: success()` / `if: failure()` | `if:` expressions + `on_soft_fail: warn` |

The key difference: in GitHub Actions the "actions" build/test your code. In Gooseherd, the nodes orchestrate an AI agent that **writes** the code, then validates, pushes, and opens a PR.

## File Map

```
src/
├── index.ts                  # Startup: wires everything together
├── config.ts                 # All env vars → AppConfig (Zod schema)
├── types.ts                  # RunRecord, RunStatus, TokenUsage, etc.
├── run-manager.ts            # Queue, concurrency, lifecycle
├── command-parser.ts         # Slack command parsing (natural + explicit formats)
├── slack-app.ts              # Slack bot (@mention, App Home, help blocks)
├── github.ts                 # GitHub API service (factory pattern, PAT + GitHub App auth)
├── store.ts                  # File-based run state persistence
├── log-parser.ts             # Goose log → structured events for dashboard
├── logger.ts                 # Structured logging utility
├── dashboard-server.ts       # Web dashboard + auth + activity stream
├── workspace-cleaner.ts      # Auto-cleanup old workspaces
├── local-trigger.ts          # CLI tool for triggering runs locally
│
├── hooks/
│   └── run-lifecycle.ts      # Run lifecycle hooks (post-run cleanup, etc.)
│
├── pipeline/
│   ├── index.ts              # Pipeline barrel export
│   ├── pipeline-engine.ts    # YAML loader → node walker → checkpointing + event logging
│   ├── pipeline-loader.ts    # YAML validation + action registry
│   ├── context-bag.ts        # Typed key-value store between nodes (with keys() iterator)
│   ├── expression-evaluator.ts # if: "config.X != ''" evaluation
│   ├── shell.ts              # Safe shell exec + shellEscape + runShellWithProgress
│   ├── types.ts              # NodeConfig, NodeHandler, NodeResult, NodeDeps, PipelineEvent
│   ├── event-logger.ts       # JSONL event logger for pipeline runs
│   ├── error-parser.ts       # Error message extraction from logs
│   │
│   ├── nodes/                # Core delivery nodes (12 handlers)
│   │   ├── clone.ts          # Git clone with progress reporting
│   │   ├── hydrate-context.ts
│   │   ├── plan-task.ts      # LLM task planning with token tracking
│   │   ├── implement.ts
│   │   ├── local-test.ts     # Local test runner (pre-validation smoke test)
│   │   ├── lint-fix.ts
│   │   ├── validate.ts
│   │   ├── fix-validation.ts
│   │   ├── commit.ts
│   │   ├── push.ts
│   │   ├── create-pr.ts
│   │   └── notify.ts
│   │
│   ├── quality-gates/        # Pre-push verification (8 files, 6 gates)
│   │   ├── classify-task-node.ts
│   │   ├── task-classifier.ts     # Pure classification logic
│   │   ├── diff-gate-node.ts
│   │   ├── diff-gate.ts           # Pure diff size logic
│   │   ├── forbidden-files-node.ts
│   │   ├── forbidden-files.ts     # Pure forbidden files logic
│   │   ├── security-scan-node.ts
│   │   ├── security-scan.ts       # Pure security scan logic
│   │   ├── scope-judge.ts         # Pure scope judge logic
│   │   ├── scope-judge-node.ts    # Node handler (with token tracking)
│   │   ├── gate-report.ts         # Gate report formatting
│   │   ├── browser-verify.ts      # Pure browser verify logic
│   │   └── browser-verify-node.ts # Node handler wrapper
│   │
│   ├── ci/                   # Post-push CI feedback
│   │   ├── ci-monitor.ts     # Pure logic (aggregate, filter, prompt)
│   │   ├── wait-ci-node.ts
│   │   └── fix-ci-node.ts
│   │
│   └── repo-config.ts        # Per-repo .gooseherd.yml loader
│
├── observer/                 # Auto-trigger system
│   ├── index.ts              # Observer barrel export
│   ├── daemon.ts             # Main daemon loop
│   ├── types.ts              # TriggerEvent, TriggerRule, SafetyDecision
│   ├── safety.ts             # Dedup, rate limit, budget, cooldown
│   ├── trigger-rules.ts      # YAML rule matching
│   ├── run-composer.ts       # TriggerEvent → RunManager input
│   ├── smart-triage.ts       # LLM-powered event classification
│   ├── state-store.ts        # Persisted observer state
│   ├── webhook-server.ts     # Separate HTTP server for webhooks
│   └── sources/
│       ├── sentry-poller.ts
│       ├── sentry-webhook-adapter.ts
│       ├── github-webhook-adapter.ts
│       ├── github-poller.ts
│       └── slack-channel-adapter.ts
│
├── llm/
│   └── caller.ts             # Thin HTTP caller for Anthropic API
│
└── memory/
    ├── provider.ts           # Memory provider interface
    └── cems-provider.ts      # CEMS memory integration

pipelines/
├── default.yml               # Bare minimum (9 nodes)
├── with-quality-gates.yml    # + quality gates (12 nodes)
├── with-ci-feedback.yml      # + CI loop (14 nodes)
└── full.yml                  # Everything (16 nodes)

observer-rules/
└── default.yml               # Trigger rule definitions

scripts/
├── setup.ts                  # Interactive setup wizard (npm run setup)
├── validate-env.ts           # Environment validation (npm run validate)
└── dummy-agent.sh            # Mock agent for testing

tests/
├── pipeline-engine.test.ts   # Pipeline engine core tests
├── pipeline-nodes.test.ts    # Node handler tests (plan-task, local-test, etc.)
├── quality-gates.test.ts     # Gate logic tests (classifier, diff, forbidden, security)
├── ci-feedback.test.ts       # CI feedback pure function tests
├── observer.test.ts          # Observer/trigger system tests (safety, rules, adapters)
├── sentry-webhook.test.ts    # Sentry webhook adapter tests
├── phase5.test.ts            # Scope judge, triage, browser verify, repo config
├── phase12.test.ts           # Dashboard auth, token usage, help blocks, events, progress
├── phase13.test.ts           # Setup wizard, GitHub App auth, team tagging
├── command-parser.test.ts    # Slack command parser (19 tests)
├── store.test.ts             # RunStore persistence tests
├── config.test.ts            # Config loading + validation tests
├── run-manager.test.ts       # RunManager lifecycle + heartbeat tests
├── slack-thread.test.ts      # Slack thread/follow-up tests
├── implement.test.ts         # Implement node tests
├── create-pr.test.ts         # PR creation node tests
├── hydrate-context.test.ts   # Context hydration tests
├── shell.test.ts             # Shell execution + progress tests
├── log-parser.test.ts        # Log parser tests
├── log-parser-snapshots.test.ts # Log parser snapshot tests
└── e2e-pipeline.test.ts      # E2E pipeline integration tests
```

## Test Coverage

466 tests across 21 test suites:

| Suite | Tests | What it covers |
|-------|-------|---------------|
| observer.test.ts | 65 | Safety pipeline, trigger rules, adapters, daemon |
| phase5.test.ts | 49 | Scope judge, smart triage, browser verify, repo config |
| quality-gates.test.ts | 44 | Classifier, diff gate, forbidden files, security scan |
| phase13.test.ts | 53 | Setup wizard, GitHub App auth, team tagging |
| phase12.test.ts | 26 | Dashboard auth, token usage, help blocks, events, clone progress |
| run-manager.test.ts | 25 | Queue, concurrency, heartbeat, lifecycle |
| shell.test.ts | 25 | Shell execution, capture, progress callbacks |
| slack-thread.test.ts | 24 | Thread follow-ups, chain resolution, retry |
| ci-feedback.test.ts | 23 | CI aggregation, filtering, prompts, abort logic |
| command-parser.test.ts | 19 | Natural/explicit format parsing, mentions, branches |
| hydrate-context.test.ts | 19 | Context bag population, config injection |
| sentry-webhook.test.ts | 17 | Sentry webhook adapter, signature verification |
| log-parser-snapshots.test.ts | 15 | Log parser output format snapshots |
| pipeline-nodes.test.ts | 14 | Plan-task, local-test, notify, screenshot nodes |
| implement.test.ts | 13 | Agent execution, prompt templating, timeout |
| create-pr.test.ts | 12 | PR creation, gate reports, diff artifacts |
| log-parser.test.ts | 11 | Goose log → structured events |
| config.test.ts | 4 | Config loading, defaults, validation |
| store.test.ts | 4 | RunStore persistence, locking, queries |
| pipeline-engine.test.ts | 2 | Engine core, node walking, checkpointing |
| e2e-pipeline.test.ts | 2 | End-to-end pipeline integration |

## Dashboard Authentication

The dashboard supports optional token-based authentication via `DASHBOARD_TOKEN`. When set:

- **API routes** (`/api/*`): require `Authorization: Bearer <token>` header or a valid session cookie
- **HTML pages** (`/`, `/runs/*`): require a `gooseherd-session` cookie (set via login page)
- **Always open**: `/healthz` and `/login` bypass auth
- **No token configured**: all routes are open (backward compat for localhost dev)

Session cookies use SHA-256 hash of the token, HttpOnly, SameSite=Strict. Token comparison uses timing-safe equality.

## Token Usage Tracking

LLM-calling nodes (plan_task, scope_judge) store token counts in the context bag under `_tokenUsage_<nodeId>` keys. After the pipeline completes, `aggregateTokenUsage()` sums all entries into a `TokenUsage` object stored on the `RunRecord`.

The dashboard displays token usage (quality gate input/output tokens) in the run detail panel.

## Pipeline Event Logger

Every pipeline run emits structured events to `<runDir>/events.jsonl`:

- `node_start` — before each node executes
- `node_end` — after each node (with outcome and duration)
- `phase_change` — when the run phase transitions
- `error` — on failures

The dashboard reads these via `GET /api/runs/:id/pipeline-events` and renders a visual timeline.

Kubernetes runner jobs also emit control-plane events through `POST /internal/runs/:runId/events`. These include `run.phase_changed`, `run.progress`, and `run.checkpoint`; the app-side Kubernetes backend drains those events while polling the job and forwards checkpoints into the same persisted `run_checkpoints` flow used by local/docker runtimes.

## Clone Progress Reporting

The clone node uses `git clone --progress` and parses stderr for progress lines (`Receiving objects: 45%`). Progress is reported to Slack via the `onDetail` callback (throttled to max once per 5 seconds) to update the run card in real time.

## Slack App Home Tab

The App Home tab (enabled in the manifest) displays help content when users open the bot's home tab. `buildHelpBlocks(config)` generates Slack Block Kit content with command reference, follow-up instructions, and quick-start examples.
