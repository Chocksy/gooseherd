import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import type { RunRecord } from "../../types.js";
import type { RunPrefetchContext } from "../../runtime/run-context-types.js";
import { runShellCapture, shellEscape } from "../shell.js";

/**
 * Hydrate context node: build prompt file with run context and instructions.
 */
export async function hydrateContextNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const run = deps.run;
  const repoDir = ctx.getRequired<string>("repoDir");
  const promptFile = ctx.getRequired<string>("promptFile");
  const isFollowUp = ctx.get<boolean>("isFollowUp") ?? false;
  const prefetchContext = getPrefetchContext(run, ctx);

  // Enrich prompt with org memories via lifecycle hooks
  const hookSections = deps.hooks ? await deps.hooks.onPromptEnrich(run) : [];

  // Build parent context for prompt
  let parentContext: { parentRunId: string; parentBranchName: string; parentChangedFiles?: string[]; parentCommitSha?: string; feedbackNote?: string } | undefined;
  if (isFollowUp && run.parentRunId && run.parentBranchName) {
    parentContext = {
      parentRunId: run.parentRunId,
      parentBranchName: run.parentBranchName,
      parentChangedFiles: run.changedFiles,
      parentCommitSha: run.commitSha,
      feedbackNote: run.feedbackNote
    };
  }

  // Build the prompt sections
  const sections: string[] = [
    `Run ID: ${run.id}`,
    `Repository: ${run.repoSlug}`,
    `Base branch: ${run.baseBranch}`,
    ""
  ];

  if (hookSections.length > 0) {
    sections.push(...hookSections);
  }

  if (parentContext) {
    sections.push(
      "## Previous Run Context",
      `This is a follow-up to run ${parentContext.parentRunId.slice(0, 8)}.`,
      `Branch: ${parentContext.parentBranchName} (you are continuing on this branch — your previous changes are already committed)`,
      ""
    );
    if (parentContext.feedbackNote) {
      sections.push(`Engineer's feedback: ${parentContext.feedbackNote}`, "");
    }
    if (parentContext.parentChangedFiles && parentContext.parentChangedFiles.length > 0) {
      sections.push(`Files changed in previous run: ${parentContext.parentChangedFiles.join(", ")}`, "");
    }

    // Inject actual diff content from previous run's commit
    const diffContent = await getParentDiff(repoDir, deps.logFile);
    if (diffContent) {
      sections.push("### Changes from previous run", "```diff", diffContent, "```", "");
    }

    sections.push("---", "");
  }

  const taskType = ctx.get<string>("taskType") ?? "chore";

  // Project profile — institutional knowledge from .gooseherd-profile.md
  const repoProfile = ctx.get<string>("repoProfile");
  if (repoProfile) {
    sections.push("## Project Profile", "", repoProfile, "");
  }

  // Build repo summary for codebase awareness
  const repoSummary = await buildRepoSummary(repoDir, deps.logFile, run.task);
  if (repoSummary) {
    sections.push("## Repository Context", "", repoSummary, "");
  }

  const prefetchSections = prefetchContext ? buildPrefetchedContextSections(prefetchContext) : [];
  if (prefetchSections.length > 0) {
    sections.push(...prefetchSections, "");
  }
  const currentBranchDiff = await getCurrentBranchDiff(
    repoDir,
    deps.logFile,
    ctx.get<string>("resolvedBaseBranch") ?? run.baseBranch
  );
  if (currentBranchDiff) {
    sections.push("### Current Branch Diff", "", "```diff", currentBranchDiff, "```", "");
  }

  const implementationPlan = ctx.get<string>("implementationPlan");

  const executionMode = ctx.get<string>("executionMode") ?? "standard";
  const externalContextInstructions = getExternalContextInstructions(prefetchContext);
  const autoReviewSummaryInstructions = getAutoReviewSummaryInstructions(run);

  sections.push(
    "## Instructions",
    `Execution mode: ${executionMode}`,
    "",
    ...getModeInstructions(executionMode),
    isFollowUp ? "- This is a follow-up run. Only address the feedback — do not refactor unrelated code." : "",
    "",
    `Task type: ${taskType}`,
    "",
    ...externalContextInstructions,
    ...(externalContextInstructions.length > 0 ? [""] : []),
    ...autoReviewSummaryInstructions,
    ...(autoReviewSummaryInstructions.length > 0 ? [""] : []),
    "Task:",
    parentContext?.feedbackNote ?? run.task,
    "",
    ...getExpectedOutput(taskType)
  );

  if (implementationPlan) {
    sections.push("", "## Implementation Plan", "", implementationPlan);
  }

  await writeFile(promptFile, sections.join("\n"), "utf8");

  // Write dynamic AGENTS.md into the cloned repo for pi-agent auto-discovery.
  // Pi-agent automatically finds and injects AGENTS.md into its system prompt.
  const agentsMd = buildAgentsMd(run, ctx, hookSections, repoSummary);
  await writeFile(path.join(repoDir, "AGENTS.md"), agentsMd, "utf8");

  return { outcome: "success" };
}

