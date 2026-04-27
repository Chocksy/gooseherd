ALTER TABLE runs ADD COLUMN IF NOT EXISTS prefetch_context jsonb;
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN IF NOT EXISTS auto_review_source_substate text;
