/**
 * Deploy Preview node — resolve a preview URL for the PR branch.
 *
 * Exactly ONE strategy is configured per pipeline YAML (no fallback chain):
 *
 * - **url_pattern**: Construct URL from template using PR number, branch,
 *   or repo slug (e.g. `https://{{prNumber}}.stg.epicpxls.com`).
 * - **github_deployment_api**: Poll GitHub deployment statuses for
 *   environment_url matching a pattern (Vercel, Netlify, Hubstaff review).
 * - **command**: Run a shell command and extract URL from stdout.
 *
 * Once a URL is obtained, polls it until it responds with any HTTP status.
 * Sets `reviewAppUrl` in context for downstream `browser_verify` node.
 */

import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { runShellCapture, appendLog } from "../shell.js";
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

  // shared
  readiness_timeout_seconds?: number;
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

  const readinessTimeout = (nc.readiness_timeout_seconds ?? 300) * 1000;
  const readinessInterval = Math.max((nc.readiness_poll_interval_seconds ?? 10), 1) * 1000;

  let previewUrl: string | undefined;

  switch (nc.strategy) {
    case "url_pattern":
      previewUrl = await resolveUrlPattern(nc, ctx, deps, logFile);
      break;

    case "github_deployment_api":
      previewUrl = await resolveGithubDeployment(nc, ctx, deps, readinessTimeout, logFile);
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
  if (readinessTimeout > 0) {
    await appendLog(logFile, `[deploy_preview] waiting for ${previewUrl} to be ready...\n`);
    const ready = await waitForUrlReady(previewUrl, readinessTimeout, readinessInterval, logFile);

    if (!ready) {
      return {
        outcome: "soft_fail",
        error: `Preview URL never became ready within ${String(Math.floor(readinessTimeout / 1000))}s: ${previewUrl}`
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
  const pattern = nc.url_pattern;
  if (!pattern) {
    await appendLog(logFile, "[deploy_preview] strategy 'url_pattern' requires 'url_pattern' in config\n");
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
  const branchName = ctx.get<string>("branchName") ?? deps.run.branchName;

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
    const deployments = await deps.githubService.listDeployments(owner, repo, branchName);
    const matching = deployments
      .filter((d: DeploymentInfo) => envRegex.test(d.environment))
      .sort((a: DeploymentInfo, b: DeploymentInfo) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    for (const deployment of matching) {
      const statuses = await deps.githubService.listDeploymentStatuses(owner, repo, deployment.id);
      const latest = statuses[0] as DeploymentStatus | undefined;
      if (latest?.state === "success" && latest.environment_url) {
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

async function waitForUrlReady(
  url: string,
  timeoutMs: number,
  intervalMs: number,
  logFile: string
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(10_000),
        redirect: "follow"
      });
      await appendLog(logFile, `[deploy_preview] URL ready: HTTP ${String(response.status)}\n`);
      return true;
    } catch {
      // Network error or timeout — URL not yet reachable
    }

    await sleep(intervalMs);
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
