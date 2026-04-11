import { randomUUID } from "node:crypto";
import { eq, and, desc } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { reviewRequests, reviewRequestComments } from "../db/schema.js";
import type {
  CompleteReviewRequestInput,
  CreateReviewRequestCommentInput,
  CreateReviewRequestInput,
  ReviewRequestCommentRecord,
  ReviewRequestRecord,
} from "./types.js";

type ReviewRequestRow = typeof reviewRequests.$inferSelect;

function rowToRecord(row: ReviewRequestRow): ReviewRequestRecord {
  return {
    id: row.id,
    workItemId: row.workItemId,
    reviewRound: row.reviewRound,
    type: row.type as ReviewRequestRecord["type"],
    targetType: row.targetType as ReviewRequestRecord["targetType"],
    targetRef: row.targetRef as Record<string, unknown>,
    status: row.status as ReviewRequestRecord["status"],
    outcome: row.outcome as ReviewRequestRecord["outcome"] | undefined,
    title: row.title,
    requestMessage: row.requestMessage,
    focusPoints: row.focusPoints as string[],
    requestedByUserId: row.requestedByUserId,
    requestedAt: row.requestedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToCommentRecord(row: typeof reviewRequestComments.$inferSelect): ReviewRequestCommentRecord {
  return {
    id: row.id,
    reviewRequestId: row.reviewRequestId,
    authorUserId: row.authorUserId ?? undefined,
    source: row.source as ReviewRequestCommentRecord["source"],
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

export class ReviewRequestStore {
  constructor(private readonly db: Database) {}

  async createReviewRequest(input: CreateReviewRequestInput): Promise<ReviewRequestRecord> {
    const id = randomUUID();
    const now = new Date();

    await this.db.insert(reviewRequests).values({
      id,
      workItemId: input.workItemId,
      reviewRound: input.reviewRound,
      type: input.type,
      targetType: input.targetType,
      targetRef: input.targetRef,
      status: input.status,
      title: input.title,
      requestMessage: input.requestMessage ?? "",
      focusPoints: input.focusPoints ?? [],
      requestedByUserId: input.requestedByUserId,
      requestedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    return (await this.getReviewRequest(id))!;
  }

  async getReviewRequest(id: string): Promise<ReviewRequestRecord | undefined> {
    const rows = await this.db.select().from(reviewRequests).where(eq(reviewRequests.id, id));
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async listReviewRequestsForWorkItem(workItemId: string, reviewRound?: number): Promise<ReviewRequestRecord[]> {
    const rows = await this.db
      .select()
      .from(reviewRequests)
      .where(
        reviewRound === undefined
          ? eq(reviewRequests.workItemId, workItemId)
          : and(eq(reviewRequests.workItemId, workItemId), eq(reviewRequests.reviewRound, reviewRound))
      )
      .orderBy(desc(reviewRequests.createdAt));
    return rows.map(rowToRecord);
  }

  async completeReviewRequest(id: string, input: CompleteReviewRequestInput): Promise<ReviewRequestRecord> {
    const resolvedAt = input.resolvedAt ? new Date(input.resolvedAt) : new Date();

    await this.db
      .update(reviewRequests)
      .set({
        status: "completed",
        outcome: input.outcome,
        resolvedAt,
        updatedAt: new Date(),
      })
      .where(eq(reviewRequests.id, id));

    const updated = await this.getReviewRequest(id);
    if (!updated) throw new Error(`ReviewRequest not found: ${id}`);
    return updated;
  }

  async setStatus(id: string, status: ReviewRequestRecord["status"]): Promise<ReviewRequestRecord> {
    await this.db
      .update(reviewRequests)
      .set({
        status,
        updatedAt: new Date(),
      })
      .where(eq(reviewRequests.id, id));

    const updated = await this.getReviewRequest(id);
    if (!updated) throw new Error(`ReviewRequest not found: ${id}`);
    return updated;
  }

  async addComment(input: CreateReviewRequestCommentInput): Promise<void> {
    await this.db.insert(reviewRequestComments).values({
      reviewRequestId: input.reviewRequestId,
      authorUserId: input.authorUserId,
      source: input.source,
      body: input.body,
      createdAt: new Date(),
    });
  }

  async listComments(reviewRequestId: string): Promise<ReviewRequestCommentRecord[]> {
    const rows = await this.db
      .select()
      .from(reviewRequestComments)
      .where(eq(reviewRequestComments.reviewRequestId, reviewRequestId))
      .orderBy(desc(reviewRequestComments.createdAt), desc(reviewRequestComments.id));
    return rows.map(rowToCommentRecord);
  }
}
