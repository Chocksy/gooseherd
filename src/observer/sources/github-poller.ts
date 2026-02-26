/**
 * GitHub Actions Poller — polls GitHub API for failed workflow runs.
 *
 * Converts failed workflow runs into TriggerEvents for the observer safety pipeline.
 * Follows the same pattern as sentry-poller.ts.
 */

import { randomUUID } from "node:crypto";
import { logError, logInfo } from "../../logger.js";
import { parseRepoSlug } from "../../github.js";
import type { TriggerEvent } from "../types.js";
import type { ObserverStateStore } from "../state-store.js";

export interface GitHubPollerConfig {
  githubToken: string;
  watchedRepos: string[];
  pollIntervalSeconds: number;
  alertChannelId: string;
}

interface WorkflowRun {
  id: number;
  name: string;
  head_branch: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  repository: {
    full_name: string;
  };
}

interface WorkflowRunsResponse {
  total_count: number;
  workflow_runs: WorkflowRun[];
}

const GITHUB_API_BASE = "https://api.github.com";

/**
 * Poll GitHub for failed workflow runs across configured repos.
 *
 * Returns TriggerEvents for workflow runs not yet seen (based on state store cursor).
 */
export async function pollGitHub(
  config: GitHubPollerConfig,
  stateStore: ObserverStateStore
): Promise<TriggerEvent[]> {
  const events: TriggerEvent[] = [];

  for (const repoSlug of config.watchedRepos) {
    try {
      const newEvents = await pollRepo(config, repoSlug, stateStore);
      events.push(...newEvents);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      logError("GitHub poll failed for repo", { repo: repoSlug, error: msg });
    }
  }

  return events;
}

async function pollRepo(
  config: GitHubPollerConfig,
  repoSlug: string,
  stateStore: ObserverStateStore
): Promise<TriggerEvent[]> {
  const { owner, repo } = parseRepoSlug(repoSlug);
  const lastRunId = stateStore.getGithubLastRunId(repoSlug);

  const runs = await fetchFailedRuns(config.githubToken, owner, repo);
  if (runs.length === 0) return [];

  // Filter to only runs newer than our cursor
  const newRuns = lastRunId
    ? runs.filter(r => r.id > lastRunId)
    : runs;

  if (newRuns.length === 0) return [];

  logInfo("GitHub: new failed runs found", { repo: repoSlug, count: newRuns.length });

  // Update cursor to highest run ID
  const maxRunId = Math.max(...newRuns.map(r => r.id));
  stateStore.setGithubLastRunId(repoSlug, maxRunId);

  return newRuns.map(run => ({
    id: `gh-actions-${String(run.id)}-${randomUUID().slice(0, 8)}`,
    source: "github_webhook" as const,
    timestamp: run.updated_at,
    repoSlug,
    baseBranch: run.head_branch,
    suggestedTask: buildFailedRunTask(run),
    priority: "high" as const,
    rawPayload: {
      eventType: "workflow_run_failure",
      repo: repoSlug,
      runId: run.id,
      name: run.name,
      branch: run.head_branch,
      sha: run.head_sha,
      conclusion: run.conclusion,
      url: run.html_url
    },
    notificationTarget: {
      type: "slack" as const,
      channelId: config.alertChannelId
    }
  }));
}

async function fetchFailedRuns(
  token: string,
  owner: string,
  repo: string
): Promise<WorkflowRun[]> {
  // Fetch recent failed workflow runs (last 10, sorted by most recent)
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/actions/runs?status=failure&per_page=10`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    signal: AbortSignal.timeout(15_000)
  });

  if (!response.ok) {
    throw new Error(`GitHub API ${String(response.status)}: ${response.statusText}`);
  }

  const data = (await response.json()) as WorkflowRunsResponse;
  return data.workflow_runs;
}

function buildFailedRunTask(run: WorkflowRun): string {
  const lines: string[] = [];
  lines.push(`Fix failed GitHub Actions workflow: ${run.name}`);
  lines.push(`Branch: ${run.head_branch}`);
  lines.push(`Conclusion: ${run.conclusion ?? "unknown"}`);
  lines.push(`\nWorkflow run: ${run.html_url}`);
  return lines.join("\n");
}
