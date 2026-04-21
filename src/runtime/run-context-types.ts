export interface RunPrefetchMeta {
  fetchedAt: string;
  sources: Array<"github_pr" | "github_ci" | "jira">;
}

export interface RunPrefetchContext {
  meta: RunPrefetchMeta;
  workItem: {
    id: string;
    title: string;
    workflow: string;
    state?: string;
    isAdoptedPr?: boolean;
    flags?: string[];
    jiraIssueKey?: string;
    githubPrUrl?: string;
    githubPrNumber?: number;
  };
  github?: {
    discussionCommentsTotalCount?: number;
    reviewsTotalCount?: number;
    reviewCommentsTotalCount?: number;
    pr: {
      number: number;
      url: string;
      title: string;
      body: string;
      state: string;
      baseRef?: string;
      headRef?: string;
      headSha?: string;
      authorLogin?: string;
    };
    discussionComments: Array<{
      id: string;
      authorLogin?: string;
      createdAt?: string;
      body: string;
      url?: string;
    }>;
    reviews: Array<{
      id: string;
      authorLogin?: string;
      createdAt?: string;
      state?: string;
      body: string;
      url?: string;
    }>;
    reviewComments: Array<{
      id: string;
      authorLogin?: string;
      createdAt?: string;
      body: string;
      path?: string;
      line?: number;
      side?: string;
      url?: string;
      threadResolved: false;
    }>;
    ci: {
      headSha?: string;
      conclusion: "success" | "failure" | "pending" | "no_ci";
      failedRuns?: Array<{
        id: number;
        name: string;
        status: string;
        conclusion: string | null;
        detailsUrl?: string;
        startedAt?: string;
        completedAt?: string;
      }>;
      primaryFailedRun?: {
        id: number;
        name: string;
        status: string;
        conclusion: string | null;
        detailsUrl?: string;
        startedAt?: string;
        completedAt?: string;
      };
      failedAnnotations?: Array<{
        checkRunName: string;
        path: string;
        line: number;
        message: string;
        level: string;
      }>;
      failedAnnotationsTotalCount?: number;
      failedLogTail?: string;
    };
  };
  jira?: {
    commentsTotalCount?: number;
    issue: {
      key: string;
      url?: string;
      summary?: string;
      status?: string;
      description: string;
    };
    comments: Array<{
      id: string;
      authorDisplayName?: string;
      createdAt?: string;
      body: string;
    }>;
  };
}
