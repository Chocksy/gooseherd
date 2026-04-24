#!/usr/bin/env tsx
/**
 * JSON → PostgreSQL data migration script.
 *
 * Reads existing JSON data files from DATA_DIR (default: "data") and
 * batch-inserts them into PostgreSQL. Idempotent — uses ON CONFLICT DO NOTHING.
 *
 * Usage:
 *   npx tsx src/db/seed-json.ts
 *   DATA_DIR=/path/to/data npx tsx src/db/seed-json.ts
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { initDatabase, closeDatabase, getDb } from "./index.js";
import {
  runs,
  learningOutcomes,
  observerDedup,
  observerRateEvents,
  observerDailyCounters,
  observerPollCursors,
  observerRuleOutcomes,
  pipelines,
  sessions,
  conversations,
} from "./schema.js";
import { isRunIntent } from "../runs/run-intent.js";

const DATA_DIR = process.env.DATA_DIR ?? "data";

function readJson<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    console.warn(`  ⚠ Could not parse ${filePath}`);
    return undefined;
  }
}

function log(msg: string): void {
  console.log(`[seed] ${msg}`);
}

// ── Runs ──

interface JsonRun {
  id: string;
  status: string;
  phase?: string;
  repoSlug: string;
  task: string;
  baseBranch: string;
  branchName: string;
  requestedBy: string;
  channelId: string;
  threadTs: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  logsPath?: string;
  statusMessageTs?: string;
  commitSha?: string;
  changedFiles?: string[];
  prUrl?: string;
  feedback?: unknown;
  error?: string;
  parentRunId?: string;
  rootRunId?: string;
  chainIndex?: number;
  parentBranchName?: string;
  feedbackNote?: string;
  pipelineHint?: string;
  skipNodes?: string[];
  enableNodes?: string[];
  ciFixAttempts?: number;
  ciConclusion?: string;
  prNumber?: number;
  title?: string;
  tokenUsage?: unknown;
  teamId?: string;
  intent?: unknown;
  intentKind?: string;
}

async function seedRuns(): Promise<number> {
  const data = readJson<JsonRun[]>(path.join(DATA_DIR, "runs.json"));
  if (!data?.length) return 0;

  const db = getDb();
  let count = 0;
  for (const r of data) {
    const intent = isRunIntent(r.intent) ? r.intent : undefined;
    await db
      .insert(runs)
      .values({
        id: r.id,
        status: r.status,
        phase: r.phase,
        repoSlug: r.repoSlug,
        task: r.task,
        baseBranch: r.baseBranch,
        branchName: r.branchName,
        requestedBy: r.requestedBy,
        channelId: r.channelId,
        threadTs: r.threadTs,
        createdAt: new Date(r.createdAt),
        startedAt: r.startedAt ? new Date(r.startedAt) : null,
        finishedAt: r.finishedAt ? new Date(r.finishedAt) : null,
        logsPath: r.logsPath,
        statusMessageTs: r.statusMessageTs,
        commitSha: r.commitSha,
        changedFiles: r.changedFiles,
        prUrl: r.prUrl,
        feedback: r.feedback,
        error: r.error,
        parentRunId: r.parentRunId,
        rootRunId: r.rootRunId,
        chainIndex: r.chainIndex,
        parentBranchName: r.parentBranchName,
        feedbackNote: r.feedbackNote,
        pipelineHint: r.pipelineHint,
        skipNodes: r.skipNodes,
        enableNodes: r.enableNodes,
        ciFixAttempts: r.ciFixAttempts,
        ciConclusion: r.ciConclusion,
        prNumber: r.prNumber,
        title: r.title,
        tokenUsage: r.tokenUsage,
        teamId: r.teamId,
        intent,
        intentKind: intent?.kind ?? r.intentKind,
      })
      .onConflictDoNothing();
    count++;
  }
  return count;
}

// ── Learning outcomes ──

interface JsonOutcome {
  runId: string;
  ruleId?: string;
  source: string;
  repoSlug: string;
  status: string;
  errorCategory?: string;
  durationMs: number;
  costUsd: number;
  changedFiles?: number;
  pipelineId?: string;
  timestamp: string;
}

async function seedLearningOutcomes(): Promise<number> {
  const data = readJson<JsonOutcome[]>(path.join(DATA_DIR, "learning-outcomes.json"));
  if (!data?.length) return 0;

  const db = getDb();

  // No natural unique key — skip if table already has data to avoid duplicates on re-run
  const existing = await db.select({ id: learningOutcomes.id }).from(learningOutcomes).limit(1);
  if (existing.length > 0) {
    log("  learning_outcomes already has data, skipping (no natural unique key)");
    return 0;
  }

  let count = 0;
  for (const o of data) {
    await db
      .insert(learningOutcomes)
      .values({
        runId: o.runId,
        ruleId: o.ruleId,
        source: o.source,
        repoSlug: o.repoSlug,
        status: o.status,
        errorCategory: o.errorCategory,
        durationMs: o.durationMs,
        costUsd: String(o.costUsd),
        changedFiles: o.changedFiles ?? 0,
        pipelineId: o.pipelineId,
        timestamp: new Date(o.timestamp),
      });
    count++;
  }
  return count;
}

// ── Observer state ──
// The old observer-state.json was a single blob with multiple sections.

interface JsonObserverState {
  dedup?: Record<string, { seenAt: number; ttlMs: number; runId?: string; ruleId?: string; completedAt?: number }>;
  rateLimitEvents?: Array<{ source: string; timestampMs: number }>;
  dailyCounters?: Record<string, { dailyCount: number; perRepo: Record<string, number> }>;
  pollCursors?: Record<string, Record<string, string>>;
  ruleOutcomes?: Record<string, { success: number; failure: number; lastOutcome: string; lastAt?: string }>;
}

async function seedObserverState(): Promise<number> {
  const data = readJson<JsonObserverState>(path.join(DATA_DIR, "observer-state.json"));
  if (!data) return 0;

  const db = getDb();
  let count = 0;

  // Dedup entries
  if (data.dedup) {
    for (const [key, entry] of Object.entries(data.dedup)) {
      await db
        .insert(observerDedup)
        .values({
          key,
          seenAt: entry.seenAt,
          ttlMs: entry.ttlMs,
          runId: entry.runId,
          ruleId: entry.ruleId,
          completedAt: entry.completedAt,
        })
        .onConflictDoNothing();
      count++;
    }
  }

  // Rate limit events — no natural unique key, skip if table already has data
  if (data.rateLimitEvents) {
    const existingRate = await db.select({ id: observerRateEvents.id }).from(observerRateEvents).limit(1);
    if (existingRate.length > 0) {
      log("  observer_rate_events already has data, skipping");
    } else {
      for (const evt of data.rateLimitEvents) {
        await db
          .insert(observerRateEvents)
          .values({ source: evt.source, timestampMs: evt.timestampMs });
        count++;
      }
    }
  }

  // Daily counters
  if (data.dailyCounters) {
    for (const [day, entry] of Object.entries(data.dailyCounters)) {
      await db
        .insert(observerDailyCounters)
        .values({ counterDay: day, dailyCount: entry.dailyCount, perRepo: entry.perRepo })
        .onConflictDoNothing();
      count++;
    }
  }

  // Poll cursors
  if (data.pollCursors) {
    for (const [sourceType, keys] of Object.entries(data.pollCursors)) {
      for (const [sourceKey, cursorValue] of Object.entries(keys)) {
        await db
          .insert(observerPollCursors)
          .values({ sourceType, sourceKey, cursorValue })
          .onConflictDoNothing();
        count++;
      }
    }
  }

  // Rule outcomes
  if (data.ruleOutcomes) {
    for (const [ruleId, entry] of Object.entries(data.ruleOutcomes)) {
      await db
        .insert(observerRuleOutcomes)
        .values({
          ruleId,
          success: entry.success,
          failure: entry.failure,
          lastOutcome: entry.lastOutcome,
          lastAt: entry.lastAt ? new Date(entry.lastAt) : null,
        })
        .onConflictDoNothing();
      count++;
    }
  }

  return count;
}

// ── Pipelines ──

interface JsonPipeline {
  id: string;
  name: string;
  description?: string;
  yaml: string;
  isBuiltIn?: boolean;
  nodeCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

async function seedPipelines(): Promise<number> {
  const data = readJson<JsonPipeline[]>(path.join(DATA_DIR, "pipelines.json"));
  if (!data?.length) return 0;

  const db = getDb();
  let count = 0;
  for (const p of data) {
    await db
      .insert(pipelines)
      .values({
        id: p.id,
        name: p.name,
        description: p.description,
        yaml: p.yaml,
        isBuiltIn: p.isBuiltIn ?? false,
        nodeCount: p.nodeCount ?? 0,
        createdAt: p.createdAt ? new Date(p.createdAt) : new Date(),
        updatedAt: p.updatedAt ? new Date(p.updatedAt) : new Date(),
      })
      .onConflictDoNothing();
    count++;
  }
  return count;
}

// ── Sessions ──

interface JsonSession {
  id: string;
  goal: string;
  repoSlug: string;
  baseBranch: string;
  status: string;
  plan?: unknown[];
  context?: Record<string, unknown>;
  maxRuns?: number;
  completedRuns?: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  requestedBy: string;
  channelId: string;
  threadTs: string;
  error?: string;
}

async function seedSessions(): Promise<number> {
  const data = readJson<JsonSession[]>(path.join(DATA_DIR, "sessions.json"));
  if (!data?.length) return 0;

  const db = getDb();
  let count = 0;
  for (const s of data) {
    await db
      .insert(sessions)
      .values({
        id: s.id,
        goal: s.goal,
        repoSlug: s.repoSlug,
        baseBranch: s.baseBranch,
        status: s.status,
        plan: s.plan ?? [],
        context: s.context ?? {},
        maxRuns: s.maxRuns ?? 10,
        completedRuns: s.completedRuns ?? 0,
        createdAt: new Date(s.createdAt),
        updatedAt: new Date(s.updatedAt),
        completedAt: s.completedAt ? new Date(s.completedAt) : null,
        requestedBy: s.requestedBy,
        channelId: s.channelId,
        threadTs: s.threadTs,
        error: s.error,
      })
      .onConflictDoNothing();
    count++;
  }
  return count;
}

// ── Conversations ──

interface JsonConversation {
  messages: unknown[];
  lastAccess?: string;
}

async function seedConversations(): Promise<number> {
  const convDir = path.join(DATA_DIR, "conversations");
  if (!existsSync(convDir)) return 0;

  const files = readdirSync(convDir).filter((f) => f.endsWith(".json"));
  if (!files.length) return 0;

  const db = getDb();
  let count = 0;
  for (const file of files) {
    const threadKey = file.replace(/\.json$/, "");
    const data = readJson<JsonConversation>(path.join(convDir, file));
    if (!data) continue;

    await db
      .insert(conversations)
      .values({
        threadKey,
        messages: data.messages ?? [],
        lastAccess: data.lastAccess ? new Date(data.lastAccess) : new Date(),
      })
      .onConflictDoNothing();
    count++;
  }
  return count;
}

// ── Main ──

async function main(): Promise<void> {
  log(`Reading JSON data from: ${path.resolve(DATA_DIR)}`);

  if (!existsSync(DATA_DIR)) {
    log("Data directory not found — nothing to migrate.");
    process.exit(0);
  }

  await initDatabase();
  log("Connected to PostgreSQL and ran migrations.");

  const results = {
    runs: await seedRuns(),
    learningOutcomes: await seedLearningOutcomes(),
    observerState: await seedObserverState(),
    pipelines: await seedPipelines(),
    sessions: await seedSessions(),
    conversations: await seedConversations(),
  };

  log("Migration complete:");
  for (const [table, count] of Object.entries(results)) {
    log(`  ${table}: ${count} records`);
  }

  // auth_credentials skipped — encrypted bytea columns require ENCRYPTION_KEY
  // and the old JSON format stored plaintext. Re-enter via the setup wizard.
  log("  auth_credentials: skipped (re-enter via setup wizard)");

  await closeDatabase();
  log("Done.");
}

main().catch((err) => {
  console.error("[seed] Fatal error:", err);
  process.exit(1);
});
