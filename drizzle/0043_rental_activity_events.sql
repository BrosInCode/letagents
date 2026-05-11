DO $$ BEGIN
  CREATE TYPE "public"."rental_activity_source" AS ENUM('agent', 'tool', 'patch_gate', 'system', 'renter', 'provider');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rental_activity_events" (
  "id" text PRIMARY KEY NOT NULL,
  "session_id" text NOT NULL,
  "room_id" text NOT NULL,
  "event_type" text NOT NULL,
  "source" "rental_activity_source" NOT NULL,
  "verified" boolean DEFAULT false NOT NULL,
  "visibility" "rental_visibility" DEFAULT 'rental_visible' NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rental_activity_events_session_id_idx" ON "rental_activity_events" USING btree ("session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rental_activity_events_room_id_idx" ON "rental_activity_events" USING btree ("room_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rental_activity_events_event_type_idx" ON "rental_activity_events" USING btree ("event_type");
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "rental_activity_events" ADD CONSTRAINT "rental_activity_events_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."rental_sessions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "rental_activity_events" ADD CONSTRAINT "rental_activity_events_room_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
