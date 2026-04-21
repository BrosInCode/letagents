ALTER TABLE "room_participants" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "room_participants" ADD COLUMN "hidden_by" text;--> statement-breakpoint
CREATE INDEX "room_participants_room_hidden_idx" ON "room_participants" USING btree ("room_id","hidden_at");
