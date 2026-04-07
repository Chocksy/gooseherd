/**
 * Scenario loader — parse YAML eval scenario files from disk.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { EvalScenario, EvalJudgeConfig } from "./types.js";

/**
 * Load a single scenario from a YAML file path.
 */
export async function loadScenario(filePath: string): Promise<EvalScenario> {
  const raw = await readFile(filePath, "utf8");
  const doc = YAML.parse(raw) as Record<string, unknown>;

  if (!doc.name || typeof doc.name !== "string") {
    throw new Error(`Scenario missing 'name' in ${filePath}`);
  }
  if (!doc.repo || typeof doc.repo !== "string") {
    throw new Error(`Scenario missing 'repo' in ${filePath}`);
  }
  if (!doc.task || typeof doc.task !== "string") {
    throw new Error(`Scenario missing 'task' in ${filePath}`);
  }
  if (!Array.isArray(doc.judges) || doc.judges.length === 0) {
    throw new Error(`Scenario missing 'judges' array in ${filePath}`);
  }

  return {
    name: doc.name,
    description: (doc.description as string) ?? "",
    repo: doc.repo,
    baseBranch: (doc.base_branch as string) ?? "main",
    task: doc.task,
    pipeline: (doc.pipeline as string) ?? undefined,
    enableNodes: Array.isArray(doc.enable_nodes) ? doc.enable_nodes as string[] : undefined,
    skipNodes: Array.isArray(doc.skip_nodes) ? doc.skip_nodes as string[] : undefined,
    judges: doc.judges as EvalJudgeConfig[],
    configOverrides: (doc.config_overrides as Record<string, string>) ?? undefined,
    tags: Array.isArray(doc.tags) ? doc.tags as string[] : undefined,
  };
}

/**
 * Load all .yml/.yaml scenarios from a directory.
 */
export async function loadScenariosFromDir(dirPath: string): Promise<EvalScenario[]> {
  const entries = await readdir(dirPath);
  const yamlFiles = entries
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort();

  const scenarios: EvalScenario[] = [];
  for (const file of yamlFiles) {
    scenarios.push(await loadScenario(path.join(dirPath, file)));
  }
  return scenarios;
}

/**
 * Filter scenarios by tag.
 */
export function filterByTag(scenarios: EvalScenario[], tag: string): EvalScenario[] {
  return scenarios.filter((s) => s.tags?.includes(tag));
}