// ── Repo summary builder ──

const EXCLUDED_DIRS = ["node_modules", ".git", "vendor", "dist", "build", "__pycache__", ".venv", ".next", ".turbo", "coverage"];
const EXCLUDE_ARGS = EXCLUDED_DIRS.map(d => `-not -path '*/${d}/*'`).join(" ");

const TECH_STACK_FILES: Record<string, string> = {
  "package.json": "Node.js",
  "Gemfile": "Ruby",
  "requirements.txt": "Python",
  "pyproject.toml": "Python",
  "Cargo.toml": "Rust",
  "go.mod": "Go",
  "tsconfig.json": "TypeScript",
  "docker-compose.yml": "Docker Compose",
  "Dockerfile": "Docker",
  ".github/workflows": "GitHub Actions CI",
};

const CONVENTION_FILES = [
  ".eslintrc*", ".prettierrc*", "rubocop.yml", ".rubocop.yml",
  "ruff.toml", ".editorconfig", "biome.json", ".stylelintrc*",
];

export async function buildRepoSummary(repoDir: string, logFile: string, taskText?: string): Promise<string | undefined> {
  try {
    const uiHeavyTask = isUiHeavyTask(taskText ?? "");
    const treeCap = uiHeavyTask ? 70 : 40;
    const readmeLineCap = uiHeavyTask ? 80 : 30;
    const readmeCharCap = uiHeavyTask ? 1600 : 700;

    const parts: string[] = [];

    // 1. Directory tree (maxdepth 2, adaptive cap)
    const treeResult = await runShellCapture(
      `find . -maxdepth 2 -type d ${EXCLUDE_ARGS} | head -${String(treeCap)}`,
      { cwd: repoDir, logFile }
    );
    if (treeResult.code === 0 && treeResult.stdout.trim()) {
      parts.push("### Directory structure", "```", treeResult.stdout.trim(), "```");
    }

    // 2. Tech stack detection (using fs.access — avoids login-shell output pollution)
    const detected: string[] = [];
    for (const [file, tech] of Object.entries(TECH_STACK_FILES)) {
      try {
        await access(path.join(repoDir, file));
        detected.push(tech);
      } catch {
        // file doesn't exist — skip
      }
    }
    if (detected.length > 0) {
      parts.push(`### Tech stack: ${[...new Set(detected)].join(", ")}`);
    }

    // 3. README excerpt (adaptive cap by task type)
    try {
      const readmeContent = await readFile(path.join(repoDir, "README.md"), "utf8");
      const excerpt = readmeContent.split("\n").slice(0, readmeLineCap).join("\n").slice(0, readmeCharCap);
      if (excerpt.trim()) {
        parts.push("### README excerpt", excerpt.trim());
      }
    } catch {
      // No README — skip
    }

    // 4. Convention files
    const conventionResult = await runShellCapture(
      `ls -1 ${CONVENTION_FILES.join(" ")} 2>/dev/null || true`,
      { cwd: repoDir, logFile }
    );
    const conventions = conventionResult.stdout.trim();
    if (conventions) {
      parts.push(`### Conventions: ${conventions.split("\n").join(", ")}`);
    }

    return parts.length > 0 ? parts.join("\n") : undefined;
  } catch {
    return undefined;
  }
}

