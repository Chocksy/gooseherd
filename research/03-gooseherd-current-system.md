# Gooseherd Current System — Complete Architecture Analysis

**Date:** 2026-03-13
**Purpose:** Map the entire system to identify what's essential vs. over-engineered, in preparation for a potential Karpathy-style simplification (define task -> execute -> evaluate -> iterate).

---

## 1. What Gooseherd IS

A self-hosted AI coding agent **orchestrator**. It receives a task (via Slack, dashboard, API, or auto-trigger), clones a repo, runs an AI coding agent, validates the output, and opens a PR. The "agent" itself is external — Gooseherd shells out to `pi` (pi-coding-agent) or any command matching `AGENT_COMMAND_TEMPLATE`.

**Core value proposition:** Wrap an AI coding agent in a pipeline that clones, validates, commits, pushes, and opens PRs — with retry loops when things fail.

---

## 2. Codebase Stats

| Metric | Value |
|--------|-------|
| **Total TypeScript** | ~29,200 lines across ~105 source files |
| **Dependencies** | 12 runtime, 5 dev |
| **Pipeline YAML presets** | 5 (pipeline, ui-change, complex, hotfix, docs-only) |
| **Registered node handlers** | 28 |
| **Config env vars** | ~140 |
| **Database tables** | 10 |

### Lines of Code by Module

| Module | LoC | Purpose |
|--------|-----|---------|
| `src/dashboard/` (html.ts + auth + wizard) | ~4,500 | Dashboard UI (single giant HTML file + setup wizard) |
| `src/pipeline/quality-gates/` | ~3,500 | Browser verify, diff gate, scope judge, security scan, etc. |
| `src/pipeline/nodes/` | ~3,200 | 23 individual node handler files |
| `src/pipeline/` (engine, shell, loader, etc.) | ~2,950 | Pipeline engine core, shell execution, context bag |
| `src/observer/` (daemon, state, safety) | ~2,800 | Auto-trigger daemon (Sentry, GitHub, Slack, cron) |
| `src/observer/sources/` | ~1,350 | Webhook adapters, pollers, extension loader |
| `src/dashboard-server.ts` | ~1,200 | HTTP API server (monolith) |
| `src/db/` | ~1,170 | Schema, migrations, setup store, seed |
| `src/` root files | ~4,700 | index.ts, run-manager.ts, store.ts, slack-app.ts, config.ts, etc. |
| `src/orchestrator/` | ~670 | LLM-based Slack message routing |
| `src/eval/` | ~670 | Evaluation harness (new) |
| `src/llm/` | ~580 | LLM caller (raw HTTP to OpenRouter) |
| `src/pipeline/ci/` | ~470 | CI wait + fix nodes |
| `src/sessions/` | ~440 | Multi-run goal-oriented sessions |
| `src/sandbox/` | ~440 | Docker container manager |
| `src/supervisor/` | ~340 | Run watchdog + auto-retry |
| `src/plugins/` | ~150 | Plugin loader |
| `src/memory/` | ~130 | CEMS memory integration |
| `src/hooks/` | ~70 | Run lifecycle hooks |

---

## 3. Complete Architecture Map

