# Slack Conversations as Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Slack interaction a `runs` row with token cost tracked per turn; same row transitions from `conversation` to `running` (pi-agent build) when the user confirms a build proposal.

**Architecture:** A Slack thread maps to one `runs` row. New status `"conversation"` and intent kind `"conversation"`. New `runs.pending_build_proposal jsonb` column. Slack-app handler creates/looks-up the thread's run before each `handleMessage` call and records token cost after. Orchestrator gets a `propose_build` tool. When the user's next message matches `APPROVAL_PATTERNS` and a proposal is pending, the slack-app calls a `synthesize-task` helper (one extra LLM call) and `runManager.promoteConversationToBuild`. Investigations triggered by `search_code` rate-limit stay as child runs via `parentRunId`.

**Tech Stack:** TypeScript, Node test runner, drizzle-orm, Postgres, Slack Bolt SDK, existing pi-agent CLI.

**Spec:** `docs/superpowers/specs/2026-05-05-slack-conversations-as-runs-design.md`

---

## File Structure

NEW files:
- `drizzle/0024_pending_build_proposal.sql`
- `src/orchestrator/synthesize-task.ts`
- `tests/run-store-conversation.test.ts`
- `tests/run-manager-conversation.test.ts`
- `tests/orchestrator-token-surface.test.ts`
- `tests/orchestrator-propose-build.test.ts`
- `tests/synthesize-task.test.ts`
- `tests/slack-app-conversation-flow.test.ts`

MODIFIED files:
- `src/types.ts` — `RunStatus` adds `"conversation"`
- `src/runs/run-intent.ts` — new `ConversationRunIntent`, validation, routing
- `src/db/schema.ts` — `runs.pending_build_proposal jsonb` column
- `src/store.ts` — three new methods, schema-mapping for new column
- `src/run-manager.ts` — three new methods
- `src/orchestrator/types.ts` — extend `HandleMessageResult` with `tokenUsage` and `buildProposal`
- `src/orchestrator/orchestrator.ts` — surface tokenUsage; add `propose_build` tool
- `src/orchestrator/system-context.ts` — propose-then-confirm prompt instructions
- `src/slack-app.ts` — mention handler flow change
- `src/dashboard/routes/run-routes.ts` — surface conversation in run detail
- `src/dashboard/html.ts` — conversation panel + status pill

---

## Task 1: Add `"conversation"` to `RunStatus` and `RunPhase`

**Files:**
- Modify: `src/types.ts:5-29`
- Test: relies on type checking + downstream tests

- [ ] **Step 1: Add status to union**

In `src/types.ts:5-15`, add `"conversation"` to `RunStatus`:

```ts
export type RunStatus =
  | "queued"
  | "running"
  | "validating"
  | "pushing"
  | "awaiting_ci"
  | "ci_fixing"
  | "cancel_requested"
  | "completed"
  | "failed"
  | "cancelled"
  | "conversation";
```

In `src/types.ts:17-29`, add `"conversation"` to `RunPhase`:

```ts
export type RunPhase =
  | "queued"
  | "cloning"
  | "rebasing"
  | "agent"
  | "validating"
  | "pushing"
  | "awaiting_ci"
  | "ci_fixing"
  | "cancel_requested"
  | "completed"
  | "failed"
  | "cancelled"
  | "conversation";
```

- [ ] **Step 2: Type check**

Run: `npm run check`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(runs): add conversation status and phase"
```

---

## Task 2: Add `ConversationRunIntent` to the `RunIntent` discriminated union

**Files:**
- Modify: `src/runs/run-intent.ts`
- Test: extend an existing test or add to `tests/run-intent.test.ts`

- [ ] **Step 1: Write failing tests**

In `tests/run-intent.test.ts` (append):

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { isRunIntent, selectPipelineIdForIntent } from "../src/runs/run-intent.js";

test("ConversationRunIntent passes isRunIntent validation", () => {
  const intent = {
    version: 1,
    kind: "conversation",
    source: "slack",
    requestedBy: "U123",
    question: "why is auth slow?",
  };
  assert.equal(isRunIntent(intent), true);
});

test("selectPipelineIdForIntent returns undefined for conversation kind", () => {
  const intent = {
    version: 1 as const,
    kind: "conversation" as const,
    source: "slack" as const,
    requestedBy: "U123",
    question: "anything",
  };
  assert.equal(selectPipelineIdForIntent(intent), undefined);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx tsc --noEmit` first — expect type errors because `kind: "conversation"` isn't in the union yet.

- [ ] **Step 3: Add the intent type**

In `src/runs/run-intent.ts`, after the `InvestigateRunIntent` interface declaration, add:

```ts
export interface ConversationRunIntent extends BaseRunIntent {
  kind: "conversation";
  source: "slack";
  /** The first user message that started the thread, verbatim or truncated. */
  question: string;
  /** Slack user id who started the thread. */
  requestedBy: string;
}
```

Update `RunIntent` union (around line 13):

```ts
export type RunIntent =
  | GenericTaskRunIntent
  | FeatureDeliveryRunIntent
  | InvestigateRunIntent
  | ConversationRunIntent;
```

- [ ] **Step 4: Add validation branch in `isRunIntent`**

In `src/runs/run-intent.ts:147` (the `isRunIntent` function), after the existing `intent.kind === "investigate"` branch, add:

```ts
  if (intent.kind === "conversation") {
    return isConversationIntent(intent);
  }
```

Add the helper near other `is*Intent` helpers (after `isInvestigateIntent`):

```ts
function isConversationIntent(intent: Record<string, unknown>): boolean {
  return (
    intent.source === "slack" &&
    typeof intent.question === "string" && intent.question.length > 0 &&
    typeof intent.requestedBy === "string" && intent.requestedBy.length > 0
  );
}
```

- [ ] **Step 5: Update `selectPipelineIdForIntent` to return undefined for conversation**

In `src/runs/run-intent.ts:213-224`, the function already returns `PIPELINE_BY_INTENT_KIND[intent.kind] ?? legacyPipelineHint`. Since `conversation` is not in `PIPELINE_BY_INTENT_KIND`, it would fall through to `legacyPipelineHint`. Make the conversation case explicit and return `undefined`:

```ts
export function selectPipelineIdForIntent(
  intent: RunIntent | undefined,
  legacyPipelineHint?: string,
): string | undefined {
  if (!intent) {
    return legacyPipelineHint;
  }
  if (intent.kind === "conversation") {
    return undefined;
  }
  if (intent.kind === "generic_task") {
    return intent.pipelineHint ?? legacyPipelineHint;
  }
  return PIPELINE_BY_INTENT_KIND[intent.kind] ?? legacyPipelineHint;
}
```

- [ ] **Step 6: Run tests**

Run: `node --test tests/run-intent.test.ts`
Expected: all tests pass.

- [ ] **Step 7: Run type check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/runs/run-intent.ts tests/run-intent.test.ts
git commit -m "feat(runs): add ConversationRunIntent kind and routing"
```

---

## Task 3: Migration — `runs.pending_build_proposal jsonb` column

**Files:**
- Create: `drizzle/0024_pending_build_proposal.sql`
- Modify: `src/db/schema.ts:39-103`

- [ ] **Step 1: Create migration file**

Create `drizzle/0024_pending_build_proposal.sql`:

```sql
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "pending_build_proposal" jsonb;
--> statement-breakpoint
```

- [ ] **Step 2: Add column to schema definition**

In `src/db/schema.ts`, locate the `runs` table definition (line 39). After the `intentKind: text("intent_kind")` line (around line 82), add:

```ts
    pendingBuildProposal: jsonb("pending_build_proposal").$type<{ repoSlug: string; summary: string }>(),
