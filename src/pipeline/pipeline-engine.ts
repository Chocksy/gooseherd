import path from "node:path";
import { mkdir } from "node:fs/promises";
import type {
  PipelineConfig,
  NodeConfig,
  NodeHandler,
  NodeResult,
  NodeDeps,
  PipelineResult,
  PipelineStepResult,
  LoopConfig,
  NodeEvent,
  NodeEventListener
} from "./types.js";
import { EventLogger } from "./event-logger.js";
import { computeCostUsd } from "../llm/model-prices.js";
import type { ExecutionResult, RunRecord, TokenUsage } from "../types.js";
import type { AppConfig } from "../config.js";
import type { GitHubService } from "../github.js";
import type { RunLifecycleHooks } from "../hooks/run-lifecycle.js";
import { ContextBag } from "./context-bag.js";
import { loadPipeline } from "./pipeline-loader.js";
import { appendLog, runInSandboxContext } from "./shell.js";
import { filterInternalGeneratedFiles } from "./internal-generated-files.js";
import { logInfo } from "../logger.js";
import type { ContainerManager } from "../sandbox/container-manager.js";
import type { SandboxHandle } from "../sandbox/types.js";

import { NODE_HANDLERS } from "./node-registry.js";
import { isNonCodeFixFailure, type BrowserVerifyFailureCode } from "./quality-gates/browser-verify-routing.js";
import { escalateMode, type ExecutionMode } from "./quality-gates/task-classifier.js";

export type PipelinePhase = "cloning" | "rebasing" | "agent" | "validating" | "pushing" | "awaiting_ci" | "ci_fixing";

/**
 * Evaluate a pipeline node `if` condition.
 * Only 5 patterns exist across all YAMLs — all resolve to truthiness or `!= ''`.
 */
function shouldRunNode(condition: string, ctx: ContextBag, config: Record<string, unknown>): boolean {
  const neqMatch = condition.match(/^(.+?)\s*!=\s*''\s*$/);
  if (neqMatch) {
    const value = ctx.resolve(neqMatch[1]!.trim(), config);
    return value !== undefined && value !== null && value !== "";
  }
  const value = ctx.resolve(condition.trim(), config);
  return !!value;
}

/**
 * Pipeline engine: loads YAML pipeline, executes nodes in order,
 * handles loop constructs for failure recovery.
 */
export class PipelineEngine {
  private readonly nodeEventListeners: NodeEventListener[] = [];

  constructor(
    private readonly config: AppConfig,
    private readonly githubService?: GitHubService,
    private readonly hooks?: RunLifecycleHooks,
    private readonly containerManager?: ContainerManager
  ) {}

  /** Register a listener for real-time node start/end events. */
  onNodeEvent(cb: NodeEventListener): void {
    this.nodeEventListeners.push(cb);
  }

  private fireNodeEvent(event: NodeEvent): void {
    for (const cb of this.nodeEventListeners) {
      try { cb(event); } catch { /* swallow */ }
    }
  }

