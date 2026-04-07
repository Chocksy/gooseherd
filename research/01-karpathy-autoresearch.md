# Deep Research: Karpathy's Autoresearch

**Repository:** https://github.com/karpathy/autoresearch
**Author:** Andrej Karpathy
**Date researched:** 2026-03-13
**License:** MIT
**Total codebase:** ~630 lines across 3 meaningful files + 1 notebook + config

---

## Executive Summary

Autoresearch is a system that lets an AI coding agent (Claude, Codex, etc.) autonomously run ML experiments overnight. The human writes a Markdown file (`program.md`) that instructs the agent what to do, and the agent enters an infinite loop: modify `train.py`, train for exactly 5 minutes, check if val_bpb improved, keep or discard, repeat. You wake up to ~100 experiments and a better model.

The genius is in what it *doesn't* do. There is no orchestration framework, no agent SDK, no tool-calling infrastructure, no evaluation harness beyond a single number. The "agent runtime" is literally your coding assistant's native ability to read files, edit code, and run shell commands. The "program" is a Markdown file.

---

## File-by-File Breakdown

### 1. `program.md` (the "agent program") -- ~180 lines

This is the heart of the system. It is a Markdown document that serves as the agent's complete instruction set. It has four sections:

**Setup section:**
- Instructs the agent to agree on a run tag (e.g., `mar5`), create a branch `autoresearch/<tag>`, read the repo files for context, verify data exists, create `results.tsv` with a header row, then confirm with the human before starting.

**Experimentation section:**
- Defines the rules: only `train.py` can be modified, `prepare.py` is read-only, no new dependencies allowed.
- The goal: lowest `val_bpb` (validation bits per byte). Fixed 5-minute time budget.
- VRAM is a soft constraint. Simplicity criterion: "all else being equal, simpler is better." A 0.001 improvement that adds 20 lines of hacky code is not worth it. Deleting code for equal performance is a win.
- First run always establishes the baseline.

**Logging section:**
- Defines the `results.tsv` format: 5 tab-separated columns (`commit`, `val_bpb`, `memory_gb`, `status`, `description`).
- Status is `keep`, `discard`, or `crash`.

**The experiment loop (the core):**

```
LOOP FOREVER:
1. Look at git state (current branch/commit)
2. Edit train.py with an experimental idea
3. git commit
4. Run: uv run train.py > run.log 2>&1
5. Read results: grep "^val_bpb:\|^peak_vram_mb:" run.log
6. If grep empty -> crash. Read tail -n 50 run.log for stack trace. Fix or give up.
7. Record results in results.tsv (do NOT commit this file)
8. If val_bpb improved (lower) -> keep the commit, advance the branch
9. If val_bpb equal or worse -> git reset back to start
```

**Critical instruction -- NEVER STOP:**
> "Once the experiment loop has begun, do NOT pause to ask the human if you should continue. Do NOT ask 'should I keep going?' The human might be asleep. You are autonomous. If you run out of ideas, think harder. The loop runs until the human interrupts you, period."

This single instruction is what makes the system work overnight. Without it, every coding agent would politely ask "shall I continue?" after a few iterations.

### 2. `train.py` (the agent's canvas) -- ~450 lines

This is the single file the agent modifies. It contains a complete GPT training setup:

**Model architecture (GPTConfig + GPT class):**
- Configurable transformer: `n_layer`, `n_head`, `n_kv_head`, `n_embd`, `vocab_size`, `sequence_len`, `window_pattern`
- Architecture derived from nanochat, simplified to single-GPU
- Uses Flash Attention 3 via the `kernels` package (Hopper-optimized path for H100, community fallback for others)
- RoPE (Rotary Position Embeddings) for position encoding
- RMS normalization (not LayerNorm)
- Sliding window attention with configurable "SSSL" pattern (Short/Long windows)
- Value Embeddings (ResFormer-style): alternating layers get a separate value embedding with input-dependent gating
- Per-layer residual scaling: `resid_lambdas` and `x0_lambdas` (learnable scalars mixing residual and original embedding)
- MLP with ReLU-squared activation (not GELU)
- Logit soft-capping at 15

