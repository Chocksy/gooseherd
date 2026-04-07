import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import type { RunRecord } from "../../types.js";
import { runShellCapture } from "../shell.js";

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

  const implementationPlan = ctx.get<string>("implementationPlan");

  const executionMode = ctx.get<string>("executionMode") ?? "standard";

  sections.push(
    "## Instructions",
    `Execution mode: ${executionMode}`,
    "",
    ...getModeInstructions(executionMode),
    isFollowUp ? "- This is a follow-up run. Only address the feedback — do not refactor unrelated code." : "",
    "",
    `Task type: ${taskType}`,
    "",
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
