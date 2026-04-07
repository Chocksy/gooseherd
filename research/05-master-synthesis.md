# Master Synthesis: Autoresearch-Inspired Gooseherd Simplification

**Date:** 2026-03-13
**Input:** 4 deep research reports from parallel agent team
**Scope:** Karpathy's autoresearch → quant-algos adaptation → Gooseherd current state → contrarian analysis

---

## The Core Insight (One Paragraph)

Karpathy's autoresearch works because it collapses the entire system to: **propose → execute → score → keep/discard → repeat**. Your quant-algos adaptation proves this generalizes — you added mode escalation, institutional memory, and a real evaluation harness, and it still worked for 4+ hours unattended with ~1,100 lines of Python. Gooseherd does the same thing (propose task → implement → validate → ship) but wraps it in 29,200 lines with 28 node handlers, 5 pipeline YAMLs, a custom expression evaluator, 4 event systems, and checkpoint/resume for containers that die on crash anyway. The goal isn't to become autoresearch. The goal is to get back to the point where you can hold the whole system in your head.

---

## What We Learned From Each System

### Karpathy's Autoresearch (630 lines)

| Principle | Implementation |
|-----------|---------------|
| Loop IS the architecture | program.md defines setup → rules → loop → eval → logging |
| Agent IS the framework | Zero orchestration code. `claude -p` does everything |
| State is minimal | Git commits + results.tsv. No checkpoint, no context bag |
| Eval is a single number | val_bpb. Lower = better. Deterministic, cheap, instant |
| "NEVER STOP" | One instruction transforms polite assistant → overnight researcher |
| Constrained surface | One file to edit, one metric, one command to run |

**Transferable:** The program.md pattern, the "never stop" instruction, git-as-experiment-tracker, output redirection to save context window.

### Your Quant-Algos Adaptation (~1,100 lines of orchestration + ~1,500 lines of engine)

| Innovation Over Karpathy | Why It Matters |
|--------------------------|----------------|
| **Mode escalation** (param → research → code → create) | Prevents plateaus. Cheap exploration first, expensive when stuck |
| **Research profile** (curated markdown = institutional memory) | Prevents Groundhog Day. LLM doesn't rediscover known failures |
| **Deterministic harness + stochastic proposal** | LLM only proposes. Everything else is reliable Python |
| **Champion persistence** (SQLite) | Crash-safe. Restart from where you left off |
| **Exhaustion detection** (18/20 discards = plateau) | Automatic mode switch vs grinding uselessly |
| **Agentic research mode** (Claude gets full tool access) | Not just "generate JSON" — "explore the codebase, THEN propose" |
| **Build-test-fix cycle** (create mode, up to 10 attempts) | This IS the Gooseherd fix loop, but simpler |

**Transferable:** Mode escalation, research profiles, exhaustion detection, the `call_claude()` 60-line wrapper pattern, build-test-fix creation cycle.

### Gooseherd Current State (29,200 lines)

| What | Lines | Essential? |
|------|-------|-----------|
| Core loop (clone → implement → validate → commit → push → PR) | ~2,000 | YES |
| Quality gates (diff, forbidden files, security, scope) | ~800 | YES |
| Fix loop (fix agent → retry original node) | ~300 | YES |
| Run queue + concurrency | ~300 | YES |
| GitHub API (PR creation, checks) | ~300 | YES |
| Prompt construction (hydrate_context) | ~375 | YES |
| LLM caller | ~520 | YES |
| Database (runs table) | ~200 | YES |
| **Essential total** | **~4,800** | — |
| Browser verification chain | ~2,700 | Valuable module |
| Observer daemon + sources | ~4,150 | Separate product |
| Dashboard | ~5,700 | Separate concern |
| Slack integration | ~1,500 | Separate concern |
| Sandbox (Docker) | ~440 | Production need |
| Everything else (pipeline DSL, sessions, orchestrator, supervisor, plugins, skills, setup wizard, 4 event systems, checkpoint/resume, sub-pipelines, expression evaluator) | ~9,910 | OVER-ENGINEERED |

**The brutal truth:** ~34% of Gooseherd is over-engineered complexity around the core loop.

---

## The Synthesis: Three Concrete Options

### Option A: "The Prune" (Conservative, Low Risk)

Delete dead weight, keep architecture. Target: 29k → ~18k lines.

**Phase 1 — Pure Deletion (zero risk):**
- Delete `retrospective` node (unused in any pipeline)
- Delete `_runSubPipeline` (zero uses)
- Delete checkpoint/resume (Docker dies = checkpoint useless)
- Delete `tryLoadPipelineOverride` (confusing indirection)
- Consolidate to 1 pipeline YAML with profiles
- Kill 3 of 4 event systems (keep `appendLog` only)
- Inline `hydrate_context`, `notify`, `summarize_changes`, `generate_title` into adjacent nodes

**Phase 2 — Simplify Engine:**
- Replace expression evaluator with profile-based node selection
- Flatten `handleLoopFailure` from 230 → ~60 lines
- Convert node registry to direct function imports
- Kill the `run`/`skill`/`run_skill` handler overlap

**Phase 3 — Extract Observer:**
- Move observer to separate process
- Communicate via HTTP API (already exists)
- Core Gooseherd works without it

**Result:** Same architecture, fewer moving parts. Still a pipeline engine, just less bloated.

### Option B: "The Rewrite" (Aggressive, High Reward)

Rewrite core as a tight loop, inspired by autoresearch. Target: 29k → ~5k-8k lines.

