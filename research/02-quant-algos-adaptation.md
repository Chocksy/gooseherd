# Quant-Algos Autoresearch: Deep Research Report

## Overview

The quant-algos autoresearch system is an autonomous strategy optimization loop that uses Claude Code (via `claude -p` non-interactive mode) to continuously propose, test, and evaluate trading strategy parameter changes and structural code modifications. The system ran for 4+ hours autonomously, executing 18+ experiment sessions against QuantConnect cloud backtests for the THT (Trend-High-Timing) strategy.

The system lives at `/Users/razvan/Development/quant-algos/trade-analyzer/` with the autoresearch module at `trade_analyzer/autoresearch/`.

---

## 1. program.md — The Core Process Document

**File**: `/Users/razvan/Development/quant-algos/trade-analyzer/program.md`

program.md is a 95-line instruction document designed to be fed directly to Claude Code as a prompt. It establishes an **infinite loop** with explicit steps:

### The Loop Structure

1. **Setup**: Read the file, check current champion (`quant research champion --strategy THT --json`), check history (`quant research history --strategy THT --limit 20`), read the research profile.

2. **Step 1 — Propose**: Based on champion metrics, experiment history, and research profile, propose ONE parameter change. Specific guidance: try unexplored areas, combine individually-good changes, try the opposite of failures.

3. **Step 2 — Run**: Execute `quant backtest run --strategy THT --json` with parameter overrides, always piping to a log file to prevent context flooding.

4. **Step 3 — Extract Metrics**: Parse JSON output for 6 key metrics: total_orders, compounding_annual_return, sharpe_ratio, max_drawdown_pct, win_rate, profit_loss_ratio.

5. **Step 4 — Score**: Compute composite fitness using a weighted formula:
   - 40% normalized Sharpe (capped at 2.0)
   - 30% normalized CAGR (capped at 20%)
   - 20% drawdown penalty (50% DD = zero score)
   - 10% normalized profit factor (capped at 2.0)
   - Hard filters: < 500 trades, > 60% drawdown, < 50% win rate = auto-DISCARD

6. **Step 5 — Keep or Discard**: >= 2% improvement over champion = KEEP (new champion), otherwise DISCARD.

7. **Step 6 — Crash Recovery**: Read log, retry network errors once, skip parameter validation errors, stop after 5 consecutive failures.

8. **Step 7 — Never Stop**: Go back to Step 1. Never repeat params.

### Rules
- Never stop until interrupted
- Never repeat parameters
- Change 1-5 params per experiment
- Never touch: StartDate, EndDate, Benchmark, DebugTickers, AccountSize, Strategy
- Log everything
- After 10 experiments, try something novel
- Always redirect output to save context window

### Key Design Insight

program.md is designed for Claude Code running interactively — it assumes Claude can execute shell commands, read files, and maintain conversation context. However, the **actual production system** (the Python autoresearch module) implements these same steps programmatically, using Claude only for the "propose" step. This dual-track design means the system works both ways: Claude can run the loop manually via program.md, or the Python loop can orchestrate it automatically.

---

## 2. The Autoresearch Module — File-by-File Breakdown

### `__init__.py`
One-line docstring. Pure package marker.

### `_cli.py` — Claude CLI Interface
**The bridge between Python and Claude Code.** Two functions:
- `call_claude(prompt, model, timeout)`: Invokes `claude -p` in non-interactive mode with `--output-format text --model <model>`. Strips the `CLAUDECODE` env var to prevent nested session conflicts. No timeout by default (lets Claude work as long as needed).
- `parse_json(text)`: Extracts JSON from LLM responses, handling markdown fences and finding the first `{...}` block.

### `experiment.py` — Data Models
Three dataclasses:
- **Proposal**: LLM output — name, hypothesis, reasoning, param_overrides, mode (param/code/research/create), optional code_changes and strategy_name.
- **FitnessResult**: Composite score + component breakdown + optional hard_filter_failed reason.
- **Experiment**: Full experiment record with all metadata (id, strategy, mode, metrics, fitness, verdict, timing, code_diff, etc.). Factory method `from_proposal()` for creation.

### `evaluator.py` — Fitness Scoring Engine
Implements the exact scoring formula from program.md:
- **Hard filters**: MIN_TRADES=500, MAX_DRAWDOWN_PCT=60.0, MIN_WIN_RATE_PCT=50.0
- **Composite score**: 0.40*norm_sharpe + 0.30*norm_cagr + 0.20*dd_penalty + 0.10*norm_pf
- **evaluate_verdict()**: Compares fitness to champion. >= 2% improvement = KEEP, otherwise DISCARD. First experiment with no champion automatically becomes champion.

