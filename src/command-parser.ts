import type { ParsedCommand } from "./types.js";

const REPO_SLUG_REGEX = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function stripMentionPrefix(text: string): string {
  return text.replace(/<@[^>]+>/g, "").trim();
}

export function parseCommand(text: string): ParsedCommand {
  const normalized = stripMentionPrefix(text);
  if (!normalized || normalized.toLowerCase() === "help") {
    return { type: "help" };
  }

  if (normalized.toLowerCase() === "status") {
    return { type: "status" };
  }

  if (normalized.toLowerCase().startsWith("status ")) {
    const runId = normalized.slice("status ".length).trim();
    return { type: "status", runId: runId || undefined };
  }

  if (normalized.toLowerCase() === "tail") {
    return { type: "tail" };
  }

  if (normalized.toLowerCase().startsWith("tail ")) {
    const runId = normalized.slice("tail ".length).trim();
    return { type: "tail", runId: runId || undefined };
  }

  if (normalized.toLowerCase().startsWith("run ")) {
    const remainder = normalized.slice("run ".length).trim();
    const separatorIndex = remainder.indexOf("|");
    if (separatorIndex === -1) {
      return {
        type: "invalid",
        reason: "Usage: run <owner/repo[@base-branch]> | <task>"
      };
    }

    const target = remainder.slice(0, separatorIndex).trim();
    const task = remainder.slice(separatorIndex + 1).trim();

    if (!task) {
      return { type: "invalid", reason: "Task is required after |" };
    }

    const [repoPart, baseBranchPart] = target.split("@");
    if (!repoPart) {
      return {
        type: "invalid",
        reason: "Repo is required. Example: run hubstaff/hubstaff-server | Fix failing spec"
      };
    }

    if (!REPO_SLUG_REGEX.test(repoPart)) {
      return {
        type: "invalid",
        reason: "Repo must be in owner/repo format."
      };
    }

    return {
      type: "run",
      payload: {
        repoSlug: repoPart,
        task,
        baseBranch: baseBranchPart?.trim() || undefined
      }
    };
  }

  return {
    type: "invalid",
    reason:
      "Unknown command. Use `help`, `status [run-id]`, `tail [run-id]`, or `run <owner/repo[@base]> | <task>`"
  };
}
