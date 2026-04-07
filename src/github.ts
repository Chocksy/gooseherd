import { readFile } from "node:fs/promises";
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

export interface AccessibleRepository {
  fullName: string;
  private: boolean;
  defaultBranch?: string;
  htmlUrl?: string;
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

  /**
   * Upload a file to the repo via Contents API (creates a commit on the branch).
   * Returns the raw.githubusercontent.com URL for the file.
   */
  async uploadFileToRepo(params: {
    repoSlug: string;
    branch: string;
    filePath: string;
    localPath: string;
    commitMessage: string;
  }): Promise<{ url: string; commitSha: string }> {
    const { owner, repo } = parseRepoSlug(params.repoSlug);
    const content = await readFile(params.localPath);
    const base64Content = content.toString("base64");

    // Check if file already exists (need its SHA to update)
    let existingSha: string | undefined;
    try {
      const existing = await this.octokit.repos.getContent({
        owner,
        repo,
        path: params.filePath,
        ref: params.branch
      });
      if (!Array.isArray(existing.data) && "sha" in existing.data) {
        existingSha = existing.data.sha;
      }
    } catch {
      // File doesn't exist yet — that's fine
    }

    const result = await this.octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: params.filePath,
      message: params.commitMessage,
      content: base64Content,
      branch: params.branch,
      sha: existingSha
    });

    const commitSha = (result.data.commit as { sha?: string })?.sha ?? "";
    // Use commit SHA instead of branch name — branch may be deleted (PR closed/merged),
    // but the commit persists. GitHub's camo proxy handles auth for private repos.
    const ref = commitSha || params.branch;
    const url = `https://github.com/${owner}/${repo}/raw/${ref}/${params.filePath}`;
    return { url, commitSha };
  }

  /**
   * Search code in a repository using the GitHub Code Search API.
   * Returns file paths and matching text fragments (read-only, no cloning).
   */
  async searchCode(
    query: string,
    repoSlug: string,
    maxResults = 10
  ): Promise<Array<{ path: string; textMatches: string[] }>> {
    const response = await this.octokit.search.code({
      q: `${query} repo:${repoSlug}`,
      per_page: maxResults,
      headers: { accept: "application/vnd.github.text-match+json" }
    });

    return response.data.items.map(item => ({
      path: item.path,
      textMatches: ((item as unknown as { text_matches?: Array<{ fragment: string }> }).text_matches ?? [])
        .map(tm => tm.fragment)
    }));
  }

  /**
   * Describe a repository: languages, root file listing, and README snippet.
   * Useful for answering "what tech stack / code type" questions without cloning.
   */
  async describeRepo(
    repoSlug: string
  ): Promise<{ languages: Record<string, number>; files: string[]; readmeSnippet: string }> {
    const { owner, repo } = parseRepoSlug(repoSlug);

    // Fetch languages (GitHub's linguist analysis)
    const langResp = await this.octokit.repos.listLanguages({ owner, repo });
    const languages = langResp.data as Record<string, number>;

    // Fetch root directory listing
    let files: string[] = [];
    try {
      const contentResp = await this.octokit.repos.getContent({ owner, repo, path: "" });
      if (Array.isArray(contentResp.data)) {
        files = contentResp.data.map(f => `${f.name}${f.type === "dir" ? "/" : ""}`);
      }
    } catch {
      // Private repo or permissions issue — files remain empty
    }

    // Fetch README (first 500 chars)
    let readmeSnippet = "";
    try {
      const readmeResp = await this.octokit.repos.getReadme({ owner, repo });
      const content = Buffer.from(
        (readmeResp.data as { content: string }).content,
        "base64"
      ).toString("utf-8");
      readmeSnippet = content.slice(0, 500);
    } catch {
      // No README — that's fine
    }

    return { languages, files, readmeSnippet };
  }

  /**
   * Read a file's content from a repository via the Contents API (no cloning).
   * Returns the UTF-8 decoded content. Throws if path is a directory.
   */
  async readFile(repoSlug: string, path: string, ref?: string): Promise<string> {
    const { owner, repo } = parseRepoSlug(repoSlug);
    const resp = await this.octokit.repos.getContent({
      owner, repo, path,
      ...(ref ? { ref } : {})
    });
    if (Array.isArray(resp.data) || (resp.data as { type: string }).type !== "file") {
      throw new Error(`${path} is a directory, not a file. Use list_files instead.`);
    }
    const content = Buffer.from(
      (resp.data as { content: string }).content,
      "base64"
    ).toString("utf-8");
    // Truncate very large files to avoid blowing token budget
    if (content.length > 15_000) {
      return content.slice(0, 15_000) + "\n\n[...truncated at 15000 chars]";
    }
    return content;
  }

  /**
   * List directory contents from a repository via the Contents API (no cloning).
   * Returns file/dir names with type indicators.
   */
  async listDirectory(
    repoSlug: string,
    path: string,
    ref?: string
  ): Promise<Array<{ name: string; type: string; size: number }>> {
    const { owner, repo } = parseRepoSlug(repoSlug);
    const resp = await this.octokit.repos.getContent({
      owner, repo, path,
      ...(ref ? { ref } : {})
    });
    if (!Array.isArray(resp.data)) {
      throw new Error(`${path} is a file, not a directory. Use read_file instead.`);
    }
    return resp.data.map(f => ({
      name: f.name,
      type: f.type,
      size: (f as { size?: number }).size ?? 0
    }));
  }

  /**
   * Update the body of an existing pull request.
   */
  async updatePullRequestBody(params: {
    repoSlug: string;
    prNumber: number;
    body: string;
  }): Promise<void> {
    const { owner, repo } = parseRepoSlug(params.repoSlug);
    await this.octokit.pulls.update({
      owner,
      repo,
      pull_number: params.prNumber,
      body: params.body
    });
  }

  /**
   * Validate a PAT token — returns the authenticated username.
   * Throws on invalid/expired tokens.
   */
  static async validateToken(token: string): Promise<{ username: string; repoCount: number }> {
    const octokit = new Octokit({ auth: token });
    const { data: user } = await octokit.users.getAuthenticated();
    const { data: repos } = await octokit.repos.listForAuthenticatedUser({ per_page: 1 });
    // total_count not available on list — use the response headers
    const repoCount = repos.length > 0 ? (user.public_repos + (user.total_private_repos ?? 0)) : 0;
    return { username: user.login, repoCount };
  }

  /**
   * List repos accessible with the current credentials.
   */
  async listAccessibleRepos(perPage = 100): Promise<AccessibleRepository[]> {
    if (this.authMode === "app") {
      const { data } = await this.octokit.apps.listReposAccessibleToInstallation({
        per_page: perPage,
      });
      return data.repositories.map((r) => ({
        fullName: r.full_name,
        private: r.private,
        defaultBranch: r.default_branch ?? undefined,
        htmlUrl: r.html_url ?? undefined,
      }));
    }

    const { data } = await this.octokit.repos.listForAuthenticatedUser({
      per_page: perPage,
      sort: "updated",
    });
    return data.map((r) => ({
      fullName: r.full_name,
      private: r.private,
      defaultBranch: r.default_branch ?? undefined,
      htmlUrl: r.html_url ?? undefined,
    }));
  }
}