### `db.py` — SQLite Persistence Layer
CRUD operations against two tables:
- **research_experiments**: Full experiment records with 21 columns (id, strategy, mode, name, hypothesis, reasoning, param_overrides, code_diff, git_branch, research_source, run_id, backtest_id, status, metrics, fitness_score, fitness_components, champion_fitness, improvement_pct, verdict, model_used, duration_seconds, created_at).
- **research_champions**: One row per strategy (strategy PK, experiment_id, fitness_score, param_overrides, metrics, promoted_at).
- Key queries: `is_duplicate_proposal()` (prevents repeat experiments), `count_recent_discards()` (exhaustion detection).

### `code_mode.py` — Structural C# Strategy Changes (817 lines)
The most complex module. Two capabilities:

**1. Code Mode** — Modify existing strategy files:
- `propose_code_change()`: Sends current Template.cs + Config.cs source to Claude Opus with a detailed prompt asking for search-and-replace diffs. Returns a Proposal with `code_changes: [{file, search, replace}]`.
- `apply_code_changes()`: Validates changes against ALLOWED_PATHS and FORBIDDEN_FILES, resolves canonical paths (prevents ../ traversal), applies search-and-replace to C# files, returns git diff.
- `revert_code_changes()`: Runs `git checkout -- <files>` to undo changes after backtest.
- Safety: Only allows modifications under `Architecture/Core/{Templates,Helpers,Models,Implementations}/`. Never touches Main.cs, config.json, or .csproj.

**2. Create Mode** — Generate entirely new strategies:
- `gather_research_material()`: Collects ALL strategy-relevant documents from the entire repo — markdown docs, research profiles, QC strategy projects (main.py/Main.cs), In & Out Strategies, Research folder, Books folder, even deleted templates from git history.
- `extract_strategy_ideas()`: Sends each research doc to Claude Sonnet to extract trading strategy ideas as JSON. Each idea saved as a separate file with status='pending'.
- `build_strategy_from_idea()`: Takes a single idea + THT reference (Template.cs + Config.cs) + all helper sources and asks Claude Opus to generate complete, compilable Template.cs + Config.cs files.
- `fix_strategy()`: When a created strategy fails (compile error, 0 trades, bad metrics), sends the broken code + error feedback + working reference back to Claude Opus for fixing. Up to MAX_CREATE_ATTEMPTS=10 fix cycles per idea.
- `validate_strategy_result()`: Minimal bar — must place 5+ orders, have non-null win rate, not 0% win rate with many orders.

### `loop.py` — Main Orchestration Loop (951 lines)
The heart of the system. Consolidated from 6 original modules (proposer.py, context.py, explorer.py, safety.py, lifecycle.py).

**Core function: `run_loop()`**
- Parameters: strategy, mode (param/code/research/create), model (sonnet/opus/haiku), max_experiments, champion_preset, research_profile, verbose, dry_run, skip_tests, research_interval.
- Runs an infinite `while True` loop with circuit breaker (5 consecutive failures = stop).
- Every 10th iteration, checks for exhaustion (plateau/convergence).
- Auto-discovers research profile from `research_profiles/{strategy}.md`.

**Four Iteration Modes**:

1. **Param Mode** (default): Builds a context prompt with champion metrics + full experiment history + research profile + output format instructions. Sends to Claude via `call_claude()`. Claude returns JSON with name, hypothesis, reasoning, param_overrides. Dedup check against last 100 experiments.

2. **Research Mode** (every Nth iteration): Sends a richer prompt that instructs Claude Code to actively USE its tools — read C# source code, check GitHub issues, explore other templates, read research docs. Claude Code gets full access to Bash, file reading, etc. The prompt says "USE THEM to research" and provides specific paths and commands. No timeout. This is the mode that produced the 182KB session transcripts where Claude was reading THTTemplate.cs, checking GitHub issue #134 about FRAMA, and analyzing FVBPivotLookback mechanics.

3. **Code Mode**: Reads strategy Template.cs + Config.cs from disk, summarizes history, sends to Claude Opus with detailed code-change prompt. Changes applied via search-and-replace, backtested, then always reverted (changes recorded in experiment for reference).

