ALTER TABLE "room_agent_sessions" ADD COLUMN IF NOT EXISTS "repo_branch" text;--> statement-breakpoint
ALTER TABLE "room_agent_presence" ADD COLUMN IF NOT EXISTS "repo_branch" text;--> statement-breakpoint
ALTER TABLE "room_agent_delivery_sessions" ADD COLUMN IF NOT EXISTS "repo_branch" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "room_agent_sessions_room_branch_idx" ON "room_agent_sessions" USING btree ("room_id", "repo_branch") WHERE "repo_branch" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "room_agent_presence_room_branch_idx" ON "room_agent_presence" USING btree ("room_id", "repo_branch") WHERE "repo_branch" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "room_agent_delivery_sessions_room_branch_idx" ON "room_agent_delivery_sessions" USING btree ("room_id", "repo_branch") WHERE "repo_branch" IS NOT NULL;
