# Contrarian Analysis: Simplifying Gooseherd vs. Keeping the Complexity

## Context

Karpathy's **autoresearch** pattern is seductive: write a `program.md` describing a loop, point Claude Code at it, and let it run autonomously for hours. The quant-algos adaptation at `trade-analyzer/` proves this works for parameter optimization. The question: can Gooseherd — a 29,000-line, 124-file TypeScript system with 28 node handlers, 5 pipeline presets, Docker sandboxing, browser verification, CI integration, Slack/dashboard UIs, an observer daemon, session management, and an eval harness — be collapsed into something that simple?

This document argues both sides, then proposes a specific path forward.

---

## The Bull Case for Simplicity

### Why the Karpathy Pattern Is Powerful

The autoresearch loop works because it nails four properties that most agent systems get wrong:

**1. The loop IS the architecture.**
In `program.md`, the entire system is described in 95 lines of Markdown. There is no pipeline engine, no node registry, no context bag serialization, no checkpoint/resume logic. The loop is: propose -> run -> score -> keep/discard -> repeat. Every iteration is independent. Failure in one iteration does not cascade. The system is its own documentation.

In the Python adaptation (`loop.py`), the full orchestrator including create-mode, code-mode, research-mode, exhaustion detection, and a SQLite experiment database is 951 lines. The evaluator is 101 lines. The CLI wrapper is 60 lines. Total: ~1,100 lines of meaningful code for a system that runs for hours unattended.

**2. Claude Code IS the agent.**
The `_cli.py` wrapper is literally 60 lines — it shells out to `claude -p` with the right flags. The autoresearch system does not need to manage agent processes, parse JSONL token streams, detect timeouts, classify agent output as "clean/suspect/empty," or extract cost data from pi-agent event formats. Claude Code handles all of that internally.

Gooseherd's `implement.ts` (234 lines) does all of those things because it treats the agent as a dumb subprocess. The autoresearch pattern treats Claude Code as an intelligent partner.

**3. State is minimal and explicit.**
The autoresearch system tracks: champion (best result so far), experiment history (SQLite), and a research profile (Markdown file). That's it. There's no ContextBag with 20+ keys, no checkpoint serialization with sensitive-key filtering, no dotted-path resolution system, no mergeOutputs/append semantics.

When the autoresearch loop crashes, it restarts from scratch. The champion is in the database. The history is in the database. Nothing else matters.

**4. Evaluation is deterministic and cheap.**
`compute_fitness()` is a pure function: 4 normalized components, weighted sum, hard filters. No LLM calls. No browser verification. No CI polling. The cycle time from "propose" to "verdict" is the backtest runtime (~2-3 minutes) plus one Claude call (~15 seconds). Gooseherd's cycle time is 10-40 minutes depending on pipeline preset, and includes multiple LLM calls, git operations, Docker container lifecycle, deployment waiting, and browser automation.

### What the Quant System Gets for Free

- **Crash recovery**: restart the loop, champion persists in DB
- **Progress visibility**: SQLite + CLI queries (`quant research history`)
- **Exhaustion detection**: simple heuristic (18/20 discards = plateau)
- **Mode switching**: param -> research -> code modes based on iteration count
- **Parallel experimentation**: run multiple `autoresearch` processes on different strategies
- **Cost tracking**: implicit (per-Claude-call billing)

Gooseherd needs thousands of lines to achieve comparable versions of each of these.

---

## The Bear Case (Contrarian): What You'd Lose by Simplifying

### 1. Multi-Tenant Concurrency and Queueing

Gooseherd serves a TEAM, not a single researcher. The `RunManager` handles:
- **Priority queue** with configurable concurrency (`PQueue` with `RUNNER_CONCURRENCY`)
- **Multiple simultaneous runs** for different repos, different requesters
- **Run cancellation** via `AbortController` per-run
- **Terminal state callbacks** for downstream systems (observer learning, session manager)

A `program.md` loop is single-threaded and single-user. If two people ask for changes to two repos at the same time, you need a queue. If a run is stuck, you need cancellation. These aren't nice-to-haves in a team setting — they're required.

