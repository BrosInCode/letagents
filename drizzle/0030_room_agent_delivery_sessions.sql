CREATE TYPE "room_agent_delivery_transport" AS ENUM('long_poll', 'sse');--> statement-breakpoint
CREATE TABLE "room_agent_delivery_sessions" (
	"room_id" text NOT NULL,
	"actor_label" text NOT NULL,
	"agent_key" text,
	"agent_instance_id" text,
	"display_name" text NOT NULL,
	"owner_label" text,
	"ide_label" text,
	"transport" "room_agent_delivery_transport" NOT NULL,
	"active_connection_count" integer DEFAULT 0 NOT NULL,
	"last_connected_at" timestamp with time zone NOT NULL,
	"last_disconnected_at" timestamp with time zone,
	"reconnect_grace_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "room_agent_delivery_sessions_pk" PRIMARY KEY("room_id","actor_label"),
	CONSTRAINT "room_agent_delivery_sessions_active_connection_count_check" CHECK ("active_connection_count" >= 0)
);--> statement-breakpoint
ALTER TABLE "room_agent_delivery_sessions" ADD CONSTRAINT "room_agent_delivery_sessions_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "room_agent_delivery_sessions_room_id_idx" ON "room_agent_delivery_sessions" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "room_agent_delivery_sessions_room_active_idx" ON "room_agent_delivery_sessions" USING btree ("room_id","active_connection_count");--> statement-breakpoint
CREATE INDEX "room_agent_delivery_sessions_room_grace_idx" ON "room_agent_delivery_sessions" USING btree ("room_id","reconnect_grace_expires_at");--> statement-breakpoint
CREATE INDEX "room_agent_delivery_sessions_room_agent_key_idx" ON "room_agent_delivery_sessions" USING btree ("room_id","agent_key");
