import type { Database } from "../db/index.js";
import { desc, eq } from "drizzle-orm";
import { workItemEvents } from "../db/schema.js";
import type { AppendWorkItemEventInput, WorkItemEventRecord } from "./types.js";

function rowToRecord(row: typeof workItemEvents.$inferSelect): WorkItemEventRecord {
  return {
    id: row.id,
    workItemId: row.workItemId,
    eventType: row.eventType,
    payload: row.payload as Record<string, unknown>,
    actorUserId: row.actorUserId ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

export class WorkItemEventsStore {
  constructor(private readonly db: Database) {}

  async append(input: AppendWorkItemEventInput): Promise<void> {
    await this.db.insert(workItemEvents).values({
      workItemId: input.workItemId,
      eventType: input.eventType,
      payload: input.payload ?? {},
      actorUserId: input.actorUserId,
      createdAt: new Date(),
    });
  }

  async listForWorkItem(workItemId: string): Promise<WorkItemEventRecord[]> {
    const rows = await this.db
      .select()
      .from(workItemEvents)
      .where(eq(workItemEvents.workItemId, workItemId))
      .orderBy(desc(workItemEvents.createdAt));
    return rows.map(rowToRecord);
  }
}