```

- [ ] **Step 3: Type check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add drizzle/0024_pending_build_proposal.sql src/db/schema.ts
git commit -m "feat(db): add pending_build_proposal column on runs"
```

---

## Task 4: `RunStore.findRunByThread`

**Files:**
- Modify: `src/store.ts`
- Test: `tests/run-store-conversation.test.ts` (NEW)

- [ ] **Step 1: Write failing test**

Create `tests/run-store-conversation.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { RunStore } from "../src/store.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";

let db: TestDb;
let store: RunStore;

test.beforeEach(async () => {
  db = await createTestDb();
  store = new RunStore(db.db);
});

test.afterEach(async () => {
  await db.cleanup();
});

test("findRunByThread returns undefined when no run exists for the thread", async () => {
  const result = await store.findRunByThread("C1", "1700000000.0");
  assert.equal(result, undefined);
});

test("findRunByThread returns the most recent run for a thread", async () => {
  const first = await store.createRun({
    repoSlug: "owner/repo",
    task: "first",
    baseBranch: "main",
    requestedBy: "U1",
    channelId: "C1",
    threadTs: "1700000000.0",
    runtime: "local",
  }, "test");

  // Backdate first run so the second is unambiguously newer.
  await new Promise((r) => setTimeout(r, 10));

  const second = await store.createRun({
    repoSlug: "owner/repo",
    task: "second",
    baseBranch: "main",
    requestedBy: "U1",
    channelId: "C1",
    threadTs: "1700000000.0",
    runtime: "local",
  }, "test");

  const result = await store.findRunByThread("C1", "1700000000.0");
  assert.ok(result);
  assert.equal(result.id, second.id);
  assert.equal(result.task, "second");
  // first still exists
  const firstAgain = await store.getRun(first.id);
  assert.ok(firstAgain);
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `node --test tests/run-store-conversation.test.ts`
Expected: FAIL with "store.findRunByThread is not a function" (or similar).

- [ ] **Step 3: Implement `findRunByThread`**

In `src/store.ts`, after the existing `getLatestRunForThread` method (around line 275), add:

```ts
async findRunByThread(channelId: string, threadTs: string): Promise<RunRecord | undefined> {
  const rows = await this.selectRunRows()
    .where(and(eq(runs.channelId, channelId), eq(runs.threadTs, threadTs)))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  return rows[0] ? rowToRecord(rows[0]) : undefined;
}
```

- [ ] **Step 4: Run test**

Run: `node --test tests/run-store-conversation.test.ts`
Expected: both tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts tests/run-store-conversation.test.ts
git commit -m "feat(store): add findRunByThread"
```

---

## Task 5: `RunStore.createConversationRun`

**Files:**
- Modify: `src/store.ts`
- Test: `tests/run-store-conversation.test.ts`

- [ ] **Step 1: Write failing test**

Append to `tests/run-store-conversation.test.ts`:

```ts
test("createConversationRun creates a row with status=conversation and intent kind=conversation", async () => {
  const run = await store.createConversationRun({
    channelId: "C2",
    threadTs: "1700000001.0",
    requestedBy: "U2",
    firstMessage: "why is auth slow in chocksy/cems?",
    defaultBaseBranch: "main",
    branchPrefix: "test",
  });

  assert.equal(run.status, "conversation");
  assert.equal(run.repoSlug, "");
  assert.equal(run.branchName.startsWith("test/"), true);
  assert.equal(run.task, "why is auth slow in chocksy/cems?");
  assert.equal(run.baseBranch, "main");
  assert.equal(run.intent?.kind, "conversation");
  assert.equal(run.intentKind, "conversation");
  assert.equal(run.channelId, "C2");
  assert.equal(run.threadTs, "1700000001.0");
});

test("createConversationRun chains via parentRunId when prior thread run is terminal", async () => {
  const first = await store.createConversationRun({
    channelId: "C3",
    threadTs: "1700000002.0",
    requestedBy: "U3",
    firstMessage: "first",
    defaultBaseBranch: "main",
    branchPrefix: "test",
  });
  await store.updateRun(first.id, { status: "completed", phase: "completed" });

  const second = await store.createConversationRun({
    channelId: "C3",
    threadTs: "1700000002.0",
    requestedBy: "U3",
    firstMessage: "follow-up",
    defaultBaseBranch: "main",
    branchPrefix: "test",
    parentRunId: first.id,
  });

  assert.equal(second.parentRunId, first.id);
  assert.equal(second.rootRunId, first.id);
  assert.equal(second.chainIndex, 1);
});
```

- [ ] **Step 2: Verify failure**

Run: `node --test tests/run-store-conversation.test.ts`
Expected: FAIL with "store.createConversationRun is not a function".

- [ ] **Step 3: Implement `createConversationRun`**

Add a new input type at the top of `src/store.ts` (near other type imports/exports, or just before the class):

```ts
export interface CreateConversationRunInput {
  channelId: string;
  threadTs: string;
  requestedBy: string;
  firstMessage: string;
  defaultBaseBranch: string;
  branchPrefix: string;
  parentRunId?: string;
}
```

Then in `RunStore`, after `createRun`, add:

```ts
async createConversationRun(input: CreateConversationRunInput): Promise<RunRecord> {
  const id = randomUUID();
  const branchName = `${input.branchPrefix}/${id.slice(0, 8)}`;
  let rootRunId: string | undefined;
  let chainIndex = 0;
  if (input.parentRunId) {
    const parentRows = await this.db.select().from(runs).where(eq(runs.id, input.parentRunId));
    const parent = parentRows[0];
    if (parent) {
      rootRunId = parent.rootRunId ?? parent.id;
      chainIndex = (parent.chainIndex ?? 0) + 1;
    }
  }

  const intent: RunIntent = {
    version: 1,
    kind: "conversation",
    source: "slack",
    question: input.firstMessage,
    requestedBy: input.requestedBy,
  };

  await this.db.insert(runs).values({
    id,
    runtime: "local",
    status: "conversation",
    phase: "conversation",
    repoSlug: "",
    task: input.firstMessage,
    baseBranch: input.defaultBaseBranch,
    branchName,
    requestedBy: input.requestedBy,
    channelId: input.channelId,
    threadTs: input.threadTs,
    createdAt: new Date(),
    parentRunId: input.parentRunId,
    rootRunId,
    chainIndex,
    intent,
    intentKind: intent.kind,
  });

  return (await this.getRun(id))!;
}
```

Make sure `RunIntent` is imported at the top — it should already be present.

- [ ] **Step 4: Run tests**

Run: `node --test tests/run-store-conversation.test.ts`
Expected: all tests pass (4 tests so far).

- [ ] **Step 5: Commit**

```bash
git add src/store.ts tests/run-store-conversation.test.ts
git commit -m "feat(store): add createConversationRun"
```

---

## Task 6: `RunStore.promoteConversationRun` and `setPendingBuildProposal`

