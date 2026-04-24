/**
 * Deploy Preview node — resolve a preview URL for the PR branch.
 *
 * Exactly ONE strategy is configured per pipeline YAML (no fallback chain):
 *
 * - **url_pattern**: Construct URL from template using PR number, branch,
 *   or repo slug (e.g. `https://{{prNumber}}.stg.example.com`).
 * - **github_deployment_api**: Poll GitHub deployment statuses for
 *   environment_url matching a pattern (Vercel, Netlify, review apps).
 * - **command**: Run a shell command and extract URL from stdout.
 *
 * Once a URL is obtained, polls it until it responds with any HTTP status.
 * Sets `reviewAppUrl` in context for downstream `browser_verify` node.
 */

import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { runShellCapture, appendLog, sleep } from "../shell.js";
import { parseRepoSlug } from "../../github.js";

type Strategy = "url_pattern" | "github_deployment_api" | "command";

interface DeployPreviewConfig {
  strategy?: Strategy;

  // url_pattern
  url_pattern?: string;

  // github_deployment_api
  github_environment_pattern?: string;

  // command
  command?: string;
  url_extract_pattern?: string;
  url_extract_strategy?: "last" | "first";

  // shared — timeout config
  /** Expected build time in seconds (default 300). Polling continues beyond this if the server signals activity (503). */
  readiness_timeout_seconds?: number;
  /** Absolute maximum wait in seconds (default 1800 = 30 min). Hard cutoff regardless of signals. */
  max_timeout_seconds?: number;
  /** Initial poll interval in seconds (default 5). Increases via exponential backoff up to 30s. */
  readiness_poll_interval_seconds?: number;
}

export async function deployPreviewNode(
  nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const nc = (nodeConfig.config ?? {}) as DeployPreviewConfig;
  const logFile = deps.logFile;

  if (!nc.strategy) {
    return {
      outcome: "soft_fail",
      error: "deploy_preview: 'strategy' is required in node config. Valid: url_pattern, github_deployment_api, command"
    };
  }

  const expectedTimeoutMs = (nc.readiness_timeout_seconds ?? 300) * 1000;
  const maxTimeoutMs = (nc.max_timeout_seconds ?? 1800) * 1000;
  const initialIntervalMs = Math.max((nc.readiness_poll_interval_seconds ?? 5), 1) * 1000;

  let previewUrl: string | undefined;

  switch (nc.strategy) {
    case "url_pattern":
      previewUrl = await resolveUrlPattern(nc, ctx, deps, logFile);
      break;

    case "github_deployment_api":
      previewUrl = await resolveGithubDeployment(nc, ctx, deps, maxTimeoutMs, logFile);
      break;

    case "command":
      previewUrl = await resolveCommand(nc, ctx, deps, logFile);
      break;

    default:
      return {
        outcome: "soft_fail",
        error: `deploy_preview: unknown strategy '${String(nc.strategy)}'. Valid: url_pattern, github_deployment_api, command`
      };
  }

  if (!previewUrl) {
    await appendLog(logFile, `[deploy_preview] strategy '${nc.strategy}' did not produce a URL\n`);
    return { outcome: "soft_fail", error: `Strategy '${nc.strategy}' could not determine preview URL` };
  }

  if (!previewUrl.startsWith("https://") && !previewUrl.startsWith("http://")) {
    return { outcome: "soft_fail", error: `Invalid preview URL scheme: ${previewUrl}` };
  }

  // Set URL in context immediately so browser_verify can use it even if readiness fails
  ctx.set("reviewAppUrl", previewUrl);

  // Wait for URL to be reachable (skip when timeout is 0)
  if (expectedTimeoutMs > 0) {
    await appendLog(logFile, `[deploy_preview] waiting for ${previewUrl} (expected: ${String(Math.floor(expectedTimeoutMs / 1000))}s, max: ${String(Math.floor(maxTimeoutMs / 1000))}s)\n`);
    const result = await waitForUrlReady(previewUrl, expectedTimeoutMs, maxTimeoutMs, initialIntervalMs, logFile);

    if (!result.ready) {
      return {
        outcome: "soft_fail",
        error: `Preview URL not ready after ${String(Math.floor(result.elapsedMs / 1000))}s (last: ${result.lastStatus}): ${previewUrl}`
      };
    }
  }

  await appendLog(logFile, `[deploy_preview] preview ready: ${previewUrl}\n`);

  return {
    outcome: "success",
    outputs: { previewUrl }
  };
}

// ── Strategy: url_pattern ──

