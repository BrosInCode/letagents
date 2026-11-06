-- Additive: saved marks (pen strokes and pins) drawn over an HTML demo in a
-- room message. A demo is one attachment of one message, so the marks follow
-- the attachment row and go when the message goes. A removed mark is deleted;
-- there is no history. The author's name and colour come from the account at
-- read time. `point_count` is the number of points of a stroke (1 for a pin):
-- the server keeps at most 500 marks and 100,000 points per demo. Older
-- servers never read this table.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "demo_marks" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"message_number" integer NOT NULL,
	"attachment_number" integer NOT NULL,
	"account_id" text NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
	"kind" text NOT NULL,
	"point_count" integer NOT NULL,
	"points" jsonb,
	"pin_at" jsonb,
	"pin_text" text,
	"anchor" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demo_marks_attachment_fk" FOREIGN KEY ("room_id", "message_number", "attachment_number")
		REFERENCES "message_attachments"("room_id", "message_number", "attachment_number") ON DELETE CASCADE ON UPDATE CASCADE,
	CONSTRAINT "demo_marks_point_count_check" CHECK ("point_count" > 0),
	CONSTRAINT "demo_marks_kind_check" CHECK (
		("kind" = 'stroke' AND "points" IS NOT NULL AND "pin_at" IS NULL AND "pin_text" IS NULL)
		OR ("kind" = 'pin' AND "points" IS NULL AND "pin_at" IS NOT NULL AND "pin_text" IS NOT NULL)
	)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "demo_marks_demo_idx" ON "demo_marks" USING btree ("room_id", "message_number", "attachment_number", "created_at", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "demo_marks_account_idx" ON "demo_marks" USING btree ("account_id");
