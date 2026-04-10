/**
 * E2E Full Conversation Test — real LLM, real agent, real pipeline.
 * NO mocking. NO dummy agents. Everything is real.
 *
 * Simulates a multi-turn Slack thread:
 *   Turn 1: Question about the repo (LLM uses GitHub tools)
 *   Turn 2: Request a simple change → execute_task queued
 *   [wait for pipeline completion — real agent makes real changes]
 *   Turn 3: Ask about results
 *
 * Gated on E2E_FULL_CONVERSATION=1 — not run in normal test suite.
 *
 * Usage:
 *   E2E_FULL_CONVERSATION=1 node --test --import tsx tests/e2e-full-conversation.test.ts
 *
 * Optional env vars:
 *   E2E_DRY_RUN=false          — push + create PR (default: true, dry-run only)
 *   E2E_AGENT_MODEL=<model>    — override the agent model (default: openai/gpt-4.1-mini)
 *   E2E_ORCHESTRATOR_MODEL=<m> — override orchestrator model (default: from .env)
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import { loadConfig, resolveGitHubAuthMode, type AppConfig } from "../src/config.js";
import { PipelineEngine } from "../src/pipeline/pipeline-engine.js";
import { GitHubService } from "../src/github.js";
import { DockerExecutionBackend } from "../src/runtime/docker-backend.js";
import { LocalExecutionBackend } from "../src/runtime/local-backend.js";
import { RunStore } from "../src/store.js";
import { RunManager } from "../src/run-manager.js";
import { handleMessage } from "../src/orchestrator/orchestrator.js";
import { buildSystemContext } from "../src/orchestrator/system-context.js";
import type { HandleMessageDeps, HandleMessageResult } from "../src/orchestrator/types.js";
import type { LLMCallerConfig, ChatMessage } from "../src/llm/caller.js";
import type { RunRecord } from "../src/types.js";

dotenv.config({ override: true });

// ── Skip gate ──────────────────────────────────────────

const ENABLED = process.env["E2E_FULL_CONVERSATION"] === "1";

// ── Helpers ────────────────────────────────────────────

/** No-op Slack client — channelId="local" bypasses all Slack posting. */
function stubWebClient() {
  return {
    chat: {
      postMessage: async () => ({ ok: true, ts: "0000000000.000001" }),
      update: async () => ({ ok: true })
    }
  };
}

/**
 * Swap the --model flag in the agent command template.
 * If the template contains `--model <something>`, replace with the new model.
 * Preserves the openrouter/ prefix if the original had one.
 * Returns original template if no --model flag found.
 */
function swapAgentModel(template: string, newModel: string): string {
  return template.replace(/--model\s+\S+/, `--model ${newModel}`);
}