async function resolveUrlPattern(
  nc: DeployPreviewConfig,
  ctx: ContextBag,
  deps: NodeDeps,
  logFile: string
): Promise<string | undefined> {
  const pattern = nc.url_pattern || deps.config.reviewAppUrlPattern;
  if (!pattern) {
    await appendLog(logFile, "[deploy_preview] strategy 'url_pattern' requires 'url_pattern' in YAML config or REVIEW_APP_URL_PATTERN env var\n");
    return undefined;
  }

  const prNumber = String(ctx.get<number>("prNumber") ?? ctx.get<string>("prNumber") ?? "");
  const branchName = ctx.get<string>("branchName") ?? deps.run.branchName;
  const repoSlug = deps.run.repoSlug;

  const url = pattern
    .replace(/\{\{prNumber\}\}/g, prNumber)
    .replace(/\{\{branchName\}\}/g, branchName)
    .replace(/\{\{repoSlug\}\}/g, repoSlug);

  // Detect unresolved or empty template variables (e.g. prNumber not set → "https://.stg.example.com")
  if (/\/\/\./.test(url) || /\{\{/.test(url)) {
    await appendLog(logFile, `[deploy_preview] url_pattern produced invalid URL (empty or unresolved variable): ${url}\n`);
    return undefined;
  }

  await appendLog(logFile, `[deploy_preview] constructed URL from pattern: ${url}\n`);
  return url;
}

// ── Strategy: github_deployment_api ──

interface DeploymentInfo {
  id: number;
  environment: string;
  created_at: string;
}

interface DeploymentStatus {
  state: string;
  environment_url?: string;
}

async function resolveGithubDeployment(
  nc: DeployPreviewConfig,
  ctx: ContextBag,
  deps: NodeDeps,
  maxWaitMs: number,
  logFile: string
): Promise<string | undefined> {
  if (!nc.github_environment_pattern) {
    await appendLog(logFile, "[deploy_preview] strategy 'github_deployment_api' requires 'github_environment_pattern' in config\n");
    return undefined;
  }

  if (!deps.githubService) {
    await appendLog(logFile, "[deploy_preview] github_deployment_api requires GitHub service (no token configured)\n");
    return undefined;
  }

  const { owner, repo } = parseRepoSlug(deps.run.repoSlug);
  const prNumber = String(ctx.get<number>("prNumber") ?? ctx.get<string>("prNumber") ?? "");

  let envRegex: RegExp;
  try {
    envRegex = new RegExp(nc.github_environment_pattern, "i");
  } catch (e) {
    await appendLog(logFile, `[deploy_preview] invalid regex in github_environment_pattern: ${String(e)}\n`);
    return undefined;
  }

  const pollInterval = 15_000;
  const deadline = Date.now() + maxWaitMs;

  await appendLog(logFile, `[deploy_preview] polling GitHub deployments for environment matching '${nc.github_environment_pattern}'...\n`);

  while (Date.now() < deadline) {
    const deployments = await deps.githubService.listDeployments(owner, repo);
    const matching = deployments
      .filter((d: DeploymentInfo) => envRegex.test(d.environment))
      .sort((a: DeploymentInfo, b: DeploymentInfo) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    for (const deployment of matching) {
      const statuses = await deps.githubService.listDeploymentStatuses(owner, repo, deployment.id);
      const latest = statuses[0] as DeploymentStatus | undefined;
      if (latest?.state === "success" && latest.environment_url) {
        if (prNumber && !urlMatchesPrNumber(latest.environment_url, prNumber)) {
          await appendLog(logFile, `[deploy_preview] deployment ${String(deployment.id)} URL does not match PR ${prNumber}, skipping\n`);
          continue;
        }
        return latest.environment_url;
      }
      if (latest?.state === "failure" || latest?.state === "error") {
        await appendLog(logFile, `[deploy_preview] deployment ${String(deployment.id)} failed, skipping\n`);
        continue;
      }
    }

    await appendLog(logFile, "[deploy_preview] no ready deployment yet, waiting...\n");
    await sleep(pollInterval);
  }

  return undefined;
}

function urlMatchesPrNumber(url: string, prNumber: string): boolean {
  const escaped = prNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[./-])${escaped}(?:$|[./-])`).test(url);
}

// ── Strategy: command ──

async function resolveCommand(
  nc: DeployPreviewConfig,
  ctx: ContextBag,
  deps: NodeDeps,
  logFile: string
): Promise<string | undefined> {
  if (!nc.command) {
    await appendLog(logFile, "[deploy_preview] strategy 'command' requires 'command' in config\n");
    return undefined;
  }

  const repoDir = ctx.get<string>("repoDir");
  await appendLog(logFile, `\n[deploy_preview] running command: ${nc.command}\n`);
  await deps.onPhase("deploying");

  const result = await runShellCapture(nc.command, {
    cwd: repoDir ?? deps.workRoot,
    logFile,
    timeoutMs: 600_000
  });

  if (result.code !== 0) {
    await appendLog(logFile, `[deploy_preview] command failed (exit ${String(result.code)})\n`);
    return undefined;
  }

  const extractPattern = nc.url_extract_pattern ?? "https?://\\S+";
  const strategy = nc.url_extract_strategy ?? "last";
  const url = extractUrlFromOutput(result.stdout, extractPattern, strategy);

  if (url) {
    await appendLog(logFile, `[deploy_preview] extracted URL from command: ${url}\n`);
  } else {
    await appendLog(logFile, "[deploy_preview] no URL found in command output\n");
  }

  return url;
}

// ── Helpers ──

function extractUrlFromOutput(
  stdout: string,
  pattern: string,
  strategy: "last" | "first"
): string | undefined {
  const lines = stdout.split("\n").filter(l => l.trim().length > 0);

  let urlRegex: RegExp;
  try {
    urlRegex = new RegExp(pattern);
  } catch {
    return undefined;
  }

  if (strategy === "last") {
    for (let i = lines.length - 1; i >= 0; i--) {
      const match = urlRegex.exec(lines[i]!.trim());
      if (match) return match[0];
    }
  } else {
    for (const line of lines) {
      const match = urlRegex.exec(line.trim());
      if (match) return match[0];
    }
  }
  return undefined;
}

interface ReadinessResult {
  ready: boolean;
  elapsedMs: number;
  lastStatus: string;
}

/**
 * Wait for a URL to become reachable with smart timeout behavior:
 * - Exponential backoff: starts at initialIntervalMs, doubles up to 30s
 * - 503 awareness: if the proxy returns 503 (e.g. Traefik waiting for backend),
 *   the system knows the domain is configured — keeps waiting beyond expectedTimeoutMs
 * - Dual timeout: expectedTimeoutMs is the normal cutoff; maxTimeoutMs is the hard limit.
 *   Polling continues past expectedTimeoutMs only if we've seen signs of activity (503, DNS resolves).
 */
async function waitForUrlReady(
  url: string,
  expectedTimeoutMs: number,
  maxTimeoutMs: number,
  initialIntervalMs: number,
  logFile: string
): Promise<ReadinessResult> {
  const startTime = Date.now();
  const expectedDeadline = startTime + expectedTimeoutMs;
  const hardDeadline = startTime + maxTimeoutMs;
  let intervalMs = initialIntervalMs;
  const maxIntervalMs = 30_000;

  let sawActivitySignal = false;
  let lastStatus = "no response";
  let pollCount = 0;

  while (Date.now() < hardDeadline) {
    pollCount++;
    const elapsed = Date.now() - startTime;

    // Past expected timeout — only continue if we saw activity signals
    if (Date.now() > expectedDeadline && !sawActivitySignal) {
      await appendLog(logFile, `[deploy_preview] expected timeout reached (${String(Math.floor(elapsed / 1000))}s), no activity signals — giving up\n`);
      return { ready: false, elapsedMs: elapsed, lastStatus };
    }

    try {
      const response = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(10_000),
        redirect: "follow"
      });

      const status = response.status;
      lastStatus = `HTTP ${String(status)}`;

      // Drain response body to free the underlying socket
      await response.body?.cancel();

      // 503 = proxy knows the domain but backend isn't ready yet (Traefik, nginx, etc.)
      // This is a strong signal that a build is in progress
      if (status === 503 || status === 502) {
        sawActivitySignal = true;
        if (pollCount % 4 === 0) {
          await appendLog(logFile, `[deploy_preview] ${lastStatus} — backend still building (${String(Math.floor(elapsed / 1000))}s elapsed)\n`);
        }
      } else if (status >= 200 && status < 500) {
        // Any non-5xx success means the app is up
        await appendLog(logFile, `[deploy_preview] URL ready: ${lastStatus} after ${String(Math.floor(elapsed / 1000))}s\n`);
        return { ready: true, elapsedMs: elapsed, lastStatus };
      } else {
        // Other 5xx errors — still a sign the proxy/server exists
        sawActivitySignal = true;
        if (pollCount % 4 === 0) {
          await appendLog(logFile, `[deploy_preview] ${lastStatus} — server error, retrying (${String(Math.floor(elapsed / 1000))}s)\n`);
        }
      }
    } catch {
      // Network error / DNS failure / timeout — no activity signal
      lastStatus = "network error";
    }

    await sleep(intervalMs);
    // Exponential backoff: double interval, cap at maxIntervalMs
    intervalMs = Math.min(intervalMs * 2, maxIntervalMs);
  }

  return { ready: false, elapsedMs: Date.now() - startTime, lastStatus };
}