  /**
   * Execute a pipeline for a run.
   * @param skipNodes — optional list of node IDs to skip entirely (from orchestrator classification)
   * @param enableNodes — optional list of node IDs to force-enable (overrides enabled: false in YAML)
   */
  async execute(
    run: RunRecord,
    onPhase: (phase: PipelinePhase) => Promise<void>,
    pipelineFile?: string,
    onDetail?: (detail: string) => Promise<void>,
    skipNodes?: string[],
    enableNodes?: string[],
    abortSignal?: AbortSignal
  ): Promise<ExecutionResult> {
    const yamlPath = pipelineFile ?? path.resolve("pipelines/pipeline.yml");
    const pipeline = await loadPipeline(yamlPath);

    logInfo("Pipeline loaded", { name: pipeline.name, nodes: pipeline.nodes.length });

    const runDir = path.resolve(this.config.workRoot, run.id);
    const logFile = path.join(runDir, "run.log");
    // Ensure run directory + log file exist before pipeline starts
    // (the clone node will rm + recreate, but we need the dir for pre-node logging)
    await mkdir(runDir, { recursive: true });
    await appendLog(logFile, `${this.config.appName} pipeline started for ${run.id}\n`);

    // Event logger — local to this execution to avoid race conditions
    // when RUNNER_CONCURRENCY > 1 (multiple execute() calls in parallel).
    const eventLogger = new EventLogger(runDir);

    // Initialize context bag
    const ctx = new ContextBag({
      runId: run.id,
      repoSlug: run.repoSlug,
      baseBranch: run.baseBranch,
      branchName: run.branchName,
      task: run.task,
      requestedBy: run.requestedBy,
      ...(run.prefetchContext ? { prefetchContext: run.prefetchContext } : {})
    });
    // Merge pipeline-level context
    if (pipeline.context) {
      for (const [key, value] of Object.entries(pipeline.context)) {
        ctx.set(key, value);
      }
    }

    const deps: NodeDeps = {
      config: this.config,
      run,
      githubService: this.githubService,
      hooks: this.hooks,
      logFile,
      workRoot: this.config.workRoot,
      onPhase: async (phase: string) => {
        await eventLogger.emit("phase_change", { phase });
        await onPhase(phase as PipelinePhase);
      },
      onDetail
    };

    let startIndex = 0;

    // Determine sandbox strategy: deferred (setup_sandbox node) or upfront (legacy)
    const hasSetupSandbox = pipeline.nodes.some(n => n.action === "setup_sandbox");

    // Create sandbox container if enabled — upfront for legacy pipelines,
    // deferred for pipelines with setup_sandbox node.
    let sandbox: SandboxHandle | undefined;
    const sandboxRef: { handle?: SandboxHandle } = {};

    if (this.config.sandboxEnabled && this.containerManager && !hasSetupSandbox) {
      // Legacy path: create sandbox upfront with global image
      sandbox = await this.buildAndCreateSandbox(run.id, this.config.sandboxImage, logFile);
    }

    // For deferred sandbox, provide requestSandbox callback
    if (hasSetupSandbox && this.config.sandboxEnabled && this.containerManager) {
      deps.requestSandbox = async (image: string) => {
        sandboxRef.handle = await this.buildAndCreateSandbox(run.id, image, logFile);
      };
      deps.containerManager = this.containerManager;
    }

    const skipNodeIdSet = skipNodes && skipNodes.length > 0 ? new Set(skipNodes) : undefined;
    let enableNodeIdSet = enableNodes && enableNodes.length > 0 ? new Set(enableNodes) : undefined;
    if (enableNodeIdSet?.has("browser_verify")) {
      // Recovery decision should follow browser_verify by default when browser verify is explicitly enabled.
      enableNodeIdSet.add("decide_recovery");
      await appendLog(logFile, "[pipeline] auto-enable: decide_recovery (browser_verify enabled)\n");
    }

    let result;
    try {
      if (sandbox) {
        // Legacy path: Run pipeline inside AsyncLocalStorage context so all shell calls
        // within this async tree route through the correct container.
        result = await runInSandboxContext(sandbox.containerId, run.id, () =>
          this.executePipeline(pipeline, ctx, deps, startIndex, eventLogger, skipNodeIdSet, enableNodeIdSet, abortSignal)
        );
      } else if (hasSetupSandbox) {
        // Deferred path: run pre-sandbox nodes on host, then enter sandbox context
        // after setup_sandbox completes. executePipeline handles the context switch.
        result = await this.executePipeline(pipeline, ctx, deps, startIndex, eventLogger, skipNodeIdSet, enableNodeIdSet, abortSignal, sandboxRef);
      } else {
        result = await this.executePipeline(pipeline, ctx, deps, startIndex, eventLogger, skipNodeIdSet, enableNodeIdSet, abortSignal);
      }
    } finally {
      // Clean up sandbox (handles both upfront and deferred)
      const activeSandbox = sandbox ?? sandboxRef.handle;
      if (activeSandbox && this.containerManager) {
        await this.containerManager.destroySandbox(run.id);
        await appendLog(logFile, `[sandbox] container destroyed: ${activeSandbox.containerName}\n`);
      }
    }

    // Aggregate token usage from all _tokenUsage_* context bag keys
    const tokenUsage = aggregateTokenUsage(ctx, this.config.defaultLlmModel);
    if (tokenUsage) {
      ctx.set("tokenUsage", tokenUsage);
    }

    // Build ExecutionResult from context bag
    const branchName = run.branchName;
    const commitSha = ctx.get<string>("commitSha") ?? "";
    const changedFiles = filterInternalGeneratedFiles(ctx.get<string[]>("changedFiles") ?? []);
    const internalArtifacts = ctx.get<string[]>("internalArtifacts");
    const prUrl = ctx.get<string>("prUrl");

    if (result.outcome === "failure") {
      const failedStep = result.steps.find(s => s.outcome === "failure");
      throw new Error(failedStep?.error ?? "Pipeline failed");
    }

    return {
      branchName,
      logsPath: logFile,
      commitSha,
      changedFiles,
      internalArtifacts,
      prUrl,
      tokenUsage: tokenUsage ?? undefined,
      title: ctx.get<string>("generatedTitle")
    };
  }