```
                          ┌─────────────────────────────────────────────┐
                          │              ENTRY POINTS                    │
                          │                                             │
                          │  Slack Bot ──┐                              │
                          │  Dashboard ──┤                              │
                          │  API ────────┤──▶ RunManager.enqueueRun()  │
                          │  Observer ───┤                              │
                          │  Local CLI ──┘                              │
                          └──────────────────────┬──────────────────────┘
                                                 │
                                                 ▼
                          ┌─────────────────────────────────────────────┐
                          │             RUN MANAGER                      │
                          │                                             │
                          │  PQueue (concurrency-limited)               │
                          │  processRun() → PipelineEngine.execute()    │
                          │  Slack heartbeat cards                      │
                          │  Terminal callbacks (observer, sessions)     │
                          └──────────────────────┬──────────────────────┘
                                                 │
                                                 ▼
                          ┌─────────────────────────────────────────────┐
                          │            PIPELINE ENGINE                   │
                          │                                             │
                          │  Load YAML → iterate nodes → dispatch       │
                          │  ContextBag (key-value store between nodes) │
                          │  Checkpoint/resume after each node          │
                          │  on_failure loops (fix → retry original)    │
                          │  _goto, _skipNodes, _runSubPipeline         │
                          │  Expression evaluator for `if` conditions   │
                          └──────────────────────┬──────────────────────┘
                                                 │
                                                 ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                           28 NODE HANDLERS                                     │
│                                                                               │
│  CORE (essential):          QUALITY GATES:           ADVANCED:                │
│  ├─ clone                   ├─ diff_gate             ├─ deploy_preview        │
│  ├─ hydrate_context         ├─ forbidden_files       ├─ browser_verify        │
│  ├─ implement               ├─ security_scan         ├─ fix_browser           │
│  ├─ lint_fix                ├─ scope_judge           ├─ wait_ci               │
│  ├─ validate                ├─ classify_task         ├─ fix_ci                │
│  ├─ fix_validation          │                        ├─ decide_next_step      │
│  ├─ commit                  LLM-POWERED:             ├─ upload_screenshot     │
│  ├─ push                    ├─ plan_task             ├─ retrospective         │
│  ├─ create_pr               ├─ generate_title        ├─ setup_sandbox         │
│  └─ notify                  ├─ summarize_changes     ├─ run / run_skill       │
│                             │                        └─ skill                 │
└───────────────────────────────────────────────────────────────────────────────┘
                                                 │
                                                 ▼
                          ┌─────────────────────────────────────────────┐
                          │             SHELL EXECUTION                  │
                          │                                             │
                          │  Local: bash -lc <command>                  │
                          │  Sandbox: Docker exec via AsyncLocalStorage │
                          │  mapToContainerPath() for path translation  │
                          └─────────────────────────────────────────────┘
```

---

## 4. Execution Flow: Start to Finish

### 4.1 Startup (`src/index.ts`)

1. Initialize PostgreSQL database (Drizzle ORM)
2. Run setup wizard config injection (if first boot)
3. Load config from env vars (~140 vars, all optional)
4. Load skills from `skills/` directory
5. Load plugins from `extensions/plugins/`
6. Create services: RunStore, GitHubService, CemsProvider, RunLifecycleHooks, ContainerManager, PipelineStore, LearningStore, EvalStore, PipelineEngine, RunManager, ConversationStore
7. Recover stale in-progress runs from before restart
8. Start SessionManager (multi-run goal loops, optional)
9. Start WorkspaceCleaner (background cleanup)
10. Start RunSupervisor (watchdog, optional)
11. Start ObserverDaemon (auto-triggers, optional)
12. Start Dashboard HTTP server
13. Start Slack Bot (Bolt framework)

### 4.2 Run Execution (`RunManager.processRun()`)

1. Update run status to "running", start heartbeat interval
2. Resolve pipeline file (from hint, store, or default)
3. Create AbortController for cancellation
4. Call `PipelineEngine.execute(run, ...)`
5. On success: update run with commitSha, changedFiles, prUrl, tokenUsage
6. On failure: update run with error
7. Post Slack summary, fire terminal callbacks

### 4.3 Pipeline Execution (`PipelineEngine.executePipeline()`)

For each node in the YAML pipeline:
1. Check abort signal
2. Check skipNodeIds (explicit skip from orchestrator)
3. Check `enabled` flag (YAML) vs enableNodeIds override
4. Evaluate `if` expression (e.g., `config.sandboxEnabled`)
5. Log + emit node_start event
6. Lookup handler from NODE_HANDLERS registry
7. Call handler(nodeConfig, ctx, deps) -> NodeResult
8. Log + emit node_end event
9. Process outputs: merge to ContextBag, handle `_skipNodes`, `_goto`, `_runSubPipeline`
10. On failure + `on_failure` config: enter fix loop
11. On soft_fail: warn or fail based on config
12. Checkpoint context to disk

### 4.4 The Fix Loop (`handleLoopFailure()`)

When a node fails and has `on_failure: { action: loop, agent_node: X, max_rounds: N }`:
1. For each attempt (1..N):
   a. Run the fix agent handler (e.g., fix_validation, fix_ci, fix_browser)
   b. Run lint_fix (unless fix_ci or fix_browser which commit internally)
   c. Re-run the original failed node
   d. If success: break, pipeline continues
   e. If fail: accumulate failure history, try next round
