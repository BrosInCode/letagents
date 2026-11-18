-- Additive: shared JSON documents for the LetAgents API (data.* methods).
-- One row per document in one scope of one room:
--   viewer  scope_id = '<page id>:<account id>' (one person, one page)
--   page    scope_id = '<page id>'              (everyone using one page)
--   room    scope_id = ''                       (all pages and agents in the room)
-- room_id leads the primary key and every query, so a document is only ever
-- reached through the room in the URL. size_bytes is the size of the JSON
-- text the caps were checked against; the viewer cap sums it. Older servers
-- never read this table.
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
	"updated_by_kind" text NOT NULL,
	"updated_by_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_documents_pkey" PRIMARY KEY ("room_id", "scope", "scope_id", "collection", "doc_id"),
	CONSTRAINT "api_documents_scope_check" CHECK ("scope" IN ('viewer', 'page', 'room')),
	CONSTRAINT "api_documents_updated_by_kind_check" CHECK ("updated_by_kind" IN ('person', 'agent')),
	CONSTRAINT "api_documents_revision_check" CHECK ("revision" >= 1),
	CONSTRAINT "api_documents_size_check" CHECK ("size_bytes" >= 0)
);