**Optimizer (MuonAdamW):**
- Hybrid optimizer: Muon for 2D matrix parameters, AdamW for everything else
- Muon uses "polar express" orthogonalization (Newton-Schulz iteration for approximate matrix polar decomposition)
- NorMuon variance reduction on top
- Cautious weight decay (only applied where gradient aligns with parameter)
- Separate learning rates for: unembedding (0.004), embedding (0.6), matrix params (0.04), scalars (0.5)
- LR scaling proportional to 1/sqrt(d_model/768)
- All fused with `@torch.compile`

**Hyperparameters (the knobs the agent turns):**
```python
ASPECT_RATIO = 64        # model_dim = depth * ASPECT_RATIO
HEAD_DIM = 128           # target head dimension
WINDOW_PATTERN = "SSSL"  # sliding window pattern
TOTAL_BATCH_SIZE = 2**19 # ~524K tokens per step
EMBEDDING_LR = 0.6
UNEMBEDDING_LR = 0.004
MATRIX_LR = 0.04
SCALAR_LR = 0.5
WEIGHT_DECAY = 0.2
ADAM_BETAS = (0.8, 0.95)
WARMUP_RATIO = 0.0
WARMDOWN_RATIO = 0.5
FINAL_LR_FRAC = 0.0
DEPTH = 8                # number of transformer layers
DEVICE_BATCH_SIZE = 128
```

**Training loop:**
- Runs until `total_training_time >= TIME_BUDGET` (300 seconds)
- First 10 steps excluded from timing (to avoid counting torch.compile warmup)
- Gradient accumulation to reach TOTAL_BATCH_SIZE
- LR schedule: flat with optional warmup, then cosine-like warmdown over last 50%
- Muon momentum ramps from 0.85 to 0.95 over first 300 steps
- Weight decay linearly decays to 0
- Fast-fail: aborts if loss is NaN or > 100
- GC management: freezes Python GC after step 0 to avoid ~500ms stalls, only collects every 5000 steps

**Output:** Prints a summary block with `val_bpb`, `training_seconds`, `total_seconds`, `peak_vram_mb`, `mfu_percent`, `total_tokens_M`, `num_steps`, `num_params_M`, `depth`.

### 3. `prepare.py` (the fixed foundation) -- ~300 lines

Read-only. Never modified by the agent. Contains:

**Constants:**
- `MAX_SEQ_LEN = 2048` (context length)
- `TIME_BUDGET = 300` (5 minutes)
- `EVAL_TOKENS = 40 * 524288` (~20M tokens for validation)

**Data pipeline:**
- Downloads parquet shards from HuggingFace (`karpathy/climbmix-400b-shuffle`)
- Up to 6,543 shards available, default downloads 10
- Pinned validation shard: the last one (shard_06542)
- Parallel download with retries

**Tokenizer:**
- BPE trained with `rustbpe` (Rust-based, fast)
- GPT-4 style split pattern
- Vocab size: 8,192 tokens + 4 special tokens
- Saved as tiktoken pickle

**Dataloader (`make_dataloader`):**
- BOS-aligned with best-fit packing
- Every row starts with BOS token
- Documents packed using best-fit decreasing to minimize cropping
- 100% utilization (no padding)
- Pre-allocated pinned CPU buffers with async GPU transfer
- Infinite iterator yielding `(inputs, targets, epoch)`

**Evaluation (`evaluate_bpb`):**
- THE metric. Fixed, untouchable.
- Bits per byte (BPB): vocabulary-size-independent
- Sums per-token cross-entropy (nats), sums target byte lengths, converts nats/byte to bits/byte
- Special tokens excluded from both sums
- Uses fixed MAX_SEQ_LEN so results comparable across configs
- Evaluates on EVAL_TOKENS worth of validation data

### 4. `analysis.ipynb` (post-hoc visualization)

