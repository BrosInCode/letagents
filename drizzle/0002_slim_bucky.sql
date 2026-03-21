CREATE TABLE "agent_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"owner_token_id" text NOT NULL,
	"sender_label" text NOT NULL,
	"state" text NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "owner_tokens" (
	"token_id" text PRIMARY KEY NOT NULL,
	"github_user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"oauth_token_expires_at" timestamp with time zone,
	CONSTRAINT "owner_tokens_github_user_id_unique" UNIQUE("github_user_id")
);
--> statement-breakpoint
ALTER TABLE "project_admins" RENAME COLUMN "project_id" TO "room_id";--> statement-breakpoint
ALTER TABLE "rooms" DROP CONSTRAINT "rooms_code_unique";--> statement-breakpoint
ALTER TABLE "rooms" DROP CONSTRAINT "rooms_name_unique";--> statement-breakpoint
ALTER TABLE "project_admins" DROP CONSTRAINT "project_admins_project_id_rooms_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_owner_token_id_owner_tokens_token_id_fk" FOREIGN KEY ("owner_token_id") REFERENCES "public"."owner_tokens"("token_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_sessions_room_id_idx" ON "agent_sessions" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "agent_sessions_owner_token_id_idx" ON "agent_sessions" USING btree ("owner_token_id");--> statement-breakpoint
ALTER TABLE "project_admins" ADD CONSTRAINT "project_admins_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- NOTE: rooms.code and rooms.name columns are intentionally preserved for backward
-- compatibility with existing data. They will be deprecated in a future migration
-- once all clients have migrated to canonical room IDs.
--> statement-breakpoint
ALTER TABLE "project_admins" DROP CONSTRAINT "project_admins_pk";
--> statement-breakpoint
ALTER TABLE "project_admins" ADD CONSTRAINT "project_admins_pk" PRIMARY KEY("room_id","account_id");