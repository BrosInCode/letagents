CREATE TABLE "desktop_push_devices" (
  "id" text PRIMARY KEY NOT NULL,
  "account_id" text NOT NULL REFERENCES "accounts"("id") ON DELETE cascade ON UPDATE cascade,
  "installation_id" text NOT NULL,
  "device_token" text NOT NULL,
  "token_hash" text NOT NULL,
  "bundle_id" text NOT NULL,
  "environment" text NOT NULL,
  "app_version" text,
  "enabled" boolean NOT NULL DEFAULT true,
  "failure_count" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "last_registered_at" timestamp with time zone NOT NULL,
  "disabled_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "desktop_push_devices_environment_check" CHECK ("environment" IN ('production', 'sandbox'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "desktop_push_devices_account_installation_uq" ON "desktop_push_devices" ("account_id", "installation_id", "environment");--> statement-breakpoint
CREATE UNIQUE INDEX "desktop_push_devices_token_uq" ON "desktop_push_devices" ("environment", "token_hash");--> statement-breakpoint
CREATE INDEX "desktop_push_devices_account_idx" ON "desktop_push_devices" ("account_id");--> statement-breakpoint
CREATE INDEX "desktop_push_devices_active_idx" ON "desktop_push_devices" ("enabled", "environment");--> statement-breakpoint

CREATE TABLE "desktop_push_notifications" (
  "id" text PRIMARY KEY NOT NULL,
  "device_id" text NOT NULL REFERENCES "desktop_push_devices"("id") ON DELETE cascade ON UPDATE cascade,
  "room_id" text NOT NULL REFERENCES "rooms"("id") ON DELETE cascade ON UPDATE cascade,
  "message_number" integer NOT NULL,
  "thread_root_number" integer,
  "room_display_name" text NOT NULL,
  "sender" text NOT NULL,
  "body" text NOT NULL,
  "state" text NOT NULL DEFAULT 'queued',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamp with time zone NOT NULL,
  "claimed_at" timestamp with time zone,
  "claimed_by" text,
  "apns_id" text,
  "last_status" integer,
  "last_error" text,
  "created_at" timestamp with time zone NOT NULL,
  "delivered_at" timestamp with time zone,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "desktop_push_notifications_message_fk" FOREIGN KEY ("room_id", "message_number") REFERENCES "messages"("room_id", "number") ON DELETE cascade ON UPDATE cascade,
  CONSTRAINT "desktop_push_notifications_state_check" CHECK ("state" IN ('queued', 'processing', 'retry', 'delivered', 'dead'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "desktop_push_notifications_device_message_uq" ON "desktop_push_notifications" ("device_id", "room_id", "message_number");--> statement-breakpoint
CREATE INDEX "desktop_push_notifications_ready_idx" ON "desktop_push_notifications" ("state", "next_attempt_at", "created_at");--> statement-breakpoint
CREATE INDEX "desktop_push_notifications_device_idx" ON "desktop_push_notifications" ("device_id");