  private async executePipeline(
    pipeline: PipelineConfig,
    ctx: ContextBag,
    deps: NodeDeps,
    startIndex: number,
    eventLogger?: EventLogger,
    skipNodeIds?: Set<string>,
    enableNodeIds?: Set<string>,
    abortSignal?: AbortSignal,
    sandboxRef?: { handle?: SandboxHandle }
  ): Promise<PipelineResult> {
    const steps: PipelineStepResult[] = [];
    const warnings: string[] = [];
    const maxGotos = 10;
    let gotoCount = 0;

    for (let i = startIndex; i < pipeline.nodes.length; i++) {
      // Check abort signal before each node
      if (abortSignal?.aborted) {
        await appendLog(deps.logFile, "\n[pipeline] run cancelled by user\n");
        return { outcome: "failure", steps: [...steps, { nodeId: "cancelled", outcome: "failure", durationMs: 0, error: "Run cancelled" }], warnings };
      }

      const node = pipeline.nodes[i] as NodeConfig;

      // Check skipNodeIds first (explicit skip always wins)
      if (skipNodeIds?.has(node.id)) {
        steps.push({ nodeId: node.id, outcome: "skipped", durationMs: 0 });
        await eventLogger?.emit("node_end", { nodeId: node.id, outcome: "skipped", durationMs: 0 });
        await appendLog(deps.logFile, `\n[pipeline] ${node.id}: skipped (in skipNodes list)\n`);
        continue;
      }

      // Check enabled flag — enableNodes overrides enabled: false
      if (node.enabled === false && !enableNodeIds?.has(node.id)) {
        steps.push({ nodeId: node.id, outcome: "skipped", durationMs: 0 });
        await eventLogger?.emit("node_end", { nodeId: node.id, outcome: "skipped", durationMs: 0 });
        continue;
      }

      // Evaluate `if` condition (simple truthiness / != '' patterns only)
      if (node.if) {
        const configObj = this.config as unknown as Record<string, unknown>;
        const shouldRun = shouldRunNode(node.if, ctx, configObj);
        if (!shouldRun) {
          steps.push({ nodeId: node.id, outcome: "skipped", durationMs: 0 });
          await eventLogger?.emit("node_end", { nodeId: node.id, outcome: "skipped", durationMs: 0 });
          await appendLog(deps.logFile, `\n[pipeline] ${node.id}: skipped (condition: ${node.if})\n`);
          continue;
        }
      }

      await appendLog(deps.logFile, `\n[pipeline] ${node.id}: starting\n`);
      const startTime = Date.now();
      const handler = this.getHandler(node.action);
      const { result, durationMs } = await this.runTrackedNode(
        node.id, node.action, handler, node, ctx, deps, eventLogger
      );
      await appendLog(deps.logFile, `\n[pipeline] ${node.id}: ${result.outcome} (${String(durationMs)}ms)\n`);

      // Write outputs to context bag
      if (result.outputs) {
        ctx.mergeOutputs(result.outputs);

        // Support dynamic node skipping from decision nodes
        const dynamicSkips = result.outputs["_skipNodes"];
        const decisionReason = typeof result.outputs["decisionReason"] === "string"
          ? result.outputs["decisionReason"] as string
          : undefined;
        if (Array.isArray(dynamicSkips)) {
          if (!skipNodeIds) {
            skipNodeIds = new Set<string>();
          }
          const added: string[] = [];
          for (const id of dynamicSkips) {
            if (typeof id === "string") {
              skipNodeIds.add(id);
              added.push(id);
            }
          }
          if (added.length > 0) {
            await eventLogger?.emit("artifact", {
              nodeId: node.id,
              artifact: `dynamic_skip:${node.id}:${added.join(",")}`
            });
            await appendLog(
              deps.logFile,
              `[pipeline] dynamic skip from ${node.id}: ${added.join(", ")}${decisionReason ? ` — ${decisionReason}` : ""}\n`
            );
          }
        }
        if (decisionReason) {
          await eventLogger?.emit("artifact", {
            nodeId: node.id,
            artifact: `decision_reason:${node.id}:${decisionReason.slice(0, 200)}`
          });
        }

        // Support goto/jump — a decision node can send execution to a different node
        // Only process goto on success/soft_fail — never let a failed node bypass failure handling
        const gotoTarget = result.outputs["_goto"];
        if (typeof gotoTarget === "string" && result.outcome !== "failure") {
          const targetIdx = pipeline.nodes.findIndex(n => n.id === gotoTarget);
          if (targetIdx < 0) {
            await appendLog(deps.logFile, `[pipeline] _goto target '${gotoTarget}' not found, ignoring\n`);
          } else {
            gotoCount++;
            if (gotoCount > maxGotos) {
              await appendLog(deps.logFile, `[pipeline] _goto limit exceeded (${String(maxGotos)}), ignoring jump to '${gotoTarget}'\n`);
            } else {
              await appendLog(deps.logFile, `[pipeline] _goto → ${gotoTarget} (jump ${String(gotoCount)}/${String(maxGotos)})\n`);
              await eventLogger?.emit("artifact", {
                nodeId: node.id,
                artifact: `goto:${node.id}:${gotoTarget}:${String(gotoCount)}`
              });
              // Record the step before jumping
              steps.push({ nodeId: node.id, outcome: result.outcome, durationMs });
              i = targetIdx - 1; // -1 because loop will i++
              continue;
            }
          }
        }

      }

      // Handle failure with loop construct
      if (result.outcome === "failure" && node.on_failure) {
        const loopResult = await this.handleLoopFailure(
          node, result, ctx, deps, eventLogger
        );

        if (loopResult.outcome === "success") {
          steps.push({ nodeId: node.id, outcome: "success", durationMs: Date.now() - startTime });
          continue;
        }

        if (loopResult.outcome === "completed_with_warnings") {
          warnings.push(`${node.id}: ${loopResult.warnings.join("; ")}`);
          steps.push({ nodeId: node.id, outcome: "success", durationMs: Date.now() - startTime });
          continue;
        }

        // Loop exhausted and no fallback
        steps.push({
          nodeId: node.id,
          outcome: "failure",
          durationMs: Date.now() - startTime,
          error: result.error ?? "Loop exhausted"
        });
        return { outcome: "failure", steps, warnings };
      }

      // Handle soft_fail
      if (result.outcome === "soft_fail") {
        if (node.on_soft_fail === "fail_run") {
          steps.push({ nodeId: node.id, outcome: "failure", durationMs, error: result.error });
          return { outcome: "failure", steps, warnings };
        }
        warnings.push(`${node.id}: ${result.error ?? "soft fail"}`);
        steps.push({ nodeId: node.id, outcome: "success", durationMs });
        continue;
      }

      // Handle hard failure (no loop construct)
      if (result.outcome === "failure") {
        steps.push({ nodeId: node.id, outcome: "failure", durationMs, error: result.error });
        return { outcome: "failure", steps, warnings };
      }

      steps.push({ nodeId: node.id, outcome: result.outcome, durationMs });

      // Deferred sandbox: after setup_sandbox completes, wrap remaining nodes
      // in sandbox context so shell commands route through the container.
      if (result.outcome === "success" && node.action === "setup_sandbox" && sandboxRef?.handle) {
        const remainingResult = await runInSandboxContext(
          sandboxRef.handle.containerId,
          deps.run.id,
          () => this.executePipeline(
            pipeline, ctx, deps, i + 1,
            eventLogger, skipNodeIds, enableNodeIds, abortSignal
          )
        );
        steps.push(...remainingResult.steps);
        warnings.push(...remainingResult.warnings);
        return { outcome: remainingResult.outcome, steps, warnings };
      }
    }

    const finalOutcome = warnings.length > 0 ? "completed_with_warnings" : "success";
    return { outcome: finalOutcome, steps, warnings };
  }

