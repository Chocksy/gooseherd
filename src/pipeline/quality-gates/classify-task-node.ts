import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { classifyTask, classifyExecutionMode } from "./task-classifier.js";

/**
 * Classify task node: determine task type and execution mode from run description.
 * Sets ctx.taskType and ctx.executionMode for downstream nodes.
 */
export async function classifyTaskNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const taskText = deps.run.task;
  const taskType = classifyTask(taskText);
  const executionMode = classifyExecutionMode(taskText);

  ctx.set("taskType", taskType);
  ctx.set("executionMode", executionMode);

  return {
    outcome: "success",
    outputs: { taskType, executionMode }
  };
}
