SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "room_agent_delivery_sessions"
	ADD COLUMN "desktop_signal_sequence" integer DEFAULT 0 NOT NULL;