**Verdict: Essential complexity. Cannot be removed for multi-tenant use.**

### 2. Docker Sandboxing (DooD)

The sandbox system (`container-manager.ts`, `shell.ts` AsyncLocalStorage routing, `setup_sandbox` node) provides:
- **Isolation**: agent code runs in a container, not on the host
- **Reproducibility**: same image, same dependencies, every time
- **Security**: untrusted agent output can't damage the host

The autoresearch system runs on the host because the backtest engine is trusted code. Gooseherd's agents modify arbitrary codebases — sandboxing is a security requirement, not a luxury.

**Verdict: Essential for production. Could be simplified but not removed.**

### 3. Quality Gates Are the Value Proposition

The pipeline's quality gates are what distinguish Gooseherd from "give Claude a task and pray":

| Gate | What It Does | Lines |
|------|-------------|-------|
| `diff_gate` | Detects whitespace-only changes, mass deletions | ~100 |
| `forbidden_files` | Prevents touching .env, lockfiles, etc. | ~80 |
| `security_scan` | Checks for leaked secrets in diff | ~120 |
| `scope_judge` | LLM evaluates if changes match the task | ~200 |
| `browser_verify` | Stagehand agent visually verifies UI changes | ~800 |
| `validate` + `lint_fix` | Runs project-specific linting/tests | ~100 each |
| `local_test` | Runs tests before pushing | ~80 |

Without these, you're pushing unvalidated AI output to production repos. The autoresearch system gets away without gates because the fitness function IS the gate — a bad experiment is simply discarded. In Gooseherd, a bad commit goes to a real PR reviewed by real humans.

**Verdict: Core value. The gates ARE the product. But the current implementation could be simplified.**

### 4. The Fix Loops Are Uniquely Sophisticated

The `handleLoopFailure()` system (lines 495-723 of pipeline-engine.ts) implements a retry pattern that the autoresearch system cannot replicate:

1. Node fails (e.g., `validate` or `browser_verify`)
2. Engine runs a **different** agent node (`fix_validation`, `fix_browser`, `fix_ci`) with the failure context
3. Engine re-runs the original failing node
4. Repeat up to `max_rounds`
5. On exhaustion, either fail or complete with warning

This is not a simple retry. The fix agent gets the previous failure's output, the browser verify failure history, and accumulated context. The engine handles lint-fix-after-agent, commit-push-for-fat-fix-nodes, and browser failure code routing (`isNonCodeFixFailure`).

The autoresearch system's version of this is: if the backtest fails, log it and move on. Next iteration proposes something different. This works when iterations are cheap (2-3 minutes). It does NOT work when a Gooseherd run takes 20 minutes and the fix might be a one-line lint error.

**Verdict: High-value complexity. The fix-loop pattern is genuinely better than "start over."**

### 5. The Observer Daemon Has No Equivalent

The observer system (`daemon.ts` at 24,000 lines worth of directory, `webhook-server.ts`, `smart-triage.ts`, `learning-store.ts`) provides:
- **Automatic trigger**: Sentry alerts, GitHub Actions failures, Slack bot messages trigger runs
- **Smart triage**: LLM evaluates whether an alert is actionable before creating a run
- **Rate limiting and safety**: per-repo, per-day limits, cooldown periods
- **Learning**: records outcomes and improves over time

A `program.md` requires a human to type a command. The observer turns Gooseherd into a proactive system that fixes things before you know they're broken. This is a fundamentally different operating mode.

**Verdict: Optional but differentiating. Not needed for core functionality, but is the path to autonomy.**

### 6. The Eval Harness Is Your Regression Safety Net

The new eval system (`eval-runner.ts`, `judges.ts`, `types.ts`) provides:
- Scenario-based testing of the pipeline itself
- 8 judge types (status, files_changed, diff_contains, pr_created, gate_verdict, browser_verdict, retro_quality, llm_judge)
- Config override injection for A/B testing different models/settings
- Cost tracking per scenario

The autoresearch system's equivalent is the fitness function itself — every run is an eval. But for Gooseherd, you need to test the PIPELINE, not just the agent output. "Did the pipeline correctly skip validation for a docs-only change?" is a meta-question that the autoresearch pattern doesn't address.

