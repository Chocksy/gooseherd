# Slack Conversations as Runs — Design

**Date:** 2026-05-05
**Status:** Draft, approved in conversation
**Branch:** `feat/dashboard-visible-investigations`

## Goal

Make every Slack interaction with the bot visible in the dashboard `/api/runs` list, with cost tracked per turn. A Slack thread becomes a single `runs` row whose status mutates from `conversation` (pure Q&A with the orchestrator) to `running` (pi-agent build) when the user confirms a build.

## Why

Today the orchestrator answers Slack mentions in-thread and writes thread messages to the `conversations` table, but no `runs` row is created unless the orchestrator escalates via `execute_task`. Token cost from those orchestrator turns is logged once and dropped. The dashboard cannot show "what the bot did and what it cost" for ordinary conversation. This spec closes that gap.

## Scope

In:

- New `runs.status = "conversation"` value
- New `RunIntent` kind `"conversation"`
- One `runs` row per Slack thread (chained via `parentRunId` for new follow-up cycles after a build completes)
- Per-turn token usage accumulated on the row via existing `addTokenUsage`
- Phase mutation: same row transitions from `conversation` to `queued` when the user confirms a build, with `repoSlug`, `branchName`, `task`, and `intent` filled in at that moment
- Orchestrator synthesizes a clean task spec from the conversation when build is confirmed; that spec becomes pi-agent's prompt
- Investigations triggered by `search_code` rate-limit remain child runs linked via `parentRunId` (existing pattern)
- Dashboard run detail surfaces the conversation messages and synthesized task

Out:

- WorkItem integration (Slack threads do NOT auto-create `WorkItemRecord`s in v1; this is a future v2)
- Promotion to `feature_delivery` workflow, Jira sync, review gates
- Phase loops back from build to conversation (a completed build closes that run; subsequent Q&A creates a child run)
- New dashboard UI tabs or major restructuring (additive changes to the existing run detail view only)

## Architecture

A Slack thread maps to one `runs` row. The row's lifecycle:

```
@goosy mention arrives
  → RunStore.findRunByThread(channelId, threadTs)
  → if none: RunStore.createConversationRun (status="conversation",
        repoSlug="", branchName="", task=<first message>,
        intent.kind="conversation")
  → orchestrator handleMessage
  → RunStore.addTokenUsage(runId, ...) for each model used
  → ConversationStore.set(threadKey, messages)  (existing)
  → orchestrator's reply posted to thread

  ... user keeps asking, each turn adds cost to the same row ...

User confirms build
  → orchestrator runs synthesis call (one extra LLM call)
  → slack-app calls runManager.promoteConversationToBuild(runId, {
        repoSlug, synthesizedTask, intent: GenericTaskRunIntent
     })
  → RunStore.promoteConversationRun: status="queued",
        task=<synthesized>, repoSlug=<resolved>, intent=<new>
  → RunManager.processRun (existing path) — pipeline engine fires

Build completes (or fails)
  → run status = "completed" / "failed" (existing)
  → postRunSummary posts result to thread (existing)

Follow-up question arrives in same thread
  → findRunByThread returns the now-completed run
  → terminal status detected → createConversationRun with
        parentRunId = previous run, chainIndex incremented
```

Investigation runs (from `search_code` rate-limit escalation) stay as **child runs** linked via `parentRunId` to whichever conversation run was active when the escalation fired. The investigation's answer flows back into the parent conversation as one more orchestrator turn.

## Components

### 1. `RunStatus` enum

`src/types.ts:5-15` — add `"conversation"` to the union. Update phase mapping helpers, terminal-status checks in `RunSupervisor`, retry/cancel guards, dashboard status pills.

### 2. `RunIntent` discriminated union

`src/runs/run-intent.ts:13-16` — add:

```ts
export interface ConversationRunIntent extends BaseRunIntent {
  kind: "conversation";
  question: string;          // first user message in the thread
  requestedBy: string;       // Slack user id
}
```

`selectPipelineIdForIntent` returns `undefined` for `conversation` kind (the conversation lifecycle bypasses the pipeline engine). `isRunIntent` validation extended.

When a run promotes to build, the intent is **replaced in place** with `GenericTaskRunIntent` (or `InvestigateRunIntent` for read-only investigations). This is the deliberate "intents change" shift — runs are durable across phases, intents are per-phase.

### 3. `RunStore` extensions

`src/store.ts` — three new methods:

