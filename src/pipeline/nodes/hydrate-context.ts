import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";

/**
 * Hydrate context node: write .goosehints, build prompt file.
 * Equivalent to executor.ts lines 193-231, 498-548.
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

  await writeFile(promptFile, sections.join("\n"), "utf8");

  return { outcome: "success" };
}