```typescript
// The entire core engine in ~50 lines
async function executeRun(task: RunTask): Promise<RunResult> {
  const repo = await cloneRepo(task);
  const prompt = buildPrompt(task, repo);
  const agentResult = await runAgent(repo, prompt);

  // Quality gates as functions, not pipeline nodes
  const gates = await runQualityGates(repo, agentResult);

  // Fix loop as a for-loop, not a 230-line method
  if (gates.failed && gates.fixable) {
    for (let i = 0; i < 2; i++) {
      await runFixAgent(repo, gates.failures);
      gates = await runQualityGates(repo, agentResult);
      if (!gates.failed) break;
    }
  }

  if (gates.failed) return { status: "failed", error: gates.summary };

  await commitAndPush(repo, task);
  const pr = await createPR(repo, task);

  // Optional post-commit verification
  if (task.browserVerify) await browserVerify(repo, pr);
  if (task.waitCI) await waitForCI(repo, pr);

  return { status: "completed", prUrl: pr.url };
}
```

**What this kills:** YAML pipeline DSL, expression evaluator, ContextBag, checkpoint/resume, sub-pipelines, goto, dynamic node skipping, node handler registry, per-node event emission. All replaced by function calls.

**What this keeps:** Every quality gate (as a function), fix loops (as a for-loop), run queue (PQueue wrapping the function), sandbox (AsyncLocalStorage wrapping the call).

### Option C: "The Hybrid" (Recommended)

Phase 1 from Option A (pure deletion), then evolve toward Option B.

1. **Prune first** (Phase 1 of Option A) — immediate 3-4k line reduction, zero risk
2. **Introduce the autoresearch pattern via the eval harness** — the eval system already does define → execute → evaluate. Add "iterate" (auto-refine pipeline config based on eval results)
3. **Adopt research profiles** — curated markdown files per-repo that capture institutional knowledge (like your `tht.md`), preventing the LLM from re-discovering known failures
4. **Add mode escalation** — simple tasks get the fast path, complex tasks escalate to research mode (Claude gets full tool access)
5. **Replace YAML pipelines with typed profiles** — `{ gates: ['diff', 'security', 'scope'], verify: 'browser', fixRounds: 2 }` instead of 80-line YAML files with expression conditionals
6. **Eventually:** Core engine becomes a function, not a class with 850 lines of dispatch logic

---

## The Autoresearch Patterns to Steal

These are the specific patterns from your quant-algos system that map directly to Gooseherd:

| Quant-Algos Pattern | Gooseherd Equivalent |
|---------------------|---------------------|
| `call_claude()` (60 lines) | `implement.ts` (234 lines). Simplify to shell-out-and-capture |
| `evaluator.py` (101 lines, pure function) | Quality gates scattered across ~800 lines. Consolidate to `evaluateRun()` |
| `research_profiles/tht.md` | Per-repo `.gooseherd-profile.md` with known patterns, failures, constraints |
| Champion persistence (SQLite) | Already have runs table. Add "best config" tracking |
| Exhaustion detection | After N failed fix rounds, escalate mode instead of failing |
| Mode escalation (param → research → code) | Simple task → full pipeline → research mode (Claude with tools) |
| Build-test-fix cycle (create mode) | This IS the fix loop, but the quant version is simpler and works |
| `program.md` (process document) | Pipeline profiles as markdown? Or typed config objects? |
| "NEVER STOP" instruction | Not applicable (runs are bounded), but "don't ask, just fix" applies |
| Output redirection (save context window) | Already do this — shell capture to log file |

---

## The Contrarian View (What We'd Lose)

The codex investigator's bear case is real. Don't dismiss it:

1. **Multi-tenant concurrency** — autoresearch is single-user. Gooseherd serves a team. PQueue + AbortController + run queue are essential.

2. **Security** — autoresearch runs on your machine against your code. Gooseherd runs untrusted agent output. Sandbox and security_scan are requirements, not luxuries.

3. **Quality gates ARE the product** — autoresearch's gate is a single number. Gooseherd's gates (diff_gate, forbidden_files, security_scan, scope_judge) are what prevent bad PRs. They're worth every line.

4. **Fix loops are genuinely sophisticated** — autoresearch discards failures. Gooseherd fixes them. A 20-minute run failing over a lint error SHOULD be fixed, not restarted. This complexity earns its keep.

5. **The observer has no equivalent** — proactive bug fixing is a fundamentally different capability. It can't be program.md'd.

**Bottom line:** You can't collapse Gooseherd to program.md. But you CAN cut 30% of the code that exists only because the system grew organically, not because the problem demands it.

---

## Concrete Next Steps

### Immediate (This Week)
1. Delete dead code: retrospective node, sub-pipeline, checkpoint/resume
2. Consolidate to 1 pipeline YAML with profile-based node selection
3. Kill 3 of 4 event systems

### Short Term (Next 2 Weeks)
4. Create research profiles per repo (`.gooseherd-profile.md`)
5. Simplify `handleLoopFailure` from 230 → 60 lines (the quant build-test-fix pattern)
6. Simplify `implement.ts` to match the `call_claude()` wrapper pattern
7. Replace expression evaluator with simple boolean profiles

### Medium Term (Next Month)
8. Add mode escalation: simple → standard → research (Claude with full tool access)
9. Add exhaustion detection: after N fix failures, switch mode instead of failing
10. Evolve eval harness into autoresearch-style meta-loop (champion configs)
11. Extract observer to separate process

### Aspirational
12. The eval meta-loop: pick scenario → run with config → compare to champion → promote or discard. This IS autoresearch applied to Gooseherd itself — continuously optimizing pipeline config, model choices, and prompt engineering.

---

## The One-Line Summary

**Gooseherd's core loop is autoresearch with quality gates.** The 29k lines exist because we added 5 layers of configurability around a 9-step process. Prune the configurability, keep the quality gates, adopt the research profile + mode escalation patterns, and evolve the eval harness into the iteration mechanism.