2. If exhausted: fail_run or complete_with_warning

### 4.5 The Default Pipeline (`pipelines/pipeline.yml`)

```
clone → setup_sandbox? → classify_task → generate_title → plan_task? →
hydrate → implement → lint_fix? → validate? (loop: fix_validation) →
local_test? (loop: fix_validation) → diff_gate → forbidden_files →
security_scan → scope_judge? → commit → push → create_pr →
summarize_changes? → deploy_preview? → browser_verify? (loop: fix_browser) →
decide_recovery? → wait_ci (loop: fix_ci) → upload_screenshot? → notify
```

Nodes marked with `?` are conditional (if expression or enabled: false by default).

---

## 5. Module-by-Module Breakdown

### 5.1 Pipeline Engine (`src/pipeline/pipeline-engine.ts` — 884 LoC)

The heart of the system. Loads YAML, iterates nodes, dispatches to handlers. Key features:
- **ContextBag**: typed key-value store passed between nodes, checkpointed to disk after each step
- **Fix loops**: on_failure triggers agent → retry pattern
- **Expression evaluator**: `if: "config.sandboxEnabled"` conditions on nodes
- **Dynamic flow control**: `_goto`, `_skipNodes`, `_runSubPipeline` outputs from nodes
- **Sandbox integration**: AsyncLocalStorage-based context for Docker-out-of-Docker
- **Pipeline overrides**: per-repo `.gooseherd.yml` can switch pipelines mid-execution
- **Sub-pipeline invocation**: nodes can trigger inline execution of another pipeline

### 5.2 Shell Execution (`src/pipeline/shell.ts` — 419 LoC)

Three shell functions: `runShell`, `runShellWithProgress`, `runShellCapture`. Each has dual paths:
- **Local**: `bash -lc <command>` via `child_process.spawn`
- **Sandbox**: `ContainerManager.exec()` via Docker API

Uses AsyncLocalStorage to transparently route commands through Docker when running in sandbox context. `mapToContainerPath()` translates host paths to container paths.

### 5.3 Node Handlers (28 total, ~3,200 LoC)

**Core execution nodes:**
- `clone` (135 LoC): git clone, checkout branch, load `.gooseherd.yml`
- `hydrate_context` (375 LoC): build prompt file with task + repo context + memory enrichment + repo structure + readme
- `implement` (234 LoC): shell out to AI agent command, analyze git diff output
- `commit` (39 LoC): git add + commit
- `push` (54 LoC): git push (refresh token for GitHub App)
- `create_pr` (243 LoC): GitHub API PR creation with rich body

**Validation nodes:**
- `validate` (57 LoC): run validation command
- `lint_fix` (44 LoC): run lint fix command
- `local_test` (47 LoC): run test command
- `fix_validation` (55 LoC): write error context to prompt, re-run agent

**Quality gate nodes:**
- `diff_gate` (via diff-gate.ts, ~130 LoC): check diff for red flags (mass deletion, whitespace-only)
- `forbidden_files` (via forbidden-files.ts): check for forbidden file patterns
- `security_scan` (via security-scan.ts): scan for leaked secrets/keys
- `scope_judge` (via scope-judge.ts): LLM-based scope verification
- `classify_task` (~100 LoC): LLM classification of task complexity

**Browser verification chain:**
- `browser_verify` (662 LoC): Stagehand agent + curl smoke + pa11y accessibility
- `deploy_preview` (378 LoC): resolve preview URL (url_pattern, GitHub API, command)
- `fix_browser` (255 LoC): compose fix prompt from browser verdict + DOM findings
- `upload_screenshot` (181 LoC): upload screenshots/video to PR via GitHub API
- `stagehand_verify` (620 LoC): Stagehand/Playwright browser agent interaction

**CI feedback loop:**
- `wait_ci` (203 LoC): poll GitHub check runs
- `fix_ci` (via fix-ci-node.ts): compose CI fix prompt, run agent
- `ci-monitor` (188 LoC): shared CI polling logic

**LLM-powered nodes:**
- `generate_title` (67 LoC): LLM generates short PR title
- `summarize_changes` (104 LoC): LLM summarizes code diff
- `plan_task` (100 LoC): LLM breaks complex task into steps
- `decide_next_step` (179 LoC): LLM decides whether to skip remaining nodes
- `retrospective` (148 LoC): LLM post-mortem analysis

