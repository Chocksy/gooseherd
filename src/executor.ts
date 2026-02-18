import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AppConfig } from "./config.js";
import type { ExecutionResult, RunRecord } from "./types.js";
import { GitHubService, buildAuthenticatedGitUrl } from "./github.js";
import type { RunLifecycleHooks } from "./hooks/run-lifecycle.js";

export type ExecutorPhase = "cloning" | "agent" | "validating" | "pushing";

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function renderTemplate(template: string, values: Record<string, string>): string {
  let output = template;
  for (const [key, value] of Object.entries(values)) {
    output = output.replaceAll(`{{${key}}}`, shellEscape(value));
  }
  return output;
}

async function runShell(
  command: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; logFile: string; timeoutMs?: number }
): Promise<void> {
  await appendLog(options.logFile, `\n$ ${sanitizeForLogs(command)}\n`);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const child = spawn("bash", ["-lc", command], {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env
      }
    });

    let timeoutHandle: NodeJS.Timeout | undefined;
    if (options.timeoutMs && options.timeoutMs > 0) {
      const timeoutMs = options.timeoutMs;
      timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        appendLog(
          options.logFile,
          `\n[timeout] command exceeded ${String(Math.floor(timeoutMs / 1000))}s, terminating\n`
        ).catch(() => {});
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!settled) {
            child.kill("SIGKILL");
          }
        }, 5000);
      }, timeoutMs);
    }

    child.stdout.on("data", async (chunk) => {
      await appendLog(options.logFile, chunk.toString());
    });

    child.stderr.on("data", async (chunk) => {
      await appendLog(options.logFile, chunk.toString());
    });

    child.on("exit", (code) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (settled) {
        return;
      }
      settled = true;
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Command failed with exit code ${String(code)}: ${sanitizeForLogs(command)}`
        )
      );
    });

    child.on("error", (error) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
  });
}

async function runShellCapture(
  command: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; logFile: string }
): Promise<{ code: number; stdout: string; stderr: string }> {
  await appendLog(options.logFile, `\n$ ${sanitizeForLogs(command)}\n`);

  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env
      }
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", async (chunk) => {
      const text = chunk.toString();
      stdout += text;
      await appendLog(options.logFile, text);
    });

    child.stderr.on("data", async (chunk) => {
      const text = chunk.toString();
      stderr += text;
      await appendLog(options.logFile, text);
    });

    child.on("exit", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });

    child.on("error", (error) => {
      reject(error);
    });
  });
}

async function appendLog(logFile: string, content: string): Promise<void> {
  await writeFile(logFile, content, { flag: "a" });
}

function sanitizeForLogs(input: string): string {
  let output = input;
  // Hide tokens in authenticated GitHub URLs.
  output = output.replace(/x-access-token:[^@'\s]+@/g, "x-access-token:***@");
  // Hide common PAT-looking values if they appear.
  output = output.replace(/\b(gh[pousr]_[A-Za-z0-9_]+)\b/g, "***");
  return output;
}

export interface ParentRunContext {
  parentRunId: string;
  parentBranchName: string;
  parentChangedFiles?: string[];
  parentCommitSha?: string;
  feedbackNote?: string;
}

export class RunExecutor {
  constructor(
    private readonly config: AppConfig,
    private readonly githubService?: GitHubService,
    private readonly hooks?: RunLifecycleHooks
  ) {}

  async execute(
    run: RunRecord,
    onPhase: (phase: ExecutorPhase) => Promise<void>,
    parentContext?: ParentRunContext
  ): Promise<ExecutionResult> {
    const runDir = path.resolve(this.config.workRoot, run.id);
    const repoDir = path.join(runDir, "repo");
    const promptFile = path.join(runDir, "task.md");
    const logFile = path.join(runDir, "run.log");
    const isFollowUp = !!parentContext;

    // Reset run workspace so restarts/retries with same run ID do not fail on stale clone dirs.
    await rm(runDir, { recursive: true, force: true });
    await mkdir(runDir, { recursive: true });
    await writeFile(logFile, `${this.config.appName} run ${run.id}${isFollowUp ? ` (follow-up from ${parentContext.parentRunId})` : ""}\n`, "utf8");

    const repoUrl = this.config.githubToken
      ? buildAuthenticatedGitUrl(run.repoSlug, this.config.githubToken)
      : `https://github.com/${run.repoSlug}.git`;

    await onPhase("cloning");
    await runShell(`git clone ${shellEscape(repoUrl)} ${shellEscape(repoDir)}`, {
      logFile
    });

    // Enrich prompt with org memories via lifecycle hooks
    const hookSections = this.hooks ? await this.hooks.onPromptEnrich(run) : [];

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

    // Build the prompt — enriched with parent context and memories
    const promptSections = this.buildPromptSections(run, parentContext, hookSections);
    await writeFile(promptFile, promptSections.join("\n"), "utf8");

    let resolvedBaseBranch = run.baseBranch;

    if (isFollowUp) {
      // Follow-up: checkout the existing parent branch
      await appendLog(logFile, `\n[info] follow-up run: checking out existing branch '${parentContext.parentBranchName}'\n`);
      const fetchResult = await runShellCapture(
        `git fetch origin ${shellEscape(parentContext.parentBranchName)}`,
        { cwd: repoDir, logFile }
      );
      if (fetchResult.code !== 0) {
        throw new Error(`Failed to fetch parent branch '${parentContext.parentBranchName}' from origin.`);
      }
      const checkoutResult = await runShellCapture(
        `git checkout ${shellEscape(parentContext.parentBranchName)}`,
        { cwd: repoDir, logFile }
      );
      if (checkoutResult.code !== 0) {
        throw new Error(`Failed to checkout parent branch '${parentContext.parentBranchName}'.`);
      }
    } else {
      // Fresh run: checkout base branch, then create new branch
      let checkoutResult = await runShellCapture(
        `git checkout ${shellEscape(resolvedBaseBranch)}`,
        { cwd: repoDir, logFile }
      );
      if (checkoutResult.code !== 0) {
        await appendLog(
          logFile,
          `\n[info] requested base branch '${resolvedBaseBranch}' not found. trying origin default branch fallback\n`
        );

        const remoteHead = await runShellCapture(
          "git symbolic-ref --quiet --short refs/remotes/origin/HEAD | sed 's#^origin/##'",
          { cwd: repoDir, logFile }
        );

        const detected = remoteHead.stdout.trim();
        if (!detected) {
          throw new Error(
            `Base branch '${resolvedBaseBranch}' not found and could not detect origin default branch.`
          );
        }

        resolvedBaseBranch = detected;
        checkoutResult = await runShellCapture(
          `git checkout ${shellEscape(resolvedBaseBranch)}`,
          { cwd: repoDir, logFile }
        );
        if (checkoutResult.code !== 0) {
          throw new Error(
            `Failed to checkout base branch '${run.baseBranch}' and fallback '${resolvedBaseBranch}'.`
          );
        }
      }

      await runShell(`git checkout -b ${shellEscape(run.branchName)}`, {
        cwd: repoDir,
        logFile
      });
    }

    await runShell(`git config user.name ${shellEscape(this.config.gitAuthorName)}`, {
      cwd: repoDir,
      logFile
    });
    await runShell(`git config user.email ${shellEscape(this.config.gitAuthorEmail)}`, {
      cwd: repoDir,
      logFile
    });

    await onPhase("agent");
    // Use the follow-up template if configured and this is a follow-up run
    const template = isFollowUp && this.config.agentFollowUpTemplate
      ? this.config.agentFollowUpTemplate
      : this.config.agentCommandTemplate;
    const agentCommand = renderTemplate(template, {
      repo_dir: repoDir,
      prompt_file: promptFile,
      task_file: promptFile,
      run_id: run.id,
      repo_slug: run.repoSlug,
      parent_run_id: parentContext?.parentRunId ?? ""
    });
    const agentCmd = this.appendMcpExtension(agentCommand);
    await runShell(agentCmd, {
      cwd: path.resolve("."),
      logFile,
      timeoutMs: this.config.agentTimeoutSeconds * 1000
    });

    if (this.config.validationCommand.trim() !== "") {
      await onPhase("validating");
      const templateVars = {
        repo_dir: repoDir,
        run_id: run.id,
        repo_slug: run.repoSlug,
        prompt_file: promptFile,
        task_file: promptFile,
        parent_run_id: parentContext?.parentRunId ?? ""
      };

      // Round 0 (free): auto-fix lint if configured
      if (this.config.lintFixCommand) {
        await appendLog(logFile, "\n[validation] round 0: running lint auto-fix\n");
        const lintCmd = renderTemplate(this.config.lintFixCommand, templateVars);
        const lintResult = await runShellCapture(lintCmd, { cwd: path.resolve("."), logFile });
        if (lintResult.code !== 0) {
          await appendLog(logFile, `\n[validation] lint auto-fix exited with code ${String(lintResult.code)} (continuing)\n`);
        }
      }

      // Validation rounds: validate → if fail, re-run agent with error context → repeat
      const maxRounds = this.config.maxValidationRounds;
      const validationCmd = renderTemplate(this.config.validationCommand, templateVars);

      for (let attempt = 0; attempt <= maxRounds; attempt++) {
        const label = attempt === 0 ? "initial" : `retry ${String(attempt)}/${String(maxRounds)}`;
        await appendLog(logFile, `\n[validation] ${label}: running validation\n`);
        const result = await runShellCapture(validationCmd, { cwd: path.resolve("."), logFile });

        if (result.code === 0) {
          await appendLog(logFile, "\n[validation] passed\n");
          break;
        }

        if (attempt >= maxRounds) {
          throw new Error(
            `Validation failed after ${String(maxRounds)} retry round(s). Last output:\n${(result.stderr || result.stdout).slice(-500)}`
          );
        }

        // Build error context and re-run the agent
        await appendLog(logFile, `\n[validation] failed (${label}), re-running agent with error context\n`);
        const errorSnippet = (result.stderr || result.stdout).slice(-2000);
        const fixPromptFile = path.join(runDir, `fix-round-${String(attempt + 1)}.md`);
        const fixPrompt = [
          `Validation failed (${label}).`,
          "",
          "Fix the following errors. Only change what is necessary — do not refactor unrelated code.",
          "",
          "```",
          errorSnippet,
          "```"
        ].join("\n");
        await writeFile(fixPromptFile, fixPrompt, "utf8");

        await onPhase("agent");
        const fixAgentCmd = this.appendMcpExtension(renderTemplate(
          isFollowUp && this.config.agentFollowUpTemplate
            ? this.config.agentFollowUpTemplate
            : this.config.agentCommandTemplate,
          { ...templateVars, prompt_file: fixPromptFile, task_file: fixPromptFile }
        ));
        await runShell(fixAgentCmd, {
          cwd: path.resolve("."),
          logFile,
          timeoutMs: this.config.agentTimeoutSeconds * 1000
        });

        // Auto-fix lint again before next validation round
        if (this.config.lintFixCommand) {
          const lintCmd = renderTemplate(this.config.lintFixCommand, templateVars);
          await runShellCapture(lintCmd, { cwd: path.resolve("."), logFile });
        }

        await onPhase("validating");
      }
    }

    await runShell("git diff --quiet HEAD", { cwd: repoDir, logFile }).then(
      () => {
        throw new Error(
          "Agent produced no file changes. Ensure AGENT_COMMAND_TEMPLATE writes modifications before commit."
        );
      },
      () => Promise.resolve()
    );

    await runShell("git add -A", { cwd: repoDir, logFile });
    const taskSummary = (isFollowUp ? run.feedbackNote ?? run.task : run.task).slice(0, 72);
    const appSlug = this.config.appName.toLowerCase().replace(/\s+/g, "-");
    const commitMsg = `${appSlug}: ${taskSummary}`;
    await runShell(`git commit -m ${shellEscape(commitMsg)}`, {
      cwd: repoDir,
      logFile
    });
    const commitShaResult = await runShellCapture("git rev-parse HEAD", {
      cwd: repoDir,
      logFile
    });
    if (commitShaResult.code !== 0) {
      throw new Error("Failed to determine commit SHA for run output.");
    }
    // Take last non-empty line to avoid shell profile noise (e.g., "--- loading .bash_profile")
    const commitSha = commitShaResult.stdout.trim().split("\n").pop()?.trim() ?? "";

    const changedFilesResult = await runShellCapture("git show --name-only --pretty='' HEAD", {
      cwd: repoDir,
      logFile
    });
    if (changedFilesResult.code !== 0) {
      throw new Error("Failed to determine changed files for run output.");
    }
    const changedFiles = changedFilesResult.stdout
      .split("\n")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0 && !entry.startsWith("---"));

    if (this.config.dryRun) {
      return {
        branchName: run.branchName,
        logsPath: logFile,
        commitSha,
        changedFiles
      };
    }

    if (!this.config.githubToken || !this.githubService) {
      throw new Error("GITHUB_TOKEN is required when DRY_RUN=false.");
    }

    await onPhase("pushing");
    // Follow-ups use --force-with-lease since we're pushing to an existing branch
    const pushFlag = isFollowUp ? " --force-with-lease" : "";
    await runShell(`git push origin ${shellEscape(run.branchName)}${pushFlag}`, {
      cwd: repoDir,
      logFile
    });

    const prTitle = `${appSlug}: ${run.task.slice(0, 80)}`;
    const prBody = this.buildPrBody(run, resolvedBaseBranch, parentContext);

    // Follow-ups update existing PR; fresh runs create new
    const prUrl = isFollowUp
      ? await this.githubService.findOrCreatePullRequest({
          repoSlug: run.repoSlug,
          title: prTitle,
          body: prBody,
          head: run.branchName,
          base: resolvedBaseBranch
        })
      : await this.githubService.createPullRequest({
          repoSlug: run.repoSlug,
          title: prTitle,
          body: prBody,
          head: run.branchName,
          base: resolvedBaseBranch
        });

    return {
      branchName: run.branchName,
      logsPath: logFile,
      commitSha,
      changedFiles,
      prUrl
    };
  }

  private appendMcpExtension(cmd: string): string {
    if (this.config.cemsMcpCommand) {
      return `${cmd} --with-extension ${shellEscape(this.config.cemsMcpCommand)}`;
    }
    return cmd;
  }

  private buildPromptSections(
    run: RunRecord,
    parentContext?: ParentRunContext,
    hookSections: string[] = []
  ): string[] {
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
        sections.push(
          `Engineer's feedback: ${parentContext.feedbackNote}`,
          ""
        );
      }
      if (parentContext.parentChangedFiles && parentContext.parentChangedFiles.length > 0) {
        sections.push(
          `Files changed in previous run: ${parentContext.parentChangedFiles.join(", ")}`,
          ""
        );
      }
      sections.push("---", "");
    }

    sections.push(
      "Task:",
      parentContext?.feedbackNote ?? run.task,
      "",
      "Expected output:",
      "- Implement the requested changes.",
      "- Keep changes minimal and deterministic.",
      "- Preserve existing style and architecture.",
      "- If tests are configured, satisfy them before finishing."
    );

    return sections;
  }

  private buildPrBody(
    run: RunRecord,
    resolvedBaseBranch: string,
    parentContext?: ParentRunContext
  ): string {
    const lines = [
      "## Task",
      "",
      run.task,
      "",
      "## Details",
      "",
      `- **Base branch:** \`${resolvedBaseBranch}\``,
      `- **Requested by:** ${run.requestedBy}`,
      `- **Run:** \`${run.id.slice(0, 8)}\``,
    ];

    if (parentContext) {
      lines.push(
        "",
        "## Follow-up",
        "",
        `> ${parentContext.feedbackNote ?? "retry"}`,
        "",
        `- **Previous run:** \`${parentContext.parentRunId.slice(0, 8)}\``,
        `- **Chain depth:** ${String(run.chainIndex ?? 1)}`
      );
    }

    lines.push(
      "",
      "---",
      `*Automated by [${this.config.appName}](https://github.com/Chocksy/gooseherd)*`
    );

    return lines.join("\n");
  }
}