**Files:**
- Modify: `src/store.ts`
- Test: `tests/run-store-conversation.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/run-store-conversation.test.ts`:

```ts
test("setPendingBuildProposal stores the proposal as a jsonb field", async () => {
  const run = await store.createConversationRun({
    channelId: "C4",
    threadTs: "1700000003.0",
    requestedBy: "U4",
    firstMessage: "explain auth",
    defaultBaseBranch: "main",
    branchPrefix: "test",
  });

  await store.setPendingBuildProposal(run.id, {
    repoSlug: "owner/repo",
    summary: "Cache JWT verification result",
  });

  const reloaded = await store.getRun(run.id);
  assert.deepEqual(reloaded?.pendingBuildProposal, {
    repoSlug: "owner/repo",
    summary: "Cache JWT verification result",
  });
});

test("setPendingBuildProposal(null) clears the proposal", async () => {
  const run = await store.createConversationRun({
    channelId: "C5",
    threadTs: "1700000004.0",
    requestedBy: "U5",
    firstMessage: "x",
    defaultBaseBranch: "main",
    branchPrefix: "test",
  });
  await store.setPendingBuildProposal(run.id, { repoSlug: "o/r", summary: "s" });
  await store.setPendingBuildProposal(run.id, null);
  const reloaded = await store.getRun(run.id);
  assert.equal(reloaded?.pendingBuildProposal, undefined);
});

test("promoteConversationRun flips status, replaces intent, fills repoSlug and task", async () => {
  const run = await store.createConversationRun({
    channelId: "C6",
    threadTs: "1700000005.0",
    requestedBy: "U6",
    firstMessage: "explain auth",
    defaultBaseBranch: "main",
    branchPrefix: "test",
  });

  const promoted = await store.promoteConversationRun(run.id, {
    repoSlug: "owner/repo",
    task: "Implement JWT cache as discussed",
    intent: {
      version: 1,
      kind: "generic_task",
      source: "slack",
      requestedBy: "U6",
    },
  });

  assert.equal(promoted.status, "queued");
  assert.equal(promoted.phase, "queued");
  assert.equal(promoted.repoSlug, "owner/repo");
  assert.equal(promoted.task, "Implement JWT cache as discussed");
  assert.equal(promoted.intent?.kind, "generic_task");
  assert.equal(promoted.intentKind, "generic_task");
  assert.equal(promoted.pendingBuildProposal, undefined);
});

test("promoteConversationRun throws if run is not in conversation status", async () => {
  const run = await store.createRun({
    repoSlug: "owner/repo",
    task: "x",
    baseBranch: "main",
    requestedBy: "U7",
    channelId: "C7",
    threadTs: "1700000006.0",
    runtime: "local",
  }, "test");

  await assert.rejects(
    () =>
      store.promoteConversationRun(run.id, {
        repoSlug: "owner/repo",
        task: "y",
        intent: { version: 1, kind: "generic_task", source: "slack", requestedBy: "U7" },
      }),
    /not in conversation status/i,
  );
});
```

- [ ] **Step 2: Verify failure**

Run: `node --test tests/run-store-conversation.test.ts`
Expected: FAIL — methods missing.

- [ ] **Step 3: Add `pendingBuildProposal` to `RunRecord` and store mapping**

In `src/types.ts`, after `intent?: RunIntent;` and `intentKind?: RunIntentKind;` (lines 118-119), add:

```ts
  pendingBuildProposal?: { repoSlug: string; summary: string };
```

In `src/store.ts`, locate `rowToRecord` (the function that maps DB rows to `RunRecord`) and ensure `pendingBuildProposal` is mapped from `row.pendingBuildProposal`. If `rowToRecord` uses spread/automatic mapping, the column will already be picked up; otherwise add an explicit field.

- [ ] **Step 4: Implement `setPendingBuildProposal`**

In `src/store.ts`, after `addTokenUsage`, add:

```ts
async setPendingBuildProposal(
  id: string,
  proposal: { repoSlug: string; summary: string } | null,
): Promise<RunRecord> {
  await this.db.update(runs).set({ pendingBuildProposal: proposal }).where(eq(runs.id, id));
  const result = await this.getRun(id);
  if (!result) throw new Error(`Run not found: ${id}`);
  return result;
}
```

- [ ] **Step 5: Implement `promoteConversationRun`**

After `setPendingBuildProposal`, add:

```ts
async promoteConversationRun(
  id: string,
  input: {
    repoSlug: string;
    task: string;
    intent: RunIntent;
    branchName?: string;
  },
): Promise<RunRecord> {
  const current = await this.getRun(id);
  if (!current) throw new Error(`Run not found: ${id}`);
  if (current.status !== "conversation") {
    throw new Error(`Run ${id} is not in conversation status (got ${current.status})`);
  }
  await this.db.update(runs).set({
    status: "queued",
    phase: "queued",
    repoSlug: input.repoSlug,
    task: input.task,
    intent: input.intent,
    intentKind: input.intent.kind,
    pendingBuildProposal: null,
    ...(input.branchName ? { branchName: input.branchName } : {}),
  }).where(eq(runs.id, id));
  const result = await this.getRun(id);
  if (!result) throw new Error(`Run not found: ${id}`);
  return result;
}
```

- [ ] **Step 6: Run tests**

Run: `node --test tests/run-store-conversation.test.ts`
Expected: all 7 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/store.ts src/types.ts tests/run-store-conversation.test.ts
git commit -m "feat(store): add setPendingBuildProposal and promoteConversationRun"
```

---

## Task 7: `RunManager.getOrCreateConversationRun` and `recordConversationTurn`

**Files:**
- Modify: `src/run-manager.ts`
- Test: `tests/run-manager-conversation.test.ts` (NEW)

- [ ] **Step 1: Write failing test**

Create `tests/run-manager-conversation.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { RunManager } from "../src/run-manager.js";
import { RunStore } from "../src/store.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import type { AppConfig } from "../src/config.js";

let db: TestDb;
let store: RunStore;
let runManager: RunManager;

const config = {
  defaultBaseBranch: "main",
  branchPrefix: "test",
  sandboxRuntime: "local",
} as unknown as AppConfig;

test.beforeEach(async () => {
  db = await createTestDb();
  store = new RunStore(db.db);
  // Construct minimal RunManager. If RunManager needs more deps, mock them.
  runManager = new RunManager({
    config,
    store,
    // Mock other deps as needed — see existing run-manager tests for the pattern.
  } as unknown as ConstructorParameters<typeof RunManager>[0]);
});

test.afterEach(async () => {
  await db.cleanup();
});

test("getOrCreateConversationRun creates a new run when no thread run exists", async () => {
  const run = await runManager.getOrCreateConversationRun({
    channelId: "C1",
    threadTs: "1700000000.0",
    requestedBy: "U1",
    firstMessage: "hi",
  });
  assert.equal(run.status, "conversation");
  assert.equal(run.intent?.kind, "conversation");
});

test("getOrCreateConversationRun reuses an active conversation run", async () => {
  const first = await runManager.getOrCreateConversationRun({
    channelId: "C2",
    threadTs: "1700000001.0",
    requestedBy: "U2",
    firstMessage: "first",
  });
  const second = await runManager.getOrCreateConversationRun({
    channelId: "C2",
    threadTs: "1700000001.0",
    requestedBy: "U2",
    firstMessage: "second",
  });
  assert.equal(second.id, first.id);
  assert.equal(second.task, "first"); // task isn't overwritten on reuse
});

