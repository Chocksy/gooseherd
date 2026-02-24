import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";

/**
 * Notify node: placeholder for future Slack/webhook notification.
 * Currently a no-op — notification is handled by RunManager's Slack card system.
 */
export async function notifyNode(
  _nodeConfig: NodeConfig,
  _ctx: ContextBag,
  _deps: NodeDeps
): Promise<NodeResult> {
  // Notification is handled externally by RunManager's postOrUpdateRunCard.
  // This node exists as a pipeline slot for future custom notifications.
  return { outcome: "success" };
}