Jupyter notebook for analyzing results after a run. Reads `results.tsv` and produces:
- Experiment outcome counts (keep/discard/crash)
- Keep rate statistics
- List of all kept experiments with descriptions
- A progress chart: val_bpb over experiment number, with running minimum frontier, kept experiments labeled with descriptions (saved as `progress.png`)
- Summary statistics: baseline vs best, total improvement
- Top hits ranked by delta improvement

### 5. `pyproject.toml`

Dependencies: `kernels>=0.11.7`, `matplotlib`, `numpy`, `pandas`, `pyarrow`, `requests`, `rustbpe`, `tiktoken`, `torch==2.9.1` (CUDA 12.8). Managed via `uv`.

### 6. `.gitignore`

Ignores: `results.tsv`, `CLAUDE.md`, `AGENTS.md` (agent-generated prompt files), `dev/`, `results/`, `queue/`, `worktrees/`.

### 7. `.python-version`

Python 3.10.

### 8. `uv.lock`

Lock file for deterministic dependency resolution.

### 9. `progress.png`

The teaser image in the README showing experiment progression over time -- a scatter plot with kept experiments (green dots) showing val_bpb descending over experiment iterations.

---

## The Core Loop Explained

The entire system works like this:

```
HUMAN                          AGENT (Claude/Codex/etc.)
  |                                |
  |-- writes program.md ---------> |
  |-- says "kick off" -----------> |
  |                                |-- reads program.md
  |                                |-- reads prepare.py, train.py, README.md
  |                                |-- creates branch autoresearch/<tag>
  |                                |-- creates results.tsv header
  |                                |-- runs baseline: uv run train.py
  |                                |-- records baseline in results.tsv
  |                                |
  |   (human goes to sleep)        |
  |                                |-- LOOP:
  |                                |   1. Think of idea (from reading code,
  |                                |      past results, ML knowledge)
  |                                |   2. Edit train.py
  |                                |   3. git commit
  |                                |   4. uv run train.py > run.log 2>&1
  |                                |   5. grep val_bpb from run.log
  |                                |   6. If improved: keep commit
  |                                |      If not: git reset
  |                                |   7. Log to results.tsv
  |                                |   8. GOTO 1
  |                                |
  |   (human wakes up)             |
  |-- interrupts ----------------> |
  |                                |
  |-- opens analysis.ipynb         |
  |-- reviews results.tsv         |
  |-- reviews git log             |
```

**The feedback loop is extremely tight:** The agent's only signal is a single floating-point number (val_bpb). Lower = better. That's it. No human judgment, no qualitative assessment, no "does the generated text look good." Just: did the number go down?

**The version control is the experiment tracker:** Git commits *are* the experiment log. Keep = advance the branch. Discard = reset. The git history on the `autoresearch/<tag>` branch is a clean chain of only-improvements. The `results.tsv` is the full history including failures.

---

## The "program.md" Pattern

This is the most novel and transferable idea in the project. Instead of building an agent framework with tool definitions, state machines, and orchestration code, you write a Markdown document that:

1. **Defines the setup procedure** (what to read, what to verify, what to create)
2. **Defines the rules** (what can/cannot be modified, constraints)
3. **Defines the loop** (the repeating cycle of actions)
4. **Defines the evaluation** (how to judge success)
5. **Defines the logging** (how to record results)
6. **Defines the termination** (never, in this case)

The agent's existing capabilities (read files, edit files, run commands, understand code, reason about ML) do all the work. The Markdown file just *directs* those capabilities.

Key properties of this pattern:
- **No code required for orchestration.** The "orchestrator" is the LLM's instruction-following ability.
- **Human-readable and human-editable.** Anyone can understand and modify the research protocol.
- **Composable.** You could write different program.md files for different research agendas (architecture search, optimizer tuning, data augmentation, etc.).
- **Agent-agnostic.** Works with any coding agent that can read files, edit files, and run commands. The README says "Claude/Codex or whatever you want."