test("getOrCreateConversationRun chains a new run after a terminal run", async () => {
  const first = await runManager.getOrCreateConversationRun({
    channelId: "C3",
    threadTs: "1700000002.0",
    requestedBy: "U3",
    firstMessage: "first",
  });
  await store.updateRun(first.id, { status: "completed", phase: "completed" });

  const second = await runManager.getOrCreateConversationRun({
    channelId: "C3",
    threadTs: "1700000002.0",
    requestedBy: "U3",
    firstMessage: "follow-up",
  });
  assert.notEqual(second.id, first.id);
  assert.equal(second.parentRunId, first.id);
  assert.equal(second.chainIndex, 1);
});

test("recordConversationTurn accumulates token usage across calls", async () => {
  const run = await runManager.getOrCreateConversationRun({
    channelId: "C4",
    threadTs: "1700000003.0",
    requestedBy: "U4",
    firstMessage: "hi",
  });
  await runManager.recordConversationTurn(run.id, [
    { model: "gpt-4.1-mini", input: 100, output: 50 },
  ]);
  await runManager.recordConversationTurn(run.id, [
    { model: "gpt-4.1-mini", input: 200, output: 100 },
  ]);
  const updated = await store.getRun(run.id);
  const entry = updated?.tokenUsage?.byModel?.find((m) => m.model === "gpt-4.1-mini");
  assert.equal(entry?.input, 300);
  assert.equal(entry?.output, 150);
});
```

- [ ] **Step 2: Verify failure**

Run: `node --test tests/run-manager-conversation.test.ts`
Expected: FAIL — methods missing.

- [ ] **Step 3: Implement `getOrCreateConversationRun`**

In `src/run-manager.ts`, after `enqueueRun` (around line 421), add:

```ts
async getOrCreateConversationRun(input: {
  channelId: string;
  threadTs: string;
  requestedBy: string;
  firstMessage: string;
}): Promise<RunRecord> {
  const existing = await this.store.findRunByThread(input.channelId, input.threadTs);
  if (existing && existing.status === "conversation") {
    return existing;
  }
  return this.store.createConversationRun({
    channelId: input.channelId,
    threadTs: input.threadTs,
    requestedBy: input.requestedBy,
    firstMessage: input.firstMessage,
    defaultBaseBranch: this.config.defaultBaseBranch,
    branchPrefix: this.config.branchPrefix,
    parentRunId: existing?.id,
  });
}
```

- [ ] **Step 4: Implement `recordConversationTurn`**

After `getOrCreateConversationRun`:

```ts
async recordConversationTurn(
  runId: string,
  tokenUsages: Array<{ model: string; input: number; output: number }>,
): Promise<void> {
  for (const usage of tokenUsages) {
    if (usage.input <= 0 && usage.output <= 0) continue;
    await this.store.addTokenUsage(runId, {
      model: usage.model,
      input: usage.input,
      output: usage.output,
      source: "quality_gate",
    });
  }
}
```

- [ ] **Step 5: Run tests**

Run: `node --test tests/run-manager-conversation.test.ts`
Expected: 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/run-manager.ts tests/run-manager-conversation.test.ts
git commit -m "feat(run-manager): add getOrCreateConversationRun and recordConversationTurn"
```

---

## Task 8: `RunManager.promoteConversationToBuild`

**Files:**
- Modify: `src/run-manager.ts`
- Test: `tests/run-manager-conversation.test.ts`

- [ ] **Step 1: Write failing test**

Append to `tests/run-manager-conversation.test.ts`:

```ts
test("promoteConversationToBuild updates the run and triggers requeue", async () => {
  const requeued: string[] = [];
  // Override requeueExistingRun on the manager to capture calls.
  const originalRequeue = runManager.requeueExistingRun.bind(runManager);
  runManager.requeueExistingRun = (id: string) => {
    requeued.push(id);
  };

  const conversationRun = await runManager.getOrCreateConversationRun({
    channelId: "C5",
    threadTs: "1700000004.0",
    requestedBy: "U5",
    firstMessage: "explain",
  });

  await runManager.promoteConversationToBuild(conversationRun.id, {
    repoSlug: "owner/repo",
    synthesizedTask: "Implement caching",
    intent: {
      version: 1,
      kind: "generic_task",
      source: "slack",
      requestedBy: "U5",
    },
  });

  const updated = await store.getRun(conversationRun.id);
  assert.equal(updated?.status, "queued");
  assert.equal(updated?.repoSlug, "owner/repo");
  assert.equal(updated?.task, "Implement caching");
  assert.deepEqual(requeued, [conversationRun.id]);

  runManager.requeueExistingRun = originalRequeue;
});
```

- [ ] **Step 2: Verify failure**

Run: `node --test tests/run-manager-conversation.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `promoteConversationToBuild`**

In `src/run-manager.ts`, after `recordConversationTurn`:

```ts
async promoteConversationToBuild(
  runId: string,
  input: {
    repoSlug: string;
    synthesizedTask: string;
    intent: RunIntent;
    branchName?: string;
  },
): Promise<RunRecord> {
  const promoted = await this.store.promoteConversationRun(runId, {
    repoSlug: input.repoSlug,
    task: input.synthesizedTask,
    intent: input.intent,
    branchName: input.branchName,
  });
  this.requeueExistingRun(runId);
  return promoted;
}
```

Make sure `RunIntent` is imported at the top of run-manager.ts (likely already is).

- [ ] **Step 4: Run tests**

Run: `node --test tests/run-manager-conversation.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/run-manager.ts tests/run-manager-conversation.test.ts
git commit -m "feat(run-manager): add promoteConversationToBuild"
```

---

## Task 9: Surface token usage from `handleMessage`

**Files:**
- Modify: `src/orchestrator/types.ts`
- Modify: `src/orchestrator/orchestrator.ts`
- Test: `tests/orchestrator-token-surface.test.ts` (NEW)

- [ ] **Step 1: Write failing test**

Create `tests/orchestrator-token-surface.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { handleMessage } from "../src/orchestrator/orchestrator.js";
import type { HandleMessageDeps, HandleMessageRequest } from "../src/orchestrator/types.js";

// Mock callLLMWithTools by stubbing the LLM HTTP layer.
// For simplicity we verify the shape of the result on a deterministic stub.