**Utility nodes:**
- `notify` (97 LoC): post completion to Slack
- `run` (81 LoC): run arbitrary shell command
- `skill` / `run_skill` (214 + 72 LoC): execute registered skill scripts
- `setup_sandbox` (62 LoC): deferred Docker container creation

### 5.4 Run Manager (`src/run-manager.ts` — 863 LoC)

Wraps PipelineEngine with:
- **PQueue**: concurrency-limited job queue
- **Slack integration**: post/update run status cards with spinners, heartbeat, feedback buttons
- **Error classification**: regex-based error categorization (clone, timeout, no_changes, etc.)
- **Run lifecycle**: enqueue, retry, continue (follow-up), cancel
- **Terminal callbacks**: notify observer, session manager, learning store

~60% of this file is Slack card formatting (Block Kit JSON construction).

### 5.5 Observer Daemon (`src/observer/daemon.ts` — 646 LoC)

Auto-trigger system that watches external sources and creates runs:
- **Sentry poller**: polls for new issues, maps project -> repo
- **GitHub poller**: watches for failed Actions runs
- **Webhook server**: receives GitHub/Sentry/custom webhooks
- **Slack channel adapter**: watches channel messages from alert bots
- **Cron scheduler**: time-based triggers via YAML rules
- **Safety pipeline**: dedup, rate limiting, daily caps, repo allowlist
- **Smart triage**: optional LLM classification (discard/defer/trigger/escalate)
- **Autonomous scheduler**: deferred event queue with capacity-based scheduling
- **Learning store**: records outcomes per rule for feedback loop

Supporting files: `state-store.ts` (324 LoC), `safety.ts` (284 LoC), `trigger-rules.ts` (186 LoC), `webhook-server.ts` (299 LoC), `learning-store.ts` (349 LoC), various adapters (~1,350 LoC total).

### 5.6 Dashboard (`src/dashboard-server.ts` + `src/dashboard/html.ts` — ~5,700 LoC total)

- `dashboard-server.ts` (1,197 LoC): HTTP server with ~40 API routes, static file serving, auth middleware, setup wizard
- `html.ts` (3,755 LoC): single file containing the entire dashboard SPA as a template literal (HTML + CSS + JS)
- `wizard-html.ts` (530 LoC): setup wizard HTML
- `auth.ts` (221 LoC): token-based auth

### 5.7 Slack App (`src/slack-app.ts` — 765 LoC)

Bolt-based Slack app with:
- Message handler routing through LLM orchestrator
- Fast-path for help/status/tail commands
- Casual message filtering
- Feedback button handlers
- Observer approval buttons

### 5.8 Orchestrator (`src/orchestrator/` — 670 LoC)

LLM-based message routing for Slack conversations:
- Takes a Slack message + conversation history
- Calls LLM with tool definitions (execute_task, list_runs, get_config, get_run_status, cancel_run, get_run_logs)
- LLM decides: answer directly, or call a tool
- Supports multi-turn conversation via ConversationStore

### 5.9 Session Manager (`src/sessions/session-manager.ts` — 440 LoC)

Multi-run goal-oriented loops:
- LLM plans steps from a high-level goal
- Executes each step as a separate pipeline run
- LLM evaluates progress after each run (continue/done/fail/replan)
- Backed by PostgreSQL sessions table

### 5.10 Sandbox (`src/sandbox/` — 436 LoC)

Docker-out-of-Docker isolation:
- `container-manager.ts` (263 LoC): create/exec/destroy containers via Dockerode
- Bind mount: `hostWorkPath/{runId}:/work`
- AsyncLocalStorage routing: concurrent runs never interfere
- Image resolver for per-repo Dockerfiles
- Orphan cleanup on startup

### 5.11 Supervisor (`src/supervisor/run-supervisor.ts` — 314 LoC)

Watchdog process:
- Tracks active runs via node events
- Detects stale runs (no node event for N seconds)
- Detects timed-out runs (total wall clock exceeded)
- Auto-retries with cooldown and daily cap
- Failure classification for retryability

### 5.12 Evaluation System (`src/eval/` — 670 LoC, NEW)