  /**
   * Handle a loop-based failure recovery (validation retry, CI fix, etc.)
   */
  private async handleLoopFailure(
    failedNode: NodeConfig,
    failedResult: NodeResult,
    ctx: ContextBag,
    deps: NodeDeps,
    eventLogger?: EventLogger
  ): Promise<PipelineResult> {
    const loopConfig = failedNode.on_failure as LoopConfig;
    const resolvedMaxRounds = typeof loopConfig.max_rounds === "string"
      ? Number(ctx.resolve(loopConfig.max_rounds) ?? loopConfig.max_rounds)
      : loopConfig.max_rounds;
    const maxRounds = Number.isFinite(resolvedMaxRounds) && resolvedMaxRounds > 0
      ? resolvedMaxRounds
      : 1;

    const onExhausted = loopConfig.on_exhausted ?? "fail_run";
    const warnings: string[] = [];
    const browserFailureCode = ctx.get<BrowserVerifyFailureCode>("browserVerifyFailureCode");

    // Short-circuit BEFORE handler lookup — bypass doesn't need the agent handler
    if (failedNode.action === "browser_verify" && isNonCodeFixFailure(browserFailureCode)) {
      const warning = `browser_verify loop bypassed for ${browserFailureCode} — not a code-fix-first failure`;
      await appendLog(deps.logFile, `[pipeline] ${warning}\n`);
      await eventLogger?.emit("artifact", {
        nodeId: failedNode.id,
        artifact: `loop_bypassed:${failedNode.id}:${browserFailureCode}`
      });
      if (onExhausted === "complete_with_warning") {
        warnings.push(warning);
        return { outcome: "completed_with_warnings", steps: [], warnings };
      }
      return {
        outcome: "failure",
        steps: [{
          nodeId: failedNode.id,
          outcome: "failure",
          durationMs: 0,
          error: warning
        }],
        warnings
      };
    }

    const agentHandler = this.getHandler(loopConfig.agent_node);

    await appendLog(deps.logFile, `\n[pipeline] entering fix loop for ${failedNode.id} (max ${String(maxRounds)} rounds)\n`);
    await eventLogger?.emit("artifact", {
      nodeId: failedNode.id,
      artifact: `loop_start:${failedNode.id}:${loopConfig.agent_node}:${String(maxRounds)}`
    });

    // Store the last failure's raw output for the fix agent
    if (failedResult.rawOutput) {
      ctx.set("lastFailureRawOutput", failedResult.rawOutput);
    }

    let lastRawOutput = failedResult.rawOutput ?? "";

    for (let attempt = 1; attempt <= maxRounds; attempt++) {
      ctx.set("loopAttempt", attempt);

      // Mode escalation: escalate execution mode before fix agent so it benefits from richer instructions
      const currentMode = (ctx.get<string>("executionMode") ?? "standard") as ExecutionMode;
      const escalated = escalateMode(currentMode, attempt);
      if (escalated !== currentMode) {
        ctx.set("executionMode", escalated);
        await appendLog(deps.logFile, `[pipeline] mode escalated: ${currentMode} → ${escalated} after ${String(attempt)} failure(s)\n`);
        await eventLogger?.emit("artifact", { nodeId: failedNode.id, artifact: `mode_escalated:${currentMode}:${escalated}` });
      }

      // Run the fix agent
      await appendLog(deps.logFile, `\n[pipeline] fix loop attempt ${String(attempt)}/${String(maxRounds)}\n`);
      const fixNode: NodeConfig = {
        id: `${loopConfig.agent_node}_loop_${String(attempt)}`,
        type: "agentic",
        action: loopConfig.agent_node
      };
      const { result: fixResult } = await this.runTrackedNode(
        fixNode.id, fixNode.action, agentHandler, fixNode, ctx, deps, eventLogger
      );

      if (fixResult.outcome !== "success") {
        await appendLog(deps.logFile, `[pipeline] fix agent outcome=${fixResult.outcome} on attempt ${String(attempt)} — skipping retry check\n`);
        await eventLogger?.emit("artifact", { nodeId: failedNode.id, artifact: `loop_fix_failed:${failedNode.id}:${String(attempt)}:${fixResult.outcome}` });
        continue;
      }
      if (fixResult.outputs) ctx.mergeOutputs(fixResult.outputs);

      // Run lint fix after agent fix (skip for fix_ci/fix_browser which commit+push internally)
      if (loopConfig.agent_node !== "fix_ci" && loopConfig.agent_node !== "fix_browser") {
        const lintHandler = NODE_HANDLERS["lint_fix"];
        if (lintHandler && deps.config.lintFixCommand) {
          await lintHandler({ id: "lint_fix_post", type: "deterministic", action: "lint_fix" }, ctx, deps);
        }
      }

      // Re-run the original node to check if fixed
      const retryNodeId = `${failedNode.id}_retry_${String(attempt)}`;
      const retryHandler = this.getHandler(failedNode.action);
      const { result: retryResult } = await this.runTrackedNode(
        retryNodeId, failedNode.action, retryHandler, failedNode, ctx, deps, eventLogger
      );

      if (retryResult.outcome === "success") {
        await appendLog(deps.logFile, `\n[pipeline] fix loop succeeded on attempt ${String(attempt)}\n`);
        await eventLogger?.emit("artifact", { nodeId: failedNode.id, artifact: `loop_success:${failedNode.id}:${String(attempt)}` });
        if (retryResult.outputs) ctx.mergeOutputs(retryResult.outputs);
        return { outcome: "success", steps: [], warnings };
      }

      // Merge retry outputs so next fix attempt sees updated failure context
      if (retryResult.outputs) ctx.mergeOutputs(retryResult.outputs);
      if (retryResult.rawOutput) {
        ctx.set("lastFailureRawOutput", retryResult.rawOutput);
        lastRawOutput = retryResult.rawOutput;
      }

      // Accumulate failure history for browser verify
      if (failedNode.action === "browser_verify") {
        ctx.append("browserVerifyFailureHistory", {
          round: attempt,
          code: ctx.get("browserVerifyFailureCode"),
          verdict: retryResult.outputs?.browserVerifyVerdictReason ?? retryResult.error,
          actionsPath: ctx.get("actionsPath"),
          timestamp: Date.now()
        });
      }

      await eventLogger?.emit("artifact", { nodeId: failedNode.id, artifact: `loop_retry_failed:${failedNode.id}:${String(attempt)}:${retryResult.outcome}` });
    }

    // Loop exhausted — include last validation output for debugging
    const lastOutputSnippet = lastRawOutput.slice(-500);
    const exhaustionError = lastOutputSnippet
      ? `Validation failed after ${String(maxRounds)} retry round(s). Last output:\n${lastOutputSnippet}`
      : `Fix loop exhausted after ${String(maxRounds)} rounds`;

    await appendLog(deps.logFile, `\n[pipeline] fix loop exhausted after ${String(maxRounds)} rounds\n`);
    await eventLogger?.emit("artifact", {
      nodeId: failedNode.id,
      artifact: `loop_exhausted:${failedNode.id}:${String(maxRounds)}`
    });

    if (onExhausted === "complete_with_warning") {
      warnings.push(`${failedNode.id} fix loop exhausted after ${String(maxRounds)} rounds — completing with warning`);
      return { outcome: "completed_with_warnings", steps: [], warnings };
    }

    return {
      outcome: "failure",
      steps: [{
        nodeId: failedNode.id,
        outcome: "failure",
        durationMs: 0,
        error: exhaustionError
      }],
      warnings
    };
  }

