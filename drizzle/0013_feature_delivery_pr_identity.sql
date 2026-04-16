DROP INDEX IF EXISTS "work_items_feature_delivery_jira_issue_key_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "work_items_feature_delivery_source_work_item_id_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "work_items_github_pr_number_idx";
--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN IF NOT EXISTS "repo" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "primary_team_id" uuid;
--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "is_default" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "work_items"
SET "repo" = (regexp_match("github_pr_url", '^https://github\.com/([^/]+/[^/]+)/pull/\d+'))[1]
WHERE "repo" IS NULL
  AND "github_pr_url" ~ '^https://github\.com/[^/]+/[^/]+/pull/\d+';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "work_items_repo_github_pr_number_idx"
  ON "work_items" USING btree ("repo", "github_pr_number")
  WHERE "repo" IS NOT NULL AND "github_pr_number" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "work_items_product_discovery_jira_issue_key_idx"
  ON "work_items" USING btree ("jira_issue_key")
  WHERE "workflow" = 'product_discovery' AND "jira_issue_key" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "teams_default_unique_idx"
  ON "teams" USING btree ("is_default")
  WHERE "is_default" = true;