**Verdict: Important for development velocity. Worth keeping but could be lighter.**

### 7. Slack/Dashboard Integration Is User Interface

~5,000 lines of dashboard HTML + server + Slack run cards. This is not algorithmic complexity — it's user interface. The autoresearch system has a CLI (`quant research status`, `quant research history`). Gooseherd needs a richer interface because it serves a team.

**Verdict: Necessary but separable. UI is orthogonal to the core loop.**

---

## The Pragmatic Middle: What to Keep, What to Cut

### Complexity Tiers

**Tier 1 — ESSENTIAL (keep, but simplify)**
- Pipeline engine (node execution, context passing)
- Quality gates (diff_gate, forbidden_files, security_scan, validate)
- Fix loops (the fix-agent-then-retry pattern)
- Run queue (PQueue concurrency management)
- Sandbox (Docker isolation)

**Tier 2 — VALUABLE (keep as opt-in modules)**
- Browser verify + fix_browser
- CI wait + fix_ci
- Observer daemon + smart triage
- Session manager (multi-run goals)
- Eval harness

**Tier 3 — OVER-ENGINEERED (simplify or remove)**
- Expression evaluator for `if` conditions in YAML (13 uses total; could be simple boolean flags)
- Sub-pipeline invocation (`_runSubPipeline`) — used zero times in existing YAML files
- Pipeline override system (`tryLoadPipelineOverride`, `repoConfigPipeline`) — confusing indirection
- Event logger + node event listeners — 4 separate event emission mechanisms (appendLog, eventLogger, fireNodeEvent, deps.onPhase)
- Checkpoint/resume system — sounds good in theory, but if the process restarts you lose the Docker container anyway, so the checkpoint is useless
- Multiple pipeline YAML presets — `pipeline.yml` with `skipNodes`/`enableNodes` can express all 5 presets

**Tier 4 — ACTUALLY DEAD WEIGHT**
- `runNode` and `skillNode` and `runSkillNode` — 3 node handlers that seem to overlap
- `retrospectiveNode` — not referenced in any pipeline YAML
- `summarize_changes` — exists solely to feed browser_verify, could be inline
- `hydrate_context` — a node that writes the task to a file. This is 1 line of logic in a dedicated node handler
- `notify` — appears at the end of every pipeline, does nothing if Slack isn't configured
- `generate_title` — LLM call to name the PR. Nice but not essential

### The Core Insight

The autoresearch pattern works because it collapses the propose-execute-evaluate loop into a tight cycle with minimal state. Gooseherd's equivalent loop is:

```
clone -> implement -> validate -> fix-if-needed -> commit -> push -> create-pr
```

This is 7 nodes. With quality gates it's 12. With browser verify it's 17. With CI wait it's 19. Each node adds ~100-300 lines. But the CORE LOOP is still just 7 steps.

The question isn't "can we use program.md?" — it's "can we collapse the 19-node pipeline into a tighter loop while keeping the quality gates?"

---

## Concrete Architecture Proposal

### Option A: "Lean Pipeline" — Simplify Within the Current Architecture

Keep the pipeline engine pattern but ruthlessly simplify:

**1. Collapse to a single pipeline definition.**
Delete `docs-only.yml`, `hotfix.yml`, `ui-change.yml`, `complex.yml`. The orchestrator already controls behavior via `skipNodes`/`enableNodes`. One pipeline, different profiles expressed as `skipNodes` sets.

**2. Inline trivial nodes.**
`hydrate_context`, `notify`, `generate_title`, `summarize_changes` become pre/post hooks on the `implement` and `create_pr` nodes, not standalone pipeline steps.

**3. Simplify the expression evaluator.**
Replace the general-purpose expression evaluator with simple boolean config checks. `if: "config.sandboxEnabled"` becomes `requires: sandboxEnabled`. No dotted paths, no comparison operators.

**4. Kill checkpoint/resume.**
The Docker container dies on crash. The git repo is ephemeral. Checkpointing adds complexity for a feature that doesn't work in practice. Instead: if a run crashes, mark it failed and let the user retry.