/** Poll RunStore until the run reaches a terminal status or timeout. */
async function waitForRunCompletion(
  store: RunStore,
  runId: string,
  timeoutMs: number
): Promise<RunRecord> {
  const deadline = Date.now() + timeoutMs;
  const shortId = runId.slice(0, 8);
  let lastPhase = "";
  while (Date.now() < deadline) {
    const run = await store.getRun(runId);
    if (run) {
      const phase = run.phase ?? run.status;
      if (phase !== lastPhase) {
        const elapsed = run.startedAt
          ? `${Math.round((Date.now() - Date.parse(run.startedAt)) / 1000)}s`
          : "?";
        console.log(`  [${shortId}] ${lastPhase || "start"} → ${phase} (${elapsed})`);
        lastPhase = phase;
      }
      if (run.status === "completed" || run.status === "failed") {
        return run;
      }
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`Run ${runId} did not complete within ${timeoutMs / 1000}s (last phase: ${lastPhase})`);
}

/** Build the LLM config from env. */
function buildLLMConfig(config: AppConfig): LLMCallerConfig {
  return {
    apiKey: process.env["OPENROUTER_API_KEY"] || "",
    defaultModel: config.orchestratorModel,
    defaultTimeoutMs: 30_000,
    providerPreferences: config.openrouterProviderPreferences
  };
}

/** Build HandleMessageDeps with real services (mirrors slack-app.ts). */
function buildDeps(
  config: AppConfig,
  runManager: RunManager,
  githubService: GitHubService | undefined,
  threadChannelId: string,
  threadTs: string
): HandleMessageDeps {
  const deps: HandleMessageDeps = {
    repoAllowlist: config.repoAllowlist,

    enqueueRun: async (repo, task, opts) => {
      const run = await runManager.enqueueRun({
        repoSlug: repo,
        task,
        baseBranch: config.defaultBaseBranch,
        requestedBy: "e2e-test",
        channelId: threadChannelId,
        threadTs,
        runtime: config.sandboxRuntime,
        skipNodes: opts.skipNodes,
        enableNodes: opts.enableNodes
      });
      return { id: run.id, branchName: run.branchName, repoSlug: run.repoSlug };
    },

    listRuns: async (repoSlug?: string) => {
      const runs = await runManager.getRecentRuns(repoSlug);
      return JSON.stringify(runs.map(r => ({
        id: r.id.slice(0, 8),
        status: r.status,
        repo: r.repoSlug,
        task: r.task.slice(0, 80)
      })));
    },

    getConfig: async (key?: string) => {
      const safeKeys = [
        "browserVerifyModel", "browserVerifyMaxSteps", "browserVerifyExecTimeoutMs", "pipelineFile",
        "orchestratorModel", "planTaskModel", "agentTimeoutSeconds",
        "maxValidationRounds", "ciMaxFixRounds"
      ];
      if (key && safeKeys.includes(key)) {
        return JSON.stringify({ [key]: (config as unknown as Record<string, unknown>)[key] });
      }
      const subset: Record<string, unknown> = {};
      for (const k of safeKeys) {
        subset[k] = (config as unknown as Record<string, unknown>)[k];
      }
      return JSON.stringify(subset);
    }
  };

  if (githubService) {
    deps.searchCode = async (query: string, repoSlug: string) => {
      const results = await githubService.searchCode(query, repoSlug);
      return results.map(r => `${r.path}\n${r.textMatches.map(m => `  ${m}`).join("\n")}`).join("\n\n");
    };

    deps.describeRepo = async (repoSlug: string) => {
      const info = await githubService.describeRepo(repoSlug);
      const parts: string[] = [];
      const totalBytes = Object.values(info.languages).reduce((a, b) => a + b, 0);
      if (totalBytes > 0) {
        const langLines = Object.entries(info.languages)
          .sort((a, b) => b[1] - a[1])
          .map(([lang, bytes]) => `- ${lang}: ${((bytes / totalBytes) * 100).toFixed(1)}%`);
        parts.push(`Languages:\n${langLines.join("\n")}`);
      }
      if (info.rootFiles.length > 0) {
        parts.push(`Root files:\n${info.rootFiles.join(", ")}`);
      }
      if (info.readme) {
        const snippet = info.readme.length > 800 ? info.readme.slice(0, 800) + "..." : info.readme;
        parts.push(`README:\n${snippet}`);
      }
      return parts.join("\n\n");
    };

    deps.readFile = async (repoSlug: string, filePath: string) => {
      return githubService.readFile(repoSlug, filePath);
    };

    deps.listFiles = async (repoSlug: string, dirPath: string) => {
      const entries = await githubService.listDirectory(repoSlug, dirPath);
      return entries
        .map(e => `${e.type === "dir" ? "d" : "f"} ${e.name}${e.type === "dir" ? "/" : ""} (${String(e.size)}B)`)
        .join("\n");
    };
  }

  return deps;
}

/** Log a conversation turn. */
function logTurn(label: string, result: HandleMessageResult): void {
  console.log(`\n── ${label} ──`);
  console.log(`Response: ${result.response.slice(0, 400)}${result.response.length > 400 ? "..." : ""}`);
  console.log(`Runs queued: ${result.runsQueued.length}`);
  console.log(`Messages in history: ${result.messages.length}`);
  for (const r of result.runsQueued) {
    console.log(`  → Run ${r.id.slice(0, 8)} on ${r.repoSlug} (branch: ${r.branchName})`);
  }
}

// ── The Test ───────────────────────────────────────────

test("E2E Full Conversation: question → execute → verify", async (t) => {
  if (!ENABLED) {
    t.skip("Set E2E_FULL_CONVERSATION=1 to run this test");
    return;
  }

  // ── Preflight checks ──
  const baseConfig = loadConfig();
  const authMode = resolveGitHubAuthMode(baseConfig);

  if (authMode === "none") {
    t.skip("No GitHub auth configured — skipping");
    return;
  }
  if (!process.env["OPENROUTER_API_KEY"]) {
    t.skip("OPENROUTER_API_KEY not set — skipping");
    return;
  }

  // ── Resolve agent model ──
  // Default to gpt-4.1-mini for speed — the production model (glm-5) is too slow for tests.
  // Override with E2E_AGENT_MODEL if you want to test a specific model.
  // Default to gpt-4.1-mini via OpenRouter for speed.
  // The openrouter/ prefix tells pi-agent to route through OpenRouter (uses OPENROUTER_API_KEY).
  const agentModel = process.env["E2E_AGENT_MODEL"] || "openrouter/openai/gpt-4.1-mini";
  const agentTemplate = swapAgentModel(baseConfig.agentCommandTemplate, agentModel);
  // Default to gpt-4.1-mini for orchestrator too — gemini-3.1-pro is ~5min/call via OpenRouter.
  const orchestratorModel = process.env["E2E_ORCHESTRATOR_MODEL"] || "openai/gpt-4.1-mini";

  console.log("\n====== E2E FULL CONVERSATION TEST ======");
  console.log(`Agent template: ${agentTemplate.slice(0, 80)}...`);
  console.log(`Agent model: ${agentModel}`);
  console.log(`Orchestrator model: ${orchestratorModel}`);
  console.log(`Pipeline: ${baseConfig.pipelineFile}`);
  console.log(`Dry run: ${process.env["E2E_DRY_RUN"] !== "false"}`);

  // ── Setup temp dirs ──
  const tmpDir = await mkdtemp(path.join(tmpdir(), "gooseherd-e2e-conv-"));
  const workRoot = path.join(tmpDir, "work");
  const dataDir = path.join(tmpDir, "data");

  const threadChannelId = "local";
  const threadTs = `e2e-${Date.now()}.000000`;
  const userId = "U_E2E_TESTER";

  try {
    // ── Build real services — no mocking ──
    const config: AppConfig = {
      ...baseConfig,
      workRoot,
      dataDir,
      dryRun: process.env["E2E_DRY_RUN"] === "false" ? false : true,
      agentCommandTemplate: agentTemplate,
      orchestratorModel,
      // 5 min agent timeout — generous for a simple README edit
      agentTimeoutSeconds: Math.min(baseConfig.agentTimeoutSeconds, 300),
      // Disable validation/lint — we're testing conversation→pipeline flow, not project linting
      validationCommand: "",
      lintFixCommand: "",
    };

    const store = new RunStore(dataDir);
    await store.init();

    const githubService = GitHubService.create(config);
    const pipelineEngine = new PipelineEngine(config, githubService);
    const runtimeRegistry = {
      local: new LocalExecutionBackend(pipelineEngine),
      docker: new DockerExecutionBackend(pipelineEngine),
      kubernetes: undefined
    };
    const slackClient = stubWebClient();
    const runManager = new RunManager(config, store, runtimeRegistry, slackClient as any);

    const llmConfig = buildLLMConfig(config);
    const systemContext = buildSystemContext(config);
    const deps = buildDeps(config, runManager, githubService, threadChannelId, threadTs);

    // Track tool calls across all turns
    const allToolCalls: Array<{ turn: number; tool: string; args: Record<string, unknown> }> = [];
    let turnNumber = 0;

    const makeOptions = () => ({
      onToolCall: (toolName: string, args: Record<string, unknown>) => {
        allToolCalls.push({ turn: turnNumber, tool: toolName, args });
        console.log(`  [Turn ${turnNumber}] Tool: ${toolName}(${JSON.stringify(args).slice(0, 120)})`);
      },
      timeoutMs: 90_000,
      wallClockTimeoutMs: 300_000
    });

    let priorMessages: ChatMessage[] = [];

    // ────────────────────────────────────────────────────
    // Turn 1: Ask about the repo
    // ────────────────────────────────────────────────────
    turnNumber = 1;
    console.log("\n====== TURN 1: Asking about the repo ======");

    const turn1 = await handleMessage(
      llmConfig, orchestratorModel, systemContext,
      {
        message: "Hey, what is epiccoders/pxls? Can you quickly look at the repo and tell me what stack it uses?",
        userId, channelId: threadChannelId, threadTs, priorMessages
      },
      deps, makeOptions()
    );
    logTurn("Turn 1 — Repo question", turn1);

    assert.ok(turn1.response.length > 50, "Turn 1 should have a substantive response");
    assert.equal(turn1.runsQueued.length, 0, "Turn 1 should not queue any runs");

    const turn1Tools = allToolCalls.filter(c => c.turn === 1).map(c => c.tool);
    assert.ok(
      turn1Tools.some(t => ["describe_repo", "list_files", "read_file", "search_code"].includes(t)),
      `Turn 1 should use repo tools. Used: ${turn1Tools.join(", ")}`
    );

    priorMessages = turn1.messages;

    // ────────────────────────────────────────────────────
    // Turn 2: Direct execution request
    // ────────────────────────────────────────────────────
    turnNumber = 2;
    console.log("\n====== TURN 2: Request change + execute ======");

    // Be direct — LLMs sometimes plan instead of executing. Force it.
    const turn2 = await handleMessage(
      llmConfig, orchestratorModel, systemContext,
      {
        message: "Add a one-line HTML comment at the very top of README.md: <!-- Monitored by Gooseherd -->. Just that one line, nothing else. Go ahead and run it now.",
        userId, channelId: threadChannelId, threadTs, priorMessages
      },
      deps, makeOptions()
    );
    logTurn("Turn 2 — Execute request", turn2);

    let queuedRun: { id: string; branchName: string; repoSlug: string } | undefined;

    if (turn2.runsQueued.length > 0) {
      queuedRun = turn2.runsQueued[0];
    } else {
      // LLM asked for confirmation — give it
      turnNumber = 3;
      console.log("\n====== TURN 2b: Explicit confirmation ======");

      const turn2b = await handleMessage(
        llmConfig, orchestratorModel, systemContext,
        {
          message: "Yes, go ahead.",
          userId, channelId: threadChannelId, threadTs,
          priorMessages: turn2.messages
        },
        deps, makeOptions()
      );
      logTurn("Turn 2b — Confirmation", turn2b);
      priorMessages = turn2b.messages;

      assert.ok(turn2b.runsQueued.length > 0, "Should queue a pipeline run after confirmation");
      queuedRun = turn2b.runsQueued[0];
    }

    assert.ok(queuedRun, "A run should have been queued");
    console.log(`\nQueued run: ${queuedRun.id.slice(0, 8)} on ${queuedRun.repoSlug}`);

    priorMessages = turn2.runsQueued.length > 0 ? turn2.messages : priorMessages;

    const executeTaskCalls = allToolCalls.filter(c => c.tool === "execute_task");
    assert.ok(executeTaskCalls.length > 0, "execute_task should have been called");

    // ────────────────────────────────────────────────────
    // Wait for pipeline completion (real agent)
    // ────────────────────────────────────────────────────
    console.log("\n====== Waiting for pipeline completion (real agent) ======");
    const completedRun = await waitForRunCompletion(store, queuedRun.id, 600_000);
    console.log(`\nRun finished: status=${completedRun.status}`);

    if (completedRun.status === "failed") {
      console.log(`Error: ${completedRun.error}`);
      if (completedRun.logsPath) {
        try {
          const logs = await readFile(completedRun.logsPath, "utf8");
          const tail = logs.split("\n").slice(-30).join("\n");
          console.log(`Last 30 log lines:\n${tail}`);
        } catch { /* no logs */ }
      }
    }

    assert.equal(completedRun.status, "completed", `Run should complete. Error: ${completedRun.error ?? "none"}`);

    // ── Verify pipeline artifacts ──
    const runDir = path.join(workRoot, queuedRun.id);
    const repoDir = path.join(runDir, "repo");

    await access(repoDir);
    console.log("  Clone: OK");

    assert.ok(completedRun.commitSha, "Should have a commit SHA");
    console.log(`  Commit: ${completedRun.commitSha?.slice(0, 8)}`);

    assert.ok(completedRun.changedFiles && completedRun.changedFiles.length > 0, "Should have changed files");
    console.log(`  Changed: ${completedRun.changedFiles?.join(", ")}`);

    // Verify the actual change in the cloned repo
    const readmeContent = await readFile(path.join(repoDir, "README.md"), "utf8");
    assert.ok(
      readmeContent.includes("Monitored by Gooseherd"),
      "README.md should contain the Gooseherd comment"
    );
    console.log("  README check: comment found");

    if (completedRun.logsPath) {
      const logs = await readFile(completedRun.logsPath, "utf8");
      assert.ok(logs.length > 0, "Logs should have content");
      console.log(`  Logs: ${logs.split("\n").length} lines`);
    }

    const promptFile = path.join(runDir, "task.md");
    const promptContent = await readFile(promptFile, "utf8");
    assert.ok(promptContent.includes("epiccoders/pxls"), "Prompt should reference the repo");
    console.log("  Prompt: OK");

    // ── Browser verify artifacts (only if infrastructure is live) ──
    const screenshotsDir = path.join(runDir, "screenshots");
    try {
      await access(screenshotsDir);
      const screenshots = await readdir(screenshotsDir);
      if (screenshots.length > 0) {
        console.log(`  Screenshots: ${screenshots.join(", ")}`);
        for (const s of screenshots) {
          const content = await readFile(path.join(screenshotsDir, s));
          assert.ok(content.length > 100, `Screenshot ${s} should have content`);
        }
      }
    } catch {
      console.log("  (No screenshots — browser_verify not enabled or no deploy preview)");
    }

    try {
      await access(path.join(runDir, "verification.mp4"));
      console.log("  Video: verification.mp4 found");
    } catch {
      console.log("  (No video — browser_verify not enabled)");
    }

    // ────────────────────────────────────────────────────
    // Turn 3: Ask about results
    // ────────────────────────────────────────────────────
    turnNumber = 4;
    console.log("\n====== TURN 3: Asking about results ======");

    const turnResults = await handleMessage(
      llmConfig, orchestratorModel, systemContext,
      {
        message: "Did that run finish? What changed?",
        userId, channelId: threadChannelId, threadTs, priorMessages
      },
      deps, makeOptions()
    );
    logTurn("Turn 3 — Results inquiry", turnResults);

    assert.ok(turnResults.response.length > 20, "Should respond about the run");

    // ── Final summary ──
    const duration = completedRun.startedAt && completedRun.finishedAt
      ? `${Math.round((Date.parse(completedRun.finishedAt) - Date.parse(completedRun.startedAt)) / 1000)}s`
      : "?";

    console.log("\n====== E2E FULL CONVERSATION — PASS ======");
    console.log(`LLM turns: ${turnNumber} | Tool calls: ${allToolCalls.length}`);
    console.log(`Tools: ${[...new Set(allToolCalls.map(c => c.tool))].join(", ")}`);
    console.log(`Run: ${completedRun.status} in ${duration}`);
    console.log(`Commit: ${completedRun.commitSha?.slice(0, 8)} | Files: ${completedRun.changedFiles?.length}`);
    console.log(`PR: ${completedRun.prUrl ?? "(dry-run)"}`);

  } finally {
    // Small grace period for any in-flight async work (heartbeat, etc.)
    await new Promise(r => setTimeout(r, 2000));
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}, { timeout: 900_000 });