- `findRunByThread(channelId, threadTs): Promise<RunRecord | undefined>` — returns the most recent run for the thread, regardless of status.
- `createConversationRun(input): Promise<RunRecord>` — creates a row with `status="conversation"`, `intent.kind="conversation"`, placeholder `repoSlug=""`, auto-generated `branchName` from `branchPrefix + id.slice(0,8)` (existing convention), `baseBranch=config.defaultBaseBranch`, `task=<first message truncated to MAX_TASK_CHARS>`. Sets `parentRunId` and chain fields if a prior thread run exists.
- `promoteConversationRun(id, { repoSlug, task, intent, branchName? }): Promise<RunRecord>` — atomic update flipping `status` from `"conversation"` to `"queued"`, replacing `task`, `repoSlug`, and `intent`, optionally updating `branchName`. Throws if current status is not `"conversation"`.

`addTokenUsage` (`src/store.ts:404`) is reused for per-turn cost. No schema migration required — existing nullable columns and the `intent` jsonb already accept the new shape.

### 4. `RunManager` orchestration

`src/run-manager.ts` — three new methods:

- `getOrCreateConversationRun(input)`: looks up an active conversation run (`status="conversation"`) for the thread; if the latest run is terminal (`completed/failed/cancelled`) or doesn't exist, creates a new one (chained via `parentRunId` if applicable).
- `recordConversationTurn(runId, tokenUsages: TokenUsageIncrement[])`: calls `store.addTokenUsage` for each entry. Used after each orchestrator turn.
- `promoteConversationToBuild(runId, { repoSlug, synthesizedTask, intent })`: calls `store.promoteConversationRun`, then enqueues processing via `requeueExistingRun(runId)` so the existing pipeline path picks it up.

### 5. Orchestrator `HandleMessageResult`

`src/orchestrator/types.ts:49-53` — extend:

```ts
export interface HandleMessageResult {
  response: string;
  runsQueued: Array<{ id: string; branchName: string; repoSlug: string }>;
  messages: ChatMessage[];
  tokenUsage: Array<{ model: string; input: number; output: number }>;  // NEW
  buildProposal?: {                                                       // NEW
    repoSlug: string;
    summary: string;
  };
}
```

`callLLMWithTools` already exposes `totalInputTokens, totalOutputTokens, model` (`src/llm/caller.ts:321-322, 477-478`). The orchestrator accumulates per-model totals across the tool-use loop and surfaces them in the result. `buildProposal` is set when the orchestrator decides this turn is proposing a build (so the slack-app knows the next user "yes" should trigger promotion).

### 6. Build trigger — propose / confirm pattern

The orchestrator gets a new tool, `propose_build`:

```
propose_build({ repoSlug, summary })
  → returns: "Proposal recorded. The user will be asked to confirm."
  → side effect: sets buildProposal on HandleMessageResult
```

Slack-app sees `buildProposal` and posts the orchestrator's text reply (which includes the proposal) plus interactive buttons (or treats the next user message in the thread as the confirmation channel — see Data Flow).

When the user's next message in the thread is a confirmation (`"yes" / "go" / "build" / "lgtm" / "approved"` etc., reusing the existing `APPROVAL_PATTERNS` regex at `src/slack-app.ts:43-44`), the slack-app calls `synthesize-task` then `promoteConversationToBuild`. If the user instead asks more questions, the proposal is invalidated and the orchestrator continues conversing.

### 7. `synthesize-task` helper

NEW: `src/orchestrator/synthesize-task.ts`

Takes the conversation messages plus the `buildProposal.summary` and runs one LLM call with a focused prompt: *"You are converting a Slack conversation into a clean task spec for a coding agent. Output: goal, constraints, files to look at, success criteria."* Returns the synthesized markdown task. Token usage from this call is also recorded against the run.

### 8. `slack-app.ts` mention handler

`src/slack-app.ts:725-885` — flow change:

1. **Resolve thread run before building deps:**
   ```ts
   const conversationRun = await runManager.getOrCreateConversationRun({
     channelId: event.channel,
     threadTs: replyThreadTs,
     requestedBy: event.user!,
     firstMessage: stripped,
     defaultBaseBranch: config.defaultBaseBranch,
     branchPrefix: config.branchPrefix,
   });
   ```

2. **Pass `runId` into `HandleMessageDeps` so orchestrator tools and synthesis can reference it.** The `enqueueRun` callback inside `depsWithContext` no longer creates new runs for `mode: "code_change"` — instead it stages a build proposal. For `mode: "investigate"` it creates a child run with `parentRunId = conversationRun.id` (existing investigation pipeline).

3. **Detect confirmation messages:** if the latest run for the thread is in `conversation` status AND has a pending `buildProposal` AND the current user message matches `APPROVAL_PATTERNS`, branch into `synthesize-task` then `promoteConversationToBuild`. Skip the normal orchestrator call for confirmation messages — there's nothing to answer.

