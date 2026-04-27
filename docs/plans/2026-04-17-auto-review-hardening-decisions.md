# Auto-Review Hardening Decisions

## Context

These notes capture the decisions made while reviewing the failure mode behind
auto-review run `713c465d-6515-4553-8906-3b7a867938b6` and the resulting commit
`2233aeb52e52ba1e418756c09de7ecfad613d5e5`.

The goal is to keep the backlog stable and avoid re-arguing the same points later.

---

## Confirmed Points

### 1. `AGENTS.md` in user commits is a real Gooseherd bug

Confirmed.

Gooseherd writes a dynamic `AGENTS.md` into the cloned repository and later stages
everything with `git add -A`. That makes internal prompt context commit-able by accident.

### 2. Internal-generated files need one shared exclusion policy

Confirmed.

It is not enough to special-case `AGENTS.md` during one analysis step. The same policy
must apply to commit staging, reporting, metadata, and follow-up prompts.

### 3. Auto-review needs the actual PR diff

Confirmed.

Comments and Jira are useful, but they are not a substitute for the current patch.
The agent should be grounded on the actual diff for the current `head`.

### 4. Keep broad comment intake; filter in reasoning

Decision:

- do not aggressively pre-filter comments out of the prefetched context
- resolved comments are already screened out
- the prompt should explicitly tell the agent to verify whether a comment is still relevant

Working rule:

- comments are hints
- the diff is the source of truth
- irrelevant comments should be ignored rather than blindly implemented

### 5. Pushing broken fixes without validation is a real problem

Confirmed.

The run was able to push a weak partial fix. A small amount of cheap validation is justified.

### 6. A lightweight Ruby check is useful but not the main fix

Confirmed.

This is not the root-cause fix for bad reasoning, but it is still worthwhile as a low-cost
safety net for Ruby repositories.

### 7. Runtime prompt artifacts should not live in tracked repo files

Confirmed.

Even if they are later excluded from commits, writing them into tracked repo files is still
risky because it mutates user state in-place.

### 8. Quality gates should defend against Gooseherd's own artifacts

Confirmed.

Earlier filtering is the primary fix, but a second layer in forbidden or guarded file rules
is still useful.

### 9. We need better post-run explainability

Confirmed.

Current logs are too thin to explain why the agent selected a given fix. A compact reasoning
artifact is worth storing.

### 10. The problem is not "noisy context"; it is missing refusal behavior

Decision:

- noisy or even intentionally contradictory context can exist
- the agent must be able to refuse or stop when it cannot derive a coherent action

Working rule:

- if task text, diff, comments, and Jira conflict materially, prefer a clear refusal path
- do not guess

### 11. End-to-end relevance checks are missing

Confirmed.

The agent should not stop at "I found a related comment". It needs to verify that the
proposed change is complete across call sites and invariants.

### 12. Why polluted `changedFiles` matters

`changedFiles` is not just a cosmetic field.

It is:

- returned from the pipeline execution result
- stored in the run record
- shown in PR summaries
- passed into downstream prompts such as browser verification and CI fix loops

So if `AGENTS.md` leaks into `changedFiles`, three bad things happen:

- reporting lies about what the user-facing change actually was
- downstream prompts are given misleading file context
- analytics and later automation operate on mixed source files plus runtime garbage

This is why the bug is not only about a dirty dashboard entry. It can change later agent behavior.

---

## Prompt Principles To Keep

- Keep broad intake for comments and surrounding context.
- Make the prompt explicit that comments are hints, not orders.
- Ground decisions on the current diff and `head`.
- Prefer refusal over guessing when context is contradictory.
- Keep cheap syntax checks as safety nets, not as replacements for reasoning quality.
