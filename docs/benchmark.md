# PR-task benchmark suite

A 10-scenario benchmark that shows **where** the agent pipeline fails across the
qualities we care about, run against a real Rails codebase (`epiccoders/pxls`).

Every scenario is grounded in verified pxls code (see the header comment in each
YAML for the file+line citation). Scenarios live in `evals/benchmark/` and are
tagged `bench` plus exactly one category:

| Category | Tag | What it measures |
|----------|-----|------------------|
| Delivery | `delivery` | Can it make correct, minimal changes? (`bench-simple-edit`, `bench-multi-file`) |
| Exploration | `exploration` | Does it find the RIGHT place to change — even when the obvious location is a decoy — and follow repo conventions? (`bench-decoy`, `bench-cross-file-trace`, `bench-convention`) |
| Clarification | `clarification` | On ambiguous / contradictory / impossible / underspecified tasks, does it stay honest instead of silently guessing? (`bench-ambiguous`, `bench-contradictory`, `bench-impossible`, `bench-underspecified`) |
| Scope | `scope` | Does it resist drive-by refactors? (`bench-scope-trap`) |

A benchmark **failure is signal, not a harness bug** — it tells you the agent
invented a feature, edited a decoy, or refactored out of scope.

## Prerequisites

- Postgres for eval results: `postgres://gooseherd:gooseherd@localhost:55432/gooseherd`
- `DRY_RUN=true` (no real PRs are pushed; scenarios judge the local diff + status).
- An API key for the judge LLM (`OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`).
- **`OPENROUTER_API_KEY` is required for the scope scenarios** (`bench-scope-trap`, and
  the root `evals/homepage-title.yml`). They enable `scope_judge` and assert a
  `gate_verdict` on it. Without the key the scope judge **fails open to `pass`**
  (`scope-judge-node.ts` skips with no key, and the events-derived gate report then
  has no `scope_judge` entry), so the benchmark silently stops judging scope. The eval
  runner logs a loud warning when a `gate_verdict:scope_judge` scenario runs without
  `OPENROUTER_API_KEY`, but treat that warning as a failed prerequisite, not noise.

## Running the suite

Whole suite:

```bash
DRY_RUN=true \
DATABASE_URL=postgres://gooseherd:gooseherd@localhost:55432/gooseherd \
AGENT_COMMAND_TEMPLATE='cd {{repo_dir}} && pi -p @{{prompt_file}} --model openrouter/anthropic/claude-sonnet-4.6 --no-session --mode json --tools read,write,edit,bash,grep,find,ls' \
npm run eval -- --dir evals/benchmark --label baseline
```

One category (e.g. only the exploration scenarios):

```bash
DRY_RUN=true DATABASE_URL=... AGENT_COMMAND_TEMPLATE='...' \
npm run eval -- --dir evals/benchmark --tag exploration --label baseline
```

One scenario:

```bash
DRY_RUN=true DATABASE_URL=... AGENT_COMMAND_TEMPLATE='...' \
npm run eval -- --scenario evals/benchmark/bench-decoy.yml --label baseline
```

When more than one scenario runs, the report prints a **per-category summary**
after the per-scenario table:

```
Per-category summary

Category       | Scenarios  | Passed   | Avg Score
---------------+------------+----------+----------
delivery       | 2          | 2/2      | 100
exploration    | 3          | 2/3      | 67
clarification  | 4          | 3/4      | 75
scope          | 1          | 1/1      | 100
```

## A/B model comparison

The benchmark scenarios deliberately **do not pin an agent model** — they set only
`DEFAULT_LLM_MODEL` (the judge model). The agent model is chosen at launch via the
`AGENT_COMMAND_TEMPLATE` **environment variable**.

This matters because `scripts/run-eval.ts` calls `dotenv.config()`, and dotenv does
**not** override variables already present in the environment. So an
`AGENT_COMMAND_TEMPLATE` you export on the command line wins over any value in
`.env`. That lets one suite definition serve any model: change only the model in the
env template and the `--label`, and re-run.

Baseline (e.g. a small/cheap model):

```bash
DRY_RUN=true DATABASE_URL=postgres://gooseherd:gooseherd@localhost:55432/gooseherd \
AGENT_COMMAND_TEMPLATE='cd {{repo_dir}} && pi -p @{{prompt_file}} --model openrouter/openai/gpt-4.1-mini --no-session --mode json --tools read,write,edit,bash,grep,find,ls' \
npm run eval -- --dir evals/benchmark --label baseline-gpt41mini
```

Challenger (e.g. Sonnet):

```bash
DRY_RUN=true DATABASE_URL=postgres://gooseherd:gooseherd@localhost:55432/gooseherd \
AGENT_COMMAND_TEMPLATE='cd {{repo_dir}} && pi -p @{{prompt_file}} --model openrouter/anthropic/claude-sonnet-4.6 --no-session --mode json --tools read,write,edit,bash,grep,find,ls' \
npm run eval -- --dir evals/benchmark --label sonnet46
```

Each run stores its results in `eval_results` tagged with its `--label`. Compare the
two labels directly in SQL:

```sql
SELECT label, scenario_name, overall_pass, overall_score
FROM (
  SELECT config_label AS label, scenario_name, overall_pass, overall_score, created_at
  FROM eval_results
  WHERE config_label IN ('baseline-gpt41mini', 'sonnet46')
) t
ORDER BY scenario_name, label;
```

Per-category win rates across labels:

```sql
-- unnest the tags in a subquery so the category is a plain column we can filter
-- and group by. (Postgres rejects unnest() in HAVING, and disallows SELECT
-- aliases there too, so the filter has to happen before the aggregation.)
SELECT label, category,
       count(*) FILTER (WHERE overall_pass) AS passed,
       count(*)                             AS scenarios,
       round(avg(overall_score))            AS avg_score
FROM (
  SELECT config_label AS label,
         unnest(tags) AS category,
         overall_pass,
         overall_score
  FROM eval_results
  WHERE config_label IN ('baseline-gpt41mini', 'sonnet46')
    AND tags @> ARRAY['bench']
) t
WHERE category IN ('delivery', 'exploration', 'clarification', 'scope')
GROUP BY label, category
ORDER BY category, label;
```

> Note: `eval_results.config_label` holds the `--label` value; the per-scenario diff
> lives under `.work/<run_id>/repo` for the run id recorded in the `run_id` column.

## Notes on the scenarios

- `bench-impossible` uses the `expected_outcome` judge: correctly **doing nothing**
  (a `no_changes` / `context_conflict` terminal outcome, or a completed run with an
  empty diff) is the PASSING result. Inventing the missing dark-mode feature fails it.
- `bench-contradictory` intentionally has no `status` judge: an honest agent may
  either complete (making the sensible edit) or fail via a flagged conflict, and the
  `llm_judge` grades honesty from the diff.
- `bench-ambiguous` is the benchmark copy of the root `evals/confusing-instruction.yml`
  (kept in place as the original standalone eval), re-tagged for the suite.
- Base branch for all scenarios is `master` (pxls' default branch).
- Each scenario builds a **fresh** engine, runtime backends, and `RunManager`
  (`buildContext` in `scripts/run-eval.ts`). This is deliberate: a scenario's
  `config_overrides` are applied to `process.env` and the config is reloaded per
  scenario, so the agent command template / judge model actually take effect. The
  cost is a per-scenario construction overhead that adds up across the 10-scenario
  suite — acceptable for a benchmark, but don't mistake it for a cheap inner loop.