4. **After `handleMessage` returns:** call `runManager.recordConversationTurn(conversationRun.id, result.tokenUsage)`.

5. **Persist the build proposal** on the run via a new `pending_build_proposal jsonb` column on `runs` (small additive migration). Cleared (set to null) when promoted or when the orchestrator's next non-proposal turn fires.

### 9. Orchestrator system prompt

`src/orchestrator/system-context.ts` — additions:

- "If the user has not specified a repo and the thread has no active repo from prior runs, ask which repo they mean before proceeding. The allowlist is provided below."
- "Before calling `execute_task` for a code change, call `propose_build` to propose the change in plain text. Do not queue the build yourself. The user will confirm in the next message; the system will queue the build at that moment."
- "If `search_code` returns a rate-limited error, escalate to `execute_task` with `mode=\"investigate\"` immediately — investigations remain child runs and don't need user confirmation." (existing behavior, just made explicit.)

### 10. Dashboard run detail

`src/dashboard/html.ts` + `src/dashboard/routes/run-routes.ts` — minimal additions:

- Render a "Conversation" panel on every run that has messages in the conversations store (uses existing `/api/runs/:id/conversation` endpoint).
- For runs with `intentKind === "conversation"`, show a "Status: Conversation in progress" badge and a "Cost so far" summary. Hide pipeline-specific UI (PR link, changed files) when not applicable.
- For runs that promoted to build, show both the synthesized task (current `task` field) AND a "View original conversation" disclosure with the messages.
- Status filter pill list adds `"conversation"`.

## Data flow

### Walking through a single thread end-to-end

```
T+0  User: "@goosy why is the auth slow in chocksy/cems?"
     slack-app: getOrCreateConversationRun → new row (status=conversation,
                                 task="why is the auth slow...", repoSlug="chocksy/cems")
     orchestrator: search_code, read_file, ... answers with explanation
     slack-app: recordConversationTurn(runId, [{model: "gpt-4.1-mini", input: 5601, output: 820}])
     run row in dashboard: 1 turn, $0.0042

T+5  User: "ok and how would we fix it?"
     slack-app: findRunByThread → existing conversation row, reuse
     orchestrator: more reasoning, finally calls propose_build({
         repoSlug: "chocksy/cems",
         summary: "Cache JWT verification result; expected ~80ms reduction."
     })
     orchestrator's text reply ends with "Want me to build this?"
     slack-app: result.buildProposal set → persisted on run
     slack-app: recordConversationTurn(runId, [...])
     run row: 2 turns, $0.0089, "Build proposed"

T+8  User: "yes go"
     slack-app: APPROVAL_PATTERNS matches AND pendingBuildProposal exists
     slack-app: synthesizeTask(conversationStore.get(threadKey), proposal)
                returns clean markdown task spec
     slack-app: recordConversationTurn(runId, [...])  // cost the synthesis call
     slack-app: promoteConversationToBuild(runId, {
         repoSlug: "chocksy/cems",
         synthesizedTask: <markdown>,
         intent: { kind: "generic_task", source: "slack", requestedBy: <user> }
     })
     RunStore.promoteConversationRun: status=conversation→queued,
                                       task=<synthesized>, intent=<new>
     RunManager.processRun: pipeline engine fires (existing path)
     run row: status=queued → running → completed, PR linked

T+45 Build completes; postRunSummary posts result; thread reply with PR.

T+90 User in same thread: "btw also rename foo to bar"
     slack-app: findRunByThread → returns the now-completed run (terminal)
     slack-app: createConversationRun with parentRunId = previous run,
                                          chainIndex = 1
     New row appears in dashboard, chained to the prior one.
```

### Investigate path (rate-limit escalation)

Unchanged from today, except the new investigation run gets `parentRunId = conversationRunId` so the dashboard chain view shows it as a child of the conversation.

## Error handling

