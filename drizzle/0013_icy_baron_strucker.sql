ALTER TABLE "messages" ADD COLUMN "reply_to_number" integer;--> statement-breakpoint
CREATE INDEX "messages_reply_to_idx" ON "messages" USING btree ("room_id","reply_to_number");