Karpathy describes program.md as a "super lightweight skill" -- the minimal encoding of a research methodology into a format an LLM can execute.

The `.gitignore` listing `CLAUDE.md` and `AGENTS.md` suggests these are generated per-session by launchers -- the actual "prompt injection point" varies by agent, but the *research protocol* stays in `program.md`.

---

## The Evaluation Mechanism

### Why val_bpb?

Bits per byte (BPB) is the metric, not perplexity or cross-entropy loss. This is a deliberate choice:

1. **Vocabulary-size independent.** If the agent changes the architecture in a way that affects how tokens map to bytes, BPB still gives a fair comparison. Cross-entropy loss is per-token, so changing tokenizer/vocab would break comparability.

2. **Physically meaningful.** BPB measures how many bits you need per byte of text. It has an information-theoretic interpretation. Lower = the model compresses text better.

3. **Fixed evaluation harness.** The `evaluate_bpb` function in `prepare.py` is untouchable. The agent cannot game the metric by modifying the evaluation code -- only by genuinely improving the model.

### How evaluation works:

```python
@torch.no_grad()
def evaluate_bpb(model, tokenizer, batch_size):
    # For each validation batch:
    #   1. Run model forward, get per-token cross-entropy (nats)
    #   2. Look up byte-length of each target token
    #   3. Exclude special tokens (byte length 0)
    #   4. Accumulate total_nats and total_bytes
    # Final: total_nats / (ln(2) * total_bytes) = bits per byte
```

The evaluation runs over `EVAL_TOKENS = 40 * 524288` (~20M tokens) from a pinned validation shard. This is substantial enough to be statistically stable but fast enough to not waste the time budget.

### The 5-minute fixed time budget

This is the most clever constraint. By fixing *wall-clock training time* (not steps, not tokens, not epochs):

1. **All experiments are directly comparable** regardless of what the agent changed (model size, batch size, architecture). A bigger model trains fewer steps but each step sees more capacity. A smaller model trains more steps. The question becomes: what's the best model you can build and train in 5 minutes?

2. **Hardware-aware optimization.** The agent implicitly optimizes for the specific GPU it's running on. A change that helps on H100 might not help on RTX 4090. This means autoresearch finds the best model *for your hardware*.

3. **Throughput is automatically a factor.** If the agent tries something that's slow (e.g., huge model with low MFU), it gets fewer training steps and likely worse results. Efficiency is rewarded without explicitly measuring it.

4. **The downside (acknowledged):** Results are not comparable across different hardware. Your run on an H100 and someone else's run on an A100 produce different optimal models.

The first 10 steps are excluded from timing to avoid penalizing torch.compile warmup.

---

## What Makes It So Simple and Effective

### 1. No agent framework

There is literally zero agent code. No LangChain, no CrewAI, no custom tool definitions, no state machines, no orchestration. The agent is whatever coding assistant you already use. The "framework" is a Markdown file.

### 2. The search space is constrained but rich

The agent can only edit one file (`train.py`), but that file contains *everything* about the model: architecture, optimizer, hyperparameters, training loop, batch size, model size, attention patterns. This is a sweet spot -- narrow enough that the agent can't break the evaluation infrastructure, broad enough that there are hundreds of meaningful experiments to try.

### 3. The feedback signal is instant and unambiguous

Every experiment takes exactly 5 minutes. The result is a single number. There's no ambiguity about whether something worked. This is the tightest possible feedback loop for ML research.

### 4. Git as experiment tracker

Using git commits as experiment checkpoints is brilliant in its simplicity:
- `git commit` = snapshot the experiment
- `git reset` = revert a failed experiment
- `git log` = experiment history
- Branch name = experiment session

No MLflow, no Weights & Biases, no experiment tracking infrastructure. The agent already knows how to use git.

### 5. The "simplicity criterion"

The program.md explicitly tells the agent: "A 0.001 val_bpb improvement that adds 20 lines of hacky code? Probably not worth it. A 0.001 val_bpb improvement from deleting code? Definitely keep."

