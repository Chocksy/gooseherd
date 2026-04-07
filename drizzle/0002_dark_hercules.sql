CREATE TABLE "eval_results" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"scenario_name" text NOT NULL,
	"run_id" uuid NOT NULL,
	"config_label" text,
	"pipeline" text,
	"model" text,
	"overall_pass" boolean NOT NULL,
	"overall_score" integer NOT NULL,
	"judge_results" jsonb NOT NULL,
	"duration_ms" integer NOT NULL,
	"cost_usd" numeric(10, 4) NOT NULL,
	"tags" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "eval_scenario_idx" ON "eval_results" USING btree ("scenario_name");--> statement-breakpoint
CREATE INDEX "eval_created_at_idx" ON "eval_results" USING btree ("created_at");