  /**
   * Run a node handler wrapped with event tracking (emit + fire for start/end).
   * Returns the result and duration. Catches handler errors into failure results.
   */
  private async runTrackedNode(
    nodeId: string,
    action: string,
    handler: NodeHandler,
    node: NodeConfig,
    ctx: ContextBag,
    deps: NodeDeps,
    eventLogger?: EventLogger
  ): Promise<{ result: NodeResult; durationMs: number }> {
    await eventLogger?.emit("node_start", { nodeId });
    this.fireNodeEvent({ runId: deps.run.id, nodeId, action, type: "start" });
    const start = Date.now();

    let result: NodeResult;
    try {
      result = await handler(node, ctx, deps);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      result = { outcome: "failure", error: message };
    }

    const durationMs = Date.now() - start;
    await eventLogger?.emit("node_end", { nodeId, outcome: result.outcome, durationMs, error: result.error });
    this.fireNodeEvent({
      runId: deps.run.id, nodeId, action,
      type: "end", outcome: result.outcome, durationMs, error: result.error
    });

    return { result, durationMs };
  }

  private getHandler(action: string): NodeHandler {
    const handler = NODE_HANDLERS[action];
    if (!handler) {
      throw new Error(`No handler registered for action: ${action}`);
    }
    return handler;
  }

