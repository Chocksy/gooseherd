/**
 * Session Manager — persistent goal-oriented loops backed by PostgreSQL.
 */

import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { logInfo, logWarn, logError } from "../logger.js";
import type { RunEnqueuer } from "../observer/run-enqueuer.js";
import type { NewRunInput } from "../types.js";
import type { Database } from "../db/index.js";
import { sessions } from "../db/schema.js";

// ── Types ──

export type SessionStatus = "planning" | "running" | "waiting" | "completed" | "failed" | "paused";

export interface SessionStep {
  id: string;
  description: string;
  runId?: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  result?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface SessionRecord {
  id: string;
  goal: string;
  repoSlug: string;
  baseBranch: string;
  status: SessionStatus;
  plan: SessionStep[];
  context: Record<string, unknown>;
  maxRuns: number;
  completedRuns: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  requestedBy: string;
  channelId: string;
  threadTs: string;
  error?: string;
}

/** LLM plan output shape. */
export interface PlanOutput {
  steps: Array<{ description: string; task: string }>;
  reasoning: string;
}

/** LLM evaluation output shape. */
export interface EvaluateOutput {
  next_action: "continue" | "done" | "fail" | "replan";
  step_result: string;
  updated_context: Record<string, unknown>;
  reason: string;
}

export type PlanGoalFn = (goal: string, repoSlug: string, baseBranch: string) => Promise<PlanOutput>;
export type EvaluateProgressFn = (session: SessionRecord) => Promise<EvaluateOutput>;

// ── Default LLM-backed implementations ──

const PLAN_SYSTEM_PROMPT = `You are a software project planner. Break a high-level goal into concrete, sequential tasks that an AI coding agent can execute one at a time.

Each step should be a self-contained task with a clear description and a task instruction for the agent.

Respond with JSON:
{
  "steps": [
    { "description": "Short human-readable description", "task": "Detailed instruction for the AI agent" }
  ],
  "reasoning": "Brief explanation of why this plan makes sense"
}

Rules:
- Each step should be independently executable as a pipeline run
- Steps should be ordered logically (dependencies first)
- Keep to 2-8 steps maximum
- Each task instruction should be specific and actionable
- Include verification steps where appropriate`;

const EVALUATE_SYSTEM_PROMPT = `You evaluate progress of a multi-step software goal. Based on completed steps and their outcomes, decide what to do next.

Respond with JSON:
{
  "next_action": "continue" | "done" | "fail" | "replan",
  "step_result": "Summary of what the last step achieved",
  "updated_context": { "any": "new context to carry forward" },
  "reason": "Why this decision"
}

Rules:
- "continue": proceed to next planned step
- "done": goal is achieved, even if steps remain
- "fail": goal cannot be achieved, abort
- "replan": current plan won't work, needs new approach (treat as continue for now)`;

export function createLLMPlanGoal(
  callLLMForJSON: <T>(system: string, userMessage: string, maxTokens: number) => Promise<T>
): PlanGoalFn {
  return async (goal, repoSlug, baseBranch) => {
    const userMsg = `Goal: ${goal}\nRepository: ${repoSlug}\nBranch: ${baseBranch}`;
    return callLLMForJSON<PlanOutput>(PLAN_SYSTEM_PROMPT, userMsg, 1024);
  };
}

export function createLLMEvaluateProgress(
  callLLMForJSON: <T>(system: string, userMessage: string, maxTokens: number) => Promise<T>
): EvaluateProgressFn {
  return async (session) => {
    const completedSteps = session.plan
      .filter(s => s.status !== "pending")
      .map(s => `- ${s.description}: ${s.result ?? s.status}`)
      .join("\n");

    const remainingSteps = session.plan
      .filter(s => s.status === "pending")
      .map(s => `- ${s.description}`)
      .join("\n");

    const userMsg = [
      `Goal: ${session.goal}`,
      `Completed steps:\n${completedSteps}`,
      `Remaining steps:\n${remainingSteps || "(none)"}`,
      `Completed runs: ${String(session.completedRuns)}/${String(session.maxRuns)}`,
      `Context: ${JSON.stringify(session.context)}`
    ].join("\n\n");

    return callLLMForJSON<EvaluateOutput>(EVALUATE_SYSTEM_PROMPT, userMsg, 512);
  };
}

// ── Helpers ──

function rowToSession(row: typeof sessions.$inferSelect): SessionRecord {
  return {
    id: row.id,
    goal: row.goal,
    repoSlug: row.repoSlug,
    baseBranch: row.baseBranch,
    status: row.status as SessionStatus,
    plan: row.plan as SessionStep[],
    context: row.context as Record<string, unknown>,
    maxRuns: row.maxRuns,
    completedRuns: row.completedRuns,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString(),
    requestedBy: row.requestedBy,
    channelId: row.channelId,
    threadTs: row.threadTs,
    error: row.error ?? undefined,
  };
}

// ── Session Manager ──

export class SessionManager {
  private readonly db: Database;
  private readonly runEnqueuer: RunEnqueuer;
  private readonly planGoal?: PlanGoalFn;
  private readonly evaluateProgress?: EvaluateProgressFn;

