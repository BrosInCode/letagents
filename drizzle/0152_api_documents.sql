-- Additive: shared JSON documents for the LetAgents API (data.* methods).
-- One row per document in one scope of one room:
--   viewer  scope_id = '<page id>:<account id>' (one person, one page)
--   page    scope_id = '<page id>'              (everyone using one page)
--   room    scope_id = ''                       (all pages and agents in the room)
-- room_id leads the primary key and every query, so a document is only ever
-- reached through the room in the URL. size_bytes is the size of the JSON
-- text the caps were checked against. A delete keeps the row as a tombstone
-- (deleted, empty data, size 0) so the doc id's revision never repeats: a
-- client holding an old revision cannot overwrite a re-created document.
-- api_document_usage holds one row per room with the live documents and
-- bytes; every write locks it, so the room caps are exact. Older servers
-- never read these tables.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_documents" (
	"room_id" text NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
	"scope" text NOT NULL,
	"scope_id" text NOT NULL,
	"collection" text NOT NULL,
	"doc_id" text NOT NULL,
	"data" jsonb NOT NULL,
	"size_bytes" integer NOT NULL,
	"revision" integer NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"updated_by_kind" text NOT NULL,
	"updated_by_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_documents_pkey" PRIMARY KEY ("room_id", "scope", "scope_id", "collection", "doc_id"),
	CONSTRAINT "api_documents_scope_check" CHECK ("scope" IN ('viewer', 'page', 'room')),
	CONSTRAINT "api_documents_updated_by_kind_check" CHECK ("updated_by_kind" IN ('person', 'agent')),
	CONSTRAINT "api_documents_revision_check" CHECK ("revision" >= 1),
	CONSTRAINT "api_documents_size_check" CHECK ("size_bytes" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_documents_tombstones_idx" ON "api_documents" USING btree ("room_id", "updated_at") WHERE "deleted";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_document_usage" (
	"room_id" text PRIMARY KEY NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
	"docs" integer DEFAULT 0 NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "api_document_usage_docs_check" CHECK ("docs" >= 0),
	CONSTRAINT "api_document_usage_bytes_check" CHECK ("bytes" >= 0)
);
