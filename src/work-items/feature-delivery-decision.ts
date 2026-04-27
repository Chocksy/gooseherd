import type { FeatureDeliveryDecision } from "./feature-delivery-reducer.js";
import type { WorkItemRecord } from "./types.js";
import { WorkItemStore } from "./store.js";

export async function applyWorkItemDecision(
  workItems: WorkItemStore,
  workItem: WorkItemRecord,
  decision: FeatureDeliveryDecision,
): Promise<WorkItemRecord> {
  let current = workItem;

  for (const patch of decision.patches) {
    current = await workItems.updateState(current.id, patch);
  }

  return current;
}
