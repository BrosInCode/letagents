CREATE TYPE "agent_presence_status" AS ENUM('idle', 'working', 'reviewing', 'blocked');--> statement-breakpoint
CREATE TABLE "room_agent_presence" (
	"room_id" text NOT NULL,
	"actor_label" text NOT NULL,
	"agent_key" text,
	"display_name" text NOT NULL,
	"owner_label" text,
	"ide_label" text,
	"status" "agent_presence_status" DEFAULT 'idle' NOT NULL,
	"status_text" text,
	"last_heartbeat_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "room_agent_presence_pk" PRIMARY KEY("room_id","actor_label")
);--> statement-breakpoint
ALTER TABLE "room_agent_presence" ADD CONSTRAINT "room_agent_presence_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "room_agent_presence_room_id_idx" ON "room_agent_presence" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "room_agent_presence_room_status_idx" ON "room_agent_presence" USING btree ("room_id","status");--> statement-breakpoint
CREATE INDEX "room_agent_presence_room_heartbeat_idx" ON "room_agent_presence" USING btree ("room_id","last_heartbeat_at");--> statement-breakpoint
CREATE INDEX "room_agent_presence_room_agent_key_idx" ON "room_agent_presence" USING btree ("room_id","agent_key");
