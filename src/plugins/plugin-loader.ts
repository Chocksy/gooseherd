import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { logInfo, logWarn, logError } from "../logger.js";
import type { GooseherdPlugin } from "./plugin-types.js";
import type { NodeHandler } from "../pipeline/types.js";
import { registerAdapter } from "../webhook-adapter-registry.js";

export interface PluginLoadResult {
  loaded: string[];
  failed: string[];
  nodeHandlers: Record<string, NodeHandler>;
  adapterCount: number;
}

/**
 * Load all plugins from the given directory.
 *
 * Each .ts or .js file in the directory should default-export a GooseherdPlugin.
 * Plugins are validated before their contributions are registered.
 */
export async function loadPlugins(pluginDir: string): Promise<PluginLoadResult> {
  const result: PluginLoadResult = {
    loaded: [],
    failed: [],
    nodeHandlers: {},
    adapterCount: 0,
  };

  let entries: string[];
  try {
    const dirStat = await stat(pluginDir);
    if (!dirStat.isDirectory()) return result;
    entries = await readdir(pluginDir);
  } catch {
    // Directory doesn't exist — that's fine, no plugins
    return result;
  }

  const pluginFiles = entries.filter(
    (f) =>
      (f.endsWith(".ts") || f.endsWith(".js")) &&
      !f.endsWith(".d.ts") &&
      !f.endsWith(".test.ts") &&
      !f.startsWith(".")
  );

  for (const file of pluginFiles) {
    const filePath = path.join(pluginDir, file);
    try {
      const mod = await import(filePath);
      const plugin = (mod.default ?? mod) as GooseherdPlugin;

      if (!validatePlugin(plugin, file)) {
        result.failed.push(file);
        continue;
      }

      // Register node handlers
      if (plugin.nodeHandlers) {
        for (const [action, handler] of Object.entries(plugin.nodeHandlers)) {
          if (result.nodeHandlers[action]) {
            logWarn("Plugin node handler collision, skipping", {
              plugin: plugin.name,
              action,
              existingPlugin: "already registered",
            });
            continue;
          }
          result.nodeHandlers[action] = handler;
          logInfo("Plugin: registered node handler", { plugin: plugin.name, action });
        }
      }

      // Register webhook adapters
      if (plugin.webhookAdapters) {
        for (const adapter of plugin.webhookAdapters) {
          registerAdapter(adapter);
          result.adapterCount += 1;
          logInfo("Plugin: registered webhook adapter", {
            plugin: plugin.name,
            source: adapter.source,
          });
        }
      }

      result.loaded.push(plugin.name);
      logInfo("Plugin loaded", { name: plugin.name, version: plugin.version });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      logError("Plugin load failed", { file, error: msg });
      result.failed.push(file);
    }
  }

  return result;
}

function validatePlugin(plugin: unknown, file: string): plugin is GooseherdPlugin {
  if (!plugin || typeof plugin !== "object") {
    logWarn("Plugin validation failed: not an object", { file });
    return false;
  }
  const p = plugin as Record<string, unknown>;
  if (typeof p.name !== "string" || !p.name) {
    logWarn("Plugin validation failed: missing name", { file });
    return false;
  }
  if (typeof p.version !== "string" || !p.version) {
    logWarn("Plugin validation failed: missing version", { file });
    return false;
  }
  if (p.nodeHandlers !== undefined && (typeof p.nodeHandlers !== "object" || p.nodeHandlers === null)) {
    logWarn("Plugin validation failed: nodeHandlers must be an object", {
      file,
      plugin: p.name,
    });
    return false;
  }
  if (p.webhookAdapters !== undefined && !Array.isArray(p.webhookAdapters)) {
    logWarn("Plugin validation failed: webhookAdapters must be an array", {
      file,
      plugin: p.name,
    });
    return false;
  }
  return true;
}

/** Get the default plugin directory path. */
export function getPluginDir(): string {
  return path.resolve("extensions/plugins");
}
