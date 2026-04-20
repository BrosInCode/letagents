CREATE TABLE "message_attachment_uploads" (
  "upload_id" text PRIMARY KEY,
  "room_id" text NOT NULL REFERENCES "rooms" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "filename" text NOT NULL,
  "content_type" text NOT NULL,
  "byte_size" integer NOT NULL,
  "storage_provider" text NOT NULL,
  "bucket" text NOT NULL,
  "object_key" text NOT NULL,
  "status" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "attached_message_number" integer,
  "created_at" timestamp with time zone NOT NULL,
  "attached_at" timestamp with time zone,
  CONSTRAINT "message_attachment_uploads_status_check" CHECK ("status" IN ('pending', 'attached')),
  CONSTRAINT "message_attachment_uploads_byte_size_check" CHECK ("byte_size" > 0)
);

CREATE INDEX "message_attachment_uploads_room_idx"
  ON "message_attachment_uploads" ("room_id", "created_at");

CREATE UNIQUE INDEX "message_attachment_uploads_object_key_idx"
  ON "message_attachment_uploads" ("object_key");

CREATE TABLE "message_attachments" (
  "room_id" text NOT NULL,
  "message_number" integer NOT NULL,
  "attachment_number" integer NOT NULL,
  "upload_id" text NOT NULL REFERENCES "message_attachment_uploads" ("upload_id"),
  "filename" text NOT NULL,
  "content_type" text NOT NULL,
  "byte_size" integer NOT NULL,
  "storage_provider" text NOT NULL,
  "bucket" text NOT NULL,
  "object_key" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "message_attachments_pk" PRIMARY KEY ("room_id", "message_number", "attachment_number"),
  CONSTRAINT "message_attachments_message_fk" FOREIGN KEY ("room_id", "message_number")
    REFERENCES "messages" ("room_id", "number")
    ON DELETE CASCADE
    ON UPDATE CASCADE,
  CONSTRAINT "message_attachments_byte_size_check" CHECK ("byte_size" > 0)
);

CREATE INDEX "message_attachments_room_idx"
  ON "message_attachments" ("room_id", "message_number");

CREATE UNIQUE INDEX "message_attachments_upload_idx"
  ON "message_attachments" ("upload_id");
