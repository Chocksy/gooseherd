import type { MemoryProvider } from "../memory/provider.js";
import type { RunRecord, ExecutionResult } from "../types.js";
import { logError } from "../logger.js";

export class RunLifecycleHooks {
  constructor(private readonly memory?: MemoryProvider) {}

  async onPromptEnrich(run: RunRecord): Promise<string[]> {
    if (!this.memory) return [];
    try {
      const query = run.feedbackNote ?? run.task;
      const memories = await this.memory.searchMemories(query, run.repoSlug);
      if (!memories) return [];
      return [
        "## Relevant Knowledge (from org memory)",
        memories,
        "",
        "---",
        ""
      ];
    } catch (error) {
      logError("Hook onPromptEnrich failed", { error: error instanceof Error ? error.message : "unknown" });
      return [];
    }
  }

  async onRunComplete(run: RunRecord, result: ExecutionResult): Promise<void> {
    if (!this.memory) return;
    try {
      const duration = run.startedAt && run.finishedAt
        ? `${String(Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000))}s`
        : "unknown";
      const fileCount = result.changedFiles?.length ?? 0;
      const fileList = fileCount > 0 ? result.changedFiles!.slice(0, 15).join(", ") : "none";
      const isFollowUp = run.parentRunId ? " (follow-up)" : "";

      const summary = [
        `Completed${isFollowUp} on ${run.repoSlug}: ${run.task.slice(0, 200)}.`,
        `Outcome: ${run.status}. Duration: ${duration}. Files changed (${String(fileCount)}): ${fileList}.`,
        run.prUrl ? `PR: ${run.prUrl}` : "",
      ].filter(Boolean).join(" ");

      const tags = ["run-completed", run.status];
      if (run.parentRunId) tags.push("follow-up");

      await this.memory.storeMemory(summary, tags, `project:${run.repoSlug}`);
    } catch (error) {
      logError("Hook onRunComplete failed", { error: error instanceof Error ? error.message : "unknown" });
    }
  }

  async onFeedback(run: RunRecord, rating: "up" | "down", note?: string): Promise<void> {
    if (!this.memory) return;
    try {
      if (rating === "down" && note?.trim()) {
        const correction = `Correction for ${run.repoSlug}: task "${run.task.slice(0, 100)}" — ${note.trim()}`;
        await this.memory.storeMemory(correction, ["correction", "feedback"], `project:${run.repoSlug}`);
      } else if (rating === "up") {
        const praise = `Positive feedback on ${run.repoSlug}: task "${run.task.slice(0, 100)}" was approved${note?.trim() ? ` — ${note.trim()}` : ""}.`;
        await this.memory.storeMemory(praise, ["approval", "feedback"], `project:${run.repoSlug}`);
      }
    } catch (error) {
      logError("Hook onFeedback failed", { error: error instanceof Error ? error.message : "unknown" });
    }
  }
}
