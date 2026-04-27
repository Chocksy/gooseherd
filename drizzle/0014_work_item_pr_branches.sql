ALTER TABLE "work_items" ADD COLUMN IF NOT EXISTS "github_pr_base_branch" text;
--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN IF NOT EXISTS "github_pr_head_branch" text;
