-- Additive: the room pages registry (docs/plans/letagents-api.md, PR7).
-- `pages`: one HTML tool. v1 pages are owned by a room (`owner_room_id`); the
-- `org` owner kind is in the contract for a later company page library, and
-- that migration adds its foreign key. The owner's room id is a real foreign
-- key so a room rename or delete carries its pages along.
-- `page_versions`: the HTML is copied in at creation (2 MB cap), so deleting
-- the chat message it came from keeps the page. It is a text column, not an
-- object in attachment storage: a version and its status change commit in one
-- transaction, and nothing is left to clean up when a page is deleted.
-- `page_placements`: where a page shows, apart from who owns it, so one org
-- page can sit in many rooms later.
-- `page_grants`: the capabilities a room admin granted one version in one
-- room. Short-lived page_grant bearer tokens are minted from these rows and
-- live in their own table.
-- `page_diagnostics`: console errors, exceptions and failed calls per version,
-- trimmed to the newest entries by the server.
-- Older servers never read these tables.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pages" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_room_id" text REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
	"owner_org_id" text,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"current_version" integer,
	"created_by_kind" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pages_owner_kind_check" CHECK ("owner_kind" IN ('room', 'org')),
	CONSTRAINT "pages_owner_check" CHECK (
		("owner_kind" = 'room' AND "owner_room_id" IS NOT NULL AND "owner_org_id" IS NULL)
		OR ("owner_kind" = 'org' AND "owner_org_id" IS NOT NULL AND "owner_room_id" IS NULL)
	),
	CONSTRAINT "pages_created_by_kind_check" CHECK ("created_by_kind" IN ('person', 'agent')),
	CONSTRAINT "pages_current_version_check" CHECK ("current_version" IS NULL OR "current_version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pages_owner_room_slug_idx" ON "pages" USING btree ("owner_room_id", "slug") WHERE "owner_room_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pages_owner_org_slug_idx" ON "pages" USING btree ("owner_org_id", "slug") WHERE "owner_org_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "page_versions" (
	"page_id" text NOT NULL REFERENCES "pages"("id") ON DELETE CASCADE,
	"version" integer NOT NULL,
	"html" text NOT NULL,
	"sha256" text NOT NULL,
	"byte_size" integer NOT NULL,
	"manifest" jsonb NOT NULL,
	"author_kind" text NOT NULL,
	"author_id" text NOT NULL,
	"author_owner_account_id" text REFERENCES "accounts"("id") ON DELETE SET NULL,
	"source_message_id" text,
	"source_attachment_id" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_versions_pkey" PRIMARY KEY ("page_id", "version"),
	CONSTRAINT "page_versions_version_check" CHECK ("version" > 0),
	CONSTRAINT "page_versions_byte_size_check" CHECK ("byte_size" > 0 AND "byte_size" <= 2097152),
	CONSTRAINT "page_versions_author_kind_check" CHECK ("author_kind" IN ('person', 'agent')),
	CONSTRAINT "page_versions_status_check" CHECK ("status" IN ('live', 'draft', 'pending_approval', 'superseded')),
	CONSTRAINT "page_versions_source_check" CHECK (("source_message_id" IS NULL) = ("source_attachment_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "page_placements" (
	"page_id" text NOT NULL REFERENCES "pages"("id") ON DELETE CASCADE,
	"room_id" text NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
	"surface" text NOT NULL,
	"position" integer NOT NULL,
	"pinned_by" text REFERENCES "accounts"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_placements_pkey" PRIMARY KEY ("page_id", "room_id", "surface"),
	CONSTRAINT "page_placements_surface_check" CHECK ("surface" IN ('room.tab', 'task.panel', 'message', 'room.widget')),
	CONSTRAINT "page_placements_position_check" CHECK ("position" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_placements_room_surface_idx" ON "page_placements" USING btree ("room_id", "surface", "position");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "page_grants" (
	"page_id" text NOT NULL,
	"version" integer NOT NULL,
	"room_id" text NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
	"capabilities" text[] NOT NULL,
	"approved_by" text REFERENCES "accounts"("id") ON DELETE SET NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_grants_pkey" PRIMARY KEY ("page_id", "version", "room_id"),
	CONSTRAINT "page_grants_version_fk" FOREIGN KEY ("page_id", "version") REFERENCES "page_versions"("page_id", "version") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "page_diagnostics" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"page_id" text NOT NULL,
	"version" integer NOT NULL,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_diagnostics_version_fk" FOREIGN KEY ("page_id", "version") REFERENCES "page_versions"("page_id", "version") ON DELETE CASCADE,
	CONSTRAINT "page_diagnostics_kind_check" CHECK ("kind" IN ('console_error', 'exception', 'failed_call')),
	CONSTRAINT "page_diagnostics_message_check" CHECK (char_length("message") BETWEEN 1 AND 2000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_diagnostics_version_idx" ON "page_diagnostics" USING btree ("page_id", "version", "id");
