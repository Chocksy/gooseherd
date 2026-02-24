import path from "node:path";
import { access, mkdir, writeFile } from "node:fs/promises";
import type {
  PipelineConfig,
  NodeConfig,
  NodeHandler,
  NodeResult,
  NodeDeps,
  PipelineResult,
  PipelineStepResult,
  LoopConfig
} from "./types.js";
import type { ExecutionResult, RunRecord } from "../types.js";
import type { AppConfig } from "../config.js";
import type { GitHubService } from "../github.js";
import type { RunLifecycleHooks } from "../hooks/run-lifecycle.js";
import { ContextBag } from "./context-bag.js";
import { evaluateExpression } from "./expression-evaluator.js";
import { loadPipeline } from "./pipeline-loader.js";
import { appendLog } from "./shell.js";
import { logInfo, logError } from "../logger.js";

// Node handler imports
import { cloneNode } from "./nodes/clone.js";
import { hydrateContextNode } from "./nodes/hydrate-context.js";
import { implementNode } from "./nodes/implement.js";
import { lintFixNode } from "./nodes/lint-fix.js";
import { validateNode } from "./nodes/validate.js";
import { fixValidationNode } from "./nodes/fix-validation.js";
import { commitNode } from "./nodes/commit.js";
import { pushNode } from "./nodes/push.js";
import { createPrNode } from "./nodes/create-pr.js";
import { notifyNode } from "./nodes/notify.js";

// Quality gate node imports
import { classifyTaskNode } from "./quality-gates/classify-task-node.js";
import { diffGateNode } from "./quality-gates/diff-gate-node.js";
import { forbiddenFilesNode } from "./quality-gates/forbidden-files-node.js";
import { securityScanNode } from "./quality-gates/security-scan-node.js";
import { scopeJudgeNode } from "./quality-gates/scope-judge-node.js";
import { browserVerifyNode } from "./quality-gates/browser-verify-node.js";

// CI feedback node imports
import { waitCiNode } from "./ci/wait-ci-node.js";
import { fixCiNode } from "./ci/fix-ci-node.js";

// ── Node handler registry ──

const NODE_HANDLERS: Record<string, NodeHandler> = {
  clone: cloneNode,
  hydrate_context: hydrateContextNode,
  implement: implementNode,
  lint_fix: lintFixNode,
  validate: validateNode,
  fix_validation: fixValidationNode,
  commit: commitNode,
  push: pushNode,
  create_pr: createPrNode,
  notify: notifyNode,
  classify_task: classifyTaskNode,
  diff_gate: diffGateNode,
  forbidden_files: forbiddenFilesNode,
  security_scan: securityScanNode,
  wait_ci: waitCiNode,
  fix_ci: fixCiNode,
  scope_judge: scopeJudgeNode,
  browser_verify: browserVerifyNode
};

export type PipelinePhase = "cloning" | "agent" | "validating" | "pushing" | "awaiting_ci" | "ci_fixing";

/**
 * Pipeline engine: loads YAML pipeline, executes nodes in order,
 * checkpoints context between nodes, handles loop constructs.
 */
export class PipelineEngine {
  constructor(
    private readonly config: AppConfig,
    private readonly githubService?: GitHubService,
    private readonly hooks?: RunLifecycleHooks
  ) {}

