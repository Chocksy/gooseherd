import { Octokit } from "@octokit/rest";

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

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
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
    // NOTE: For native GitHub Actions, check_run IDs and job IDs coincide.
    // For third-party CI (CircleCI, etc.), they may differ — callers should
    // resolve the correct job ID if needed. The caller wraps this in try/catch.
    // The download endpoint returns a redirect; octokit follows it automatically
    const response = await this.octokit.actions.downloadJobLogsForWorkflowRun({
      owner,
      repo,
      job_id: jobId
    });
    // Response data is the log text (octokit follows redirect)
    return typeof response.data === "string" ? response.data : String(response.data);
  }
}