test("HandleMessageResult exposes per-model token usage", async () => {
  // The orchestrator delegates to callLLMWithTools, which returns totalInputTokens etc.
  // We need to mock at the HTTP boundary. The simplest path: feed a fake LLM caller config
  // that returns a stubbed response. See existing tests/orchestrator-integration.test.ts
  // for the pattern.
  // For this unit test we skip the LLM and assert the output shape by injecting a
  // pre-recorded result via a test seam.

  // If your codebase doesn't yet expose a test seam, add one: pass an optional
  // `_callLLM` override on HandleMessageOptions that handleMessage uses instead of
  // the real callLLMWithTools when set.
  const fakeLLM = async () => ({
    content: "answer",
    messages: [{ role: "user" as const, content: "q" }, { role: "assistant" as const, content: "answer" }],
    turnsUsed: 1,
    totalInputTokens: 100,
    totalOutputTokens: 50,
    perModelUsage: [{ model: "gpt-4.1-mini", input: 100, output: 50 }],
  });

  const deps: HandleMessageDeps = {
    enqueueRun: async () => ({ id: "x", branchName: "b", repoSlug: "o/r" }),
    listRuns: async () => "[]",
    getConfig: async () => "{}",
    repoAllowlist: ["o/r"],
  };
  const request: HandleMessageRequest = {
    message: "test",
    userId: "U1",
    channelId: "C1",
    threadTs: "T1",
  };

  const result = await handleMessage(
    {} as never,  // llmConfig — unused with the override
    "test-model",
    "system",
    request,
    deps,
    { _callLLMOverride: fakeLLM } as never,
  );

  assert.equal(Array.isArray(result.tokenUsage), true);
  assert.equal(result.tokenUsage[0]?.model, "gpt-4.1-mini");
  assert.equal(result.tokenUsage[0]?.input, 100);
  assert.equal(result.tokenUsage[0]?.output, 50);
});
```

- [ ] **Step 2: Verify failure**

Run: `node --test tests/orchestrator-token-surface.test.ts`
Expected: FAIL — `result.tokenUsage` undefined and override not honored.

- [ ] **Step 3: Extend `HandleMessageResult`**

In `src/orchestrator/types.ts:49-53`:

```ts
export interface HandleMessageResult {
  response: string;
  runsQueued: Array<{ id: string; branchName: string; repoSlug: string }>;
  messages: ChatMessage[];
  tokenUsage: Array<{ model: string; input: number; output: number }>;
  buildProposal?: { repoSlug: string; summary: string };
}
```

- [ ] **Step 4: Add a test seam to `HandleMessageOptions`**

In `src/orchestrator/types.ts`, extend `HandleMessageOptions`:

```ts
export interface HandleMessageOptions {
  onToolCall?: (toolName: string, args: Record<string, unknown>) => void;
  timeoutMs?: number;
  wallClockTimeoutMs?: number;
  maxInputTokens?: number;
  /**
   * Internal test seam. Replaces the underlying callLLMWithTools call.
   * NOT for production use.
   */
  _callLLMOverride?: (...args: unknown[]) => Promise<{
    content: string;
    messages: ChatMessage[];
    turnsUsed: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    perModelUsage?: Array<{ model: string; input: number; output: number }>;
  }>;
}
```

- [ ] **Step 5: Add per-model accumulation in `callLLMWithTools`**

In `src/llm/caller.ts`, locate the loop that increments `totalInputTokens` and `totalOutputTokens` (around line 411-412). Add a per-model accumulator above the loop (around line 351-352):

```ts
let totalInputTokens = 0;
let totalOutputTokens = 0;
const perModel = new Map<string, { input: number; output: number }>();
```

In the loop where `totalInputTokens += data.usage?.prompt_tokens ?? 0;` (line 411), add:

```ts
const callModel = (data.model as string | undefined) ?? request.model ?? "unknown";
const acc = perModel.get(callModel) ?? { input: 0, output: 0 };
acc.input += data.usage?.prompt_tokens ?? 0;
acc.output += data.usage?.completion_tokens ?? 0;
perModel.set(callModel, acc);
```

In the function's return (around line 477-478), add:

```ts
return {
  // existing fields...
  totalInputTokens,
  totalOutputTokens,
  perModelUsage: Array.from(perModel.entries()).map(([model, v]) => ({ model, ...v })),
  // ...
};
```

Verify the LLMCallResult type (line 320-322) includes `perModelUsage`:

```ts
export interface LLMCallResult {
  // existing fields
  perModelUsage: Array<{ model: string; input: number; output: number }>;
}
```

- [ ] **Step 6: Update `handleMessage` to surface tokens**

In `src/orchestrator/orchestrator.ts:241-289`, replace the `callLLMWithTools` call with:

```ts
const callLLMFn = options?._callLLMOverride ?? callLLMWithTools;
const result = await callLLMFn(llmConfig, {
  // ...existing args...
});
```

In the return block (around 303-309):

```ts
return {
  response: isExhausted ? "Sorry, ..." : content,
  runsQueued,
  messages: conversationMessages,
  tokenUsage: result.perModelUsage ?? [],
};
```

In the catch block (around 320-326), also include `tokenUsage: []`.

- [ ] **Step 7: Run tests**

Run: `node --test tests/orchestrator-token-surface.test.ts`
Expected: PASS.

Run: `npm run check`
Expected: PASS.

Run: `node --test tests/orchestrator-integration.test.ts`
Expected: PASS (existing tests should still work; if they rely on `result.runsQueued.length` etc, no breakage).

- [ ] **Step 8: Commit**

```bash
git add src/orchestrator/types.ts src/orchestrator/orchestrator.ts src/llm/caller.ts tests/orchestrator-token-surface.test.ts
git commit -m "feat(orchestrator): surface per-model token usage from handleMessage"
```

---

## Task 10: `propose_build` orchestrator tool

**Files:**
- Modify: `src/orchestrator/orchestrator.ts`
- Test: `tests/orchestrator-propose-build.test.ts` (NEW)

- [ ] **Step 1: Write failing test**

Create `tests/orchestrator-propose-build.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { handleMessage } from "../src/orchestrator/orchestrator.js";
import type { HandleMessageDeps, HandleMessageRequest } from "../src/orchestrator/types.js";