Eval harness inspired by the Karpathy pattern:
- `types.ts` (97 LoC): scenario/judge/result type definitions
- `scenario-loader.ts` (67 LoC): YAML scenario parser
- `eval-runner.ts` (149 LoC): enqueue run -> wait for completion -> run judges -> store result
- `judges.ts` (261 LoC): 8 judge types (status, files_changed, diff_contains, pr_created, gate_verdict, browser_verdict, retro_quality, llm_judge)
- `eval-store.ts` (95 LoC): Drizzle CRUD for eval_results table
- `scripts/run-eval.ts` (159 LoC): CLI entry point

### 5.13 LLM Caller (`src/llm/caller.ts` — 521 LoC)

Raw HTTP caller to OpenRouter (OpenAI-compatible API):
- Supports text, vision, and tool-use calls
- Retry with exponential backoff (429, 502, 503)
- JSON mode
- Token counting + cost tracking
- Model price table (`model-prices.ts`)

### 5.14 Database (`src/db/` — 1,170 LoC)

PostgreSQL via Drizzle ORM:
- 10 tables: runs, learning_outcomes, observer_dedup, observer_rate_events, observer_daily_counters, observer_poll_cursors, observer_rule_outcomes, pipelines, sessions, conversations, auth_credentials, eval_results, setup
- Setup store with encrypted fields (bytea) for secrets
- Drizzle Kit for migrations

### 5.15 Config (`src/config.ts` — 547 LoC)

~140 environment variables parsed via Zod. Every feature is opt-in via env var. The AppConfig interface has 90+ fields.

---

## 6. Dependencies

| Dependency | Purpose | Essential? |
|------------|---------|------------|
| `@browserbasehq/stagehand` | Browser agent for visual verification | No — advanced feature |
| `@octokit/rest` + `@octokit/auth-app` | GitHub API (PRs, checks, deployments) | Yes for PR creation |
| `@slack/bolt` | Slack bot framework | No — one of multiple entry points |
| `dockerode` | Docker API for sandbox containers | No — optional feature |
| `dotenv` | .env file loading | Yes (trivial) |
| `drizzle-orm` + `postgres` | Database ORM + driver | Yes |
| `p-queue` | Concurrency-limited job queue | Yes (could use simpler impl) |
| `playwright` | Browser automation (Stagehand dependency) | No — advanced feature |
| `yaml` | YAML parsing (pipelines, scenarios) | Yes |
| `zod` | Schema validation | Yes (config, browser verify) |
| `deepmerge` | Deep object merging | Minimal use |

---

## 7. The Core Loop — What's Underneath All the Abstractions

Strip away everything optional, and the essential loop is:

```
1. RECEIVE task + repo
2. CLONE repo, create branch
3. WRITE prompt file with task context
4. RUN AI agent (shell out to coding agent CLI)
5. CHECK if agent made meaningful changes
6. VALIDATE (lint, tests) — retry with agent if fails
7. COMMIT + PUSH
8. CREATE PR
9. REPORT result
```

**That's 9 steps. The system wraps this in ~29,000 lines of TypeScript.**

The Karpathy-style core loop equivalent would be:

```
while not done:
    define_task(context)
    result = execute(task)      # steps 2-8
    evaluation = evaluate(result)
    context = update(context, evaluation)
```

---

## 8. Complexity Assessment

### 8.1 Essential (Must Keep)

| Component | Why Essential |
|-----------|--------------|
| Git operations (clone, branch, commit, push) | Core functionality |
| Agent invocation (shell out to coding agent) | Core functionality |
| Validation + retry loop | The key quality mechanism |
| PR creation via GitHub API | Core output |
| Run state management (queue, status) | Concurrency control |
| Prompt construction (task + repo context) | Agent needs context |
| Config loading | Minimal env var parsing |

### 8.2 Valuable but Could Be Simpler

| Component | Simplification Opportunity |
|-----------|---------------------------|
| **Pipeline YAML engine** | 5 presets that are 80% identical. Could be a single hardcoded pipeline with feature flags instead of a full YAML DSL with expression evaluator, goto, sub-pipelines, checkpoint/resume |
| **ContextBag** | Over-engineered shared state. A plain object passed between functions would suffice |
| **28 node handlers** | Most are <60 LoC wrappers. Could be inline functions in a single pipeline |
| **Dashboard** (5,700 LoC) | 3,755 LoC of HTML-in-JS. Could be a separate SPA or even just a log viewer |
| **RunManager** (863 LoC) | ~500 LoC is Slack card formatting. Separate concerns |
| **Config** (547 LoC, 140 env vars) | Most features are optional. Could be a smaller config with sensible defaults |
| **LLM caller** (521 LoC) | Works well, but could use an SDK instead of raw HTTP |

