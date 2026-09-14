CREATE TABLE "room_knowledge" (
  "room_id" text NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "id" text NOT NULL, "type" text NOT NULL CHECK ("type" IN ('memory', 'attention')),
  "version" integer NOT NULL CHECK ("version" > 0), "value" jsonb NOT NULL,
  PRIMARY KEY ("room_id", "id")
);
--> statement-breakpoint
CREATE INDEX "room_knowledge_type_idx" ON "room_knowledge" ("room_id", "type");
--> statement-breakpoint
CREATE TABLE "room_knowledge_revisions" (
  "room_id" text NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "id" text NOT NULL, "version" integer NOT NULL CHECK ("version" > 0), "value" jsonb NOT NULL,
  PRIMARY KEY ("room_id", "id", "version")
);