test("propose_build tool sets buildProposal on result without queueing a run", async () => {
  const fakeLLM = async (_: unknown, opts: { tools: Array<{ function: { name: string } }>; executeTool: (n: string, a: Record<string, unknown>) => Promise<string> }) => {
    // Simulate the LLM calling propose_build then returning the answer.
    await opts.executeTool("propose_build", { repoSlug: "o/r", summary: "Cache JWT" });
    return {
      content: "Want me to build this fix?",
      messages: [],
      turnsUsed: 1,
      totalInputTokens: 50,
      totalOutputTokens: 20,
      perModelUsage: [{ model: "test", input: 50, output: 20 }],
    };
  };

  const deps: HandleMessageDeps = {
    enqueueRun: async () => ({ id: "x", branchName: "b", repoSlug: "o/r" }),
    listRuns: async () => "[]",
    getConfig: async () => "{}",
    repoAllowlist: ["o/r"],
  };
  const request: HandleMessageRequest = { message: "fix it", userId: "U1", channelId: "C1", threadTs: "T1" };

  const result = await handleMessage(
    {} as never,
    "test-model",
    "system",
    request,
    deps,
    { _callLLMOverride: fakeLLM } as never,
  );

  assert.deepEqual(result.buildProposal, { repoSlug: "o/r", summary: "Cache JWT" });
  assert.equal(result.runsQueued.length, 0);
});
```

- [ ] **Step 2: Verify failure**

Run: `node --test tests/orchestrator-propose-build.test.ts`
Expected: FAIL — `propose_build` tool not registered.

- [ ] **Step 3: Add the tool definition**

In `src/orchestrator/orchestrator.ts:11-203` (`buildTools`), add a new tool entry near `execute_task`:

```ts
{
  type: "function",
  function: {
    name: "propose_build",
    description: "Propose a code change to the user. Use this BEFORE execute_task. The user must confirm with 'yes' / 'go' / 'lgtm' in their next message before the build runs. Do NOT call execute_task with mode='code_change' directly — always propose first.",
    parameters: {
      type: "object",
      properties: {
        repoSlug: {
          type: "string",
          description: "Repository slug in owner/repo format",
        },
        summary: {
          type: "string",
          description: "One-paragraph summary of what the build will do",
        },
      },
      required: ["repoSlug", "summary"],
    },
  },
},
```

- [ ] **Step 4: Wire the tool in `handleMessage`**

In `src/orchestrator/orchestrator.ts:218`, declare a `buildProposal` capture variable near `runsQueued`:

```ts
const runsQueued: HandleMessageResult["runsQueued"] = [];
let buildProposal: { repoSlug: string; summary: string } | undefined;
```

In the `executeTool` switch (around line 246-282), add a branch:

```ts
if (name === "propose_build") {
  const repoSlug = args["repoSlug"] as string | undefined;
  const summary = args["summary"] as string | undefined;
  if (!repoSlug || !summary) {
    return "Error: both 'repoSlug' and 'summary' are required.";
  }
  if (deps.repoAllowlist.length > 0 && !deps.repoAllowlist.includes(repoSlug)) {
    return `Error: repo '${repoSlug}' is not in the allowlist.`;
  }
  buildProposal = { repoSlug, summary };
  return `Proposal recorded. The user will be asked to confirm in their next message.`;
}
```

In the return (success path):

```ts
return {
  response: ...,
  runsQueued,
  messages: conversationMessages,
  tokenUsage: result.perModelUsage ?? [],
  ...(buildProposal ? { buildProposal } : {}),
};
```

- [ ] **Step 5: Run tests**

Run: `node --test tests/orchestrator-propose-build.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/orchestrator.ts tests/orchestrator-propose-build.test.ts
git commit -m "feat(orchestrator): add propose_build tool"
```

---

## Task 11: System prompt updates

**Files:**
- Modify: `src/orchestrator/system-context.ts`
- Test: `tests/orchestrator-propose-build.test.ts`

- [ ] **Step 1: Write failing test**

Append to `tests/orchestrator-propose-build.test.ts`:

```ts
import { buildSystemContext } from "../src/orchestrator/system-context.js";

test("system context includes propose-then-confirm instruction", () => {
  const ctx = buildSystemContext({
    repoAllowlist: ["o/r"],
    appName: "Goose",
    botCommandName: "goose",
  } as Parameters<typeof buildSystemContext>[0]);

  assert.match(ctx, /propose_build/);
  assert.match(ctx, /confirm/i);
  assert.match(ctx, /Do not call execute_task .* code_change.* directly/);
});

test("system context includes ask-for-repo instruction when none active", () => {
  const ctx = buildSystemContext({
    repoAllowlist: ["o/r"],
    appName: "Goose",
    botCommandName: "goose",
  } as Parameters<typeof buildSystemContext>[0]);

  assert.match(ctx, /ask which repo/i);
});
```

- [ ] **Step 2: Verify failure**

Run: `node --test tests/orchestrator-propose-build.test.ts`
Expected: new tests FAIL — strings missing.

- [ ] **Step 3: Update system prompt**

In `src/orchestrator/system-context.ts`, add to the rules section (the numbered rules list — find the list around line 138-140 and append):

```
12. **Propose before building** — for any code_change task, call `propose_build` first with a clear summary. Do not call execute_task with mode="code_change" directly. The user will confirm in their next message; the system queues the build at that moment.
13. **Ask for repo when missing** — if the user has not specified a repo and the thread has no active repo from prior runs, ask which repo they mean. The allowlist is provided above.
```

(Adjust numbering if the list is structured differently — preserve existing rules and add the two new ones at the end.)

In the `### execute_task` section, update the description: change from "Use mode='code_change' (default) to make code changes that produce a PR" to "For code changes, use `propose_build` first, NOT execute_task. execute_task is for investigations only (mode='investigate') in the conversation flow."

- [ ] **Step 4: Run tests**

Run: `node --test tests/orchestrator-propose-build.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/system-context.ts tests/orchestrator-propose-build.test.ts
git commit -m "feat(orchestrator): require propose_build before code change"
```

---

## Task 12: `synthesize-task` helper

**Files:**
- Create: `src/orchestrator/synthesize-task.ts`
- Test: `tests/synthesize-task.test.ts` (NEW)

- [ ] **Step 1: Write failing test**

Create `tests/synthesize-task.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { synthesizeTask } from "../src/orchestrator/synthesize-task.js";
import type { ChatMessage } from "../src/llm/caller.js";

test("synthesizeTask returns markdown spec from conversation + proposal", async () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "auth is slow" },
    { role: "assistant", content: "let me look... it's the JWT verification on each request" },
    { role: "user", content: "ok how do we fix it" },
    { role: "assistant", content: "we can cache the JWT verification result" },
  ];
  const proposal = { repoSlug: "owner/repo", summary: "Cache JWT verification result" };

  const stubLLM = async () => ({
    content: "## Goal\nCache JWT verification\n\n## Files\n- src/auth.ts",
    messages: [],
    turnsUsed: 1,
    totalInputTokens: 200,
    totalOutputTokens: 100,
    perModelUsage: [{ model: "test", input: 200, output: 100 }],
  });

  const result = await synthesizeTask({
    llmConfig: {} as never,
    model: "test-model",
    messages,
    proposal,
    _callLLMOverride: stubLLM as never,
  });

  assert.match(result.task, /## Goal/);
  assert.match(result.task, /Cache JWT/);
  assert.equal(result.tokenUsage[0]?.model, "test");
  assert.equal(result.tokenUsage[0]?.input, 200);
});

test("synthesizeTask falls back to proposal summary on LLM failure", async () => {
  const messages: ChatMessage[] = [{ role: "user", content: "do x" }];
  const proposal = { repoSlug: "owner/repo", summary: "Do X" };

  const failingLLM = async () => {
    throw new Error("LLM unavailable");
  };

  const result = await synthesizeTask({
    llmConfig: {} as never,
    model: "test-model",
    messages,
    proposal,
    _callLLMOverride: failingLLM as never,
  });

  assert.match(result.task, /Do X/);
  assert.equal(result.tokenUsage.length, 0);
  assert.equal(result.fallback, true);
});
```

- [ ] **Step 2: Verify failure**

Run: `node --test tests/synthesize-task.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `synthesizeTask`**

Create `src/orchestrator/synthesize-task.ts`:

```ts
import type { ChatMessage, LLMCallerConfig } from "../llm/caller.js";
import { callLLMWithTools } from "../llm/caller.js";
import { logWarn } from "../logger.js";

interface SynthesizeTaskInput {
  llmConfig: LLMCallerConfig;
  model: string;
  messages: ChatMessage[];
  proposal: { repoSlug: string; summary: string };
  _callLLMOverride?: typeof callLLMWithTools;
}

export interface SynthesizeTaskResult {
  task: string;
  tokenUsage: Array<{ model: string; input: number; output: number }>;
  fallback: boolean;
}

const SYSTEM_PROMPT = `You are converting a Slack conversation into a clean task spec for a coding agent.
Output the spec in markdown with these sections (omit any that don't apply):

## Goal
One sentence describing what to build.

## Context
Relevant facts from the conversation — what's broken, what was found.

## Files / Areas
Specific files, modules, or paths the agent should focus on.

## Approach
The plan agreed on in the conversation.

## Constraints
Anything to avoid or preserve.

## Success criteria
How the agent knows it's done.

Keep it concise — the agent reads this once and runs.`;

