-- p1.5: Add heartbeat columns to rental_sessions for liveness tracking (§18.3)
ALTER TABLE "rental_sessions" ADD COLUMN "heartbeat_count" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "rental_sessions" ADD COLUMN "last_heartbeat_at" timestamp with time zone;