// ── Task-type prompt templates ──

const TASK_TYPE_INSTRUCTIONS: Record<string, string[]> = {
  bugfix: [
    "Expected output:",
    "- Identify the root cause before writing any fix.",
    "- Make a surgical, minimal fix — do not refactor surrounding code.",
    "- Add a regression test that would have caught this bug.",
    "- Preserve all non-buggy behavior and existing tests.",
  ],
  feature: [
    "Expected output:",
    "- Follow the existing architecture and patterns in the codebase.",
    "- Add tests for the new functionality.",
    "- Keep scope tight — implement exactly what was requested, nothing more.",
    "- Preserve existing style and conventions.",
  ],
  refactor: [
    "Expected output:",
    "- Preserve ALL existing behavior — no functional changes.",
    "- Ensure all existing tests continue to pass.",
    "- Update all references and call sites affected by the refactor.",
    "- Keep changes minimal and focused on the refactoring goal.",
  ],
  chore: [
    "Expected output:",
    "- Implement the requested changes.",
    "- Keep changes minimal and deterministic.",
    "- Preserve existing style and architecture.",
    "- If tests are configured, satisfy them before finishing.",
  ],
};

export function getExpectedOutput(taskType: string): string[] {
  return TASK_TYPE_INSTRUCTIONS[taskType] ?? TASK_TYPE_INSTRUCTIONS["chore"]!;
}

// ── Execution mode instructions ──

const MODE_INSTRUCTIONS: Record<string, string[]> = {
  simple: [
    "- Keep changes minimal and deterministic",
    "- Single-pass fix — do not over-explore",
    "- Preserve existing style and architecture",
  ],
  standard: [
    "- Keep changes minimal and deterministic",
    "- Preserve existing style and architecture",
    "- If tests are configured, satisfy them before finishing",
  ],
  research: [
    "- Explore the codebase thoroughly before making changes",
    "- Read related files and understand the full call chain",
    "- Consider edge cases and architectural implications",
    "- Preserve existing style and architecture",
    "- If tests are configured, satisfy them before finishing",
    "- Document non-obvious decisions with brief comments",
  ],
};

export function getModeInstructions(mode: string): string[] {
  return MODE_INSTRUCTIONS[mode] ?? MODE_INSTRUCTIONS["standard"]!;
}

// ── Prefetched context rendering ──

function getPrefetchContext(run: RunRecord, ctx: ContextBag): RunPrefetchContext | undefined {
  return ctx.get<RunPrefetchContext>("prefetchContext") ?? run.prefetchContext;
}

function buildPrefetchedContextSections(prefetchContext: RunPrefetchContext): string[] {
  const parts: string[] = ["## Prefetched Context"];

  appendPrefetchedSection(parts, "Work Item Context", formatWorkItemContext(prefetchContext));
  appendPrefetchedSection(parts, "PR Description", formatBodySection(prefetchContext.github?.pr.body));
  appendPrefetchedSection(
    parts,
    "PR Discussion Comments",
    formatDiscussionComments(
      prefetchContext.github?.discussionComments,
      prefetchContext.github?.discussionCommentsTotalCount
    )
  );
  appendPrefetchedSection(
    parts,
    "PR Review Summaries",
    formatReviewSummaries(prefetchContext.github?.reviews, prefetchContext.github?.reviewsTotalCount)
  );
  appendPrefetchedSection(
    parts,
    "PR Unresolved Inline Review Comments",
    formatInlineReviewComments(
      prefetchContext.github?.reviewComments,
      prefetchContext.github?.reviewCommentsTotalCount
    )
  );
  appendPrefetchedSection(parts, "CI Snapshot", formatCiSnapshot(prefetchContext.github?.ci));
  appendPrefetchedSection(parts, "Jira Description", formatBodySection(prefetchContext.jira?.issue.description));
  appendPrefetchedSection(
    parts,
    "Jira Comments",
    formatJiraComments(prefetchContext.jira?.comments, prefetchContext.jira?.commentsTotalCount)
  );

  return parts;
}