  constructor(
    db: Database,
    runEnqueuer: RunEnqueuer,
    planGoal?: PlanGoalFn,
    evaluateProgress?: EvaluateProgressFn
  ) {
    this.db = db;
    this.runEnqueuer = runEnqueuer;
    this.planGoal = planGoal;
    this.evaluateProgress = evaluateProgress;
  }

  async load(): Promise<void> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(sessions);
    logInfo("SessionManager: loaded sessions", { count: rows[0]?.count ?? 0 });
  }

  async createSession(opts: {
    goal: string;
    repoSlug: string;
    baseBranch: string;
    maxRuns?: number;
    requestedBy: string;
    channelId: string;
    threadTs: string;
  }): Promise<SessionRecord> {
    const now = new Date();
    const id = randomUUID();

    await this.db.insert(sessions).values({
      id,
      goal: opts.goal,
      repoSlug: opts.repoSlug,
      baseBranch: opts.baseBranch,
      status: "planning",
      plan: [],
      context: {},
      maxRuns: opts.maxRuns ?? 10,
      completedRuns: 0,
      createdAt: now,
      updatedAt: now,
      requestedBy: opts.requestedBy,
      channelId: opts.channelId,
      threadTs: opts.threadTs,
    });

    logInfo("SessionManager: created session", { id, goal: opts.goal });
    return (await this.getSession(id))!;
  }

  async planSession(sessionId: string): Promise<SessionRecord> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (!this.planGoal) throw new Error("No planner configured for session planning");

    const parsed = await this.planGoal(session.goal, session.repoSlug, session.baseBranch);
    const plan: SessionStep[] = parsed.steps.map((s) => ({
      id: randomUUID().slice(0, 8),
      description: s.description,
      status: "pending" as const,
    }));

    const context = { planReasoning: parsed.reasoning, stepTasks: parsed.steps.map(s => s.task) };

    await this.db
      .update(sessions)
      .set({ plan, context, status: "running", updatedAt: new Date() })
      .where(eq(sessions.id, sessionId));

