SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "room_agent_delivery_instances" (
	"room_id" text NOT NULL,
	"delivery_key" text NOT NULL,
	"instance_id" text NOT NULL,
	"credential_fingerprint" text,
	"transport" "room_agent_delivery_transport" NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "room_agent_delivery_instances_pk" PRIMARY KEY("room_id", "delivery_key", "instance_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "room_agent_delivery_instances_stale_idx"
	ON "room_agent_delivery_instances" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "room_agent_delivery_instances_delivery_key_idx"
	ON "room_agent_delivery_instances" USING btree ("delivery_key");--> statement-breakpoint
ALTER TABLE "room_agent_delivery_instances"
	ADD CONSTRAINT "room_agent_delivery_instances_room_id_rooms_id_fk"
	FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id")
	ON DELETE cascade ON UPDATE cascade NOT VALID;--> statement-breakpoint
ALTER TABLE "room_agent_delivery_instances"
	VALIDATE CONSTRAINT "room_agent_delivery_instances_room_id_rooms_id_fk";
