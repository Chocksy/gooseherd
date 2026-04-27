import type { NodeHandler } from "../pipeline/types.js";
import type { WebhookAdapter } from "../webhook-adapter-registry.js";

/**
 * A Gooseherd plugin can contribute:
 * - Custom pipeline node handlers (usable in YAML pipelines)
 * - Custom webhook adapters (for receiving external events)
 */
export interface GooseherdPlugin {
  /** Unique plugin name (e.g. "my-company/rubocop-plugin") */
  name: string;
  /** SemVer version string */
  version: string;
  /** Custom node handlers keyed by action name */
  nodeHandlers?: Record<string, NodeHandler>;
  /** Custom webhook adapters */
  webhookAdapters?: WebhookAdapter[];
}
