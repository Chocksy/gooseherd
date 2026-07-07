# Dashboard-Visible Investigation Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Slack users ask investigation/why-questions ("why didn't DWS go out for org X", "explain how Y works"), make them first-class pipeline runs that appear in the dashboard. The orchestrator tries GitHub Search API first (fast path, no run); when search rate-limits or signal is insufficient, the LLM escalates to a clone-based read-only investigation run that posts the answer back to the Slack thread.

**Architecture:**

- New `investigation` pipeline preset (`pipelines/investigation.yml`): `clone → setup_sandbox → hydrate → investigate → post_answer → notify`. **No** `commit`, `push`, `create_pr`, `validate`, `local_test`, `diff_gate`.
- New node action `investigate` runs the coding agent with a "research, don't modify" prompt; the agent writes `.gooseherd/answer.md`; node captures the file content into the pipeline's ContextBag.
- New node action `post_answer` reads the captured answer from ContextBag and posts it back to the Slack thread (channel + threadTs from the run).
- New `investigate` RunIntent kind that routes to `INVESTIGATION_PIPELINE_ID` via `selectPipelineIdForIntent`.
- Orchestrator: remove the `READ_ONLY_REPO_QUESTION_RE` regex block introduced by commit `fbcee51`. Add a `mode: "code_change" | "investigate"` parameter to the `execute_task` tool so the LLM can explicitly queue investigations.
- `search_code` wrapper in `slack-app.ts`: detect GitHub 403/secondary-rate-limit and return a structured tool result that explicitly nudges the LLM to call `execute_task` with `mode: "investigate"`.
- System-context update: describe investigate mode, document the rate-limit-fallback behavior, keep `search_code` as fast-path.

**Tech Stack:** TypeScript / Node.js, YAML pipeline definitions, existing pipeline-engine, existing Octokit GitHub client (`@octokit/rest`), Vitest for tests.

---

## File Structure

**New files (5):**

| Path | Responsibility |
|---|---|
| `pipelines/investigation.yml` | YAML preset for investigation runs |
| `src/pipeline/nodes/investigate.ts` | Read-only agent invocation; captures `.gooseherd/answer.md` |
| `src/pipeline/nodes/post-answer.ts` | Posts captured answer to Slack thread |
| `tests/orchestrator-investigation.test.ts` | Orchestrator unit tests for `mode: "investigate"` |
| `tests/pipeline-investigation.test.ts` | Pipeline integration test for the investigate node + post_answer |

**Modified files (8):**

| Path | Change |
|---|---|
| `src/pipeline/builtin-pipelines.ts` | Add `INVESTIGATION_PIPELINE_ID` |
| `src/runs/run-intent.ts` | Add `InvestigateRunIntent`, validation, intent → pipeline map |
| `src/orchestrator/types.ts` | Extend `HandleMessageDeps.enqueueRun` to accept `mode` opt |
| `src/orchestrator/orchestrator.ts` | Drop regex block; add `mode` to `execute_task` schema + handler |
| `src/orchestrator/system-context.ts` | Clarify investigate mode + rate-limit fallback rules |
| `src/slack-app.ts` | Wrap `searchCode` with 403 detection; build investigate intent when `mode == "investigate"` |
| `src/index.ts` | Register `investigateNode` and `postAnswerNode` in the node registry; seed `investigation.yml` |
| `src/pipeline/registry.ts` (or equivalent — find at task time) | Wire new node actions |

**Each file has one clear responsibility.** The pipeline YAML is data, the two node files are pure node logic, the run-intent change is type-only with one map entry, and the orchestrator changes are localized to the tool definition + executeTask body.

---

## Pre-flight: branch + worktree

- [ ] **Step 0a: Verify clean working tree**

```bash
git status
```

Expected: clean tree on `main` (or feature branch if already created).

- [ ] **Step 0b: Create feature branch**

```bash
git checkout -b feat/dashboard-visible-investigations
```

---

## Task 1: Register INVESTIGATION_PIPELINE_ID constant

**Files:**
- Modify: `src/pipeline/builtin-pipelines.ts`

- [ ] **Step 1: Add the constant**

Edit `src/pipeline/builtin-pipelines.ts` and append after the existing exports:

```ts
export const INVESTIGATION_PIPELINE_ID = "investigation";
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/pipeline/builtin-pipelines.ts
git commit -m "chore: register INVESTIGATION_PIPELINE_ID constant"
```

---

## Task 2: Add `InvestigateRunIntent` to the RunIntent union

**Files:**
- Modify: `src/runs/run-intent.ts`
- Test: `tests/runs/run-intent.test.ts` (extend existing if present, otherwise create)

- [ ] **Step 1: Write the failing test**

Create or extend `tests/runs/run-intent.test.ts` with:

```ts
import { describe, expect, test } from "vitest";
import { isRunIntent, selectPipelineIdForIntent } from "../../src/runs/run-intent.js";
import { INVESTIGATION_PIPELINE_ID } from "../../src/pipeline/builtin-pipelines.js";

describe("InvestigateRunIntent", () => {
  test("isRunIntent accepts a valid investigate intent", () => {
    const intent = {
      version: 1 as const,
      kind: "investigate" as const,
      source: "slack" as const,
      requestedBy: "U123",
      question: "Why didn't DWS go out for org 633609 on 2026-04-24?",
      triggerReason: "slack-mention"
    };
    expect(isRunIntent(intent)).toBe(true);
  });

  test("selectPipelineIdForIntent returns INVESTIGATION_PIPELINE_ID for investigate intent", () => {
    const intent = {
      version: 1 as const,
      kind: "investigate" as const,
      source: "slack" as const,
      requestedBy: "U123",
      question: "How does the X feature work?"
    };
    expect(selectPipelineIdForIntent(intent)).toBe(INVESTIGATION_PIPELINE_ID);
  });

  test("isRunIntent rejects an investigate intent missing question", () => {
    const intent = {
      version: 1,
      kind: "investigate",
      source: "slack",
      requestedBy: "U123"
    };
    expect(isRunIntent(intent)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npx vitest run tests/runs/run-intent.test.ts
```

Expected: FAIL — `kind: "investigate"` is not yet a valid RunIntent variant.

- [ ] **Step 3: Add `InvestigateRunIntent` interface**

In `src/runs/run-intent.ts`, after the `GenericTaskRunIntent` interface (~line 31), insert:

```ts
export interface InvestigateRunIntent extends BaseRunIntent {
  kind: "investigate";
  /** The user's question, verbatim or paraphrased by the orchestrator. */
  question: string;
  /** Slack user id who asked, when source === "slack". */
  requestedBy?: string;
}
```

- [ ] **Step 4: Add `InvestigateRunIntent` to the union**

Modify the top-level `RunIntent` union (~line 12):

```ts
export type RunIntent =
  | GenericTaskRunIntent
  | FeatureDeliveryRunIntent
  | InvestigateRunIntent;
```

- [ ] **Step 5: Add validation branch in `isRunIntent`**

In `isRunIntent` (~line 125), after the `intent.kind === "generic_task"` branch, before the feature-delivery branch:

```ts
if (intent.kind === "investigate") {
  return (
    RUN_INTENT_SOURCES.has(String(intent.source)) &&
    typeof intent.question === "string" && intent.question.length > 0 &&
    optionalString(intent.requestedBy) &&
    optionalString(intent.triggerReason)
  );
}
```

- [ ] **Step 6: Map intent → pipeline**

Import `INVESTIGATION_PIPELINE_ID`:

```ts
import {
  // existing imports kept
  FEATURE_DELIVERY_QA_PREPARATION_PIPELINE_ID,
  INVESTIGATION_PIPELINE_ID,
} from "../pipeline/builtin-pipelines.js";
```

Add to `PIPELINE_BY_INTENT_KIND` (~line 88):

```ts
const PIPELINE_BY_INTENT_KIND: Partial<Record<RunIntentKind, string>> = {
  // ...existing entries kept
  "feature_delivery.qa_preparation": FEATURE_DELIVERY_QA_PREPARATION_PIPELINE_ID,
  "investigate": INVESTIGATION_PIPELINE_ID,
};
```

- [ ] **Step 7: Run tests, verify pass**

```bash
npx vitest run tests/runs/run-intent.test.ts
```

Expected: all 3 tests PASS.

- [ ] **Step 8: Run the full test suite to catch type fan-out**

```bash
npx tsc --noEmit && npx vitest run
```

