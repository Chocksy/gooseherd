ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "work_item_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_work_item_id_idx" ON "runs" ("work_item_id") WHERE "work_item_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
  "id" uuid PRIMARY KEY NOT NULL,
  "slack_user_id" text,
  "github_login" text,
  "jira_account_id" text,
  "display_name" text NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_slack_user_id_idx"
  ON "users" ("slack_user_id")
  WHERE "slack_user_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_github_login_idx"
  ON "users" ("github_login")
  WHERE "github_login" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_jira_account_id_idx"
  ON "users" ("jira_account_id")
  WHERE "jira_account_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "teams" (
  "id" uuid PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "slack_channel_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "teams_name_idx" ON "teams" ("name");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "teams_slack_channel_id_idx" ON "teams" ("slack_channel_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "team_members" (
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "functional_roles" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("team_id", "user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_role_assignments" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "org_role" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("user_id", "org_role")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "work_items" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workflow" text NOT NULL,
  "state" text NOT NULL,
  "substate" text,
  "flags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "title" text NOT NULL,
  "summary" text DEFAULT '' NOT NULL,
  "owner_team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE RESTRICT,
  "home_channel_id" text NOT NULL,
  "home_thread_ts" text NOT NULL,
  "origin_channel_id" text,
  "origin_thread_ts" text,
  "jira_issue_key" text,
  "github_pr_number" integer,
  "github_pr_url" text,
  "source_work_item_id" uuid REFERENCES "work_items"("id") ON DELETE SET NULL,
  "created_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "work_items_workflow_state_idx" ON "work_items" ("workflow", "state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "work_items_owner_team_idx" ON "work_items" ("owner_team_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "work_items_created_at_idx" ON "work_items" ("created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "work_items_jira_issue_key_idx"
  ON "work_items" ("jira_issue_key")
  WHERE "jira_issue_key" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "work_items_github_pr_number_idx"
  ON "work_items" ("github_pr_number")
  WHERE "github_pr_number" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "review_requests" (
  "id" uuid PRIMARY KEY NOT NULL,
  "work_item_id" uuid NOT NULL REFERENCES "work_items"("id") ON DELETE CASCADE,
  "review_round" integer DEFAULT 1 NOT NULL,
  "type" text NOT NULL,
  "target_type" text NOT NULL,
  "target_ref" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text NOT NULL,
  "outcome" text,
  "title" text NOT NULL,
  "request_message" text DEFAULT '' NOT NULL,
  "focus_points" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "requested_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_requests_work_item_round_idx"
  ON "review_requests" ("work_item_id", "review_round");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_requests_status_idx" ON "review_requests" ("status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "review_request_comments" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "review_request_id" uuid NOT NULL REFERENCES "review_requests"("id") ON DELETE CASCADE,
  "author_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "source" text NOT NULL,
  "body" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_request_comments_review_request_id_idx"
  ON "review_request_comments" ("review_request_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "work_item_events" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "work_item_id" uuid NOT NULL REFERENCES "work_items"("id") ON DELETE CASCADE,
  "event_type" text NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "actor_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "work_item_events_work_item_id_created_at_idx"
  ON "work_item_events" ("work_item_id", "created_at");
