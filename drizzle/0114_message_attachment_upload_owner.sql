-- Additive: older servers ignore the owner columns, and rows without an owner stay open to the room.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "message_attachment_uploads"
  ADD COLUMN "uploader_account_id" text,
  ADD COLUMN "uploader_agent_session_id" text;
--> statement-breakpoint
-- Every existing row has neither owner, so NOT VALID skips only a pointless
-- scan; new and updated rows are still checked.
ALTER TABLE "message_attachment_uploads" ADD CONSTRAINT "message_attachment_uploads_single_uploader_check" CHECK ("message_attachment_uploads"."uploader_account_id" IS NULL OR "message_attachment_uploads"."uploader_agent_session_id" IS NULL) NOT VALID;
--> statement-breakpoint
-- The table holds one row per staged upload, so building this partial index
-- in the migration is a short scan.
CREATE INDEX IF NOT EXISTS "message_attachment_uploads_pending_expiry_idx" ON "message_attachment_uploads" USING btree ("expires_at", "upload_id") WHERE "message_attachment_uploads"."status" = 'pending';