Expected: no TS errors; all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/runs/run-intent.ts tests/runs/run-intent.test.ts
git commit -m "feat: add InvestigateRunIntent kind and map to investigation pipeline"
```

---

## Task 3: Create the `investigate` node action

**Files:**
- Create: `src/pipeline/nodes/investigate.ts`
- Test: `tests/pipeline-investigation.test.ts` (will be expanded in later tasks)

- [ ] **Step 1: Write the failing test (skeleton)**

Create `tests/pipeline-investigation.test.ts`:

```ts
import { describe, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { investigateNode } from "../src/pipeline/nodes/investigate.js";
import { ContextBag } from "../src/pipeline/context-bag.js";
import type { NodeDeps, NodeConfig } from "../src/pipeline/types.js";

function buildTestRun(): import("../src/types.js").RunRecord {
  return {
    id: "run-test-1",
    runtime: "local" as const,
    status: "running",
    repoSlug: "owner/repo",
    task: "Why didn't DWS go out for org 633609?",
    baseBranch: "master",
    branchName: "investigate/run-test-1",
    requestedBy: "U_TEST",
    channelId: "C_TEST",
    threadTs: "1234567890.000100",
    createdAt: new Date().toISOString()
  };
}

describe("investigateNode", () => {
  test("captures .gooseherd/answer.md content into ContextBag.answer", async () => {
    const repoDir = await mkdtemp(path.join(tmpdir(), "investigate-"));
    await mkdir(path.join(repoDir, ".gooseherd"), { recursive: true });
    await writeFile(
      path.join(repoDir, ".gooseherd/answer.md"),
      "# Answer\n\nDWS run for org 633609 was skipped because Sidekiq queue X drained late.\n"
    );

    const ctx = new ContextBag();
    ctx.set("repoDir", repoDir);

    const runShellCapture = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    const deps = {
      run: buildTestRun(),
      config: {
        agentCommandTemplate: "true",
        appName: "Hubble",
        mcpExtensions: [],
        piAgentExtensions: []
      },
      logFile: path.join(repoDir, "run.log"),
      runShellCapture
    } as unknown as NodeDeps;

    const result = await investigateNode({} as NodeConfig, ctx, deps);

    expect(result.outcome).toBe("success");
    expect(ctx.get<string>("answer")).toContain("DWS run for org 633609 was skipped");
    expect(runShellCapture).toHaveBeenCalledOnce();
  });

  test("returns soft_fail when .gooseherd/answer.md is missing", async () => {
    const repoDir = await mkdtemp(path.join(tmpdir(), "investigate-"));
    const ctx = new ContextBag();
    ctx.set("repoDir", repoDir);

    const runShellCapture = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    const deps = {
      run: buildTestRun(),
      config: { agentCommandTemplate: "true", appName: "Hubble", mcpExtensions: [], piAgentExtensions: [] },
      logFile: path.join(repoDir, "run.log"),
      runShellCapture
    } as unknown as NodeDeps;

    const result = await investigateNode({} as NodeConfig, ctx, deps);

    expect(result.outcome).toBe("soft_fail");
    expect(result.error).toMatch(/answer\.md/i);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npx vitest run tests/pipeline-investigation.test.ts
```

Expected: FAIL — `investigateNode` is not yet defined.

- [ ] **Step 3: Implement `investigateNode`**

Create `src/pipeline/nodes/investigate.ts`:

```ts
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { appendLog } from "../shell.js";
import { buildAgentCommand } from "../agent-command.js";
import { logInfo } from "../../logger.js";

const ANSWER_PATH = ".gooseherd/answer.md";

const INVESTIGATE_PROMPT_TEMPLATE = `You are investigating a question about this repository. DO NOT modify any source files. Your job is to read code, search, and produce a written answer.

# Question
{{task}}

# Output
Write your answer to \`${ANSWER_PATH}\` (markdown). Include:
- A direct answer to the question.
- Specific file:line references that back up the answer.
- Any caveats, unknowns, or follow-up suggestions.

When you have written \`${ANSWER_PATH}\`, exit. Do not commit, push, or open a PR.
`;

export async function investigateNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const repoDir = ctx.get<string>("repoDir");
  if (!repoDir) {
    return { outcome: "fail", error: "repoDir missing from ContextBag" };
  }

  const promptFile = path.join(repoDir, ".gooseherd", "investigate-prompt.md");
  await mkdir(path.dirname(promptFile), { recursive: true });
  await writeFile(
    promptFile,
    INVESTIGATE_PROMPT_TEMPLATE.replace("{{task}}", deps.run.task),
    "utf-8"
  );

  const command = buildAgentCommand(deps.config, deps.run, repoDir, promptFile, false);
  await appendLog(deps.logFile, `\n[pipeline] investigate: running agent\n  ${command}\n`);

  const exec = await deps.runShellCapture(command, { cwd: repoDir, logFile: deps.logFile });
  if (exec.exitCode !== 0) {
    return {
      outcome: "soft_fail",
      error: `Agent exited with code ${String(exec.exitCode)}`
    };
  }

  const answerPath = path.join(repoDir, ANSWER_PATH);
  let answer: string;
  try {
    answer = await readFile(answerPath, "utf-8");
  } catch {
    return {
      outcome: "soft_fail",
      error: `Agent did not produce ${ANSWER_PATH}`
    };
  }

  if (!answer.trim()) {
    return { outcome: "soft_fail", error: `${ANSWER_PATH} was empty` };
  }

  ctx.set("answer", answer);
  logInfo("investigate node: captured answer", {
    runId: deps.run.id,
    bytes: answer.length
  });
  return { outcome: "success" };
}
```

- [ ] **Step 4: Run test, verify pass**

```bash
npx vitest run tests/pipeline-investigation.test.ts
```

Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/nodes/investigate.ts tests/pipeline-investigation.test.ts
git commit -m "feat: add investigate node action"
```

---

## Task 4: Create the `post_answer` node action

**Files:**
- Create: `src/pipeline/nodes/post-answer.ts`
- Test: extend `tests/pipeline-investigation.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/pipeline-investigation.test.ts`:

```ts
import { postAnswerNode } from "../src/pipeline/nodes/post-answer.js";

describe("postAnswerNode", () => {
  test("posts ContextBag.answer to slackClient.chat.postMessage", async () => {
    const ctx = new ContextBag();
    ctx.set("answer", "# Answer\n\nDWS skipped because the scheduler dropped org 633609 from the queue.\n");

    const postMessage = vi.fn().mockResolvedValue({ ok: true, ts: "1234.5" });
    const slackClient = { chat: { postMessage } };

    const deps = {
      run: buildTestRun(),
      config: { appName: "Hubble", slackCommandName: "hubble" },
      logFile: "/tmp/run.log",
      slackClient
    } as unknown as NodeDeps;

    const result = await postAnswerNode({} as NodeConfig, ctx, deps);

    expect(result.outcome).toBe("success");
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: "C_TEST",
      thread_ts: "1234567890.000100",
      text: expect.stringContaining("DWS skipped because the scheduler")
    }));
  });

  test("skips when slackClient is unavailable", async () => {
    const ctx = new ContextBag();
    ctx.set("answer", "answer text");

    const deps = {
      run: buildTestRun(),
      config: { appName: "Hubble" },
      logFile: "/tmp/run.log",
      slackClient: undefined
    } as unknown as NodeDeps;

    const result = await postAnswerNode({} as NodeConfig, ctx, deps);

    expect(result.outcome).toBe("skipped");
  });

  test("returns soft_fail when ContextBag.answer is missing", async () => {
    const ctx = new ContextBag();
    const postMessage = vi.fn();
    const deps = {
      run: buildTestRun(),
      config: { appName: "Hubble" },
      logFile: "/tmp/run.log",
      slackClient: { chat: { postMessage } }
    } as unknown as NodeDeps;

    const result = await postAnswerNode({} as NodeConfig, ctx, deps);

    expect(result.outcome).toBe("soft_fail");
    expect(postMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npx vitest run tests/pipeline-investigation.test.ts
```

Expected: FAIL — `postAnswerNode` is not yet defined.

- [ ] **Step 3: Implement `postAnswerNode`**

Create `src/pipeline/nodes/post-answer.ts`:

```ts
import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { appendLog } from "../shell.js";
import { logInfo, logError } from "../../logger.js";

export async function postAnswerNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const slackClient = (deps as unknown as { slackClient?: { chat: { postMessage: (args: unknown) => Promise<unknown> } } }).slackClient;
  if (!slackClient) {
    await appendLog(deps.logFile, "\n[pipeline] post_answer: skipped (no slackClient)\n");
    return { outcome: "skipped" };
  }

  const answer = ctx.get<string>("answer");
  if (!answer || !answer.trim()) {
    return { outcome: "soft_fail", error: "ContextBag.answer is missing or empty" };
  }

  const run = deps.run;
  if (!run.channelId || !run.threadTs) {
    return { outcome: "soft_fail", error: "run.channelId or run.threadTs missing" };
  }

  try {
    await slackClient.chat.postMessage({
      channel: run.channelId,
      thread_ts: run.threadTs,
      text: answer,
      ...(deps.config.slackCommandName ? { username: deps.config.slackCommandName } : {})
    });
    logInfo("post_answer: posted to Slack", { runId: run.id, bytes: answer.length });
    return { outcome: "success" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    logError("post_answer: failed to post", { runId: run.id, error: msg });
    return { outcome: "soft_fail", error: `Slack postMessage failed: ${msg}` };
  }
}
```

- [ ] **Step 4: Run test, verify pass**

```bash
npx vitest run tests/pipeline-investigation.test.ts
```

Expected: all `postAnswerNode` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/nodes/post-answer.ts tests/pipeline-investigation.test.ts
git commit -m "feat: add post_answer node action that posts ContextBag.answer to Slack thread"
```

---

## Task 5: Wire the new node actions into the pipeline registry

**Files:**
- Modify: the central node registry (locate via `grep -rn "implementNode\|cloneNode" src/`)

- [ ] **Step 1: Locate the registry**

```bash
grep -rn "registerNode\|nodeRegistry\|action: \"implement\"\|action === \"clone\"" src/pipeline/ src/index.ts | head -20
```

Read the file that registers all node actions and identify the registration pattern.

- [ ] **Step 2: Register the two new node actions**

In the registry (file located in Step 1), add:

```ts
import { investigateNode } from "./pipeline/nodes/investigate.js";
import { postAnswerNode } from "./pipeline/nodes/post-answer.js";
// ...inside the registration block:
registerNode("investigate", investigateNode);
registerNode("post_answer", postAnswerNode);
```

(Adapt to the actual API exposed by the registry file.)

- [ ] **Step 3: Run TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: register investigate and post_answer node actions"
```

---

## Task 6: Add `pipelines/investigation.yml`

**Files:**
- Create: `pipelines/investigation.yml`

- [ ] **Step 1: Create the YAML**

```yaml
version: 1
name: "investigation"
description: "Read-only investigation pipeline. Clones the repo, runs the agent in research mode, and posts the answer to the Slack thread. No commits, no PR."

nodes:
  - id: clone
    type: deterministic
    action: clone

  - id: setup_sandbox
    type: deterministic
    action: setup_sandbox
    if: "config.sandboxEnabled"

  - id: generate_title
    type: deterministic
    action: generate_title
    on_soft_fail: warn

  - id: hydrate
    type: deterministic
    action: hydrate_context

  - id: investigate
    type: agentic
    action: investigate

  - id: post_answer
    type: deterministic
    action: post_answer
    on_soft_fail: warn

  - id: notify
    type: deterministic
    action: notify
    on_soft_fail: warn
```

- [ ] **Step 2: Verify pipeline parses on startup**

```bash
grep -rn "Seeded built-in pipelines" src/
```

Inspect the seeding code; ensure new YAML is loaded automatically (typically `pipelines/*.yml` is globbed). If hardcoded, append `"investigation"` to the seed list.

- [ ] **Step 3: Boot the app locally and confirm pipeline is registered**

```bash
npm run dev
```

In a second terminal:
```bash
curl -s http://localhost:8787/api/pipelines | grep investigation
```

Expected: investigation appears in the pipeline list. Stop the dev server (`Ctrl-C`).

- [ ] **Step 4: Commit**

```bash
git add pipelines/investigation.yml
git commit -m "feat: add investigation pipeline preset"
```

---

## Task 7: Remove the read-only-question regex block from the orchestrator

**Files:**
- Modify: `src/orchestrator/orchestrator.ts`

This task reverses the guard added by `fbcee51` while preserving the safer `execute_task` description.

- [ ] **Step 1: Write the failing test**

Add to `tests/orchestrator-integration.test.ts` (or `tests/orchestrator-investigation.test.ts` if you prefer to keep them separated):

```ts
test("executeTask no longer blocks read-only-style questions", async () => {
  // Regression: commit fbcee51 added a regex block that returned
  // "Error: this is a read-only question" for any 'what is X repository' wording.
  // The orchestrator now relies on the LLM picking the right `mode` instead.
  const enqueueRun = vi.fn().mockResolvedValue({
    id: "run-1", branchName: "x", repoSlug: "owner/repo"
  });

  const deps: HandleMessageDeps = {
    repoAllowlist: ["owner/repo"],
    listRuns: vi.fn(),
    getConfig: vi.fn(),
    enqueueRun
  };

  // Build a tool-call result going through `executeTask` directly.
  // (Use the existing pattern for invoking the orchestrator with a mock LLM
  // that issues an `execute_task` tool_call with a "describe the repo" task.)
  // ... (existing helpers in this file)

  // Assert the run was enqueued (no "Error: read-only" string returned).
  expect(enqueueRun).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npx vitest run tests/orchestrator-integration.test.ts
```

Expected: FAIL — `enqueueRun` was not called because the regex block short-circuited.

- [ ] **Step 3: Remove the regex constants and helper**

In `src/orchestrator/orchestrator.ts`, delete these lines (around 201-206):

```ts
const MUTATION_INTENT_RE = /\b(add|fix|change|update|remove|delete|move|rename|refactor|implement|create|build|enable|disable|make|set|write|edit|modify|convert|migrate|test|lint|upgrade|bump|patch|repair|resolve)\b/i;
const READ_ONLY_REPO_QUESTION_RE = /\b(what\s+(?:is|are)|what'?s|explain|describe|tell\s+me\s+about|show\s+me|summari[sz]e)\b.*\b(repo|repos|repository|repositories|project|codebase)\b|\b(repo|repository|project|codebase)\b.*\b(about|overview|summary|tech\s+stack|structure|purpose)\b|\bwhat\s+kind\s+of\s+code\b|\btech\s+stack\b/i;

function isReadOnlyRepositoryQuestion(task: string): boolean {
  return READ_ONLY_REPO_QUESTION_RE.test(task) && !MUTATION_INTENT_RE.test(task);
}
```

- [ ] **Step 4: Remove the guard call inside `executeTask`**

Remove these lines (around 350-352):

```ts
if (isReadOnlyRepositoryQuestion(task)) {
  return "Error: this is a read-only question about a repository, not a code-change task. Do not queue a pipeline run. Use describe_repo, list_files, read_file, or search_code to answer it directly.";
}
```

- [ ] **Step 5: Run test, verify pass**

```bash
npx vitest run tests/orchestrator-integration.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/orchestrator.ts tests/orchestrator-integration.test.ts
git commit -m "fix(orchestrator): remove read-only-question regex block (revert fbcee51 guard)

The block forced read-only investigations through search_code, which gets
secondary-rate-limited on /search/code and produces the 'Sorry, I ran out
of time' UX. Routing investigations to a pipeline run is the new path."
```

---

## Task 8: Add `mode` parameter to `execute_task` tool

**Files:**
- Modify: `src/orchestrator/orchestrator.ts`
- Modify: `src/orchestrator/types.ts`
- Modify: `src/slack-app.ts`
- Test: extend `tests/orchestrator-investigation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/orchestrator-investigation.test.ts`:

```ts
import { describe, expect, test, vi } from "vitest";
import { handleMessage } from "../src/orchestrator/orchestrator.js";
import type { HandleMessageDeps } from "../src/orchestrator/types.js";

// (Reuse the in-file mock LLM helpers from tests/orchestrator-integration.test.ts;
// extract to a shared helper if not already shared.)

describe("orchestrator investigate mode", () => {
  test("execute_task with mode='investigate' enqueues an investigate intent run", async () => {
    const enqueueRun = vi.fn().mockResolvedValue({
      id: "run-inv-1", branchName: "x", repoSlug: "owner/repo"
    });

    const deps: HandleMessageDeps = {
      repoAllowlist: ["owner/repo"],
      listRuns: vi.fn(),
      getConfig: vi.fn(),
      enqueueRun
    };

    // Mock LLM that on its single turn calls execute_task with mode='investigate'.
    // Use the existing harness; pass the args:
    //   { repo: "owner/repo", task: "Why didn't DWS go out for org 633609?", mode: "investigate" }

    // ... call handleMessage ...

    expect(enqueueRun).toHaveBeenCalledWith(
      "owner/repo",
      "Why didn't DWS go out for org 633609?",
      expect.objectContaining({ mode: "investigate" })
    );
  });

  test("default mode is 'code_change' when omitted", async () => {
    const enqueueRun = vi.fn().mockResolvedValue({
      id: "run-cc-1", branchName: "x", repoSlug: "owner/repo"
    });
    const deps: HandleMessageDeps = {
      repoAllowlist: ["owner/repo"],
      listRuns: vi.fn(),
      getConfig: vi.fn(),
      enqueueRun
    };

    // Mock LLM call: { repo: "owner/repo", task: "Add a button" }  (no mode)

    expect(enqueueRun).toHaveBeenCalledWith(
      "owner/repo",
      "Add a button",
      expect.objectContaining({ mode: "code_change" })
    );
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npx vitest run tests/orchestrator-investigation.test.ts
```

Expected: FAIL — `mode` parameter is not yet wired through.

- [ ] **Step 3: Extend `HandleMessageDeps.enqueueRun` signature**

In `src/orchestrator/types.ts` find the `enqueueRun` signature (~line where `EnqueueRun*` opts are defined) and add a `mode` field to its options:

```ts
enqueueRun: (
  repo: string,
  task: string,
  opts: {
    skipNodes?: string[];
    enableNodes?: string[];
    continueFrom?: string;
    pipeline?: string;
    /** "investigate" → use investigation pipeline + investigate intent. */
    mode?: "code_change" | "investigate";
  }
) => Promise<{ id: string; branchName: string; repoSlug: string }>;
```

- [ ] **Step 4: Add `mode` to the `execute_task` tool schema**

In `src/orchestrator/orchestrator.ts` (the buildTools function, around line 19-49):

```ts
parameters: {
  type: "object",
  properties: {
    // ...existing properties kept
    pipeline: {
      type: "string",
      description: "Pipeline preset name. Use 'pipeline' (default). Use skipNodes/enableNodes to customize behavior instead of preset names. Omit to use the default."
    },
    mode: {
      type: "string",
      enum: ["code_change", "investigate"],
      description: "Run mode. 'code_change' (default) opens a PR. 'investigate' clones the repo, runs the agent in read-only mode, and posts the answer back to the Slack thread. Use 'investigate' for 'why', 'how', or 'explain' questions, especially when search_code returns rate-limit errors."
    }
  },
  required: ["repo", "task"]
}
```

- [ ] **Step 5: Pass `mode` through `executeTask`**

In the `executeTask` function (~line 332), parse and forward `mode`:

```ts
const mode = args["mode"] === "investigate" ? "investigate" : "code_change";

// ... existing skipNodes/enableNodes/etc. parsing kept ...

try {
  const run = await deps.enqueueRun(repo, task, {
    skipNodes,
    enableNodes,
    continueFrom,
    pipeline,
    mode
  });
  runsQueued.push(run);
  const continuation = continueFrom ? ` (continuing from previous run)` : "";
  const modeLabel = mode === "investigate" ? " (investigation)" : "";
  return `Run queued successfully${modeLabel}. ID: ${run.id.slice(0, 8)}, Branch: ${run.branchName}, Repo: ${run.repoSlug}${continuation}`;
} catch (err) { /* unchanged */ }
```

- [ ] **Step 6: Build `InvestigateRunIntent` in the slack-app enqueueRun wrapper**

In `src/slack-app.ts`, find `enqueueRun: async (repo, task, opts) => {` (~line 751) inside `depsWithContext`. Replace the body with:

```ts
enqueueRun: async (repo, task, opts) => {
  if (opts.continueFrom) {
    const continued = await runManager.continueRun(opts.continueFrom, task, event.user!);
    if (!continued) {
      throw new Error(`No prior run found to continue: ${opts.continueFrom}`);
    }
    return { id: continued.id, branchName: continued.branchName, repoSlug: continued.repoSlug };
  }

  const isInvestigate = opts.mode === "investigate";
  const intent = isInvestigate
    ? {
        version: 1 as const,
        kind: "investigate" as const,
        source: "slack" as const,
        requestedBy: event.user!,
        question: task,
        triggerReason: "slack-mention"
      }
    : undefined;
  const pipelineHint = isInvestigate ? "investigation" : (opts.pipeline ?? undefined);

  const run = await runManager.enqueueRun({
    repoSlug: repo,
    task,
    baseBranch: config.defaultBaseBranch,
    requestedBy: event.user!,
    channelId: event.channel,
    threadTs: replyThreadTs,
    runtime: config.sandboxRuntime,
    skipNodes: opts.skipNodes,
    enableNodes: opts.enableNodes,
    pipelineHint,
    intent
  });

  return { id: run.id, branchName: run.branchName, repoSlug: run.repoSlug };
}
```

(Adapt to existing variable names: `event`, `replyThreadTs`, `runManager`, `config` are already in scope at that callsite per slack-app.ts:751.)

- [ ] **Step 7: Run test, verify pass**

```bash
npx vitest run tests/orchestrator-investigation.test.ts
```

Expected: PASS.

- [ ] **Step 8: Run full suite**

```bash
npx tsc --noEmit && npx vitest run
```

Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add src/orchestrator/orchestrator.ts src/orchestrator/types.ts src/slack-app.ts tests/orchestrator-investigation.test.ts
git commit -m "feat: add mode='investigate' to execute_task; route to investigation pipeline"
```

---

## Task 9: Detect GitHub /search/code rate-limit and nudge LLM to escalate

**Files:**
- Modify: `src/slack-app.ts` (the `deps.searchCode` wrapper at line 184)
- Test: `tests/slack-app-search-rate-limit.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/slack-app-search-rate-limit.test.ts`:

```ts
import { describe, expect, test, vi } from "vitest";
import { wrapSearchCodeWithRateLimitNudge } from "../src/slack-app.js";

describe("wrapSearchCodeWithRateLimitNudge", () => {
  test("returns a structured nudge string when octokit throws 403 with 'rate limit'", async () => {
    const inner = vi.fn().mockRejectedValue(
      Object.assign(new Error("You have exceeded a secondary rate limit. Please wait a few minutes before you try again."), { status: 403 })
    );
    const wrapped = wrapSearchCodeWithRateLimitNudge(inner);

    const result = await wrapped("daily work summary", "owner/repo");

    expect(result).toContain("rate-limited");
    expect(result).toContain("execute_task");
    expect(result).toContain("mode=\"investigate\"");
  });

  test("re-throws non-rate-limit errors unchanged", async () => {
    const inner = vi.fn().mockRejectedValue(
      Object.assign(new Error("Bad credentials"), { status: 401 })
    );
    const wrapped = wrapSearchCodeWithRateLimitNudge(inner);

    await expect(wrapped("q", "owner/repo")).rejects.toThrow(/Bad credentials/);
  });

  test("returns inner result unchanged on success", async () => {
    const inner = vi.fn().mockResolvedValue("path/to/file.rb\n  match line");
    const wrapped = wrapSearchCodeWithRateLimitNudge(inner);

    expect(await wrapped("q", "owner/repo")).toBe("path/to/file.rb\n  match line");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npx vitest run tests/slack-app-search-rate-limit.test.ts
```

Expected: FAIL — `wrapSearchCodeWithRateLimitNudge` doesn't exist.

- [ ] **Step 3: Implement and export the wrapper**

In `src/slack-app.ts`, add this near the top-level helpers (above `buildHandleMessageDeps`):

```ts
/**
 * Wraps the searchCode tool callback so that GitHub /search/code rate-limit
 * 403s are turned into a structured nudge string the LLM can act on.
 *
 * Why: the orchestrator LLM otherwise wastes turns retrying search with
 * different queries. The nudge string explicitly tells the model to escalate
 * to a clone-based investigation run via execute_task with mode="investigate".
 */
export function wrapSearchCodeWithRateLimitNudge(
  inner: (query: string, repoSlug: string) => Promise<string>
): (query: string, repoSlug: string) => Promise<string> {
  return async (query, repoSlug) => {
    try {
      return await inner(query, repoSlug);
    } catch (err) {
      const status = (err as { status?: number } | null)?.status;
      const msg = err instanceof Error ? err.message : String(err);
      if (status === 403 && /rate limit|abuse|secondary/i.test(msg)) {
        return [
          `Error: GitHub /search/code is rate-limited (status 403): ${msg}`,
          ``,
          `Do NOT keep calling search_code. Instead, call execute_task with`,
          `mode="investigate" to clone the repo and let an agent investigate it.`,
          `That run will appear in the dashboard and post the answer back here.`
        ].join("\n");
      }
      throw err;
    }
  };
}
```

- [ ] **Step 4: Use the wrapper in `buildHandleMessageDeps`**

Locate `deps.searchCode = async (query: string, repoSlug: string) => { ... };` (line 184 currently). Replace with:

```ts
deps.searchCode = wrapSearchCodeWithRateLimitNudge(async (query, repoSlug) => {
  const results = await githubService.searchCode(query, repoSlug);
  return results.map(r => `${r.path}\n${r.textMatches.map(m => `  ${m}`).join("\n")}`).join("\n\n");
});
```

- [ ] **Step 5: Run test, verify pass**

```bash
npx vitest run tests/slack-app-search-rate-limit.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/slack-app.ts tests/slack-app-search-rate-limit.test.ts
git commit -m "feat: surface GitHub /search/code rate-limit as escalation nudge to LLM"
```

---

## Task 10: Update orchestrator system prompt for investigation routing

**Files:**
- Modify: `src/orchestrator/system-context.ts`

- [ ] **Step 1: Update the `execute_task` description block**

In `src/orchestrator/system-context.ts`, find `### execute_task` (line ~79) and replace with:

```md
### execute_task
Queue a pipeline run. You MUST specify a repo and task. Use the \`mode\` parameter:
- \`mode: "code_change"\` (default) — opens a PR with code changes. Use for "fix X", "add Y", "implement Z" requests.
- \`mode: "investigate"\` — clones the repo, runs the agent read-only, posts the answer to this Slack thread. Use for "why didn't X happen", "how does Y work", "explain Z" questions. The run shows up in the dashboard so engineers can review the investigation.

When to choose \`mode: "investigate"\`:
- The user is asking a question, not requesting changes.
- \`search_code\` returned a rate-limit error (escalate immediately, do not retry).
- The question requires reading more than 3-4 files to answer well.
- The user explicitly asked for a written investigation.
```

- [ ] **Step 2: Add a behavioral rule about rate-limit escalation**

In the same file, in the `## Behavioral Rules` section, append:

```md
11. **Escalate on rate-limit** — if \`search_code\` returns a "rate-limited" error string, immediately call \`execute_task\` with \`mode: "investigate"\` and the same question. Do NOT keep retrying \`search_code\` with different queries.
```

- [ ] **Step 3: Run prompt-related tests**

```bash
npx vitest run tests/orchestrator-integration.test.ts tests/orchestrator-investigation.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/system-context.ts
git commit -m "docs(orchestrator): describe investigate mode + rate-limit escalation rule"
```

---

## Task 11: End-to-end smoke

**Files:**
- None (manual verification)

- [ ] **Step 1: Boot the dev server**

```bash
npm run dev
```

- [ ] **Step 2: From a Slack workspace bound to your dev `.env`, mention the bot with an investigate-style question**

Sample message:

> @hubble Why doesn't org 633609 receive the Daily Work Summary email? Investigate.

- [ ] **Step 3: Verify expected behavior**

- [ ] The bot responds in-thread with "Run queued successfully (investigation). ID: …"
- [ ] A new run appears in the dashboard at `http://localhost:8787/runs`
- [ ] The run's pipeline is `investigation`
- [ ] The run's `intent.kind` (visible via `/api/runs/<id>`) is `investigate`
- [ ] When the run completes, the agent's answer is posted back to the Slack thread (markdown body)
- [ ] No `Sorry, I ran out of time processing that.` UX is produced

- [ ] **Step 4: Verify rate-limit nudge path**

Manually trigger the rate-limit branch:
- Set a `GITHUB_TOKEN` with very tight quota OR temporarily mock the wrapper to throw a synthetic 403.
- Mention the bot with a search-able question.
- Confirm the bot's next assistant turn calls `execute_task mode=investigate` instead of looping on `search_code`.

- [ ] **Step 5: Stop the dev server**

`Ctrl-C`.

---

## Task 12: Push branch + open PR

- [ ] **Step 1: Push**

```bash
git push -u origin feat/dashboard-visible-investigations
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "feat: dashboard-visible investigations with GitHub-search-first fallback" --body "$(cat <<'EOF'
## Summary
- Adds an `investigation` pipeline preset (clone → hydrate → read-only agent → post answer to Slack → notify).
- Adds an `investigate` RunIntent kind that routes to the new pipeline.
- Adds `mode: "code_change" | "investigate"` to the `execute_task` orchestrator tool.
- Removes the read-only-question regex block introduced by `fbcee51`.
- Wraps `search_code` to detect `/search/code` 403 rate-limits and nudge the LLM to escalate to an investigate run instead of looping.
- Updates the orchestrator system prompt to document the new mode + rate-limit escalation rule.

## Why
The April 24 DWS investigation (`runsQueued: 0`, `turnsUsed: 25`, `inputTokens: 293_699` per prod logs) blew through the orchestrator's turn budget chasing GitHub `/search/code` 403s with no escalation path. That request now creates a dashboard-visible run that clones and investigates properly.

## Test plan
- [ ] `npx tsc --noEmit && npx vitest run` is green
- [ ] Local Slack mention with an investigate-style question creates an `investigation` run visible in the dashboard
- [ ] Run posts agent's answer back to the Slack thread on completion
- [ ] Synthetic 403 from `searchCode` causes the LLM to call `execute_task mode=investigate` on its next turn
EOF
)"
```

---

## Self-Review Checklist (run before declaring done)

- [ ] **Spec coverage** — every requirement from the brainstorm is addressed:
  - ✓ Always show questions as runs in dashboard → Task 6 (`investigation.yml`) + Task 8 (`mode: "investigate"`)
  - ✓ GitHub Search first → orchestrator's `search_code` tool stays as the fast path
  - ✓ Clone fallback when search fails/rate-limits → Task 9 (rate-limit nudge) + Task 8 (escalate via `execute_task`)
  - ✓ Remove or make optional the read-only guard → Task 7 (regex block removed)
  - ✓ Work-item perspective preserved → `intent` field is set, runs flow through the same `RunManager`/store as feature-delivery work, and `workItemId` field on `NewRunInput` remains untouched (orchestrator-initiated investigations don't link to a work item; future task can add that linkage)

- [ ] **Placeholder scan** — search the plan for `TBD`, `TODO`, `implement later`, "similar to Task N", "fill in details". None should remain.

- [ ] **Type consistency** — verify the names used across tasks line up:
  - `INVESTIGATION_PIPELINE_ID` (Task 1) used in `run-intent.ts` (Task 2)
  - `InvestigateRunIntent.question` field referenced in tests + slack-app intent builder
  - `mode: "code_change" | "investigate"` consistent across orchestrator types, system prompt, slack-app
  - `wrapSearchCodeWithRateLimitNudge` name used in both definition (Task 9 step 3) and test (Task 9 step 1)
  - `investigateNode` and `postAnswerNode` registered in Task 5 with the same names as in Task 3-4

- [ ] **Out-of-scope items NOT in this plan (deferred):**
  - Removing the orchestrator's inner `maxTurns: 25` cap entirely (separate brainstorm; covered by escalation here for the immediate symptom).
  - Loop-detector for repeated tool calls.
  - Linking investigate runs to work items.
  - Replacing GitHub `/search/code` with the GraphQL search endpoint (deprecation deadline 2026-09-27).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-28-dashboard-visible-investigations.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach?