function appendPrefetchedSection(parts: string[], title: string, lines: string[]): void {
  if (lines.length === 0) {
    return;
  }
  parts.push(`### ${title}`, "", ...lines, "");
}

function formatWorkItemContext(prefetchContext: RunPrefetchContext): string[] {
  const lines = [
    `- Work Item ID: ${prefetchContext.workItem.id}`,
    `- Title: ${prefetchContext.workItem.title}`,
    `- Workflow: ${prefetchContext.workItem.workflow}`,
  ];

  if (prefetchContext.workItem.state) {
    lines.push(`- State: ${prefetchContext.workItem.state}`);
  }
  if (prefetchContext.workItem.jiraIssueKey) {
    lines.push(`- Jira Issue: ${prefetchContext.workItem.jiraIssueKey}`);
  }
  if (prefetchContext.workItem.githubPrUrl) {
    lines.push(`- PR URL: ${prefetchContext.workItem.githubPrUrl}`);
  }
  if (prefetchContext.workItem.githubPrNumber !== undefined) {
    lines.push(`- PR Number: ${String(prefetchContext.workItem.githubPrNumber)}`);
  }

  lines.push(`- Fetched at: ${prefetchContext.meta.fetchedAt}`);
  if (prefetchContext.meta.sources.length > 0) {
    lines.push(`- Sources: ${prefetchContext.meta.sources.join(", ")}`);
  }

  return lines;
}

function formatBodySection(body: string | undefined): string[] {
  if (!body?.trim()) {
    return [];
  }
  return body.split("\n");
}

function formatDiscussionComments(
  comments: NonNullable<RunPrefetchContext["github"]>["discussionComments"] | undefined,
  totalCount?: number
): string[] {
  if (!comments || comments.length === 0) {
    return [];
  }
  return withTruncationNotice(
    formatEntryList(
      comments.map((comment) => ({
        header: formatCommentHeader(comment.authorLogin ? `@${comment.authorLogin}` : undefined, comment.createdAt),
        body: comment.body,
      }))
    ),
    comments.length,
    totalCount,
    "discussion comments"
  );
}

function formatReviewSummaries(
  reviews: NonNullable<RunPrefetchContext["github"]>["reviews"] | undefined,
  totalCount?: number
): string[] {
  if (!reviews || reviews.length === 0) {
    return [];
  }
  return withTruncationNotice(
    formatEntryList(
      reviews.map((review) => ({
        header: formatCommentHeader(
          review.state?.toUpperCase(),
          review.authorLogin ? `@${review.authorLogin}` : undefined,
          review.createdAt
        ),
        body: review.body,
      }))
    ),
    reviews.length,
    totalCount,
    "review summaries"
  );
}

function formatInlineReviewComments(
  comments: NonNullable<RunPrefetchContext["github"]>["reviewComments"] | undefined,
  totalCount?: number
): string[] {
  if (!comments || comments.length === 0) {
    return [];
  }
  return withTruncationNotice(
    formatEntryList(
      comments.map((comment) => {
        const locationParts = [comment.path];
        if (comment.line !== undefined) {
          locationParts.push(String(comment.line));
        }
        if (comment.side) {
          locationParts.push(`(${comment.side})`);
        }
        return {
          header: formatCommentHeader(
            comment.authorLogin ? `@${comment.authorLogin}` : undefined,
            comment.createdAt,
            locationParts.join(":")
          ),
          body: comment.body,
        };
      })
    ),
    comments.length,
    totalCount,
    "inline review comments"
  );
}

