ALTER TABLE "task_leases" ADD COLUMN "agent_session_id" text;--> statement-breakpoint
ALTER TABLE "task_leases" ADD CONSTRAINT "task_leases_agent_session_id_room_agent_sessions_session_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."room_agent_sessions"("session_id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "task_leases_room_agent_session_idx" ON "task_leases" USING btree ("room_id","agent_session_id");--> statement-breakpoint