4. **Create Mode**: Pulls pending ideas from `strategy_ideas/` directory. For each idea, runs build-test-fix loop up to 10 attempts. If no pending ideas, first gathers all research material and extracts ideas via Claude Sonnet.

**Single Experiment Flow** (`_run_single_experiment()`):
1. Get champion from DB
2. Propose experiment (mode-dependent)
3. Validate proposal (name + hypothesis required)
4. Dedup check (param mode only)
5. Create experiment record in DB (status=running)
6. Apply code changes if code mode
7. Run backtest pipeline (`run_pipeline()`)
8. Compute fitness score
9. Evaluate verdict (KEEP/DISCARD)
10. Promote to champion if KEEP + save winning preset
11. Revert code changes in finally block

**Exhaustion Detection**:
- **Plateau**: 18+ discards in last 20 experiments with max improvement delta < 0.5% = exhausted
- **Convergence**: Last 10 proposals all touch the same 1-2 parameter combos = exhausted
- Recommendation: switch to code mode or force research interval

---

## 3. The Evaluation/Feedback Mechanism

### Fitness Scoring

The composite fitness score is a weighted blend of four normalized metrics:

| Component | Weight | Normalization | Saturation Point |
|-----------|--------|---------------|------------------|
| Sharpe Ratio | 40% | clamp(0, 2.0) / 2.0 | 2.0 Sharpe = 1.0 |
| CAGR | 30% | clamp(0, 20%) / 20% | 20% CAGR = 1.0 |
| Drawdown Penalty | 20% | 1.0 - abs(DD) / 50% | 0% DD = 1.0, 50% DD = 0.0 |
| Profit Factor | 10% | clamp(0, 2.0) / 2.0 | 2.0 PF = 1.0 |

**Hard filters** reject immediately (score=0): < 500 trades, > 60% max drawdown, < 50% win rate.

**Promotion threshold**: New experiment must score >= 2% better than current champion to become the new champion. This prevents noisy promotions from tiny improvements.

### The Feedback Loop

The feedback loop operates at multiple levels:

1. **Experiment History as Context**: Every proposal call includes the full history of recent experiments (up to 50) with their verdicts, fitness scores, and parameter values. The LLM sees what worked and what failed, and is explicitly told "Do NOT repeat exact param combos from history" and "try the OPPOSITE of something that didn't work."

2. **Research Profile as Institutional Memory**: `research_profiles/tht.md` is a manually-curated 124-line document that captures hard-won knowledge: what parameters work, what definitively failed, unexplored areas, and production configurations. It includes Peter's "re-entry only" discovery with comparative performance data — this becomes the north star for the optimizer.

3. **Exhaustion Escalation**: When param mode gets exhausted (18/20 discards), the system recommends escalating to code mode or research mode. Research mode gives Claude access to the full codebase and external sources (GitHub issues, other strategies) to find genuinely novel ideas.

4. **Create Mode Fix Loop**: For new strategies, the feedback is direct — compile errors, runtime errors, 0 trades, broken exit logic — all get fed back to Claude Opus for iterative fixing. Up to 10 attempts per strategy idea.

---

## 4. The Harness Architecture

### Python-to-C# Bridge

The Python harness orchestrates C# QuantConnect strategies through a multi-step pipeline:

```
Python autoresearch loop
  |
  +--> Claude Code (claude -p) — proposes parameters or code changes
  |
  +--> run_pipeline() — Python orchestrator
         |
         +--> config_gen.py — runs `dotnet run --project ConfigGenerator` to extract
         |    C# [StrategyParameter] attributes into JSON, merges param_overrides
         |
         +--> apply_config() — writes merged params to corealgo/config.json
         |
         +--> test_runner.py — runs `dotnet test` (optional, skipped by default)
         |
         +--> isolator.py — context manager that:
         |      - Backs up non-target templates/models
         |      - Removes orphaned C# files (type reference analysis)
         |      - Strips comments from large files
         |      - Validates 64K char limit per file
         |
         +--> lean_cloud.py — pushes to QuantConnect Cloud:
         |      - Small payloads: `lean cloud push`
         |      - Large payloads: per-file API (files/create, files/update, files/delete)
         |      - Syncs config.json parameters via projects/update API
         |
         +--> lean_cloud.backtest() — runs cloud backtest:
         |      - `lean cloud backtest` with Popen for streaming
         |      - Fallback: polls QC API if CLI dies
         |      - No timeout — waits for completion
         |
         +--> result_parser.py — fetches metrics from QC API:
         |      - backtest_metrics_from_api() → BacktestMetrics dataclass
         |      - Parses statistics dict from QC REST API
         |
         +--> Isolator.__exit__() — restores all backed-up files
```

