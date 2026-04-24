CREATE TABLE IF NOT EXISTS "run_checkpoints" (
  "run_id" uuid NOT NULL REFERENCES "runs"("id") ON DELETE CASCADE,
  "checkpoint_key" text NOT NULL,
  "checkpoint_type" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "emitted_at" timestamp with time zone NOT NULL DEFAULT now(),
  "processed_at" timestamp with time zone,
  "processed_error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("run_id", "checkpoint_key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_checkpoints_type_emitted_at_idx"
  ON "run_checkpoints" USING btree ("checkpoint_type", "emitted_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_checkpoints_unprocessed_idx"
  ON "run_checkpoints" USING btree ("emitted_at")
  WHERE "processed_at" IS NULL;
--> statement-breakpoint
INSERT INTO "run_checkpoints" (
  "run_id",
  "checkpoint_key",
  "checkpoint_type",
  "payload",
  "emitted_at",
  "created_at",
  "updated_at"
)
SELECT
  r."id",
  'external_ci_wait_started',
  'run.waiting_external_ci',
  jsonb_build_object(
    'source', 'legacy_awaiting_ci_backfill',
    'legacyStatus', r."status",
    'legacyPhase', r."phase",
    'intentKind', r."intent_kind",
    'requestedBy', r."requested_by"
  ),
  COALESCE(r."started_at", r."created_at", now()),
  now(),
  now()
FROM "runs" r
WHERE r."work_item_id" IS NOT NULL
  AND (
    r."intent_kind" IN (
      'feature_delivery.self_review',
      'feature_delivery.apply_review_feedback',
      'feature_delivery.repair_ci'
    )
    OR r."requested_by" IN ('work-item:auto-review', 'work-item:ci-fix')
  )
  AND (r."phase" = 'awaiting_ci' OR r."status" = 'awaiting_ci')
ON CONFLICT ("run_id", "checkpoint_key") DO NOTHING;
--> statement-breakpoint
UPDATE "runs"
SET
  "status" = 'running',
  "phase" = COALESCE("phase", 'awaiting_ci')
WHERE "status" = 'awaiting_ci';