  /**
   * Build sandbox env, create container, and write pi-agent config.
   * Shared by both upfront and deferred sandbox creation paths.
   */
  private async buildAndCreateSandbox(
    runId: string,
    image: string,
    logFile: string
  ): Promise<SandboxHandle> {
    if (!this.containerManager) {
      throw new Error("Cannot create sandbox: no ContainerManager configured");
    }

    const sandboxEnv: Record<string, string> = {};

    // Pass through agent-relevant env vars
    for (const key of [
      "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY",
      "XAI_API_KEY", "GEMINI_API_KEY",
      "CEMS_API_URL", "CEMS_API_KEY",
      "OPENROUTER_PROVIDER_PREFERENCES"
    ]) {
      if (process.env[key]) {
        sandboxEnv[key] = process.env[key]!;
      }
    }

    // Pass git token for authenticated operations
    const gitToken = await this.githubService?.getToken();
    if (gitToken) {
      sandboxEnv["GIT_TOKEN"] = gitToken;
    }

    const sandbox = await this.containerManager.createSandbox(
      runId,
      {
        image,
        cpus: this.config.sandboxCpus,
        memoryMb: this.config.sandboxMemoryMb,
        env: sandboxEnv,
        networkMode: "bridge"
      },
      this.config.sandboxHostWorkPath
    );

    await appendLog(logFile, `[sandbox] container created: ${sandbox.containerName} (image: ${image})\n`);

    // Write pi-agent models.json with OpenRouter provider routing preferences
    if (this.config.openrouterProviderPreferences) {
      await this.writePiAgentModelsJson(sandbox.containerId, this.config.openrouterProviderPreferences, logFile);
    }

    return sandbox;
  }

