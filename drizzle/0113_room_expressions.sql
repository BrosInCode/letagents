ALTER TABLE "room_settings" ADD COLUMN "expressions_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "gif" jsonb;
--> statement-breakpoint
ALTER TABLE "message_reactions" ADD COLUMN "agent_key" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "message_reactions" ADD COLUMN "agent_name" text;
--> statement-breakpoint
ALTER TABLE "message_reactions" DROP CONSTRAINT "message_reactions_pk";
--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_pk" PRIMARY KEY ("room_id", "message_number", "account_id", "agent_key", "emoji");