This prevents the agent from converging on a complex, overfit mess. It creates evolutionary pressure toward elegant solutions.

### 6. The "NEVER STOP" instruction

This single sentence is what transforms a coding assistant into an autonomous researcher. Without it, every agent would stop after a few experiments to ask permission. With it, the agent runs 100+ experiments overnight.

### 7. The agent brings its own ML knowledge

The most underappreciated aspect: modern LLMs (Claude, GPT-4, etc.) have deep knowledge of ML research. They know about learning rate schedules, attention variants, normalization techniques, optimizer tricks. The agent doesn't need to be told what experiments to try -- it reads the code, understands what's there, and draws on its training data to propose improvements. The program.md just gives it permission and a protocol.

---

## Results (from external reporting)

From Karpathy's initial runs:

| Run | Experiments | Kept | Success Rate | val_bpb Start | val_bpb End |
|-----|-------------|------|-------------|---------------|-------------|
| Overnight (DEPTH=8) | 83 | 15 | ~18% | 0.9979 | 0.9697 |
| Extended (DEPTH=8) | 126 | ~20 | ~16% | 0.9979 | ~0.97 |
| Two-day (DEPTH=12) | ~700 | 20 | ~3% | - | - |

Notable findings:
- All 20 improvements from the DEPTH=12 run **transferred to DEPTH=24** -- suggesting the agent finds genuine improvements, not overfitting artifacts.
- The agent discovered: missing scaler multipliers in attention, misconfigured Adam betas, suboptimal weight decay schedules, value embedding regularization issues, batch size optimizations, model aspect ratio improvements.
- Shopify CEO Tobi Lutke applied the framework internally and reported a **19% validation improvement**, with a smaller agent-optimized model outperforming a larger manually configured one.

---

## Key Design Decisions and Trade-offs

### Decision 1: Single GPU, single file
**Pro:** Keeps scope manageable, diffs reviewable, no distributed training complexity.
**Con:** Cannot explore multi-GPU strategies, data parallelism, pipeline parallelism.
**Why it works:** For the "overnight autonomous research" use case, single GPU is the right scope. Most ML practitioners have one GPU.

### Decision 2: Fixed time budget (not fixed steps/tokens)
**Pro:** Fair comparison across any changes. Hardware-aware optimization.
**Con:** Results not comparable across hardware. A "good" change on H100 might be "bad" on A6000.
**Why it works:** The goal is to find the best model for *your* setup, not to produce reproducible benchmarks.

### Decision 3: val_bpb as sole metric
**Pro:** Unambiguous, vocabulary-independent, information-theoretically grounded.
**Con:** Doesn't measure downstream task performance, reasoning ability, or text quality.
**Why it works:** For pretraining research, compression quality (BPB) is the most fundamental metric. Everything else is downstream of it.

### Decision 4: Agent chooses its own experiments
**Pro:** Leverages LLM's broad ML knowledge. No need to define a search space.
**Con:** Agent might get stuck in local optima. No systematic coverage guarantee.
**Why it works:** The agent has read thousands of ML papers in training. It proposes reasonable experiments. The keep/discard mechanism ensures only improvements survive.

### Decision 5: No parallel exploration
**Pro:** Simple. One branch, one agent, one GPU.
**Con:** Cannot explore multiple directions simultaneously. Sequential search is slow.
**Future direction:** Karpathy hints at "asynchronously massively collaborative agents (SETI@home style)" as the next evolution.

### Decision 6: results.tsv is untracked by git
**Pro:** The TSV accumulates ALL results (kept + discarded + crashed) while git history shows only kept improvements. Clean separation of concerns.
**Con:** If the session crashes, you lose the TSV (but git history is preserved).

### Decision 7: Redirect stdout to run.log
The program.md explicitly says `uv run train.py > run.log 2>&1` and NOT to use `tee` or let output flood the context. This is critical -- training produces thousands of lines of step-by-step logs. Piping to file keeps the agent's context window clean. The agent only reads what it needs via `grep`.

