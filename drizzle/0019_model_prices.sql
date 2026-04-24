CREATE TABLE IF NOT EXISTS "model_prices" (
	"model" text PRIMARY KEY NOT NULL,
	"input_per_m" numeric(12, 6),
	"output_per_m" numeric(12, 6),
	"currency" text DEFAULT 'USD' NOT NULL,
	"source" text DEFAULT 'observed' NOT NULL,
	"first_seen_run_id" uuid,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_prices_missing_idx"
  ON "model_prices" USING btree ("source", "last_seen_at")
  WHERE "input_per_m" IS NULL OR "output_per_m" IS NULL;
