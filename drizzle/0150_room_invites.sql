-- Additive: one-use invite codes for members-only rooms ("Invite a bot").
-- The `invites` table has existed since 0000 and no server ever wrote it; it
-- becomes the store for these codes. `code` holds the SHA-256 of the code,
-- never the code itself, so a row without `kind` (an old row, if any) can
-- never match a code. An admin's invite ('admit') adds the account that uses
-- it as a member ('invite' in room_members.added_via); a member's invite
-- ('request') files a join request for the admins. Older servers never read
-- this table, and never read 'invite' as a member source.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "kind" text;
--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "platform" text;
--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "origin_room_id" text REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;
--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "used_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "used_by" text REFERENCES "accounts"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "outcome" text;
--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "join_request_id" text REFERENCES "room_join_requests"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "invites" DROP CONSTRAINT IF EXISTS "invites_kind_check";
--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_kind_check" CHECK ("kind" IS NULL OR "kind" IN ('admit', 'request'));
--> statement-breakpoint
ALTER TABLE "invites" DROP CONSTRAINT IF EXISTS "invites_platform_check";
--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_platform_check" CHECK ("platform" IS NULL OR "platform" IN ('grok', 'chatgpt', 'claude', 'other'));
--> statement-breakpoint
ALTER TABLE "invites" DROP CONSTRAINT IF EXISTS "invites_outcome_check";
--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_outcome_check" CHECK ("outcome" IS NULL OR "outcome" IN ('admitted', 'requested'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invites_created_by_idx" ON "invites" USING btree ("created_by", "created_at");
--> statement-breakpoint
ALTER TABLE "room_members" DROP CONSTRAINT IF EXISTS "room_members_added_via_check";
--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_added_via_check" CHECK ("added_via" IN ('creator', 'seed', 'approved_request', 'invite'));
