ALTER TABLE "teams" ADD COLUMN "slack_user_group_id" text;
--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "slack_user_group_handle" text;
--> statement-breakpoint
ALTER TABLE "team_members" ADD COLUMN "membership_source" text DEFAULT 'manual' NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "teams_slack_user_group_id_idx"
  ON "teams" USING btree ("slack_user_group_id")
  WHERE "slack_user_group_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "dashboard_auth_sessions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "token_hash" text NOT NULL,
  "principal_type" text NOT NULL,
  "user_id" uuid,
  "auth_method" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "dashboard_auth_sessions"
  ADD CONSTRAINT "dashboard_auth_sessions_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE cascade
  ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_auth_sessions_token_hash_idx"
  ON "dashboard_auth_sessions" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "dashboard_auth_sessions_user_id_idx"
  ON "dashboard_auth_sessions" USING btree ("user_id")
  WHERE "user_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "dashboard_auth_sessions_expires_at_idx"
  ON "dashboard_auth_sessions" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "dashboard_auth_sessions_revoked_at_idx"
  ON "dashboard_auth_sessions" USING btree ("revoked_at");
