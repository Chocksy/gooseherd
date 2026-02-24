/**
 * Observer state store — persists dedup keys, rate counters, and poll cursors to disk.
 *
 * Survives restarts so a process restart during an error storm
 * doesn't re-trigger every alert.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { DedupEntry, ObserverState } from "./types.js";

/** Create a fresh empty state (avoids shared-reference mutation). */
function freshState(): ObserverState {
  return {
    dedupEntries: {},
    rateLimitEvents: {},
    dailyCount: 0,
    dailyPerRepo: {},
    counterDay: "",
    sentryLastPoll: {}
  };
}

export class ObserverStateStore {
  private state: ObserverState = freshState();
  private readonly filePath: string;
  private dirty = false;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "observer-state.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<ObserverState>;
      this.state = {
        dedupEntries: parsed.dedupEntries ?? {},
        rateLimitEvents: parsed.rateLimitEvents ?? {},
        dailyCount: parsed.dailyCount ?? 0,
        dailyPerRepo: parsed.dailyPerRepo ?? {},
        counterDay: parsed.counterDay ?? "",
        sentryLastPoll: parsed.sentryLastPoll ?? {}
      };
    } catch {
      this.state = freshState();
    }
    // Reset daily counters if day changed
    this.resetDailyIfNeeded();
    // Sweep expired dedup entries
    this.sweepDedup();
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
    this.dirty = false;
  }

  // ── Dedup ──

  hasDedup(key: string): boolean {
    const entry = this.state.dedupEntries[key];
    if (!entry) return false;
    if (entry.ttlMs === 0 || Date.now() - entry.seenAt > entry.ttlMs) {
      delete this.state.dedupEntries[key];
      this.dirty = true;
      return false;
    }
    return true;
  }

  setDedup(key: string, ttlMs: number, runId?: string): void {
    this.state.dedupEntries[key] = { seenAt: Date.now(), ttlMs, runId };
    this.dirty = true;
  }

  markDedupCompleted(runId: string): void {
    for (const entry of Object.values(this.state.dedupEntries)) {
      if (entry.runId === runId) {
        entry.completedAt = Date.now();
        this.dirty = true;
        return;
      }
    }
  }

  getDedupEntry(key: string): DedupEntry | undefined {
    return this.state.dedupEntries[key];
  }

  sweepDedup(): void {
    const now = Date.now();
    let swept = false;
    for (const [key, entry] of Object.entries(this.state.dedupEntries)) {
      if (now - entry.seenAt > entry.ttlMs) {
        delete this.state.dedupEntries[key];
        swept = true;
      }
    }
    if (swept) this.dirty = true;
  }

  // ── Rate limiting ──

  getRateLimitEvents(source: string): number[] {
    return this.state.rateLimitEvents[source] ?? [];
  }

  addRateLimitEvent(source: string, timestamp: number): void {
    if (!this.state.rateLimitEvents[source]) {
      this.state.rateLimitEvents[source] = [];
    }
    this.state.rateLimitEvents[source].push(timestamp);
    this.dirty = true;
  }

  pruneRateLimitEvents(source: string, windowMs: number): void {
    const cutoff = Date.now() - windowMs;
    const events = this.state.rateLimitEvents[source];
    if (events) {
      this.state.rateLimitEvents[source] = events.filter(t => t > cutoff);
      this.dirty = true;
    }
  }

  // ── Daily counters ──

  getDailyCount(): number {
    this.resetDailyIfNeeded();
    return this.state.dailyCount;
  }

  getDailyPerRepoCount(repoSlug: string): number {
    this.resetDailyIfNeeded();
    return this.state.dailyPerRepo[repoSlug] ?? 0;
  }

  incrementDailyCount(repoSlug: string): void {
    this.resetDailyIfNeeded();
    this.state.dailyCount += 1;
    this.state.dailyPerRepo[repoSlug] = (this.state.dailyPerRepo[repoSlug] ?? 0) + 1;
    this.dirty = true;
  }

  private resetDailyIfNeeded(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (this.state.counterDay !== today) {
      this.state.dailyCount = 0;
      this.state.dailyPerRepo = {};
      this.state.counterDay = today;
      this.dirty = true;
    }
  }

  // ── Sentry poll cursors ──

  getSentryLastPoll(project: string): string | undefined {
    return this.state.sentryLastPoll[project];
  }

  setSentryLastPoll(project: string, timestamp: string): void {
    this.state.sentryLastPoll[project] = timestamp;
    this.dirty = true;
  }
}
