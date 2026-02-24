/**
 * Trigger rules: load YAML rules, match events against rules.
 *
 * Follows the same pattern as pipeline-loader.ts.
 */

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { TriggerEvent, TriggerRule, TriggerSource, RuleCondition, ConditionOperator } from "./types.js";

const VALID_SOURCES = new Set<string>(["sentry_alert", "github_webhook", "slack_observer"]);
const VALID_OPERATORS = new Set<string>(["equals", "contains", "matches", "exists"]);

export class TriggerRulesLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriggerRulesLoadError";
  }
}

/**
 * Load and validate trigger rules from a YAML file.
 */
export async function loadTriggerRules(yamlPath: string): Promise<TriggerRule[]> {
  let raw: string;
  try {
    raw = await readFile(yamlPath, "utf8");
  } catch {
    // No rules file — return empty (observer runs with no rules = no auto triggers)
    return [];
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    throw new TriggerRulesLoadError(`Invalid YAML in trigger rules: ${msg}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new TriggerRulesLoadError("Trigger rules file must be a YAML object");
  }

  const config = parsed as Record<string, unknown>;
  const rawRules = config["trigger_rules"];

  if (!Array.isArray(rawRules)) {
    throw new TriggerRulesLoadError("trigger_rules must be an array");
  }

  const rules: TriggerRule[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < rawRules.length; i++) {
    const raw = rawRules[i] as Record<string, unknown>;
    const label = `rule[${String(i)}]`;

    // Validate id
    if (typeof raw["id"] !== "string" || !raw["id"].trim()) {
      throw new TriggerRulesLoadError(`${label}: must have a string 'id'`);
    }
    if (seenIds.has(raw["id"])) {
      throw new TriggerRulesLoadError(`${label}: duplicate rule id '${raw["id"]}'`);
    }
    seenIds.add(raw["id"]);

    // Validate source
    if (typeof raw["source"] !== "string" || !VALID_SOURCES.has(raw["source"])) {
      throw new TriggerRulesLoadError(`${label} (${raw["id"]}): source must be one of: ${Array.from(VALID_SOURCES).join(", ")}`);
    }

    // Validate conditions
    const conditions: RuleCondition[] = [];
    if (raw["conditions"]) {
      if (!Array.isArray(raw["conditions"])) {
        throw new TriggerRulesLoadError(`${label} (${raw["id"]}): conditions must be an array`);
      }
      for (const cond of raw["conditions"] as Record<string, unknown>[]) {
        if (typeof cond["field"] !== "string") {
          throw new TriggerRulesLoadError(`${label} (${raw["id"]}): condition.field must be a string`);
        }
        if (typeof cond["operator"] !== "string" || !VALID_OPERATORS.has(cond["operator"])) {
          throw new TriggerRulesLoadError(`${label} (${raw["id"]}): condition.operator must be one of: ${Array.from(VALID_OPERATORS).join(", ")}`);
        }
        conditions.push({
          field: cond["field"],
          operator: cond["operator"] as ConditionOperator,
          value: cond["value"] !== undefined ? String(cond["value"]) : undefined
        });
      }
    }

    rules.push({
      id: raw["id"],
      source: raw["source"] as TriggerSource,
      conditions,
      pipeline: typeof raw["pipeline"] === "string" ? raw["pipeline"] : undefined,
      requiresApproval: raw["requiresApproval"] === true,
      notificationChannel: typeof raw["notificationChannel"] === "string" ? raw["notificationChannel"] : undefined,
      cooldownMinutes: typeof raw["cooldownMinutes"] === "number" ? raw["cooldownMinutes"] : 60,
      maxRunsPerHour: typeof raw["maxRunsPerHour"] === "number" ? raw["maxRunsPerHour"] : 5,
      repoSlug: typeof raw["repoSlug"] === "string" ? raw["repoSlug"] : undefined,
      task: typeof raw["task"] === "string" ? raw["task"] : undefined,
      baseBranch: typeof raw["baseBranch"] === "string" ? raw["baseBranch"] : undefined
    });
  }

  return rules;
}

/**
 * Find the first trigger rule that matches a TriggerEvent.
 *
 * Returns null if no rule matches.
 */
export function matchTriggerRule(event: TriggerEvent, rules: TriggerRule[]): TriggerRule | null {
  for (const rule of rules) {
    if (rule.source !== event.source) continue;

    // Check all conditions
    const allMatch = rule.conditions.every(cond => evaluateCondition(event, cond));
    if (allMatch) return rule;
  }
  return null;
}

/**
 * Evaluate a single condition against a TriggerEvent.
 *
 * Uses dot-path access for nested fields (e.g., "rawPayload.data.event.level").
 */
export function evaluateCondition(event: TriggerEvent, condition: RuleCondition): boolean {
  const fieldValue = resolveFieldPath(event, condition.field);

  switch (condition.operator) {
    case "exists":
      return fieldValue !== undefined && fieldValue !== null;

    case "equals":
      return String(fieldValue) === condition.value;

    case "contains":
      return typeof fieldValue === "string" && condition.value !== undefined
        && fieldValue.includes(condition.value);

    case "matches": {
      if (typeof fieldValue !== "string" || !condition.value) return false;
      try {
        return new RegExp(condition.value).test(fieldValue);
      } catch {
        return false;
      }
    }

    default:
      return false;
  }
}

/**
 * Resolve a dot-separated field path against an object.
 * e.g., "rawPayload.data.level" → event.rawPayload.data.level
 */
function resolveFieldPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}