**5. Flatten the event system.**
One logging mechanism, not four. `appendLog` to the run log file. Dashboard reads the log file. No EventLogger, no NodeEventListener callbacks, no fireNodeEvent.

**6. Remove sub-pipeline invocation.**
Nobody uses it. YAGNI.

Estimated reduction: ~3,000-4,000 lines of engine code, 4 YAML files, significant cognitive load reduction.

**Result: Same architecture, fewer moving parts. Pipeline is still ~12-15 nodes for a full run.**

### Option B: "Autoresearch-Inspired" — Rewrite the Core as a Loop

Replace the pipeline engine entirely with a tight loop modeled on autoresearch:

```typescript
async function executeRun(task: RunTask): Promise<RunResult> {
  const repo = await cloneRepo(task);
  const agentResult = await runAgent(repo, task.prompt);

  // Quality gates as a simple function, not a pipeline
  const gateResult = await runQualityGates(repo, agentResult);

  if (gateResult.failed && gateResult.fixable) {
    // Fix loop (max 2 rounds)
    for (let attempt = 0; attempt < 2; attempt++) {
      await runFixAgent(repo, gateResult.failures);
      const retryResult = await runQualityGates(repo, agentResult);
      if (!retryResult.failed) { gateResult = retryResult; break; }
    }
  }

  if (gateResult.failed) return { status: "failed", error: gateResult.summary };

  await commitAndPush(repo, task);
  const pr = await createPR(repo, task);

  // Optional post-commit gates (browser verify, CI)
  if (task.browserVerify) await browserVerify(repo, pr);
  if (task.waitCI) await waitForCI(repo, pr);

  return { status: "completed", prUrl: pr.url };
}
```

This is ~50 lines for the core loop. Quality gates are functions, not nodes. The fix loop is a `for` loop, not a 230-line `handleLoopFailure` method.

**What this keeps:**
- All quality gates (as functions)
- Fix loops (as simple retry)
- Run queue (PQueue wrapping the function)
- Sandbox (AsyncLocalStorage wrapping the function call)

**What this loses:**
- YAML-driven pipeline configuration (pipelines become code, not config)
- Per-node skip/enable granularity (replaced with task-level flags)
- Per-node timing and event emission (replaced with run-level logging)
- Checkpoint/resume (dropped entirely)
- Plugin system for custom node handlers

**Estimated result: Core engine drops from ~850 lines to ~200 lines. Total codebase reduction: 5,000-8,000 lines.**

### Option C: "Hybrid" (Recommended)

Keep the YAML pipeline pattern for its declarative configurability, but adopt the autoresearch philosophy in these specific ways:

**1. Pipeline-as-function.**
Each pipeline step becomes a function call with a standard signature, not a class-based handler dispatched through a registry. The "engine" is a `for` loop that calls functions, not an 850-line class.

**2. Adopt the "champion" pattern for eval.**
The eval harness already does this implicitly. Make it explicit: every pipeline run produces a `RunScore` (gate results, cost, duration, changed files). Compare against the current "champion" configuration. Use this to A/B test pipeline configs.

**3. Replace YAML conditionals with profiles.**
Instead of `if: "config.sandboxEnabled"` in YAML, define profiles:
```yaml
profiles:
  default: [clone, implement, validate, fix, commit, push, create_pr]
  ui: [clone, implement, validate, fix, commit, push, create_pr, deploy, browser_verify]
  hotfix: [clone, implement, commit, push, create_pr]
```
No expression evaluator needed. Profile selection is the orchestrator's job.

**4. Kill the 4-way event system.**
One event stream: structured JSON lines to the run log file. Dashboard tails this file. No in-memory listeners, no separate EventLogger class.

**5. Make the observer a separate process.**
The observer daemon doesn't need to share memory with the pipeline engine. It should be a separate process that enqueues runs via the API. This simplifies the monolith and makes the core smaller.

---

## Migration Path

### Phase 1: Prune Dead Weight (1 week, no breaking changes)

