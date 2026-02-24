import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { runShellCapture } from "../shell.js";

/**
 * Hydrate context node: write .goosehints, build prompt file.
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

  // Enrich prompt with org memories via lifecycle hooks
  const hookSections = deps.hooks ? await deps.hooks.onPromptEnrich(run) : [];

  // Write dynamic .goosehints with run context
  const goosehintsContent = [
    `# Gooseherd Run Context`,
    ``,
    `Run ID: ${run.id}`,
    `Repository: ${run.repoSlug}`,
    `Base branch: ${run.baseBranch}`,
    `Requested by: ${run.requestedBy}`,
    ``,
    `## Instructions`,
    `- Keep changes minimal and deterministic`,
    `- Preserve existing style and architecture`,
    `- If tests are configured, satisfy them before finishing`,
    isFollowUp ? `- This is a follow-up run. Only address the feedback — do not refactor unrelated code.` : ``,
    ``,
    `## Memory (CEMS)`,
    `You have memory tools: memory_search, memory_add. USE THEM.`,
    ``,
    `### Before coding:`,
    `- Search for past mistakes, corrections, and patterns on this repo`,
    `- Search for architectural decisions and coding conventions`,
    `- Use SPECIFIC, DETAILED queries — not generic keywords. Examples:`,
    `  - "What SEO improvements were rejected or corrected on epiccoders/pxls?"`,
    `  - "What landing page patterns work well for this project?"`,
    `  - "Previous bugs or issues with the landing pages controller"`,
    ``,
    `### After completing work:`,
    `- Store what you learned: what files you changed, what approach worked`,
    `- Store any gotchas or decisions for the next agent run`,
    `- Include the repo name and specific file paths in your memory`,
  ].filter(Boolean).join("\n");

  await writeFile(path.join(repoDir, ".goosehints"), goosehintsContent, "utf8");

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

  // Build repo summary for codebase awareness
  const repoSummary = await buildRepoSummary(repoDir, deps.logFile);
  if (repoSummary) {
    sections.push("## Repository Context", "", repoSummary, "");
  }

  const taskType = ctx.get<string>("taskType") ?? "chore";
  sections.push(
    `Task type: ${taskType}`,
    "",
    "Task:",
    parentContext?.feedbackNote ?? run.task,
    "",
    ...getExpectedOutput(taskType)
  );

  await writeFile(promptFile, sections.join("\n"), "utf8");

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

export async function buildRepoSummary(repoDir: string, logFile: string): Promise<string | undefined> {
  try {
    const parts: string[] = [];

    // 1. Directory tree (maxdepth 2, capped at 40)
    const treeResult = await runShellCapture(
      `find . -maxdepth 2 -type d ${EXCLUDE_ARGS} | head -40`,
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

    // 3. README excerpt (first 30 lines, capped at 500 chars)
    try {
      const readmeContent = await readFile(path.join(repoDir, "README.md"), "utf8");
      const excerpt = readmeContent.split("\n").slice(0, 30).join("\n").slice(0, 500);
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

// ── Parent diff extraction for follow-up runs ──

const MAX_DIFF_CHARS = 3000;

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
