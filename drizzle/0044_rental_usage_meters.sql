CREATE TYPE "public"."rental_usage_meter_source" AS ENUM('adapter', 'tool', 'self_reported', 'system');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rental_usage_meters" (
  "id" text PRIMARY KEY NOT NULL,
  "session_id" text NOT NULL,
  "source" "rental_usage_meter_source" NOT NULL,
  "native_unit" text,
  "native_used" numeric,
  "native_remaining" numeric,
  "native_reset_at" timestamp with time zone,
  "input_tokens" integer DEFAULT 0 NOT NULL,
  "output_tokens" integer DEFAULT 0 NOT NULL,
  "cache_creation_tokens" integer DEFAULT 0 NOT NULL,
  "cache_read_tokens" integer DEFAULT 0 NOT NULL,
  "reasoning_tokens" integer DEFAULT 0 NOT NULL,
  "requests_used" integer DEFAULT 0 NOT NULL,
  "credits_used" numeric,
  "usd_used" numeric,
  "lrt_delta" integer DEFAULT 0 NOT NULL,
  "lrt_total" integer DEFAULT 0 NOT NULL,
  "confidence" "rental_meter_confidence" NOT NULL,
  "adapter_payload" jsonb,
  "tool_call_count" integer DEFAULT 0 NOT NULL,
  "command_run_count" integer DEFAULT 0 NOT NULL,
  "files_exposed_count" integer DEFAULT 0 NOT NULL,
  "heartbeat_count" integer DEFAULT 0 NOT NULL,
  "last_heartbeat_at" timestamp with time zone,
  "idempotency_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rental_usage_meters" ADD CONSTRAINT "rental_usage_meters_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."rental_sessions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rental_usage_meters_session_id_idx" ON "rental_usage_meters" USING btree ("session_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rental_usage_meters_session_idempotency_uq" ON "rental_usage_meters" USING btree ("session_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rental_usage_meters_session_created_idx" ON "rental_usage_meters" USING btree ("session_id","created_at");
