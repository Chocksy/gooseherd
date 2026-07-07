import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NodeConfig, NodeDeps, NodeResult } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { appendLog, runShellCapture } from "../shell.js";
import { buildAgentCommand } from "../agent-command.js";
import { logInfo } from "../../logger.js";

const ANSWER_PATH = ".gooseherd/answer.md";
const PROMPT_PATH = ".gooseherd/investigate-prompt.md";

function buildPrompt(task: string): string {
  return [
    "You are investigating a question about this repository. DO NOT modify any source files. Your job is to read code, search, and produce a written answer.",
    "",
    "# Question",
    task,
    "",
    "# Output",
    `Write your answer to \`${ANSWER_PATH}\` (markdown). Include:`,
    "- A direct answer to the question.",
    "- Specific file:line references that back up the answer.",
    "- Any caveats, unknowns, or follow-up suggestions.",
    "",
    `When you have written \`${ANSWER_PATH}\`, exit. Do not commit, push, or open a PR.`,
    ""
  ].join("\n");
}

export async function investigateNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const repoDir = ctx.get<string>("repoDir");
  if (!repoDir) {
    return { outcome: "failure", error: "repoDir missing from ContextBag" };
  }

  const promptFile = path.join(repoDir, PROMPT_PATH);
  await mkdir(path.dirname(promptFile), { recursive: true });
  await writeFile(promptFile, buildPrompt(deps.run.task), "utf-8");

  const command = buildAgentCommand(deps.config, deps.run, repoDir, promptFile, false);
  await appendLog(deps.logFile, `\n[pipeline] investigate: running agent\n  ${command}\n`);

  const exec = await runShellCapture(command, {
    cwd: repoDir,
    logFile: deps.logFile,
    sandboxId: deps.sandboxId
  });

  if (exec.code !== 0) {
    return {
      outcome: "soft_fail",
      error: `Agent exited with code ${String(exec.code)}`,
      rawOutput: exec.stderr || exec.stdout
    };
  }

  const answerPath = path.join(repoDir, ANSWER_PATH);
  let answer: string;
  try {
    answer = await readFile(answerPath, "utf-8");
  } catch {
    return {
      outcome: "soft_fail",
      error: `Agent did not produce ${ANSWER_PATH}`
    };
  }

  if (!answer.trim()) {
    return { outcome: "soft_fail", error: `${ANSWER_PATH} was empty` };
  }

  ctx.set("answer", answer);
  logInfo("investigate node: captured answer", {
    runId: deps.run.id,
    bytes: answer.length
  });
  return { outcome: "success" };
}
