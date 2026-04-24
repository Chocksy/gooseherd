import { eq, desc } from "drizzle-orm";
import type { Database } from "./index.js";
import { modelPrices, runs } from "./schema.js";
import type { RunRecord, TokenUsage } from "../types.js";
import { MODEL_PRICES } from "../llm/model-prices.js";

export interface ModelPriceRecord {
  model: string;
  inputPerM?: number;
  outputPerM?: number;
  currency: string;
  source: string;
  firstSeenRunId?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  updatedBy?: string;
  updatedAt: string;
  missing: boolean;
}

export interface ModelPriceStats {
  totalModels: number;
  missingPrices: number;
  incompleteRuns: number;
}

function toRecord(row: typeof modelPrices.$inferSelect): ModelPriceRecord {
  return {
    model: row.model,
    inputPerM: row.inputPerM === null ? undefined : Number(row.inputPerM),
    outputPerM: row.outputPerM === null ? undefined : Number(row.outputPerM),
    currency: row.currency,
    source: row.source,
    firstSeenRunId: row.firstSeenRunId ?? undefined,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    updatedBy: row.updatedBy ?? undefined,
    updatedAt: row.updatedAt.toISOString(),
    missing: row.inputPerM === null || row.outputPerM === null,
  };
}

function isTokenUsage(value: unknown): value is TokenUsage {
  return Boolean(value && typeof value === "object");
}

function computeCostForUsage(tokenUsage: TokenUsage, prices: Map<string, ModelPriceRecord>): TokenUsage {
  let totalCost = 0;
  const missing = new Set<string>();
  const byModel = (tokenUsage.byModel ?? []).map((entry) => {
    const price = prices.get(entry.model);
    if (price?.inputPerM === undefined || price.outputPerM === undefined) {
      if (entry.costUsd !== undefined) {
        totalCost += entry.costUsd;
        return entry;
      }
      missing.add(entry.model);
      const { costUsd: _costUsd, ...withoutCost } = entry;
      return withoutCost;
    }

    const costUsd = Math.round(((entry.input / 1_000_000) * price.inputPerM + (entry.output / 1_000_000) * price.outputPerM) * 10000) / 10000;
    totalCost += costUsd;
    return { ...entry, costUsd };
  });

  const next: TokenUsage = {
    ...tokenUsage,
    byModel,
  };
  if (totalCost > 0) {
    next.costUsd = Math.round(totalCost * 10000) / 10000;
  } else {
    delete next.costUsd;
  }
  if (missing.size > 0) {
    next.missingPriceModels = [...missing].sort((a, b) => a.localeCompare(b));
    next.costIncomplete = true;
  } else {
    delete next.missingPriceModels;
    delete next.costIncomplete;
  }
  return next;
}

export class ModelPriceStore {
  constructor(private readonly db: Database) {}

  async list(): Promise<{ prices: ModelPriceRecord[]; stats: ModelPriceStats }> {
    const rows = await this.db.select().from(modelPrices).orderBy(desc(modelPrices.lastSeenAt), modelPrices.model);
    const prices = rows.map(toRecord);
    const runRows = await this.db.select({ tokenUsage: runs.tokenUsage }).from(runs);
    const incompleteRuns = runRows.filter((row) =>
      isTokenUsage(row.tokenUsage) && Boolean(row.tokenUsage.costIncomplete)
    ).length;
    return {
      prices,
      stats: {
        totalModels: prices.length,
        missingPrices: prices.filter((price) => price.missing).length,
        incompleteRuns,
      },
    };
  }

  async save(model: string, inputPerM: number, outputPerM: number, updatedBy?: string): Promise<ModelPriceRecord> {
    const now = new Date();
    const rows = await this.db.insert(modelPrices).values({
      model,
      inputPerM: String(inputPerM),
      outputPerM: String(outputPerM),
      source: "manual",
      updatedBy,
      updatedAt: now,
      lastSeenAt: now,
    }).onConflictDoUpdate({
      target: modelPrices.model,
      set: {
        inputPerM: String(inputPerM),
        outputPerM: String(outputPerM),
        source: "manual",
        updatedBy,
        updatedAt: now,
      },
    }).returning();
    return toRecord(rows[0]!);
  }

  async seedFallbackPrices(): Promise<void> {
    const now = new Date();
    for (const [model, price] of Object.entries(MODEL_PRICES)) {
      await this.db.insert(modelPrices).values({
        model,
        inputPerM: String(price.inputPerM),
        outputPerM: String(price.outputPerM),
        source: "fallback",
        lastSeenAt: now,
        updatedAt: now,
      }).onConflictDoNothing();
    }
  }

  async recalculateIncompleteRuns(): Promise<{ updated: number }> {
    const { prices } = await this.list();
    const priceMap = new Map(prices.map((price) => [price.model, price]));
    const runRows = await this.db.select({ id: runs.id, tokenUsage: runs.tokenUsage }).from(runs);
    let updated = 0;

    for (const row of runRows) {
      if (!isTokenUsage(row.tokenUsage) || !row.tokenUsage.costIncomplete) continue;
      const next = computeCostForUsage(row.tokenUsage, priceMap);
      if (JSON.stringify(next) === JSON.stringify(row.tokenUsage)) continue;
      await this.db.update(runs).set({ tokenUsage: next }).where(eq(runs.id, row.id));
      updated++;
    }

    return { updated };
  }
}
