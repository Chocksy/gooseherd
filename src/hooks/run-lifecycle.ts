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
      const summary = `Completed task on ${run.repoSlug}: ${run.task.slice(0, 200)}. Changed files: ${(result.changedFiles ?? []).join(", ")}`;
      await this.memory.storeMemory(summary, ["run-completed"], `project:${run.repoSlug}`);
    } catch (error) {
      logError("Hook onRunComplete failed", { error: error instanceof Error ? error.message : "unknown" });
    }
  }

  async onFeedback(run: RunRecord, rating: "up" | "down", note?: string): Promise<void> {
    if (!this.memory || rating !== "down" || !note?.trim()) return;
    try {
      const correction = `Correction for ${run.repoSlug}: task "${run.task.slice(0, 100)}" — ${note.trim()}`;
      await this.memory.storeMemory(correction, ["correction", "feedback"], `project:${run.repoSlug}`);
    } catch (error) {
      logError("Hook onFeedback failed", { error: error instanceof Error ? error.message : "unknown" });
    }
  }
}
