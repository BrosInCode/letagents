ALTER TABLE "room_agent_sessions" ADD COLUMN "host_id" text;--> statement-breakpoint
ALTER TABLE "room_agent_sessions" ADD COLUMN "host_kind" text;--> statement-breakpoint
ALTER TABLE "room_agent_sessions" ADD COLUMN "host_label" text;--> statement-breakpoint
ALTER TABLE "room_agent_sessions" ADD COLUMN "liveness_capability" text;--> statement-breakpoint
ALTER TABLE "room_agent_sessions" ADD COLUMN "tool_bridge_id" text;--> statement-breakpoint
CREATE TABLE "room_agent_liveness_observations" (
	"room_id" text NOT NULL,
	"agent_session_id" text NOT NULL,
	"source" text DEFAULT 'agent_session' NOT NULL,
	"host_id" text,
	"host_kind" text,
	"host_label" text,
	"liveness_capability" text DEFAULT 'session_activity' NOT NULL,
	"tool_bridge_id" text,
	"last_observed_at" timestamp with time zone NOT NULL,
	"last_tool_call_at" timestamp with time zone,
	"detail" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "room_agent_liveness_observations_pk" PRIMARY KEY("room_id","agent_session_id","source")
);
--> statement-breakpoint
ALTER TABLE "room_agent_liveness_observations" ADD CONSTRAINT "room_agent_liveness_observations_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "room_agent_liveness_observations" ADD CONSTRAINT "room_agent_liveness_observations_agent_session_id_room_agent_sessions_session_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."room_agent_sessions"("session_id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "room_agent_liveness_observations_room_id_idx" ON "room_agent_liveness_observations" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "room_agent_liveness_observations_session_idx" ON "room_agent_liveness_observations" USING btree ("agent_session_id");--> statement-breakpoint
CREATE INDEX "room_agent_liveness_observations_observed_idx" ON "room_agent_liveness_observations" USING btree ("room_id","last_observed_at");