  /**
   * Write ~/.pi/agent/models.json inside the sandbox container.
   * Pi-agent auto-discovers this file and applies provider-level compat settings,
   * including openRouterRouting which gets passed as the `provider` field in
   * OpenRouter API requests.
   */
  private async writePiAgentModelsJson(
    containerId: string,
    providerPreferences: Record<string, unknown>,
    logFile: string
  ): Promise<void> {
    if (!this.containerManager) return;

    const modelsJson = JSON.stringify({
      providers: {
        openrouter: {
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "OPENROUTER_API_KEY",
          api: "openai-completions",
          compat: {
            openRouterRouting: providerPreferences
          }
        }
      }
    });

    try {
      await this.containerManager.exec(containerId, `mkdir -p /root/.pi/agent && cat > /root/.pi/agent/models.json << 'PIEOF'\n${modelsJson}\nPIEOF`, {});
      await appendLog(logFile, `[sandbox] wrote pi-agent models.json with provider preferences: ${JSON.stringify(providerPreferences)}\n`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown";
      await appendLog(logFile, `[sandbox] warning: failed to write models.json: ${msg}\n`);
    }
  }
}

/** Aggregate all _tokenUsage_* context bag entries into a single TokenUsage. */
export function aggregateTokenUsage(ctx: ContextBag, defaultModel?: string): TokenUsage | null {
  let gateInput = 0;
  let gateOutput = 0;
  const entries: Array<{ input: number; output: number; model?: string }> = [];

  for (const key of ctx.keys()) {
    if (!key.startsWith("_tokenUsage_")) continue;
    const entry = ctx.get<{ input: number; output: number; model?: string }>(key);
    if (!entry) continue;
    gateInput += entry.input;
    gateOutput += entry.output;
    entries.push(entry);
  }

  // Include pi-agent cost if present (from implement node)
  const agentCost = ctx.get<{ inputTokens: number; outputTokens: number; totalCost: number }>("agentCost");
  const agentIn = agentCost?.inputTokens ?? 0;
  const agentOut = agentCost?.outputTokens ?? 0;
  const agentDollarCost = agentCost?.totalCost ?? 0;

  if (gateInput === 0 && gateOutput === 0 && agentIn === 0) return null;

  // Compute cost from gate token entries using price table
  const gateCostUsd = computeCostUsd(entries, defaultModel);
  const totalCostUsd = gateCostUsd + agentDollarCost;

  return {
    qualityGateInputTokens: gateInput,
    qualityGateOutputTokens: gateOutput,
    ...(agentIn > 0 ? { agentInputTokens: agentIn, agentOutputTokens: agentOut } : {}),
    ...(totalCostUsd > 0 ? { costUsd: Math.round(totalCostUsd * 10000) / 10000 } : {})
  };
}