function formatCiSnapshot(ci: NonNullable<RunPrefetchContext["github"]>["ci"] | undefined): string[] {
  if (!ci) {
    return [];
  }

  const lines = [
    `- Head SHA: ${ci.headSha ?? "unknown"}`,
    `- Conclusion: ${ci.conclusion}`,
  ];

  if (ci.failedRuns && ci.failedRuns.length > 0) {
    lines.push("- Failed runs:");
    for (const failedRun of ci.failedRuns) {
      lines.push(`  - ${failedRun.name} (#${String(failedRun.id)}): ${failedRun.conclusion ?? failedRun.status}`);
      if (failedRun.detailsUrl) {
        lines.push(`    Details: ${failedRun.detailsUrl}`);
      }
      if (failedRun.startedAt) {
        lines.push(`    Started: ${failedRun.startedAt}`);
      }
      if (failedRun.completedAt) {
        lines.push(`    Completed: ${failedRun.completedAt}`);
      }
    }
  }

  if (ci.failedAnnotations && ci.failedAnnotations.length > 0) {
    lines.push(...withTruncationNotice([], ci.failedAnnotations.length, ci.failedAnnotationsTotalCount, "failed annotations"));
    lines.push("- Failed annotations:");
    for (const annotation of ci.failedAnnotations) {
      lines.push(
        `  - ${annotation.checkRunName}: ${annotation.path}:${String(annotation.line)} [${annotation.level}] ${annotation.message}`
      );
    }
  }

  return lines;
}

function formatJiraComments(
  comments: NonNullable<RunPrefetchContext["jira"]>["comments"] | undefined,
  totalCount?: number
): string[] {
  if (!comments || comments.length === 0) {
    return [];
  }
  return withTruncationNotice(
    formatEntryList(
      comments.map((comment) => ({
        header: formatCommentHeader(comment.authorDisplayName, comment.createdAt),
        body: comment.body,
      }))
    ),
    comments.length,
    totalCount,
    "Jira comments"
  );
}

function formatEntryList(entries: Array<{ header: string; body: string }>): string[] {
  const lines: string[] = [];
  entries.forEach((entry, index) => {
    if (index > 0) {
      lines.push("");
    }
    lines.push(entry.header, ...indentLines(entry.body));
  });
  return lines;
}

function withTruncationNotice(lines: string[], visibleCount: number, totalCount: number | undefined, noun: string): string[] {
  if (!totalCount || totalCount <= visibleCount) {
    return lines;
  }

  return [
    `Showing ${String(visibleCount)} of ${String(totalCount)} ${noun}.`,
    "",
    ...lines,
  ];
}

function formatCommentHeader(primary?: string, secondary?: string, tertiary?: string): string {
  const parts: string[] = [];
  if (primary) {
    parts.push(primary);
  }
  if (secondary) {
    parts.push(secondary);
  }
  if (tertiary) {
    parts.push(tertiary);
  }
  return `- ${parts.length > 0 ? parts.join(" • ") : "Comment"}`;
}

function indentLines(body: string): string[] {
  return body.split("\n").map(line => `  ${line}`);
}

// ── Dynamic AGENTS.md builder ──

/**
 * Build a dynamic AGENTS.md that pi-agent auto-discovers in the repo root.
 * Injects task context, CEMS memories, project conventions, and coding rules.
 */
