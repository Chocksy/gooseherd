DROP INDEX IF EXISTS "work_items_jira_issue_key_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "work_items_feature_delivery_jira_issue_key_idx"
  ON "work_items" USING btree ("jira_issue_key")
  WHERE "jira_issue_key" IS NOT NULL AND "workflow" = 'feature_delivery';
