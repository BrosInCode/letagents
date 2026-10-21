-- Ticket connectors (PR3): per room, per connection, which tickets to import.
-- Additive for older servers: they never read the new table, and nothing older
-- writes ticket_state or external_item_id on tasks.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "room_tracker_filters" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
	"connection_id" text NOT NULL REFERENCES "tracker_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE,
	"filter" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by_account_id" text NOT NULL,
	"last_synced_at" timestamp with time zone,
	"sync_claimed_at" timestamp with time zone,
	"sync_finished_at" timestamp with time zone,
	"sync_requested_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "room_tracker_filters_room_connection_uq" ON "room_tracker_filters" USING btree ("room_id", "connection_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "room_tracker_filters_connection_idx" ON "room_tracker_filters" USING btree ("connection_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "room_tracker_filters_enabled_idx" ON "room_tracker_filters" USING btree ("sync_claimed_at") WHERE "enabled";