### 8.3 Over-Engineered (Candidates for Removal)

| Component | LoC | Why Over-Engineered |
|-----------|-----|---------------------|
| **Observer daemon** | ~4,150 | Full auto-trigger system (Sentry, GitHub, Slack, cron, webhooks) with safety pipeline, smart triage, dedup, rate limiting, daily caps, autonomous scheduler, learning store. This is a second product bolted onto the core. |
| **Browser verification chain** | ~2,700 | Stagehand agent, CDP screencast, pa11y, curl smoke, auth credential store, browser-verify-routing, fix_browser. Impressive but complex; visual verification is a separate concern. |
| **Session manager** | ~440 | Multi-run goal loops — LLM plans steps, executes each as a separate run. Rarely used. |
| **Orchestrator** | ~670 | LLM-based Slack message routing with tool use. Could be pattern matching. |
| **Supervisor** | ~340 | Watchdog + auto-retry. The pipeline engine already has retry loops. |
| **Plugins** | ~150 | Plugin loader for extension node handlers. No plugins exist yet. |
| **Skills** | ~286 | Skill registry + execution. Adds a layer of indirection. |
| **Sandbox** | ~440 | Docker-out-of-Docker. Necessary for security in production, but adds complexity everywhere (dual code paths in shell.ts, path mapping). |
| **Pipeline YAML DSL features** | — | goto, sub-pipelines, checkpoint/resume, expression evaluator, dynamic skipping. Used by <5% of runs. |
| **Setup wizard** | ~900 | First-boot config wizard with encrypted storage. Could be a simple env file. |

---

## 9. Pain Points and Areas of Over-Engineering

### 9.1 The YAML Pipeline DSL is a Mini Programming Language

The pipeline engine supports:
- Conditional execution (`if` expressions with a custom evaluator)
- Loops (`on_failure` with retry)
- Goto/jump (`_goto` output)
- Sub-pipeline invocation (`_runSubPipeline`)
- Dynamic node skipping (`_skipNodes` output)
- Checkpoint/resume (crash recovery)
- Pipeline switching mid-execution (per-repo overrides)

This is effectively a workflow engine. The 5 pipeline presets are 80% identical — they share the same nodes in slightly different configurations. The "orchestrator" (LLM in Slack) also manipulates `skipNodes` and `enableNodes` to customize behavior, making the YAML somewhat redundant.

### 9.2 Dual Code Paths Everywhere (Sandbox vs. Local)

Every shell function has `if (sandbox) { docker exec } else { local spawn }`. The `mapToContainerPath()` function is called in ~15 places. AsyncLocalStorage adds invisible state. This doubles the testing surface.

### 9.3 The Dashboard is a 3,755-Line Template Literal

The entire SPA (HTML + CSS + JavaScript) lives in a single TypeScript template literal. No framework, no build step, no component model. Changes require reading through a massive string.

### 9.4 140 Config Variables

Every feature is a separate env var. The AppConfig interface has 90+ fields. This makes the system highly configurable but hard to reason about — any combination of 140 booleans/strings could produce unexpected behavior.

### 9.5 Slack is Deeply Coupled

The RunManager is ~60% Slack formatting code. The Observer daemon posts to Slack. The orchestrator is Slack-specific. Removing Slack support would require gutting multiple modules.

### 9.6 The Observer is a Second Product

The observer daemon (4,150 LoC) is a complete auto-trigger system with:
- Multiple source adapters (Sentry, GitHub, Slack, cron, webhooks)
- Safety pipeline (dedup, rate limiting, daily caps)
- Smart triage (LLM-based event classification)
- Autonomous scheduler (deferred event queue)
- Learning store (outcome tracking per rule)
- Webhook server (separate HTTP listener)
- State persistence (6 database tables just for observer state)

This is arguably a bigger system than the core pipeline executor.

---

## 10. The Evaluation System (New, Promising)

