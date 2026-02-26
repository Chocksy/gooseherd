/**
 * Notify node — send external notifications when a pipeline run completes.
 *
 * Supports webhook POST to a configured URL. Skips if no webhook is configured
 * (preserving backward compatibility — RunManager handles Slack notifications).
 *
 * Configure via pipeline YAML:
 *   - id: notify
 *     type: deterministic
 *     action: notify
 *     config:
 *       webhook_url: https://example.com/hook
 *       webhook_headers:
 *         Authorization: "Bearer token"
 */

import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { appendLog } from "../shell.js";
import { logInfo } from "../../logger.js";

interface WebhookConfig {
  webhook_url?: string;
  webhook_headers?: Record<string, string>;
}

export async function notifyNode(
  nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const nc = (nodeConfig.config ?? {}) as WebhookConfig;
  const logFile = deps.logFile;

  if (!nc.webhook_url) {
    return { outcome: "skipped" };
  }

  // Validate URL scheme
  if (!nc.webhook_url.startsWith("https://") && !nc.webhook_url.startsWith("http://")) {
    await appendLog(logFile, "\n[pipeline] notify: skipped (invalid webhook URL scheme)\n");
    return { outcome: "skipped" };
  }

  const run = deps.run;
  const payload = {
    event: "pipeline_completed",
    run_id: run.id,
    repo_slug: run.repoSlug,
    task: run.task,
    status: run.status,
    branch_name: run.branchName,
    pr_url: ctx.get<string>("prUrl"),
    commit_sha: ctx.get<string>("commitSha"),
    changed_files: ctx.get<string[]>("changedFiles"),
    gate_report: ctx.get<unknown>("gateReport"),
    timestamp: new Date().toISOString()
  };

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": `${deps.config.appName}/1.0`,
      ...nc.webhook_headers
    };

    const response = await fetch(nc.webhook_url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000)
    });

    await appendLog(logFile, `\n[pipeline] notify: webhook ${String(response.status)} → ${nc.webhook_url}\n`);

    if (!response.ok) {
      logInfo("notify: webhook returned non-2xx", {
        status: response.status,
        url: nc.webhook_url
      });
      return {
        outcome: "soft_fail",
        error: `Webhook returned HTTP ${String(response.status)}`
      };
    }

    logInfo("notify: webhook delivered", { url: nc.webhook_url, status: response.status });
    return { outcome: "success" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    await appendLog(logFile, `\n[pipeline] notify: webhook failed — ${msg}\n`);
    return {
      outcome: "soft_fail",
      error: `Webhook delivery failed: ${msg}`
    };
  }
}