### Key Design Decisions

**Isolation Pattern**: The Isolator is crucial. QuantConnect Cloud has file size and character limits. The isolator temporarily removes all non-target strategy files, strips comments, and removes orphaned code — then restores everything after push. This lets a project with 15+ strategies push only the one being tested.

**Config Merging**: The ConfigGenerator is a .NET tool that reads C# `[StrategyParameter]` attributes from the strategy's Config class, outputting all parameters as JSON. The autoresearch loop then merges its param_overrides on top of these defaults and writes them to config.json.

**Cloud Backtesting**: Backtests run on QuantConnect Cloud (not local). Each backtest takes minutes. The pipeline handles push → backtest → metrics fetch as an atomic unit. Results come from the QC REST API as structured JSON.

---

## 5. How Claude Code Interacted with This System

### Two Interaction Patterns

**Pattern 1: Orchestrated Subprocess (Primary)**

The Python `run_loop()` calls `call_claude(prompt, model)` which invokes `claude -p` (non-interactive pipe mode). Claude receives a carefully constructed prompt with:
- Role description ("autonomous strategy optimization agent")
- Champion baseline with metrics
- Full experiment history (up to 50 entries with verdicts and scores)
- Research profile (curated knowledge document)
- Strict output format (JSON with specific keys)

Claude responds with a single JSON proposal. The Python loop handles everything else — backtest execution, scoring, champion promotion, DB persistence.

**Pattern 2: Research Mode — Full Agentic Access**

In research mode, Claude Code is launched with a prompt that says "You have access to Bash, file reading, and other tools. USE THEM to research." It provides specific instructions:
1. Read strategy source code (gives exact paths)
2. Read GitHub issues (gives exact `gh` commands)
3. Explore other strategies
4. Read research docs

The session transcripts reveal Claude Code actually executing these steps:
- Reading THTTemplate.cs (cat command)
- Reading THTConfig.cs for available parameters
- Searching for re-entry logic patterns (grep)
- Listing GitHub issues (`gh issue list -R chocksy/quant-algos`)
- Reading specific issues (`gh issue view 134` — FRAMA issue)
- Analyzing FVBPivotLookback mechanics

This produced a sophisticated proposal that combined Peter's re-entry discovery with the FRAMA concept from GitHub issue #134, proposing `FVBPivotLookback=3` to increase TP cycle frequency.

### Session Evidence

18 session directories in `logs/sessions/`, each representing one Claude Code invocation:
- Most are 8-line transcripts (param mode — prompt in, JSON out)
- Two 23-line transcripts (research mode — multi-tool exploration)
- Session 28337198 (182KB transcript): Claude read THTTemplate.cs, THTConfig.cs, searched for re-entry patterns, checked GitHub issues, read FRAMA issue #134, analyzed FVBPivotLookback mechanics — then proposed FVB_PIVOT_3 experiment.

---

## 6. What Made It Work for 4+ Hours Autonomously

### Architecture Factors

1. **Deterministic Pipeline, Creative Proposals**: The loop is fully deterministic except for the LLM proposal step. Every other step (backtest, scoring, champion comparison, DB write) is pure Python with no LLM involvement. This means failures are predictable and recoverable.

2. **Circuit Breaker**: MAX_CONSECUTIVE_FAILURES=5 prevents infinite crash loops. The system logs the failure and moves on gracefully.

3. **Dedup Prevention**: `is_duplicate_proposal()` checks the last 100 experiments to prevent the LLM from proposing the same parameter combination twice. This forces exploration.

4. **Exhaustion Escalation**: When param tuning hits a plateau (18/20 discards), the system detects this and recommends mode escalation. The research_interval=10 parameter automatically injects research-mode iterations every 10th cycle.

5. **Output Redirection**: program.md explicitly says "Always redirect output to save context." The pipeline captures all output programmatically. No context window flooding.

6. **No Timeout on LLM Calls**: `timeout=0` (no timeout) for code/research mode. Claude can think as long as it needs. Param mode is faster (simpler prompts).

7. **Automatic Code Revert**: Code-mode experiments always revert C# changes in a `finally` block. Failed code experiments cannot corrupt the codebase.

