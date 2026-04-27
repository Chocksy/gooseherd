ALTER TABLE "work_items" ADD COLUMN IF NOT EXISTS "github_pr_head_sha" text;
--> statement-breakpoint
