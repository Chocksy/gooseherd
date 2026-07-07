CREATE TABLE IF NOT EXISTS "agent_profile_policies" (
  "id" uuid PRIMARY KEY,
  "scope" text NOT NULL,
  "pipeline_id" text,
  "intent_kind" text,
  "node_id" text,
  "action" text,
  "purpose" text,
  "target_key" text NOT NULL,
  "mode" text NOT NULL DEFAULT 'single',
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_profile_policies_target_key_idx"
  ON "agent_profile_policies" USING btree ("target_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_profile_policies_scope_idx"
  ON "agent_profile_policies" USING btree ("scope");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_profile_policies_enabled_idx"
  ON "agent_profile_policies" USING btree ("enabled");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_profile_policy_members" (
  "id" uuid PRIMARY KEY,
  "policy_id" uuid NOT NULL REFERENCES "agent_profile_policies"("id") ON DELETE CASCADE,
  "profile_id" uuid NOT NULL REFERENCES "agent_profiles"("id") ON DELETE CASCADE,
  "role" text,
  "ordinal" integer NOT NULL DEFAULT 0,
  "weight" integer,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_profile_policy_members_policy_profile_idx"
  ON "agent_profile_policy_members" USING btree ("policy_id", "profile_id", "role");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_profile_policy_members_policy_idx"
  ON "agent_profile_policy_members" USING btree ("policy_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_profile_policy_members_profile_idx"
  ON "agent_profile_policy_members" USING btree ("profile_id");