8. **Champion Persistence**: SQLite database survives restarts. The champion is never lost. History accumulates across sessions.

### Prompt Engineering Factors

1. **Rich Context Window**: Each proposal call includes the FULL experiment history (not just the last few). The LLM sees trends — which parameters improve things, which hurt.

2. **Research Profile as Memory**: The 124-line `tht.md` encodes months of manual optimization knowledge. This prevents the LLM from re-discovering known failures.

3. **Structured Output Format**: Strict JSON format with specific keys. No ambiguity in parsing. The `parse_json()` helper handles markdown fences and finds the first valid JSON block.

4. **Guided Creativity**: The prompt says "Be creative. After 10 experiments, try something you haven't tried before." The research profile lists "Unexplored Areas" as explicit targets.

5. **Anti-patterns Listed**: "What Definitively Did NOT Work" prevents the LLM from wasting iterations on known dead ends.

---

## 7. Key Patterns That Transfer to Other Domains

### Pattern 1: The Propose-Execute-Evaluate Loop
**Core loop**: LLM proposes a change → deterministic system executes it → quantitative scoring evaluates the result → comparison to champion → promote or discard.

This is domain-agnostic. Replace "backtest" with any execution step that produces measurable metrics:
- **ML hyperparameter tuning**: propose hyperparams → train model → evaluate accuracy/loss
- **Prompt optimization**: propose prompt variation → run evaluation → score output quality
- **Infrastructure tuning**: propose config changes → run load test → measure latency/throughput
- **A/B test design**: propose variation → deploy → measure conversion

### Pattern 2: Institutional Memory via Research Profile
A manually-curated markdown document that captures hard-won knowledge. The LLM reads it on every iteration. Key sections:
- What worked (ranked by impact)
- What definitively did not work
- Unexplored areas (explicit exploration targets)
- Current champion configuration

This prevents the "Groundhog Day" problem where an LLM keeps rediscovering the same insights.

### Pattern 3: Mode Escalation
Start with cheap exploration (param tuning via Sonnet), detect exhaustion, escalate to expensive exploration (code changes via Opus, external research). The escalation is automatic:
- param mode → detects plateau → research mode (broader context)
- research mode → still stuck → code mode (structural changes)
- code mode → still stuck → create mode (entirely new strategies)

### Pattern 4: Deterministic Harness, Stochastic Proposal
Keep the LLM's role narrow and well-defined (propose ONE change as JSON). Everything else is deterministic Python — execution, scoring, comparison, persistence. This makes the system debuggable and reliable.

### Pattern 5: Agentic Research Sessions
In research mode, Claude Code gets full tool access to explore the codebase, read external sources (GitHub issues), and discover genuinely novel ideas. This is not just "generate a JSON" — it's "use your tools to research, then propose." The quality of proposals jumps significantly when Claude can read the actual source code.

### Pattern 6: Build-Test-Fix Cycle for Creation
For create mode (new strategies), a multi-attempt loop:
1. Build from idea + reference implementation
2. Test (compile + backtest)
3. If broken, feed error + broken code + working reference back to LLM
4. Repeat up to N times
5. If still broken, mark idea as failed and move on

This is directly applicable to code generation pipelines — the key insight is providing both the broken output AND a working reference so the LLM can compare.

### Pattern 7: Safety Guardrails for Code Generation
- ALLOWED_PATHS whitelist (only modify specific directories)
- FORBIDDEN_FILES blacklist (never touch critical files)
- Path traversal prevention (resolve canonical paths)
- Automatic revert in finally block
- Git diff capture for audit trail

### Pattern 8: Exhaustion Detection
Two signals that the search space is depleted:
- **Plateau**: High discard rate with small improvement deltas
- **Convergence**: Proposals keep touching the same parameters

When detected, the system escalates rather than grinding uselessly.

---

## 8. Architecture Diagram