The eval system (`src/eval/`, 670 LoC) is the newest addition and is actually the closest thing to the Karpathy pattern:

```yaml
# evals/homepage-title.yml
name: homepage-title
repo: epiccoders/pxls
task: "Change the homepage h1 title..."
pipeline: ui-change
judges:
  - type: status
    expect: completed
  - type: files_changed
    expect_any: ["app/views/landing/index.html.erb"]
  - type: diff_contains
    patterns: ["Welcome to Epic Pixels"]
  - type: browser_verdict
    expect: pass
```

Flow: define scenario (YAML) -> execute (enqueue run, wait) -> evaluate (run judges) -> store result.

8 judge types: status, files_changed, diff_contains, pr_created, gate_verdict, browser_verdict, retro_quality, llm_judge.

This is the seed of the simpler system. It already implements the "define task -> execute -> evaluate" pattern. The missing piece is the "iterate" step (automatically refine based on evaluation results).

---

## 11. What a Karpathy-Style Rewrite Would Look Like

### The Essential Core (~2,000 LoC estimated)

```
SimpleAgent {
  config: { repo, agentCommand, githubToken, workRoot }

  async run(task: string): Result {
    // 1. Clone
    workDir = clone(repo)

    // 2. Build prompt
    prompt = buildPrompt(task, workDir)

    // 3. Execute agent
    agentResult = shell(agentCommand, { cwd: workDir, prompt })

    // 4. Evaluate
    if (noChanges(workDir)) return fail("no changes")
    if (validationCommand) {
      result = shell(validationCommand, { cwd: workDir })
      if (result.failed) {
        // Retry loop: fix -> validate -> repeat
        for (attempt of maxRetries) {
          shell(agentCommand, { prompt: fixPrompt(result) })
          result = shell(validationCommand)
          if (result.ok) break
        }
      }
    }

    // 5. Ship
    commit(workDir)
    push(workDir)
    prUrl = createPR(workDir)

    return { prUrl, changedFiles }
  }
}
```

### What Gets Cut

| Cut | Savings | Risk |
|-----|---------|------|
| YAML pipeline DSL + expression evaluator | ~1,500 LoC | None — hardcode the pipeline |
| 28 separate node handler files | ~3,200 LoC | None — inline the ~9 essential steps |
| Observer daemon + all sources | ~4,150 LoC | Lose auto-triggers (can add webhooks later) |
| Browser verification chain | ~2,700 LoC | Lose visual verification |
| Dashboard (or replace with minimal UI) | ~5,700 LoC | Lose rich dashboard |
| Session manager | ~440 LoC | Lose multi-run sessions |
| Orchestrator (LLM Slack routing) | ~670 LoC | Use pattern matching |
| Supervisor | ~340 LoC | Simpler timeout handling |
| Plugins + Skills | ~436 LoC | Lose extensibility |
| Sandbox (dual paths) | ~440 LoC | Lose Docker isolation |
| Setup wizard | ~900 LoC | Use env vars |
| ContextBag + checkpoint | ~200 LoC | Use plain objects |

**Total potential savings: ~20,000+ LoC (from 29,200 to ~5,000-8,000)**

### What Gets Kept

1. Git operations (clone, commit, push) — essential
2. Agent shell-out — essential
3. Validation + retry loop — the key quality mechanism
4. GitHub API (PR creation, check runs) — essential for output
5. LLM caller — useful for title generation, cost tracking
6. Database (runs table) — state tracking
7. HTTP API (simplified) — entry point
8. Eval harness — the "evaluate" part of the loop

---

## 12. Summary

Gooseherd is a well-built system that has grown organically to handle many production concerns (auto-triggers, browser verification, Docker sandboxing, multi-run sessions, learning loops). However, the core value is a 9-step pipeline that wraps an external AI coding agent. The ~29,000 LoC reflects the accumulation of features around that core.

For a Karpathy-style rewrite, the target is: **extract the 9-step core loop, add a proper evaluation mechanism, and let the iteration happen through the eval harness rather than through ever-more-complex pipeline YAML and node handlers.**

The existing eval system (`src/eval/`) is already 80% of the way to the "evaluate" step. The main insight is that quality should come from **running the loop again with better context**, not from adding more nodes to a single pipeline run.
