ALTER TABLE "runs" ADD COLUMN "runtime" text NOT NULL DEFAULT 'local';
UPDATE "runs" SET "runtime" = CASE
  WHEN COALESCE("status", '') <> '' THEN 'local'
  ELSE 'local'
END;
CREATE INDEX "runs_runtime_idx" ON "runs" ("runtime");
