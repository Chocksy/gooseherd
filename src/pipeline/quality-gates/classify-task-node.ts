import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { classifyTask } from "./task-classifier.js";

/**
 * Classify task node: determine task type from run description.
 * Sets ctx.taskType for use by downstream gates (diff size, etc.).
 */
export async function classifyTaskNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const taskText = deps.run.task;
  const taskType = classifyTask(taskText);

  ctx.set("taskType", taskType);

  return {
    outcome: "success",
    outputs: { taskType }
  };
}
