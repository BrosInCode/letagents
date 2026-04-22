CREATE TABLE "room_live_agent_suppressions" (
	"room_id" text NOT NULL,
	"actor_label" text NOT NULL,
	"suppressed_by" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "room_live_agent_suppressions_pk" PRIMARY KEY("room_id","actor_label")
);
--> statement-breakpoint
ALTER TABLE "room_live_agent_suppressions" ADD CONSTRAINT "room_live_agent_suppressions_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
CREATE INDEX "room_live_agent_suppressions_room_id_idx" ON "room_live_agent_suppressions" USING btree ("room_id");
--> statement-breakpoint
CREATE INDEX "room_live_agent_suppressions_room_actor_idx" ON "room_live_agent_suppressions" USING btree ("room_id","actor_label");
