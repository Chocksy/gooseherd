ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "intent" jsonb;
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "intent_kind" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_intent_kind_idx"
  ON "runs" USING btree ("intent_kind")
  WHERE "intent_kind" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_work_item_intent_kind_idx"
  ON "runs" USING btree ("work_item_id", "intent_kind")
  WHERE "work_item_id" IS NOT NULL AND "intent_kind" IS NOT NULL;