  /**
   * Execute a pipeline for a run.
   */
  async execute(
    run: RunRecord,
    onPhase: (phase: PipelinePhase) => Promise<void>,
    pipelineFile?: string
  ): Promise<ExecutionResult> {
    const yamlPath = pipelineFile ?? path.resolve("pipelines/default.yml");
    const pipeline = await loadPipeline(yamlPath);

    logInfo("Pipeline loaded", { name: pipeline.name, nodes: pipeline.nodes.length });

    const runDir = path.resolve(this.config.workRoot, run.id);
    const logFile = path.join(runDir, "run.log");
    const checkpointDir = path.join(runDir, "checkpoints");

    // Ensure run directory + log file exist before pipeline starts
    // (the clone node will rm + recreate, but we need the dir for pre-node logging)
    await mkdir(runDir, { recursive: true });
    await appendLog(logFile, `${this.config.appName} pipeline started for ${run.id}\n`);

    // Initialize context bag
    const ctx = new ContextBag({
      runId: run.id,
      repoSlug: run.repoSlug,
      baseBranch: run.baseBranch,
      branchName: run.branchName,
      task: run.task,
      requestedBy: run.requestedBy
    });
    ctx.setCheckpointDir(checkpointDir);

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
        await onPhase(phase as PipelinePhase);
      }
    };

    // Try to resume from checkpoint
    const checkpoint = await ContextBag.resume(checkpointDir);
    let startIndex = 0;
    if (checkpoint) {
      const lastNodeIndex = pipeline.nodes.findIndex(n => n.id === checkpoint.lastCompletedNodeId);
      if (lastNodeIndex >= 0) {
        startIndex = lastNodeIndex + 1;
        // Restore context from checkpoint
        const resumedData = checkpoint.ctx.toObject();
        for (const [key, value] of Object.entries(resumedData)) {
          ctx.set(key, value);
        }
        logInfo("Resumed from checkpoint", { lastNode: checkpoint.lastCompletedNodeId, nextIndex: startIndex });
      }
    }

    const result = await this.executePipeline(pipeline, ctx, deps, startIndex);

    // Build ExecutionResult from context bag
    const branchName = run.branchName;
    const commitSha = ctx.get<string>("commitSha") ?? "";
    const changedFiles = ctx.get<string[]>("changedFiles") ?? [];
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
      prUrl
    };
  }

  private async executePipeline(
    pipeline: PipelineConfig,
    ctx: ContextBag,
    deps: NodeDeps,
    startIndex: number,
    pipelineSwitched = false
  ): Promise<PipelineResult> {
    const steps: PipelineStepResult[] = [];
    const warnings: string[] = [];

    for (let i = startIndex; i < pipeline.nodes.length; i++) {
      const node = pipeline.nodes[i] as NodeConfig;

      // Check enabled flag
      if (node.enabled === false) {
        steps.push({ nodeId: node.id, outcome: "skipped", durationMs: 0 });
        continue;
      }

      // Evaluate `if` condition
      if (node.if) {
        const configObj = this.config as unknown as Record<string, unknown>;
        const shouldRun = evaluateExpression(node.if, (varName: string) => {
          return ctx.resolve(varName, configObj);
        });
        if (!shouldRun) {
          steps.push({ nodeId: node.id, outcome: "skipped", durationMs: 0 });
          await appendLog(deps.logFile, `\n[pipeline] ${node.id}: skipped (condition: ${node.if})\n`);
          continue;
        }
      }

      await appendLog(deps.logFile, `\n[pipeline] ${node.id}: starting\n`);
      const startTime = Date.now();

      // Execute the node
      const handler = this.getHandler(node.action);
      let result: NodeResult;

      try {
        result = await handler(node, ctx, deps);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        result = { outcome: "failure", error: message };
      }

      const durationMs = Date.now() - startTime;
      await appendLog(deps.logFile, `\n[pipeline] ${node.id}: ${result.outcome} (${String(durationMs)}ms)\n`);

      // Write outputs to context bag
      if (result.outputs) {
        ctx.mergeOutputs(result.outputs);
      }

      // Handle failure with loop construct
      if (result.outcome === "failure" && node.on_failure) {
        const loopResult = await this.handleLoopFailure(
          node, result, ctx, deps, pipeline
        );

        if (loopResult.outcome === "success") {
          steps.push({ nodeId: node.id, outcome: "success", durationMs: Date.now() - startTime });
          await ctx.checkpoint(node.id);
          continue;
        }

        if (loopResult.outcome === "completed_with_warnings") {
          warnings.push(`${node.id}: ${loopResult.warnings.join("; ")}`);
          steps.push({ nodeId: node.id, outcome: "success", durationMs: Date.now() - startTime });
          await ctx.checkpoint(node.id);
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
        await ctx.checkpoint(node.id);
        continue;
      }

      // Handle hard failure (no loop construct)
      if (result.outcome === "failure") {
        steps.push({ nodeId: node.id, outcome: "failure", durationMs, error: result.error });
        return { outcome: "failure", steps, warnings };
      }

      steps.push({ nodeId: node.id, outcome: result.outcome, durationMs });

      // Checkpoint after each successful node
      if (result.outcome === "success") {
        await ctx.checkpoint(node.id);

        // Check for per-repo pipeline override (set by clone → applyRepoConfig)
        if (!pipelineSwitched) {
          const override = ctx.get<string>("repoConfigPipeline");
          if (override) {
            const newPipeline = await this.tryLoadPipelineOverride(override, deps.logFile);
            if (newPipeline) {
              const currentIdx = newPipeline.nodes.findIndex(n => n.id === node.id);
              if (currentIdx >= 0) {
                const tailResult = await this.executePipeline(newPipeline, ctx, deps, currentIdx + 1, true);
                steps.push(...tailResult.steps);
                warnings.push(...tailResult.warnings);
                return { outcome: tailResult.outcome, steps, warnings };
              }
              await appendLog(deps.logFile, `[pipeline] override '${override}' does not contain node '${node.id}', ignoring\n`);
            }
          }
        }
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
    pipeline: PipelineConfig
  ): Promise<PipelineResult> {
    const loopConfig = failedNode.on_failure as LoopConfig;
    const maxRounds = typeof loopConfig.max_rounds === "string"
      ? Number(ctx.resolve(loopConfig.max_rounds) ?? loopConfig.max_rounds)
      : loopConfig.max_rounds;

    const agentHandler = this.getHandler(loopConfig.agent_node);
    const onExhausted = loopConfig.on_exhausted ?? "fail_run";
    const warnings: string[] = [];

    await appendLog(deps.logFile, `\n[pipeline] entering fix loop for ${failedNode.id} (max ${String(maxRounds)} rounds)\n`);

    // Store the last failure's raw output for the fix agent
    if (failedResult.rawOutput) {
      ctx.set("lastFailureRawOutput", failedResult.rawOutput);
    }

    let lastRawOutput = failedResult.rawOutput ?? "";

    for (let attempt = 1; attempt <= maxRounds; attempt++) {
      ctx.set("loopAttempt", attempt);

      // Run the fix agent
      await appendLog(deps.logFile, `\n[pipeline] fix loop attempt ${String(attempt)}/${String(maxRounds)}\n`);
      const fixNode: NodeConfig = {
        id: `${loopConfig.agent_node}_loop_${String(attempt)}`,
        type: "agentic",
        action: loopConfig.agent_node
      };

      try {
        await agentHandler(fixNode, ctx, deps);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        await appendLog(deps.logFile, `\n[pipeline] fix agent failed: ${message}\n`);
        continue;
      }

      // Run lint fix after agent fix (lint only runs after agent changes)
      // Skip for fix_ci which already commits+pushes internally
      if (loopConfig.agent_node !== "fix_ci") {
        const lintHandler = NODE_HANDLERS["lint_fix"];
        if (lintHandler && deps.config.lintFixCommand) {
          const lintNode: NodeConfig = { id: "lint_fix_post", type: "deterministic", action: "lint_fix" };
          await lintHandler(lintNode, ctx, deps);
        }
      }

      // Re-run the original node to check if fixed
      const retryHandler = this.getHandler(failedNode.action);
      let retryResult: NodeResult;
      try {
        retryResult = await retryHandler(failedNode, ctx, deps);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        retryResult = { outcome: "failure", error: message };
      }

      if (retryResult.outcome === "success") {
        await appendLog(deps.logFile, `\n[pipeline] fix loop succeeded on attempt ${String(attempt)}\n`);
        if (retryResult.outputs) {
          ctx.mergeOutputs(retryResult.outputs);
        }
        return { outcome: "success", steps: [], warnings };
      }

      // Store updated failure output for next fix attempt
      if (retryResult.rawOutput) {
        ctx.set("lastFailureRawOutput", retryResult.rawOutput);
        lastRawOutput = retryResult.rawOutput;
      }
    }

    // Loop exhausted — include last validation output for debugging
    const lastOutputSnippet = lastRawOutput.slice(-500);
    const exhaustionError = lastOutputSnippet
      ? `Validation failed after ${String(maxRounds)} retry round(s). Last output:\n${lastOutputSnippet}`
      : `Fix loop exhausted after ${String(maxRounds)} rounds`;

    await appendLog(deps.logFile, `\n[pipeline] fix loop exhausted after ${String(maxRounds)} rounds\n`);

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

  private async tryLoadPipelineOverride(name: string, logFile: string): Promise<PipelineConfig | undefined> {
    // Validate: alphanumeric, hyphens, underscores only
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      await appendLog(logFile, `[pipeline] invalid override name '${name}', must be alphanumeric/hyphens/underscores\n`);
      return undefined;
    }

    const yamlPath = path.resolve("pipelines", `${name}.yml`);
    try {
      await access(yamlPath);
    } catch {
      await appendLog(logFile, `[pipeline] override pipeline not found: ${yamlPath}\n`);
      return undefined;
    }

    try {
      const pipeline = await loadPipeline(yamlPath);
      logInfo("Pipeline override loaded", { name, nodes: pipeline.nodes.length });
      await appendLog(logFile, `[pipeline] switched to override pipeline '${name}' (${String(pipeline.nodes.length)} nodes)\n`);
      return pipeline;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown";
      await appendLog(logFile, `[pipeline] failed to load override pipeline '${name}': ${msg}\n`);
      return undefined;
    }
  }

  private getHandler(action: string): NodeHandler {
    const handler = NODE_HANDLERS[action];
    if (!handler) {
      throw new Error(`No handler registered for action: ${action}`);
    }
    return handler;
  }
}