    logInfo("SessionManager: planned session", { id: sessionId, steps: plan.length });
    return (await this.getSession(sessionId))!;
  }

  async executeNextStep(sessionId: string): Promise<SessionRecord> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    if (session.completedRuns >= session.maxRuns) {
      await this.db
        .update(sessions)
        .set({
          status: "failed",
          error: `Max runs limit reached (${String(session.maxRuns)})`,
          updatedAt: new Date(),
        })
        .where(eq(sessions.id, sessionId));
      return (await this.getSession(sessionId))!;
    }

    const nextStepIndex = session.plan.findIndex(s => s.status === "pending");
    if (nextStepIndex === -1) {
      await this.db
        .update(sessions)
        .set({
          status: "completed",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(sessions.id, sessionId));
      return (await this.getSession(sessionId))!;
    }

    const step = session.plan[nextStepIndex]!;
    const stepTasks = session.context["stepTasks"] as string[] | undefined;
    const task = stepTasks?.[nextStepIndex] ?? step.description;

    const input: NewRunInput = {
      repoSlug: session.repoSlug,
      task,
      baseBranch: session.baseBranch,
      requestedBy: session.requestedBy,
      channelId: session.channelId,
      threadTs: session.threadTs,
      runtime: "local",
    };

    const run = await this.runEnqueuer.enqueueRun(input);

    // Update the step in the plan
    const updatedPlan = [...session.plan];
    updatedPlan[nextStepIndex] = {
      ...step,
      status: "running",
      runId: run.id,
      startedAt: new Date().toISOString(),
    };

    await this.db
      .update(sessions)
      .set({
        plan: updatedPlan,
        status: "waiting",
        completedRuns: session.completedRuns + 1,
        updatedAt: new Date(),
      })
      .where(eq(sessions.id, sessionId));

    logInfo("SessionManager: started step", { sessionId, stepId: step.id, runId: run.id });
    return (await this.getSession(sessionId))!;
  }

  async onRunCompleted(runId: string, status: string): Promise<void> {
    // Find session containing this run
    const allSessions = await this.db.select().from(sessions).where(
      inArray(sessions.status, ["running", "waiting"])
    );

    const sessionRow = allSessions.find(s => {
      const plan = s.plan as SessionStep[];
      return plan.some(step => step.runId === runId);
    });
    if (!sessionRow) return;

    const session = rowToSession(sessionRow);
    const stepIndex = session.plan.findIndex(s => s.runId === runId);
    if (stepIndex === -1) return;

    // Update step status
    const updatedPlan = [...session.plan];
    updatedPlan[stepIndex] = {
      ...updatedPlan[stepIndex]!,
      status: status === "completed" ? "completed" : "failed",
      completedAt: new Date().toISOString(),
      result: status,
    };

    if (status !== "completed" && this.evaluateProgress) {
      try {
        const tempSession = { ...session, plan: updatedPlan };
        const evaluation = await this.evaluateProgress(tempSession);
        if (evaluation.next_action === "fail") {
          await this.db
            .update(sessions)
            .set({
              plan: updatedPlan,
              status: "failed",
              error: evaluation.reason,
              updatedAt: new Date(),
            })
            .where(eq(sessions.id, session.id));
          return;
        }
        if (evaluation.next_action === "done") {
          await this.db
            .update(sessions)
            .set({
              plan: updatedPlan,
              status: "completed",
              completedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(sessions.id, session.id));
          return;
        }
        // "continue" or "replan"
        const mergedContext = { ...session.context, ...evaluation.updated_context };
        await this.db
          .update(sessions)
          .set({ plan: updatedPlan, context: mergedContext, updatedAt: new Date() })
          .where(eq(sessions.id, session.id));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown";
        logWarn("SessionManager: evaluation failed, continuing", { sessionId: session.id, error: msg });
        // Still persist the updated plan even though evaluation failed
        await this.db
          .update(sessions)
          .set({ plan: updatedPlan, updatedAt: new Date() })
          .where(eq(sessions.id, session.id));
      }
    } else {
      await this.db
        .update(sessions)
        .set({ plan: updatedPlan, updatedAt: new Date() })
        .where(eq(sessions.id, session.id));
    }

    // Auto-advance to next step
    await this.db
      .update(sessions)
      .set({ status: "running", updatedAt: new Date() })
      .where(eq(sessions.id, session.id));

    try {
      await this.executeNextStep(session.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      logError("SessionManager: failed to advance session", { sessionId: session.id, error: msg });
      await this.db
        .update(sessions)
        .set({ status: "failed", error: msg, updatedAt: new Date() })
        .where(eq(sessions.id, session.id));
    }
  }

  // ── Query methods ──

  async getSession(id: string): Promise<SessionRecord | undefined> {
    const rows = await this.db.select().from(sessions).where(eq(sessions.id, id));
    return rows[0] ? rowToSession(rows[0]) : undefined;
  }

  async listSessions(): Promise<SessionRecord[]> {
    const rows = await this.db.select().from(sessions);
    return rows.map(rowToSession);
  }

  async getActiveSessions(): Promise<SessionRecord[]> {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(inArray(sessions.status, ["planning", "running", "waiting"]));
    return rows.map(rowToSession);
  }

  async pauseSession(id: string): Promise<boolean> {
    const session = await this.getSession(id);
    if (!session || session.status === "completed" || session.status === "failed") return false;
    await this.db
      .update(sessions)
      .set({ status: "paused", updatedAt: new Date() })
      .where(eq(sessions.id, id));
    return true;
  }

  async resumeSession(id: string): Promise<SessionRecord | undefined> {
    const session = await this.getSession(id);
    if (!session || session.status !== "paused") return undefined;
    await this.db
      .update(sessions)
      .set({ status: "running", updatedAt: new Date() })
      .where(eq(sessions.id, id));
    return this.executeNextStep(id);
  }
}
