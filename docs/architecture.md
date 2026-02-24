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
                         │  │  (queue, concurrency, lifecycle) │   │
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

## The 18 Node Handlers

Every node maps to a handler function. Here's what each one does:

### Core Pipeline (the delivery spine)

| Node | What it does |
|------|-------------|
| `clone` | Clones the repo, creates a working branch, loads `.gooseherd.yml` per-repo config |
| `hydrate_context` | Fills the context bag with task, repo info, branch, config values |
| `implement` | Runs the AI agent (Goose) with the task prompt. The agent writes code. |
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
├── config.ts                 # All env vars → AppConfig
├── run-manager.ts            # Queue, concurrency, lifecycle
├── executor.ts               # Legacy executor (pre-pipeline)
├── slack-app.ts              # Slack bot (@mention handler)
├── github.ts                 # GitHub API service
├── store.ts                  # File-based run state persistence
├── dashboard-server.ts       # Web dashboard
├── workspace-cleaner.ts      # Auto-cleanup old workspaces
│
├── pipeline/
│   ├── pipeline-engine.ts    # YAML loader → node walker → checkpointing
│   ├── pipeline-loader.ts    # YAML validation + action registry
│   ├── context-bag.ts        # Typed key-value store between nodes
│   ├── expression-evaluator.ts # if: "config.X != ''" evaluation
│   ├── shell.ts              # Safe shell exec + shellEscape
│   ├── types.ts              # NodeConfig, NodeHandler, NodeResult, etc.
│   │
│   ├── nodes/                # Core delivery nodes
│   │   ├── clone.ts
│   │   ├── hydrate-context.ts
│   │   ├── implement.ts
│   │   ├── lint-fix.ts
│   │   ├── validate.ts
│   │   ├── fix-validation.ts
│   │   ├── commit.ts
│   │   ├── push.ts
│   │   ├── create-pr.ts
│   │   └── notify.ts
│   │
│   ├── quality-gates/        # Pre-push verification
│   │   ├── classify-task-node.ts
│   │   ├── diff-gate-node.ts
│   │   ├── forbidden-files-node.ts
│   │   ├── security-scan-node.ts
│   │   ├── scope-judge.ts          # Pure logic
│   │   ├── scope-judge-node.ts     # Node handler wrapper
│   │   ├── browser-verify.ts       # Pure logic
│   │   └── browser-verify-node.ts  # Node handler wrapper
│   │
│   ├── ci/                   # Post-push CI feedback
│   │   ├── ci-monitor.ts     # Pure logic (aggregate, filter, prompt)
│   │   ├── wait-ci-node.ts
│   │   └── fix-ci-node.ts
│   │
│   └── repo-config.ts        # Per-repo .gooseherd.yml loader
│
├── observer/                 # Auto-trigger system
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
│       ├── github-webhook-adapter.ts
│       └── slack-channel-adapter.ts
│
├── llm/
│   └── caller.ts             # Thin HTTP caller for Anthropic API
│
└── memory/
    └── cems-provider.ts      # Optional memory integration

pipelines/
├── default.yml               # Bare minimum (9 nodes)
├── with-quality-gates.yml    # + quality gates (12 nodes)
├── with-ci-feedback.yml      # + CI loop (14 nodes)
└── full.yml                  # Everything (16 nodes)

observer-rules/
└── default.yml               # Trigger rule definitions

tests/
├── pipeline.test.ts          # Pipeline engine + loader tests
├── quality-gates.test.ts     # Gate logic tests
├── ci-monitor.test.ts        # CI feedback pure function tests
├── observer.test.ts          # Observer/trigger system tests
├── phase5.test.ts            # Scope judge, triage, browser verify, repo config
└── snapshot.test.ts          # Log inspector snapshot tests
```

## Test Coverage

201 tests across 6 test suites:

| Suite | Tests | What it covers |
|-------|-------|---------------|
| pipeline.test.ts | 30 | Engine, loader, context bag, expressions, error parser |
| quality-gates.test.ts | 44 | Classifier, diff gate, forbidden files, security scan |
| ci-monitor.test.ts | 22 | CI aggregation, filtering, prompts, abort logic |
| observer.test.ts | 55 | Safety pipeline, trigger rules, adapters, daemon |
| phase5.test.ts | 49 | Scope judge, smart triage, browser verify, repo config |
| snapshot.test.ts | 1 | Log inspector output format |