```
                         +-----------------+
                         |   program.md    |  (Manual: Claude Code reads and follows)
                         +-----------------+
                                 |
                                 v
+------------------------------------------------------------------+
|                    quant research start                            |
|                    (CLI entry point)                               |
+------------------------------------------------------------------+
                                 |
                                 v
+------------------------------------------------------------------+
|                        run_loop()                                 |
|  ┌─────────────────────────────────────────────────────────┐     |
|  │  while True:                                             │     |
|  │    1. Get champion from DB                               │     |
|  │    2. Decide mode (param/research/code/create)           │     |
|  │    3. Propose experiment ─────────────────────┐          │     |
|  │    4. Dedup check                              │          │     |
|  │    5. Run backtest pipeline ──────────┐        │          │     |
|  │    6. Compute fitness                  │        │          │     |
|  │    7. Evaluate verdict (KEEP/DISCARD) │        │          │     |
|  │    8. Promote champion if KEEP         │        │          │     |
|  │    9. Check exhaustion every 10th      │        │          │     |
|  │    10. Circuit breaker on 5 failures   │        │          │     |
|  └────────────────────────────────────────┼────────┼──────────┘   |
+-------------------------------------------┼────────┼──────────────+
                                            |        |
                    +-----------------------+        +------------------+
                    |                                                    |
                    v                                                    v
    +-------------------------------+              +---------------------------+
    |     run_pipeline()            |              |   call_claude()            |
    |  config_gen → isolate →       |              |   claude -p (subprocess)   |
    |  push → backtest → restore    |              |                           |
    +-------------------------------+              |   Modes:                  |
    |  ConfigGenerator (.NET)       |              |   - param: JSON in/out    |
    |  Isolator (file management)   |              |   - research: full tools  |
    |  lean CLI (QC Cloud push)     |              |   - code: C# diffs (Opus) |
    |  QC API (metrics fetch)       |              |   - create: new files     |
    +-------------------------------+              +---------------------------+
                    |                                          |
                    v                                          v
    +-------------------------------+              +---------------------------+
    |  QuantConnect Cloud           |              |  Research Profile (tht.md)|
    |  - Compile C# strategy        |              |  Experiment History (DB)  |
    |  - Run 10-25 year backtest   |              |  C# Source Code           |
    |  - Return statistics JSON    |              |  GitHub Issues            |
    +-------------------------------+              +---------------------------+
```

---

## 9. File Inventory

| File | Lines | Purpose |
|------|-------|---------|
| `program.md` | 95 | Human-readable loop instructions for Claude Code |
| `autoresearch/__init__.py` | 1 | Package marker |
| `autoresearch/_cli.py` | 59 | `call_claude()` + `parse_json()` — Claude CLI bridge |
| `autoresearch/experiment.py` | 70 | Proposal, FitnessResult, Experiment dataclasses |
| `autoresearch/evaluator.py` | 101 | Fitness scoring + KEEP/DISCARD verdict |
| `autoresearch/db.py` | 198 | SQLite CRUD for experiments + champions |
| `autoresearch/code_mode.py` | 817 | C# code changes + strategy creation + research material gathering |
| `autoresearch/loop.py` | 951 | Main orchestration: run_loop, proposal contexts, exhaustion detection |
| `cli/commands/research.py` | 209 | CLI entry points: start, status, history, champion |
| `api/routes/research.py` | 98 | REST API for monitoring (experiments, champion, stats) |
| `research_profiles/tht.md` | 124 | Curated strategy knowledge (institutional memory) |
| `engine/runner.py` | 337 | Backtest pipeline orchestrator |
| `engine/config_gen.py` | 196 | .NET ConfigGenerator wrapper |
| `engine/isolator.py` | 417 | Strategy file isolation (context manager) |
| `engine/lean_cloud.py` | 458 | QC Cloud push + backtest + API polling |
| `engine/result_parser.py` | 80 | QC API metrics → BacktestMetrics dataclass |

**Previously separate modules (now merged into loop.py)**: proposer.py, context.py, explorer.py, safety.py, lifecycle.py — still visible as pycache artifacts.

---

## 10. Summary

The quant-algos autoresearch system demonstrates that an LLM can effectively drive a multi-hour optimization loop when:

1. **The LLM's role is tightly scoped** — propose one change as structured JSON
2. **Everything else is deterministic** — execution, scoring, comparison, persistence
3. **Rich context accumulates** — experiment history + curated knowledge profile
4. **Multiple exploration modes exist** — cheap param tuning escalating to expensive code generation
5. **Safety is built in** — dedup prevention, circuit breakers, code reverts, file path validation
6. **The execution step is real** — actual cloud backtests producing real metrics, not simulations

The system's elegance is in the separation of concerns: the Python harness handles reliability (retries, reversion, persistence), the scoring handles objectivity (quantitative fitness function), and the LLM handles creativity (what to try next). Each component does what it's best at.
