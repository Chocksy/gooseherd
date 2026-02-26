import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { PipelineConfig, NodeConfig } from "./types.js";

// Only actions with registered handlers are valid.
const VALID_ACTIONS = new Set([
  "clone", "hydrate_context", "implement", "lint_fix",
  "validate", "fix_validation", "commit", "push",
  "create_pr", "notify",
  "classify_task", "plan_task", "local_test",
  "diff_gate", "forbidden_files", "security_scan",
  "wait_ci", "fix_ci",
  "scope_judge", "deploy_preview", "browser_verify"
]);

const VALID_TYPES = new Set(["deterministic", "agentic", "conditional", "async"]);

export class PipelineLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineLoadError";
  }
}

/**
 * Load and validate a pipeline YAML file.
 */
export async function loadPipeline(yamlPath: string): Promise<PipelineConfig> {
  let raw: string;
  try {
    raw = await readFile(yamlPath, "utf8");
  } catch {
    throw new PipelineLoadError(`Pipeline file not found: ${yamlPath}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    throw new PipelineLoadError(`Invalid YAML in pipeline file: ${msg}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new PipelineLoadError("Pipeline file must be a YAML object");
  }

  const config = parsed as Record<string, unknown>;

  // Validate version
  if (config["version"] !== 1) {
    throw new PipelineLoadError(`Unsupported pipeline version: ${String(config["version"])}. Only version 1 is supported.`);
  }

  // Validate name
  if (typeof config["name"] !== "string" || !config["name"].trim()) {
    throw new PipelineLoadError("Pipeline must have a 'name' field");
  }

  // Validate nodes
  if (!Array.isArray(config["nodes"]) || config["nodes"].length === 0) {
    throw new PipelineLoadError("Pipeline must have at least one node");
  }

  const nodes = config["nodes"] as Record<string, unknown>[];
  const seenIds = new Set<string>();

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as Record<string, unknown>;
    const label = `node[${String(i)}]`;

    if (typeof node["id"] !== "string" || !node["id"].trim()) {
      throw new PipelineLoadError(`${label}: must have a string 'id' field`);
    }
    if (seenIds.has(node["id"])) {
      throw new PipelineLoadError(`${label}: duplicate node id '${node["id"]}'`);
    }
    seenIds.add(node["id"]);

    if (typeof node["type"] !== "string" || !VALID_TYPES.has(node["type"])) {
      throw new PipelineLoadError(`${label} (${node["id"]}): type must be one of: ${Array.from(VALID_TYPES).join(", ")}`);
    }

    if (typeof node["action"] !== "string" || !VALID_ACTIONS.has(node["action"])) {
      throw new PipelineLoadError(`${label} (${node["id"]}): unknown action '${String(node["action"])}'. Valid: ${Array.from(VALID_ACTIONS).join(", ")}`);
    }

    // Validate on_soft_fail if present
    if (node["on_soft_fail"] !== undefined) {
      const validSoftFail = ["warn", "fail_run"];
      if (!validSoftFail.includes(node["on_soft_fail"] as string)) {
        throw new PipelineLoadError(`${label} (${node["id"]}): on_soft_fail must be one of: ${validSoftFail.join(", ")}`);
      }
    }

    // Validate on_failure if present
    if (node["on_failure"]) {
      const onFailure = node["on_failure"] as Record<string, unknown>;
      if (onFailure["action"] !== "loop") {
        throw new PipelineLoadError(`${label} (${node["id"]}): on_failure.action must be 'loop'`);
      }
      if (typeof onFailure["agent_node"] !== "string") {
        throw new PipelineLoadError(`${label} (${node["id"]}): on_failure.agent_node must be a string`);
      }
      if (!onFailure["max_rounds"]) {
        throw new PipelineLoadError(`${label} (${node["id"]}): on_failure.max_rounds is required`);
      }
    }
  }

  // Validate on_failure agent_node references are registered action names.
  // The engine resolves agent_node via the handler registry (by action name),
  // so only action names are valid here — not node IDs.
  for (const node of nodes) {
    const onFailure = (node as Record<string, unknown>)["on_failure"] as Record<string, unknown> | undefined;
    if (onFailure) {
      const agentAction = onFailure["agent_node"] as string;
      if (!VALID_ACTIONS.has(agentAction)) {
        throw new PipelineLoadError(`Node '${(node as Record<string, unknown>)["id"]}': on_failure.agent_node '${agentAction}' must be a registered action name. Valid: ${Array.from(VALID_ACTIONS).join(", ")}`);
      }
    }
  }

  return {
    version: config["version"] as number,
    name: config["name"] as string,
    description: config["description"] as string | undefined,
    context: config["context"] as Record<string, unknown> | undefined,
    nodes: nodes as unknown as NodeConfig[]
  };
}
