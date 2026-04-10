CREATE TABLE "agent_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"runtime" text NOT NULL,
	"provider" text,
	"model" text,
	"tools" text[] DEFAULT '{}' NOT NULL,
	"mode" text,
	"extensions" text[] DEFAULT '{}' NOT NULL,
	"extra_args" text,
	"is_built_in" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"custom_command_template" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agent_profiles_active_idx" ON "agent_profiles" USING btree ("is_active");
--> statement-breakpoint
CREATE INDEX "agent_profiles_runtime_idx" ON "agent_profiles" USING btree ("runtime");