---

## Architecture Diagram

```
+-------------------------------------------+
|              program.md                    |
|  (human-written research protocol)         |
|  - setup instructions                      |
|  - rules & constraints                     |
|  - experiment loop definition              |
|  - evaluation criteria                     |
|  - "NEVER STOP"                            |
+-------------------------------------------+
                    |
                    | read by
                    v
+-------------------------------------------+
|         AI Coding Agent                    |
|  (Claude / Codex / any)                    |
|  - reads files                             |
|  - edits train.py                          |
|  - runs shell commands                     |
|  - reasons about ML                        |
|  - manages git                             |
+-------------------------------------------+
         |              |              |
    edit |         run  |         git  |
         v              v              v
+-------------+  +-------------+  +----------+
|  train.py   |  |   run.log   |  |   git    |
|  (model,    |  |  (stdout)   |  |  branch  |
|   optim,    |  |             |  | autore-  |
|   loop)     |  | grep for    |  | search/  |
+-------------+  | val_bpb     |  | <tag>    |
                 +-------------+  +----------+
         |                              |
    imports                        commit/reset
         v                              |
+-------------+                         v
| prepare.py  |              +------------------+
| (READONLY)  |              | results.tsv      |
| - constants |              | (untracked)      |
| - tokenizer |              | - all experiments |
| - dataloader|              | - keep/discard/  |
| - eval_bpb  |              |   crash status   |
+-------------+              +------------------+
```

---

## Transferable Insights for Other Projects

1. **The "program.md" pattern is general.** Any autonomous agent loop can be encoded as a Markdown file: setup, rules, loop, evaluation, logging, termination. No framework needed.

2. **Fixed time budgets make experiments comparable.** This principle applies beyond ML: any agent task where you want to compare approaches should fix the resource budget.

3. **Git as state management.** Commit on attempt, reset on failure. The agent already knows git. No need for custom checkpointing.

4. **"NEVER STOP" is the key instruction.** Without it, agents are too polite. They ask permission, they hedge, they pause. One explicit instruction changes the behavior fundamentally.

5. **Constrain the surface area.** One file to edit, one metric to optimize, one command to run. The agent works best when the search space is clearly bounded.

6. **Let the agent bring its knowledge.** Don't over-specify what to try. The LLM knows ML. Give it a goal and let it explore.

7. **Simplicity criterion prevents drift.** Explicitly telling the agent that complexity has a cost prevents convergence to unmaintainable solutions.

8. **Redirect verbose output, grep for results.** Keep the agent's context window clean. Only read what matters.

---

## What Karpathy Says About the Future

> "autoresearch has to be asynchronously massively collaborative for agents (think: SETI@home style). The goal is not to emulate a single PhD student, it's to emulate a research community of them."

The `.gitignore` already hints at multi-agent infrastructure: `worktrees/`, `queue/`, `results/` directories are excluded. The `CLAUDE.md` and `AGENTS.md` files are listed as "generated per-session by launchers" -- suggesting a launcher system that spins up multiple agents, each with their own worktree and prompt.

The progression is clear: single agent -> multiple agents on multiple GPUs -> distributed research swarm. The program.md pattern scales naturally -- you write the protocol once, launch N agents, each on their own branch, and merge improvements.

---

## Summary

Autoresearch is 630 lines of code that turns any AI coding assistant into an autonomous ML researcher. Its power comes from radical simplicity:

- **3 files matter.** One the human writes (program.md), one the agent writes (train.py), one nobody touches (prepare.py).
- **1 metric.** val_bpb. Lower is better. That's the entire evaluation.
- **1 loop.** Edit, train, measure, keep-or-discard, repeat forever.
- **0 frameworks.** The agent IS the framework. program.md IS the orchestration.

The insight that a Markdown file + an LLM + git + a single metric = an autonomous research agent is the kind of simplification that, in retrospect, seems obvious -- and that's exactly what makes it brilliant.