1. Delete `retrospective` node handler (unused in any pipeline)
2. Delete sub-pipeline invocation code (`_runSubPipeline`, `tryLoadPipelineOverride`)
3. Delete checkpoint/resume system (replace with "mark failed on crash")
4. Consolidate to one pipeline YAML (keep `pipeline.yml`, delete the 4 variants)
5. Inline `hydrate_context` into the clone node (it writes one file)
6. Flatten the event system to `appendLog` only

### Phase 2: Simplify the Engine (2 weeks)

1. Replace the expression evaluator with simple profile-based node selection
2. Convert the 28-handler node registry into direct function imports
3. Simplify `handleLoopFailure` — it's currently 230 lines and can be ~60
4. Remove the `NodeConfig.type` field (it's never used for dispatch)
5. Make the sandbox context switch explicit (not hidden in AsyncLocalStorage magic)

### Phase 3: Extract the Observer (2 weeks)

1. Move observer daemon to its own entry point
2. Communication via HTTP API (already exists in dashboard-server)
3. Remove observer-related code from `src/index.ts` (saves ~40 lines of wiring)
4. Observer becomes optional — Gooseherd works without it

### Phase 4: Eval Loop (Aspirational)

Once the core is simpler, build a Karpathy-style meta-loop:

```
while true:
  pick a scenario from eval suite
  run it with current config
  compare to champion config
  if better: promote
  if worse: record and try different config
```

This is the autoresearch pattern applied to Gooseherd itself — using the eval harness to continuously optimize the pipeline configuration, model choices, and prompt engineering.

---

## Risk Assessment

### Risks of Simplifying Too Aggressively

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Lose YAML configurability, need code changes for every pipeline tweak | High | Medium | Keep profiles in YAML, just simplify the expression language |
| Break the fix loops, which are the highest-value feature | Medium | High | Write thorough eval scenarios BEFORE simplifying |
| Remove something a customer depends on | Low | High | Check all observer rules and per-repo configs before pruning |
| The "simple" version has subtle bugs the complex version already fixed | Medium | High | Use the existing test suite + eval harness as regression guard |

### Risks of NOT Simplifying

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Cognitive overload prevents adding new features | High | High | Every new feature requires understanding 29k lines |
| New contributors can't onboard | High | Medium | 124 files, 28 node handlers, 4 event systems |
| Bugs hide in complexity (the checkpoint bug you don't know about yet) | Medium | High | Unused code paths rot and create false confidence |
| The eval harness can't be trusted because the system it tests is too complex to reason about | Medium | High | Eval quality is bounded by system comprehensibility |

### Risks of the Hybrid Approach (Recommended)

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Migration takes longer than estimated | High | Low | Phase 1 is pure deletion with no risk; stop there if needed |
| Phase 2 introduces regressions | Medium | Medium | Eval harness catches regressions |
| Observer extraction creates API versioning headaches | Low | Low | Observer already uses RunManager interface |
| Team resists removing "we might need it" features | Medium | Low | Point to this document's evidence |

---

## The Bottom Line

The autoresearch pattern works because it matches the structure of its problem: propose-evaluate-promote is a tight loop with cheap iterations and deterministic scoring.

Gooseherd's problem is different: it needs quality gates, security, multi-tenancy, and integration with external systems (GitHub, Slack, Docker, CI). You cannot collapse it to a `program.md`. But you CAN:

1. **Delete the 30% that's unused or over-engineered** (Phase 1, risk-free)
2. **Simplify the 40% that's more complex than it needs to be** (Phase 2, moderate risk)
3. **Extract the 20% that should be separate processes** (Phase 3, architectural)
4. **Apply the autoresearch philosophy to the eval harness** (Phase 4, upside play)

The goal is not to become autoresearch. The goal is to have the same property autoresearch has: a system simple enough that you can hold the entire thing in your head while making changes.

Current state: you cannot hold Gooseherd in your head. 124 files, 29k lines, 4 event systems, 28 node handlers, 5 pipeline variants, checkpoint/resume for containers that die on crash anyway.

Target state: ~80 files, ~18k lines, 1 event stream, ~20 node handlers (functions, not registered handlers), 1 pipeline with profiles, no dead code paths.

That's the pragmatic simplification. Not a rewrite. A prune.