export function buildAgentsMd(
  run: RunRecord,
  ctx: ContextBag,
  hookSections: string[],
  repoSummary: string | undefined
): string {
  const parts: string[] = [];
  const taskType = ctx.get<string>("taskType") ?? "chore";
  const taskHints = extractTaskHints(run.task);
  const failureCode = ctx.get<string>("browserVerifyFailureCode");
  const failureReason = ctx.get<string>("browserVerifyVerdictReason");
  const failureHistory = ctx.get<Array<{ round: number; verdict?: string; code?: string }>>("browserVerifyFailureHistory");

  parts.push("# AGENTS.md — Gooseherd Context");
  parts.push("");

  // Task context
  parts.push("## Task Context");
  parts.push(`- Run ID: ${run.id}`);
  parts.push(`- Repository: ${run.repoSlug}`);
  parts.push(`- Base branch: ${run.baseBranch}`);
  parts.push(`- Task type: ${taskType}`);
  parts.push(`- Task summary: ${truncateSingleLine(run.task, 320)}`);
  if (taskHints.routes.length > 0) {
    parts.push(`- Route hints: ${taskHints.routes.join(", ")}`);
  }
  if (taskHints.authRequiredLikely) {
    parts.push("- Auth likely required: yes (login/signup flows may be necessary for verification)");
  }
  parts.push("");

  // CEMS memories (from onPromptEnrich hooks)
  if (hookSections.length > 0) {
    parts.push("## Organizational Memory");
    parts.push("");
    parts.push("Relevant patterns and past solutions from your team's knowledge base:");
    parts.push("");
    parts.push(...hookSections);
    parts.push("");
  }

  // Project profile (from .gooseherd-profile.md)
  const repoProfile = ctx.get<string>("repoProfile");
  if (repoProfile) {
    parts.push("## Project Profile");
    parts.push("");
    parts.push(repoProfile);
    parts.push("");
  }

  // Project conventions (from repo summary)
  if (repoSummary) {
    parts.push("## Project Conventions");
    parts.push("");
    parts.push(repoSummary);
    parts.push("");
  }

  if (failureCode || failureReason || (failureHistory && failureHistory.length > 0)) {
    parts.push("## Recovery Memory");
    parts.push("");
    if (failureCode) {
      parts.push(`- Latest browser verification failure class: \`${failureCode}\``);
    }
    if (failureReason) {
      parts.push(`- Latest failure reason: ${truncateSingleLine(failureReason, 260)}`);
    }
    if (failureHistory && failureHistory.length > 0) {
      const recent = failureHistory.slice(-3);
      for (const item of recent) {
        parts.push(`- Prior round ${String(item.round)}: ${item.code ? `[${item.code}] ` : ""}${truncateSingleLine(item.verdict ?? "unknown", 160)}`);
      }
    }
    parts.push("");
  }

  if (taskHints.authRequiredLikely || taskHints.uiVerificationLikely) {
    parts.push("## Verification Guidance");
    parts.push("");
    if (taskHints.authRequiredLikely) {
      parts.push("- If verification is blocked by login and no credentials are provided, use signup when available.");
      parts.push("- Do not guess random credentials unless explicitly instructed.");
    }
    if (taskHints.uiVerificationLikely) {
      parts.push("- For UI tasks, verify rendered output in browser-visible routes before broad refactors.");
    }
    parts.push("- If the blocker is auth/provider/runtime related, do not patch unrelated application code.");
    parts.push("");
  }

  // Coding rules
  parts.push("## Coding Rules");
  parts.push("");
  parts.push("- Keep changes minimal and deterministic");
  parts.push("- Preserve existing style and architecture");
  parts.push("- Do not refactor unrelated code");
  parts.push("- If tests exist, ensure they pass before finishing");
  parts.push("- Prefer editing existing files over creating new ones");
  parts.push("");

  return parts.join("\n");
}

// ── Parent diff extraction for follow-up runs ──

const MAX_DIFF_CHARS = 3000;
const MAX_CURRENT_BRANCH_DIFF_CHARS = 4000;

async function getParentDiff(repoDir: string, logFile: string): Promise<string | undefined> {
  try {
    // Check if there's a parent commit to diff against
    const logResult = await runShellCapture("git rev-list --count HEAD", { cwd: repoDir, logFile });
    const commitCount = Number.parseInt(logResult.stdout.trim(), 10);
    if (logResult.code !== 0 || commitCount < 2) return undefined;

    const diffResult = await runShellCapture(
      "git diff HEAD~1..HEAD --unified=3",
      { cwd: repoDir, logFile }
    );
    if (diffResult.code !== 0 || !diffResult.stdout.trim()) return undefined;

    const diff = diffResult.stdout;
    if (diff.length <= MAX_DIFF_CHARS) return diff;
    return diff.slice(0, MAX_DIFF_CHARS) + "\n... (truncated)";
  } catch {
    return undefined;
  }
}

