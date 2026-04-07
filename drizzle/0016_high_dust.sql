CREATE TABLE "github_room_events" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text,
	"delivery_id" text,
	"event_type" text NOT NULL,
	"action" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"github_object_id" text,
	"github_object_url" text,
	"title" text,
	"state" text,
	"actor_login" text,
	"metadata" jsonb,
	"linked_task_id" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "github_room_events_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "github_room_events" ADD CONSTRAINT "github_room_events_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "github_room_events" ADD CONSTRAINT "github_room_events_delivery_id_github_webhook_deliveries_delivery_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."github_webhook_deliveries"("delivery_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_room_events_room_id_idx" ON "github_room_events" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "github_room_events_event_type_idx" ON "github_room_events" USING btree ("room_id","event_type");--> statement-breakpoint
CREATE INDEX "github_room_events_object_idx" ON "github_room_events" USING btree ("room_id","event_type","github_object_id");--> statement-breakpoint
CREATE INDEX "github_room_events_delivery_id_idx" ON "github_room_events" USING btree ("delivery_id");