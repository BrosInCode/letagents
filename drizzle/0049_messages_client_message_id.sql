ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "client_message_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "messages_room_client_message_id_uq"
  ON "messages" USING btree ("room_id","client_message_id")
  WHERE "client_message_id" IS NOT NULL;