function fallbackTask(proposal: { repoSlug: string; summary: string }): string {
  return `## Goal\n${proposal.summary}\n\n## Repo\n${proposal.repoSlug}\n`;
}

export async function synthesizeTask(input: SynthesizeTaskInput): Promise<SynthesizeTaskResult> {
  const callFn = input._callLLMOverride ?? callLLMWithTools;
  const transcript = input.messages
    .map((m) => `**${m.role}:** ${typeof m.content === "string" ? m.content : "[non-text content]"}`)
    .join("\n\n");
  const userMessage = `Conversation transcript:\n\n${transcript}\n\n---\n\nProposed change: ${input.proposal.summary}\nRepo: ${input.proposal.repoSlug}\n\nWrite the task spec.`;

  try {
    const result = await callFn(input.llmConfig, {
      system: SYSTEM_PROMPT,
      initialMessages: [{ role: "user", content: userMessage }],
      tools: [],
      executeTool: async () => "",
      model: input.model,
      maxTokens: 1500,
      timeoutMs: 90_000,
      wallClockTimeoutMs: 90_000,
    });
    return {
      task: result.content || fallbackTask(input.proposal),
      tokenUsage: result.perModelUsage ?? [],
      fallback: !result.content,
    };
  } catch (err) {
    logWarn("synthesizeTask: LLM call failed; falling back", {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      task: fallbackTask(input.proposal),
      tokenUsage: [],
      fallback: true,
    };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/synthesize-task.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/synthesize-task.ts tests/synthesize-task.test.ts
git commit -m "feat(orchestrator): add synthesizeTask helper"
```

---

## Task 13: Slack-app handler — conversation lifecycle

**Files:**
- Modify: `src/slack-app.ts`
- Test: `tests/slack-app-conversation-flow.test.ts` (NEW)

This task is the integration point. It changes the message handler flow significantly.

- [ ] **Step 1: Write failing test**

Create `tests/slack-app-conversation-flow.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildHandleMessageDeps } from "../src/slack-app.js";
import type { AppConfig } from "../src/config.js";
import type { RunManager } from "../src/run-manager.js";
import type { NewRunInput, RunRecord } from "../src/types.js";

function makeConfig(): AppConfig {
  return {
    repoAllowlist: ["owner/repo"],
    defaultBaseBranch: "master",
    branchPrefix: "test",
    sandboxRuntime: "local",
    appName: "Test",
  } as unknown as AppConfig;
}

test("buildHandleMessageDeps.enqueueRun mode='code_change' no longer creates a new run; it stages a proposal", async () => {
  // After this task, code_change mode goes through propose_build.
  // The enqueueRun deps callback should explicitly reject the code_change path
  // and direct the orchestrator to propose_build instead.
  const captures: { input?: NewRunInput } = {};
  const runManager = {
    enqueueRun: async (input: NewRunInput) => {
      captures.input = input;
      return { id: "x", branchName: "b", repoSlug: input.repoSlug, status: "queued", task: input.task, baseBranch: input.baseBranch, requestedBy: input.requestedBy, channelId: input.channelId, threadTs: input.threadTs, createdAt: new Date().toISOString(), runtime: "local" } as RunRecord;
    },
    continueRun: async () => undefined,
    getRecentRuns: async () => [],
  } as unknown as RunManager;

  const deps = buildHandleMessageDeps(makeConfig(), runManager);
  await assert.rejects(
    () => deps.enqueueRun("owner/repo", "do thing", { mode: "code_change" }),
    /propose_build/i,
  );
  assert.equal(captures.input, undefined);
});

test("buildHandleMessageDeps.enqueueRun mode='investigate' still creates an investigate run", async () => {
  const captures: { input?: NewRunInput } = {};
  const runManager = {
    enqueueRun: async (input: NewRunInput) => {
      captures.input = input;
      return { id: "x", branchName: "investigate/x", repoSlug: input.repoSlug, status: "queued", task: input.task, baseBranch: input.baseBranch, requestedBy: input.requestedBy, channelId: input.channelId, threadTs: input.threadTs, createdAt: new Date().toISOString(), runtime: "local" } as RunRecord;
    },
    continueRun: async () => undefined,
    getRecentRuns: async () => [],
  } as unknown as RunManager;

  const deps = buildHandleMessageDeps(makeConfig(), runManager);
  await deps.enqueueRun("owner/repo", "explain", { mode: "investigate" });

  assert.ok(captures.input);
  assert.equal(captures.input.intent?.kind, "investigate");
});
```

- [ ] **Step 2: Verify failure**

Run: `node --test tests/slack-app-conversation-flow.test.ts`
Expected: FAIL — first test, the enqueueRun currently creates a generic_task run for code_change mode.

- [ ] **Step 3: Reject code_change in `enqueueRun` deps**

In `src/slack-app.ts:124-163` (`buildHandleMessageDeps.enqueueRun`), add an early branch:

```ts
enqueueRun: async (repo, task, opts) => {
  if (opts.continueFrom) {
    // ...existing continueRun path...
  }

  if (opts.mode === "code_change") {
    throw new Error(
      "Direct code_change runs from the orchestrator are no longer allowed — call propose_build first."
    );
  }

  // For investigate mode, keep the existing path.
  const intent = opts.mode === "investigate"
    ? { /* existing investigate intent */ }
    : undefined;

  // ... existing run = await runManager.enqueueRun({...})
}
```

Apply the same change in the live-event override (`src/slack-app.ts:768-805`) — also reject `mode === "code_change"`.

- [ ] **Step 4: Run tests**

Run: `node --test tests/slack-app-conversation-flow.test.ts`
Expected: both unit tests pass.

- [ ] **Step 5: Wire `getOrCreateConversationRun` into the live message handler**

In `src/slack-app.ts:725-885`, restructure the message handler:

```ts
// (Casual pre-filter unchanged)

// ... after threadCtx and priorMessages load ...

// NEW: get-or-create the thread's conversation run BEFORE calling handleMessage.
const conversationRun = await runManager.getOrCreateConversationRun({
  channelId: event.channel,
  threadTs: replyThreadTs,
  requestedBy: event.user!,
  firstMessage: stripped,
});

// NEW: if a build proposal is pending and this message is a confirmation, promote.
if (
  conversationRun.pendingBuildProposal &&
  APPROVAL_PATTERNS.test(stripped)
) {
  // Synthesize task and promote.
  await handleBuildConfirmation({
    runManager,
    conversationRun,
    proposal: conversationRun.pendingBuildProposal,
    priorMessages: priorMessages ?? [],
    say,
    replyThreadTs,
    llmConfig,
    config,
  });
  return;  // skip orchestrator call for confirmation messages
}

// ... existing handleMessage call ...

const result = await handleMessage(/* ... */);

// NEW: record token usage on the conversation run.
await runManager.recordConversationTurn(
  conversationRun.id,
  result.tokenUsage ?? [],
);

// NEW: if the orchestrator proposed a build, persist the proposal.
if (result.buildProposal) {
  await runManager.store.setPendingBuildProposal(
    conversationRun.id,
    result.buildProposal,
  );
} else if (conversationRun.pendingBuildProposal) {
  // Orchestrator did not re-propose; clear stale proposal.
  await runManager.store.setPendingBuildProposal(conversationRun.id, null);
}

// ... existing reply posting ...
```

Note: `runManager.store` may not be a public accessor today. Add a public getter or a thin pass-through method `RunManager.setPendingBuildProposal(runId, proposal)` to avoid leaking the store. Add it now:

```ts
async setPendingBuildProposal(runId: string, proposal: { repoSlug: string; summary: string } | null): Promise<void> {
  await this.store.setPendingBuildProposal(runId, proposal);
}
```

- [ ] **Step 6: Implement `handleBuildConfirmation` helper**

Add a private helper near the top of `startSlackApp` (or in a new file `src/slack-app-build-confirmation.ts` if you prefer):

```ts
async function handleBuildConfirmation(input: {
  runManager: RunManager;
  conversationRun: RunRecord;
  proposal: { repoSlug: string; summary: string };
  priorMessages: ChatMessage[];
  say: (msg: { thread_ts?: string; text: string }) => Promise<unknown>;
  replyThreadTs: string;
  llmConfig: LLMCallerConfig;
  config: AppConfig;
}): Promise<void> {
  const { runManager, conversationRun, proposal, priorMessages, say, replyThreadTs, llmConfig, config } = input;

  await say({ thread_ts: replyThreadTs, text: ":hammer_and_wrench: Synthesizing the task and starting the build..." });

  const synthesis = await synthesizeTask({
    llmConfig,
    model: config.orchestratorModel ?? "anthropic/claude-sonnet-4-6",
    messages: priorMessages,
    proposal,
  });

  // Record synthesis cost on the conversation run.
  await runManager.recordConversationTurn(conversationRun.id, synthesis.tokenUsage);

  await runManager.promoteConversationToBuild(conversationRun.id, {
    repoSlug: proposal.repoSlug,
    synthesizedTask: synthesis.task,
    intent: {
      version: 1,
      kind: "generic_task",
      source: "slack",
      requestedBy: conversationRun.requestedBy,
    },
  });

  await say({
    thread_ts: replyThreadTs,
    text: `:rocket: Build queued for *${proposal.repoSlug}* — run ${conversationRun.id.slice(0, 8)}.`,
  });
}
```

Import `synthesizeTask`, `RunRecord`, etc. at the top of `src/slack-app.ts`.

- [ ] **Step 7: Type check + run all tests**

Run: `npm run check`
Expected: PASS.

Run: `node --test tests/slack-app-conversation-flow.test.ts tests/slack-app-investigate-boundary.test.ts`
Expected: PASS.

Run: `npm test` for the full suite.
Expected: PASS (any failing test from the schema/intent changes earlier should already be fixed by prior tasks).

- [ ] **Step 8: Commit**

```bash
git add src/slack-app.ts src/run-manager.ts tests/slack-app-conversation-flow.test.ts
git commit -m "feat(slack): wire conversation lifecycle into mention handler"
```

---

## Task 14: Dashboard run detail — show conversation messages and status pill

**Files:**
- Modify: `src/dashboard/routes/run-routes.ts`
- Modify: `src/dashboard/html.ts`

- [ ] **Step 1: Verify the conversation route already serves messages**

The route at `src/dashboard/routes/run-routes.ts:476-485` already returns `{ threadKey, available, messages }` when called as `GET /api/runs/:id/conversation`. No backend change needed if the run record correctly carries `channelId/threadTs`.

- [ ] **Step 2: Add `pendingBuildProposal` to the run detail response**

The existing `GET /api/runs/:id` returns `{ run }` directly. `RunRecord` now has `pendingBuildProposal` so it's included automatically — no code change needed unless dashboard explicitly strips fields.

- [ ] **Step 3: Update dashboard HTML — status pill renders "conversation"**

In `src/dashboard/html.ts`, locate the run-status-color or status-label functions (search for `status === "queued"` or similar). Add a branch for `"conversation"` rendering as e.g. blue/grey "Conversation" pill.

- [ ] **Step 4: Update dashboard HTML — conversation panel for conversation runs**

In `src/dashboard/html.ts`, the run detail view fetches `/api/runs/:id/conversation` (search for the existing `'/api/runs/' + ... + '/conversation'` reference). Make sure that panel is shown for conversation-status runs even when there are no changedFiles or PR. If the existing code only shows the conversation panel when a PR/changes exist, change the visibility condition.

The simplest: always render the conversation panel if `conversation.messages.length > 0`, regardless of run status.

- [ ] **Step 5: Update dashboard HTML — pending proposal banner**

If `run.pendingBuildProposal` is set, render a banner at the top of the run detail view: "Build proposal pending: {summary}. Reply with 'yes' / 'go' in Slack to confirm."

- [ ] **Step 6: Type check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 7: Manual smoke test**

Start the dashboard locally:

```bash
docker compose --env-file .env up -d --build
```

In Slack, mention the bot in a channel from the allowlist with a question. Open `http://localhost:8787` (login with `gooseherd123`). Verify:

- A run appears in the runs list with status "Conversation".
- Clicking the run shows the conversation messages and accumulating cost.
- After multiple turns, the cost on the row grows.
- When the orchestrator says "Want me to build X?", a proposal banner appears.
- Replying "yes" in Slack triggers a synthesis + build; the run transitions to "queued" → "running" → "completed".

- [ ] **Step 8: Commit**

```bash
git add src/dashboard/html.ts src/dashboard/routes/run-routes.ts
git commit -m "feat(dashboard): render conversation runs with cost and proposal banner"
```

---

## Task 15: End-to-end verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: ALL pass.

- [ ] **Step 2: Run lint / format**

Run: `npm run lint` if a lint script exists; otherwise `npm run check`.
Expected: PASS.

- [ ] **Step 3: Manual Docker E2E**

Same as Task 14 step 7. Verify the full flow:

1. Slack mention "what auth methods does chocksy/cems support?"
2. Dashboard shows new "Conversation" run, repoSlug initially "" or "chocksy/cems" depending on inference.
3. Follow up: "ok how would we add MFA?"
4. Same row in dashboard, cost grows.
5. Orchestrator (eventually) calls `propose_build`, posts proposal.
6. Reply "yes go".
7. Same run row transitions to queued → running.
8. pi-agent uses synthesized task, makes changes.
9. Run completes; PR linked on the same row.

- [ ] **Step 4: Commit any final fixes**

If the manual smoke test surfaces issues, fix and commit individually (do not bundle).

---

## Self-Review

Spec coverage:
- ✓ Conversation status & intent (Tasks 1-2)
- ✓ Schema migration (Task 3)
- ✓ Store methods (Tasks 4-6)
- ✓ RunManager methods (Tasks 7-8)
- ✓ Token surfacing (Task 9)
- ✓ propose_build tool (Task 10)
- ✓ System prompt updates (Task 11)
- ✓ synthesize-task helper (Task 12)
- ✓ Slack-app integration (Task 13)
- ✓ Dashboard updates (Task 14)
- ✓ E2E verification (Task 15)

No placeholders. Type names consistent across tasks: `ConversationRunIntent`, `getOrCreateConversationRun`, `recordConversationTurn`, `promoteConversationToBuild`, `setPendingBuildProposal`, `synthesizeTask`, `propose_build`, `pendingBuildProposal`.
