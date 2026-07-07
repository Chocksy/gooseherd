CREATE TABLE IF NOT EXISTS "runner_db_slots" (
  "id" smallint PRIMARY KEY,
  "status" text NOT NULL DEFAULT 'free',
  "run_id" uuid,
  "claimed_at" timestamp with time zone,
  CONSTRAINT "runner_db_slots_status_check" CHECK ("status" IN ('free', 'claimed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runner_db_slots_status_idx"
  ON "runner_db_slots" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runner_db_slots_claimed_at_idx"
  ON "runner_db_slots" USING btree ("claimed_at")
  WHERE "claimed_at" IS NOT NULL;
