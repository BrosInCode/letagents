-- Additive: one desktop push per admin device for a request to join a
-- members-only room, so an admin whose app is quit still learns that someone
-- asked. Rows follow the request (a decided or cancelled request retires its
-- queued rows) and the device. The preview columns (room name, requester) are
-- blanked once a row is delivered or dead, as the message outbox does. Older
-- servers never read this table.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "desktop_join_request_pushes" (
	"id" text PRIMARY KEY NOT NULL,
	"join_request_id" text NOT NULL REFERENCES "room_join_requests"("id") ON DELETE CASCADE,
	"device_id" text NOT NULL REFERENCES "desktop_push_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE,
	"room_id" text NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
	"room_display_name" text DEFAULT '' NOT NULL,
	"sender" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"apns_id" text,
	"last_status" integer,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "desktop_join_request_pushes_state_check" CHECK ("state" IN ('queued', 'processing', 'retry', 'delivered', 'dead'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "desktop_join_request_pushes_device_request_uq" ON "desktop_join_request_pushes" USING btree ("device_id", "join_request_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "desktop_join_request_pushes_ready_idx" ON "desktop_join_request_pushes" USING btree ("state", "next_attempt_at", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "desktop_join_request_pushes_request_idx" ON "desktop_join_request_pushes" USING btree ("join_request_id");
