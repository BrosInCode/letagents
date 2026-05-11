CREATE TYPE "public"."rental_visibility" AS ENUM('rental_visible', 'renter_only', 'provider_only', 'internal');
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "visibility" "rental_visibility";
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "rental_session_id" text;
--> statement-breakpoint
CREATE INDEX "messages_rental_session_id_idx" ON "messages" ("room_id", "rental_session_id") WHERE "rental_session_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "messages_rental_visibility_idx" ON "messages" ("room_id", "visibility") WHERE "visibility" IS NOT NULL;
