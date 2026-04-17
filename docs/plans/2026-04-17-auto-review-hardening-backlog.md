# Auto-Review Hardening Backlog

## Purpose

This backlog captures follow-up work after reviewing auto-review run `713c465d-6515-4553-8906-3b7a867938b6`
and commit `2233aeb52e52ba1e418756c09de7ecfad613d5e5` against `vsevolod/openai_bot` PR #2.

The goals are:

- stop Gooseherd from committing its own runtime artifacts
- improve auto-review grounding on the actual PR diff
- add safe failure modes when the context is contradictory
- catch obvious broken fixes before push
- keep downstream prompts and reporting clean

## Priority Order

- `P0`: correctness and trust blockers
- `P1`: prompt, safety, and observability improvements
- `P2`: defense in depth and product polish

---

## P0

### P0.1 Prevent `AGENTS.md` and other internal runtime artifacts from being committed

Problem:

- `hydrate_context` writes a dynamic `AGENTS.md` into the repo root.
- commit staging later uses `git add -A`.
- runtime files can be pushed to user repositories by accident.

Relevant code:

- `src/pipeline/nodes/hydrate-context.ts`
- `src/pipeline/git-ops.ts`

Acceptance criteria:

- internal runtime files cannot appear in git commits created by Gooseherd
- internal runtime files cannot appear in `changedFiles`
- internal runtime files cannot appear in generated PR summaries

### P0.2 Introduce one shared policy for internal-generated files

Problem:

- `AGENTS.md` is currently treated as internal only in one place.
- other pipeline stages still treat it as a normal source file.

Relevant code:

- `src/pipeline/nodes/implement.ts`
- `src/pipeline/git-ops.ts`
- any node that reads `changedFiles`

Acceptance criteria:

- one shared helper defines what counts as an internal-generated file
- commit, reporting, prompt-building, and metadata paths all use the same filter
- adding a new internal artifact requires changing one place only

### P0.3 Provide the actual PR diff to auto-review runs

Problem:

- auto-review currently gets task text, comments, review summaries, CI, and Jira
- it does not get the actual current patch in an explicit form
- the agent can react to comments without grounding on the current diff

Relevant code:

- `src/runtime/run-context-prefetcher.ts`
- `src/pipeline/nodes/hydrate-context.ts`

Acceptance criteria:

- auto-review prompt includes the current PR diff, patch summary, or selected hunks
- the prompt makes it clear which `head` SHA the diff belongs to
- a reviewer can inspect the stored prompt context and confirm the diff was present

### P0.4 Add an explicit conflict/refusal path for contradictory context

Problem:

- today the agent is pressured to act even when task text, PR diff, comments, and Jira do not line up
- that leads to low-confidence random fixes instead of a clear refusal

Acceptance criteria:

- the pipeline supports a terminal outcome like `context_conflict` or `needs_clarification`
- the agent can stop without code changes when it cannot form a coherent action
- no commit or push happens after this refusal path triggers

### P0.5 Add a regression test for the `AGENTS.md` incident

Problem:

- the current failure mode is easy to reintroduce
- there is no test that proves internal prompt files stay out of commits and metadata

Acceptance criteria:

- an automated test reproduces a run that generates internal files and real code changes
- the resulting commit excludes internal files
- the resulting `changedFiles` excludes internal files

---

## P1

### P1.1 Add a minimal Ruby syntax gate before push

Problem:

- the auto-review run was able to push a Ruby change that was not end-to-end sound
- a cheap syntax-level gate would catch a useful class of bad fixes

Scope:

- lightweight validation only
- start with changed `.rb` files

Acceptance criteria:

- Gooseherd runs `ruby -c` on changed Ruby files before push
- syntax failures stop the run before push
- the failure is visible in logs and the final run status

### P1.2 Sanitize all downstream consumers of `changedFiles`

Problem:

- `changedFiles` is not just a dashboard field
- it feeds PR summaries and follow-up prompts
- polluted file lists distort later agent behavior

Relevant code:

- `src/pipeline/nodes/create-pr.ts`
- `src/pipeline/quality-gates/browser-verify.ts`
- `src/pipeline/ci/fix-ci-node.ts`
- dashboard and reconciliation paths

Acceptance criteria:

- downstream prompts only see source files relevant to the user's change
- internal files never appear in PR body tables or fix prompts
- stored completion metadata uses the sanitized file list

### P1.3 Strengthen the auto-review prompt instruction for review comments

Decision:

- keep broad comment intake
- do not pre-filter comments aggressively
- require the agent to verify relevance itself

Needed prompt behavior:

- comments are hints, not instructions
- comments must be checked against the current diff and `head`
- irrelevant comments should be ignored explicitly

Acceptance criteria:

- the prompt contains this rule clearly
- an evaluation case with stale or irrelevant comments no longer causes unrelated fixes

### P1.4 Store a structured reasoning summary for each auto-review run

Problem:

- current logs are not enough to reconstruct why a fix was chosen
- postmortems depend on diff archaeology and guesswork

Acceptance criteria:

- each auto-review run stores a compact artifact with:
  - selected findings
  - ignored findings
  - rationale for chosen fix
- the artifact is accessible after the run completes

### P1.5 Add a regression test for contradictory prompt context

Problem:

- we want a reliable refusal path, not just a prompt wish

Acceptance criteria:

- a fixture with conflicting task text and diff triggers the refusal path
- the run ends without commit or push
- the final status clearly explains why the run stopped

---

## P2

### P2.1 Expand lightweight language-aware smoke checks

Problem:

- `ruby -c` is a good start but only covers one stack
- other repos need similarly cheap early feedback

Acceptance criteria:

- Gooseherd supports pluggable lightweight checks by file type or stack
- the first implementation keeps the runtime cheap and deterministic

### P2.2 Separate source-file changes from internal artifacts in the data model

Problem:

- today one mixed list tries to serve both reporting and automation
- that creates ambiguity and encourages accidental coupling

Acceptance criteria:

- the run model distinguishes source changes from internal artifacts
- UI and prompts use the source-change list by default
- internal artifacts remain available only for debugging where needed

### P2.3 Add defense in depth in forbidden/guarded file rules

Problem:

- internal artifacts should be blocked even if earlier filtering fails

Acceptance criteria:

- guarded or denied rules cover Gooseherd-owned runtime files
- a leaked internal file causes a visible gate failure before push

### P2.4 Add quality metrics for auto-review grounding

Problem:

- we currently lack a measurable signal for whether the agent fixed something tied to the actual diff

Acceptance criteria:

- define and store at least one metric for finding-to-diff relevance
- use it in evaluation or run review reporting

---

## Suggested Execution Order

1. `P0.1`
2. `P0.2`
3. `P0.5`
4. `P0.3`
5. `P0.4`
6. `P1.2`
7. `P1.3`
8. `P1.5`
9. `P1.1`
10. `P1.4`
11. `P2.*`

## Notes

- Keep broad comment ingestion. Relevance filtering should happen inside agent reasoning, not by aggressively trimming the source data.
- Add a refusal path for contradictory context instead of silently guessing.