async function getCurrentBranchDiff(repoDir: string, logFile: string, baseBranch?: string): Promise<string | undefined> {
  if (!baseBranch?.trim()) {
    return undefined;
  }

  try {
    const remoteBaseRef = shellEscape(`origin/${baseBranch}`);
    const localBaseRef = shellEscape(baseBranch);
    let diffResult = await runShellCapture(
      `git diff ${remoteBaseRef}...HEAD --unified=3`,
      { cwd: repoDir, logFile }
    );
    if (diffResult.code !== 0 || !diffResult.stdout.trim()) {
      diffResult = await runShellCapture(
        `git diff ${localBaseRef}...HEAD --unified=3`,
        { cwd: repoDir, logFile }
      );
    }
    if (diffResult.code !== 0 || !diffResult.stdout.trim()) {
      return undefined;
    }

    const diff = diffResult.stdout;
    if (diff.length <= MAX_CURRENT_BRANCH_DIFF_CHARS) {
      return diff;
    }
    return diff.slice(0, MAX_CURRENT_BRANCH_DIFF_CHARS) + "\n... (truncated)";
  } catch {
    return undefined;
  }
}

function getExternalContextInstructions(prefetchContext: RunPrefetchContext | undefined): string[] {
  if (!prefetchContext?.github && !prefetchContext?.jira) {
    return [];
  }

  return [
    "- Use the current branch state and diff as the source of truth for code changes.",
    "- Treat PR body, Jira, discussion comments, and review comments as hints that may be stale or contradictory.",
    "- Comments may be stale, speculative, or already addressed elsewhere in the branch.",
    "- Do not treat comments as mandatory tasks.",
    "- Only act on a comment if the current diff and branch state show the problem still exists.",
    "- Ignore comments that would require expanding scope beyond the current PR or changing unrelated code.",
    "- If the hints cannot be reconciled with the current diff without guessing intent or expanding scope, make no code changes and print `GOOSEHERD_CONTEXT_CONFLICT: <reason>` before exiting.",
  ];
}

function getAutoReviewSummaryInstructions(run: RunRecord): string[] {
  if (run.requestedBy !== "work-item:auto-review") {
    return [];
  }

  return [
    "Auto-review reporting requirements:",
    '- Before exiting, print exactly one line that starts with `GOOSEHERD_REVIEW_SUMMARY:` followed by compact JSON.',
    '- Use this exact JSON shape: `{"selectedFindings":["..."],"ignoredFindings":["..."],"rationale":"..."}`.',
    "- Keep each finding short and concrete. Use empty arrays when there is nothing to list.",
  ];
}

function isUiHeavyTask(task: string): boolean {
  return /(ui|page|view|visual|browser|screenshot|css|html|slim|erb|frontend|layout)/i.test(task);
}

function truncateSingleLine(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return normalized.slice(0, max) + "...";
}

function extractTaskHints(task: string): { routes: string[]; authRequiredLikely: boolean; uiVerificationLikely: boolean } {
  const routes = new Set<string>();
  const routeMatches = task.match(/\/[a-z0-9_/-]+/gi) ?? [];
  for (const route of routeMatches) {
    if (!/^\/(tmp|var|usr|etc|bin|dev|proc|sys)\b/i.test(route)) {
      routes.add(route);
    }
  }
  const authRequiredLikely = /(login|sign in|signup|sign up|authenticated|user edit|account|devise)/i.test(task);
  const uiVerificationLikely = /(browser|screenshot|visual|ui|homepage|page|render)/i.test(task);
  return { routes: [...routes].slice(0, 6), authRequiredLikely, uiVerificationLikely };
}