- **Concurrent Slack mentions on the same thread:** `findRunByThread` runs inside the same transaction as `createConversationRun` to avoid two rows being created for one thread. Postgres advisory lock on `hashtext(channelId + ":" + threadTs)` (consistent with the pattern at `src/work-items/orchestrator.ts:92`).
- **Promotion fails (DB error):** the conversation row stays in `conversation` status, the user sees a Slack error reply, the buildProposal stays pending so a retry "yes" works.
- **Synthesis LLM call fails:** fall back to using the orchestrator's last reply as the synthesized task (degraded but functional). Log a warning and surface in the run's `error` field.
- **Pipeline engine receives a run with `intent.kind="conversation"`:** should never happen because promote replaces intent before requeue, but `selectPipelineIdForIntent` defends by returning undefined; `RunManager.processRun` already throws on missing pipeline.
- **User keeps asking after a proposal without confirming or rejecting:** the proposal is overwritten by the next `propose_build` call, or naturally invalidated as conversation continues.
- **`postRunSummary` for a conversation run:** when a conversation run terminates without ever building (e.g. user abandons the thread), `postRunSummary` should NOT post anything for that case. Add a guard: skip summary when the run never left `conversation` status.

## Testing strategy

Following TDD — failing test first, then implementation, for each unit:

### Store-level

- `tests/run-store-conversation.test.ts` (NEW)
  - `findRunByThread` returns most recent run for thread / undefined if none
  - `createConversationRun` writes status=conversation, intent.kind=conversation, placeholders for repoSlug/branchName, populates baseBranch from default
  - `promoteConversationRun` flips status, replaces intent, updates repoSlug/task atomically
  - `promoteConversationRun` throws if current status is not "conversation"
  - `addTokenUsage` works on conversation rows (existing test extended)

### RunManager

- `tests/run-manager-conversation.test.ts` (NEW)
  - `getOrCreateConversationRun` returns existing active conversation run for thread
  - `getOrCreateConversationRun` chains a new run after a terminal previous run (parentRunId, chainIndex)
  - `recordConversationTurn` accumulates token usage across multiple calls
  - `promoteConversationToBuild` updates row and triggers `requeueExistingRun`

### Orchestrator

- `tests/orchestrator-token-surface.test.ts` (NEW)
  - `handleMessage` returns `tokenUsage` per-model array summed across the tool loop
- `tests/orchestrator-propose-build.test.ts` (NEW)
  - `propose_build` tool sets `buildProposal` on result without queueing a run
  - `execute_task` mode=investigate still creates an investigate child run
  - System prompt contains the propose-then-confirm instruction

### Synthesize task

- `tests/synthesize-task.test.ts` (NEW)
  - Given a transcript and proposal summary, produces a structured markdown spec
  - Returns token usage for caller to record
  - Falls back gracefully when LLM call fails

### Slack-app integration

- `tests/slack-app-conversation-flow.test.ts` (NEW)
  - First mention creates a conversation run; second mention reuses it
  - APPROVAL_PATTERNS match on a thread with pendingBuildProposal triggers synthesize+promote
  - APPROVAL_PATTERNS match on a thread WITHOUT pendingBuildProposal does not promote
  - Investigate child runs link via parentRunId to the conversation run
  - Token usage recorded after each handleMessage call

### End-to-end (Docker)

- Manual: ask a question in Slack, observe row appears in dashboard with cost; follow up; say "yes go"; observe row transitions to running → completed with PR link.

## Open questions

None blocking v1. Future work:

- WorkItem auto-creation for Slack threads (v2 — when ready to wire Jira/review gates)
- Promotion of a conversation run into a `feature_delivery` WorkItem (v2)
- Cost summary endpoint `/api/runs/cost-summary?period=...` for finance/observability (v2)
- Streaming token usage updates so the dashboard "Cost so far" updates live (v2)

## File touchpoints (for implementation plan)

NEW files:

- `src/orchestrator/synthesize-task.ts`
- `tests/run-store-conversation.test.ts`
- `tests/run-manager-conversation.test.ts`
- `tests/orchestrator-token-surface.test.ts`
- `tests/orchestrator-propose-build.test.ts`
- `tests/synthesize-task.test.ts`
- `tests/slack-app-conversation-flow.test.ts`

MODIFIED files:

- `src/types.ts` — `RunStatus` add `"conversation"`
- `src/runs/run-intent.ts` — `RunIntent` add `ConversationRunIntent`, validation, routing
- `src/store.ts` — three new methods
- `src/run-manager.ts` — three new methods
- `src/orchestrator/types.ts` — extend `HandleMessageResult` (tokenUsage, buildProposal)
- `src/orchestrator/orchestrator.ts` — surface tokenUsage; add `propose_build` tool
- `src/orchestrator/system-context.ts` — propose-then-confirm prompt instructions
- `src/slack-app.ts` — mention handler flow change
- `src/db/schema.ts` — add `pending_build_proposal` jsonb column on `runs` (small migration)
- `drizzle/<next>_pending_build_proposal.sql` — migration
- `src/dashboard/routes/run-routes.ts` — surface conversation messages to run detail
- `src/dashboard/html.ts` — conversation panel + status pill
