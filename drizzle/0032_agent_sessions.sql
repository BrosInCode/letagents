CREATE TYPE "room_agent_session_kind" AS ENUM('controller', 'worker');--> statement-breakpoint
CREATE TABLE "room_agent_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"session_kind" "room_agent_session_kind" NOT NULL,
	"runtime" text NOT NULL,
	"actor_label" text NOT NULL,
	"agent_key" text NOT NULL,
	"agent_instance_id" text,
	"display_name" text NOT NULL,
	"owner_account_id" text NOT NULL,
	"owner_label" text NOT NULL,
	"ide_label" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "room_agent_sessions_token_hash_unique" UNIQUE("token_hash")
);--> statement-breakpoint
ALTER TABLE "room_agent_sessions" ADD CONSTRAINT "room_agent_sessions_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "room_agent_sessions" ADD CONSTRAINT "room_agent_sessions_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "room_agent_presence" ADD COLUMN "agent_session_id" text;--> statement-breakpoint
ALTER TABLE "room_agent_presence" ADD COLUMN "session_kind" "room_agent_session_kind" DEFAULT 'controller' NOT NULL;--> statement-breakpoint
ALTER TABLE "room_agent_presence" ADD COLUMN "runtime" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "room_agent_presence" ADD CONSTRAINT "room_agent_presence_agent_session_id_room_agent_sessions_session_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."room_agent_sessions"("session_id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "room_agent_delivery_sessions" ADD COLUMN "agent_session_id" text;--> statement-breakpoint
ALTER TABLE "room_agent_delivery_sessions" ADD COLUMN "session_kind" "room_agent_session_kind" DEFAULT 'controller' NOT NULL;--> statement-breakpoint
ALTER TABLE "room_agent_delivery_sessions" ADD COLUMN "runtime" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "room_agent_delivery_sessions" ADD COLUMN "delivery_key" text;--> statement-breakpoint
UPDATE "room_agent_delivery_sessions" SET "delivery_key" = CASE WHEN "agent_session_id" IS NOT NULL THEN 'agent_session:' || "agent_session_id" ELSE 'controller:' || "actor_label" END;--> statement-breakpoint
ALTER TABLE "room_agent_delivery_sessions" ALTER COLUMN "delivery_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "room_agent_delivery_sessions" DROP CONSTRAINT "room_agent_delivery_sessions_pk";--> statement-breakpoint
ALTER TABLE "room_agent_delivery_sessions" ADD CONSTRAINT "room_agent_delivery_sessions_pk" PRIMARY KEY("room_id","delivery_key");--> statement-breakpoint
ALTER TABLE "room_agent_delivery_sessions" ADD CONSTRAINT "room_agent_delivery_sessions_agent_session_id_room_agent_sessions_session_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."room_agent_sessions"("session_id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "room_agent_sessions_room_id_idx" ON "room_agent_sessions" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "room_agent_sessions_room_kind_idx" ON "room_agent_sessions" USING btree ("room_id","session_kind");--> statement-breakpoint
CREATE INDEX "room_agent_sessions_agent_key_idx" ON "room_agent_sessions" USING btree ("agent_key");--> statement-breakpoint
CREATE INDEX "room_agent_presence_room_session_kind_idx" ON "room_agent_presence" USING btree ("room_id","session_kind");--> statement-breakpoint
CREATE INDEX "room_agent_delivery_sessions_room_actor_idx" ON "room_agent_delivery_sessions" USING btree ("room_id","actor_label");--> statement-breakpoint
CREATE INDEX "room_agent_delivery_sessions_room_session_kind_idx" ON "room_agent_delivery_sessions" USING btree ("room_id","session_kind");
