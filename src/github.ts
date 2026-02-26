import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import type { AppConfig } from "./config.js";

interface PullRequestParams {
  repoSlug: string;
  title: string;
  body: string;
  head: string;
  base: string;
}

export interface PullRequestResult {
  url: string;
  number: number;
}

export interface CICheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}

export interface CICheckAnnotation {
  path: string;
  start_line: number;
  message: string;
  annotation_level: string;
}

export function parseRepoSlug(repoSlug: string): { owner: string; repo: string } {
  const [owner, repo] = repoSlug.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repo slug: ${repoSlug}`);
  }
  return { owner, repo };
}

export function buildAuthenticatedGitUrl(repoSlug: string, token: string): string {
  const encodedToken = encodeURIComponent(token);
  return `https://x-access-token:${encodedToken}@github.com/${repoSlug}.git`;
}

export class GitHubService {
  private readonly octokit: Octokit;
  private readonly authMode: "pat" | "app";
  private readonly patToken?: string;

  private constructor(octokit: Octokit, authMode: "pat" | "app", patToken?: string) {
    this.octokit = octokit;
    this.authMode = authMode;
    this.patToken = patToken;
  }

  /**
   * Factory: creates a GitHubService from config.
   * Returns undefined if no GitHub auth is configured.
   */
  static create(config: AppConfig): GitHubService | undefined {
    if (config.githubAppId && config.githubAppPrivateKey && config.githubAppInstallationId) {
      const octokit = new Octokit({
        authStrategy: createAppAuth,
        auth: {
          appId: config.githubAppId,
          privateKey: config.githubAppPrivateKey,
          installationId: config.githubAppInstallationId
        }
      });
      return new GitHubService(octokit, "app");
    }

    if (config.githubToken) {
      const octokit = new Octokit({ auth: config.githubToken });
      return new GitHubService(octokit, "pat", config.githubToken);
    }

    return undefined;
  }

  /**
   * Returns a token string usable for git operations (clone URLs, Bearer headers).
   * PAT mode: returns the stored token.
   * App mode: requests/refreshes an installation token via @octokit/auth-app.
   */
  async getToken(): Promise<string> {
    if (this.authMode === "pat" && this.patToken) {
      return this.patToken;
    }

    // App auth: octokit.auth() returns an installation token
    const auth = (await this.octokit.auth({ type: "installation" })) as { token: string };
    return auth.token;
  }

  async createPullRequest(params: PullRequestParams): Promise<PullRequestResult> {
    const { owner, repo } = parseRepoSlug(params.repoSlug);
    const response = await this.octokit.pulls.create({
      owner,
      repo,
      title: params.title,
      body: params.body,
      head: params.head,
      base: params.base
    });

    return { url: response.data.html_url, number: response.data.number };
  }

  async findOrCreatePullRequest(params: PullRequestParams): Promise<PullRequestResult> {
    const { owner, repo } = parseRepoSlug(params.repoSlug);

    // Check if a PR already exists for this head branch
    const existing = await this.octokit.pulls.list({
      owner,
      repo,
      head: `${owner}:${params.head}`,
      state: "open"
    });

    if (existing.data.length > 0) {
      const pr = existing.data[0];
      // Update the existing PR title and body with latest run info
      await this.octokit.pulls.update({
        owner,
        repo,
        pull_number: pr.number,
        title: params.title,
        body: params.body
      });
      return { url: pr.html_url, number: pr.number };
    }

    return this.createPullRequest(params);
  }

  async listCheckRuns(owner: string, repo: string, ref: string): Promise<CICheckRun[]> {
    const response = await this.octokit.checks.listForRef({
      owner,
      repo,
      ref
    });
    return response.data.check_runs.map(cr => ({
      id: cr.id,
      name: cr.name,
      status: cr.status,
      conclusion: cr.conclusion
    }));
  }

  async getCheckAnnotations(owner: string, repo: string, checkRunId: number): Promise<CICheckAnnotation[]> {
    const response = await this.octokit.checks.listAnnotations({
      owner,
      repo,
      check_run_id: checkRunId
    });
    return response.data.map(a => ({
      path: a.path,
      start_line: a.start_line,
      message: a.message ?? "",
      annotation_level: a.annotation_level ?? "warning"
    }));
  }

  async downloadJobLog(owner: string, repo: string, jobId: number): Promise<string> {
    const response = await this.octokit.actions.downloadJobLogsForWorkflowRun({
      owner,
      repo,
      job_id: jobId
    });
    return typeof response.data === "string" ? response.data : String(response.data);
  }

  async listDeployments(
    owner: string,
    repo: string,
    ref: string
  ): Promise<Array<{ id: number; environment: string; created_at: string }>> {
    const response = await this.octokit.repos.listDeployments({
      owner,
      repo,
      ref,
      per_page: 20
    });
    return response.data.map(d => ({
      id: d.id,
      environment: d.environment,
      created_at: d.created_at
    }));
  }

  async listDeploymentStatuses(
    owner: string,
    repo: string,
    deploymentId: number
  ): Promise<Array<{ state: string; environment_url?: string }>> {
    const response = await this.octokit.repos.listDeploymentStatuses({
      owner,
      repo,
      deployment_id: deploymentId,
      per_page: 5
    });
    return response.data.map(s => ({
      state: s.state,
      environment_url: s.environment_url || undefined
    }));
  }
}
