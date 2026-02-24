import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import type { RunStore } from "./store.js";
import { logError, logInfo } from "./logger.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class WorkspaceCleaner {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly store: RunStore
  ) {}

  start(): void {
    if (!this.config.workspaceCleanupEnabled) {
      logInfo("Workspace cleanup disabled");
      return;
    }

    const intervalMs = this.config.workspaceCleanupIntervalMinutes * 60 * 1000;
    logInfo("Workspace cleanup started", {
      intervalMinutes: this.config.workspaceCleanupIntervalMinutes,
      maxAgeHours: this.config.workspaceMaxAgeHours
    });

    // Run once on startup (after a short delay to let the app initialize)
    setTimeout(() => this.sweep(), 10_000);

    this.timer = setInterval(() => this.sweep(), intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async sweep(): Promise<void> {
    if (this.running) {
      return; // Skip if a sweep is already in progress
    }
    this.running = true;

    try {
      const workRoot = path.resolve(this.config.workRoot);
      let entries: string[];
      try {
        entries = await readdir(workRoot);
      } catch {
        // .work/ doesn't exist yet — nothing to clean
        return;
      }

      const ttlMs = this.config.workspaceMaxAgeHours * 60 * 60 * 1000;
      const now = Date.now();
      let cleaned = 0;
      let skipped = 0;

      for (const entry of entries) {
        if (!UUID_REGEX.test(entry)) {
          continue; // Skip non-UUID directories (safety guard)
        }

        const dirPath = path.join(workRoot, entry);

        // Verify it's actually a directory
        try {
          const dirStat = await stat(dirPath);
          if (!dirStat.isDirectory()) {
            continue;
          }
        } catch {
          continue; // Entry vanished between readdir and stat
        }

        const run = await this.store.getRun(entry);

        if (run) {
          // Known run — check status and age
          if (!isTerminal(run.status)) {
            skipped += 1;
            continue; // Never delete in-progress runs
          }

          const finishedTime = run.finishedAt
            ? new Date(run.finishedAt).getTime()
            : run.createdAt
              ? new Date(run.createdAt).getTime() + 48 * 60 * 60 * 1000 // Fallback: createdAt + 48h
              : 0;

          if (finishedTime === 0 || now - finishedTime < ttlMs) {
            skipped += 1;
            continue; // Not old enough yet
          }
        } else {
          // Orphan directory (UUID-shaped but no matching run record)
          // Use filesystem mtime as age indicator
          try {
            const dirStat = await stat(dirPath);
            if (now - dirStat.mtimeMs < ttlMs) {
              skipped += 1;
              continue; // Orphan is still fresh
            }
          } catch {
            continue;
          }
        }

        // Delete the directory
        try {
          await rm(dirPath, { recursive: true, force: true });
          cleaned += 1;
          logInfo("Workspace cleaned", {
            runId: entry.slice(0, 8),
            status: run?.status ?? "orphan"
          });
        } catch (err) {
          logError("Workspace cleanup failed for directory", {
            runId: entry.slice(0, 8),
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }

      if (cleaned > 0 || skipped > 0) {
        logInfo("Workspace cleanup sweep complete", { cleaned, skipped });
      }
    } catch (err) {
      logError("Workspace cleanup sweep error", {
        error: err instanceof Error ? err.message : String(err)
      });
    } finally {
      this.running = false;
    }
  }
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed";
}
