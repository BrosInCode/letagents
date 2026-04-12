-- Migration 0020: Rent-an-Agent Marketplace tables
-- Only creates genuinely new tables; does NOT touch room_agent_presence,
-- room_participants, or tasks.assignee_agent_key (already in 0017-0019).

CREATE TYPE "rental_listing_status" AS ENUM('active', 'paused', 'retired');--> statement-breakpoint
CREATE TYPE "rental_session_status" AS ENUM('requested', 'accepted', 'active', 'paused', 'completed', 'cancelled', 'expired', 'disputed');--> statement-breakpoint

CREATE TABLE "provider_notification_prefs" (
	"account_id" text PRIMARY KEY NOT NULL,
	"email_enabled" integer DEFAULT 1 NOT NULL,
	"email_address" text,
	"telegram_enabled" integer DEFAULT 0 NOT NULL,
	"telegram_chat_id" text,
	"whatsapp_enabled" integer DEFAULT 0 NOT NULL,
	"whatsapp_number" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);--> statement-breakpoint

CREATE TABLE "rental_listings" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_account_id" text NOT NULL,
	"agent_display_name" text NOT NULL,
	"agent_model" text NOT NULL,
	"agent_ide" text NOT NULL,
	"agent_description" text,
	"agent_model_verified" text,
	"agent_ide_verified" text,
	"fingerprint_verified_at" timestamp with time zone,
	"cu_budget_total" integer NOT NULL,
	"cu_budget_used" integer DEFAULT 0 NOT NULL,
	"cu_budget_per_session" integer,
	"status" "rental_listing_status" DEFAULT 'active' NOT NULL,
	"available_from" timestamp with time zone,
	"available_until" timestamp with time zone,
	"max_concurrent_sessions" integer DEFAULT 1 NOT NULL,
	"price_per_1k_cu" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"supported_output_types" jsonb DEFAULT '["research_note","comment","draft_pr"]'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);--> statement-breakpoint

CREATE TABLE "rental_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"listing_id" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"renter_account_id" text NOT NULL,
	"task_title" text NOT NULL,
	"task_description" text NOT NULL,
	"task_acceptance_criteria" text,
	"repo_scope" text NOT NULL,
	"target_branch" text NOT NULL,
	"expected_outcome" text NOT NULL,
	"sandbox_room_id" text,
	"cu_budget" integer NOT NULL,
	"cu_used" integer DEFAULT 0 NOT NULL,
	"status" "rental_session_status" DEFAULT 'requested' NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"max_duration_minutes" integer DEFAULT 240 NOT NULL,
	"result_pr_url" text,
	"result_summary" text,
	"total_cost_cents" integer DEFAULT 0 NOT NULL,
	"payment_status" text DEFAULT 'free' NOT NULL,
	"payment_intent_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);--> statement-breakpoint

CREATE TABLE "rental_token_events" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"tokens_input" integer DEFAULT 0 NOT NULL,
	"tokens_output" integer DEFAULT 0 NOT NULL,
	"cu_delta" integer NOT NULL,
	"event_type" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone NOT NULL
);--> statement-breakpoint

-- Foreign keys
ALTER TABLE "provider_notification_prefs" ADD CONSTRAINT "provider_notification_prefs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental_listings" ADD CONSTRAINT "rental_listings_provider_account_id_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental_sessions" ADD CONSTRAINT "rental_sessions_listing_id_rental_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."rental_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental_sessions" ADD CONSTRAINT "rental_sessions_provider_account_id_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental_sessions" ADD CONSTRAINT "rental_sessions_renter_account_id_accounts_id_fk" FOREIGN KEY ("renter_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental_sessions" ADD CONSTRAINT "rental_sessions_sandbox_room_id_rooms_id_fk" FOREIGN KEY ("sandbox_room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental_token_events" ADD CONSTRAINT "rental_token_events_session_id_rental_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."rental_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Indexes
CREATE INDEX "rental_listings_provider_idx" ON "rental_listings" USING btree ("provider_account_id");--> statement-breakpoint
CREATE INDEX "rental_listings_status_idx" ON "rental_listings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "rental_listings_model_idx" ON "rental_listings" USING btree ("agent_model");--> statement-breakpoint
CREATE INDEX "rental_sessions_listing_idx" ON "rental_sessions" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "rental_sessions_provider_idx" ON "rental_sessions" USING btree ("provider_account_id");--> statement-breakpoint
CREATE INDEX "rental_sessions_renter_idx" ON "rental_sessions" USING btree ("renter_account_id");--> statement-breakpoint
CREATE INDEX "rental_sessions_status_idx" ON "rental_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "rental_sessions_room_idx" ON "rental_sessions" USING btree ("sandbox_room_id");--> statement-breakpoint
CREATE INDEX "rental_token_events_session_idx" ON "rental_token_events" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "rental_token_events_created_idx" ON "rental_token_events" USING btree ("created_at");
