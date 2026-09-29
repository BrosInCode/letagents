CREATE TABLE "execution_approval_publications" (
  "publication_id" text PRIMARY KEY NOT NULL,
  "room_agent_work_attempt_id" text NOT NULL REFERENCES "room_agent_work"("attempt_id") ON DELETE cascade,
  "delegation_instance_id" text NOT NULL,
  "delegation_revision" integer NOT NULL,
  "request_id" text NOT NULL,
  "request_version" integer NOT NULL,
  "request_sha256" text NOT NULL,
  "projection_sha256" text NOT NULL,
  "projection_json" text NOT NULL,
  "publication_digest" text NOT NULL,
  "produced_at" timestamp with time zone NOT NULL,
  "published_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "closed_at" timestamp with time zone,
  CONSTRAINT "execution_approval_publications_delegation_fk"
    FOREIGN KEY ("delegation_instance_id", "delegation_revision")
    REFERENCES "execution_delegation_grants"("delegation_instance_id", "revision")
    ON DELETE cascade,
  CONSTRAINT "execution_approval_publications_delegation_revision_check" CHECK ("delegation_revision" >= 1),
  CONSTRAINT "execution_approval_publications_request_version_check" CHECK ("request_version" >= 1),
  CONSTRAINT "execution_approval_publications_request_digest_check" CHECK ("request_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "execution_approval_publications_projection_digest_check" CHECK ("projection_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "execution_approval_publications_publication_digest_check" CHECK ("publication_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "execution_approval_publications_projection_size_check" CHECK (octet_length("projection_json") <= 24576),
  CONSTRAINT "execution_approval_publications_expiry_check" CHECK ("expires_at" > "produced_at" AND "expires_at" > "published_at"),
  CONSTRAINT "execution_approval_publications_closure_check" CHECK ("closed_at" IS NULL OR "closed_at" >= "published_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "execution_approval_publications_request_uq"
  ON "execution_approval_publications" ("delegation_instance_id", "delegation_revision", "request_id", "request_version");
--> statement-breakpoint
CREATE INDEX "execution_approval_publications_inventory_idx"
  ON "execution_approval_publications" ("delegation_instance_id", "delegation_revision", "published_at", "publication_id");
--> statement-breakpoint
CREATE INDEX "execution_approval_publications_work_idx"
  ON "execution_approval_publications" ("room_agent_work_attempt_id");
--> statement-breakpoint
CREATE INDEX "execution_approval_publications_expiry_idx"
  ON "execution_approval_publications" ("expires_at");
--> statement-breakpoint
CREATE FUNCTION "guard_execution_approval_publication"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."closed_at" IS NULL
    AND NEW."closed_at" IS NOT NULL
    AND (to_jsonb(NEW) - 'closed_at') = (to_jsonb(OLD) - 'closed_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'execution approval publications are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "execution_approval_publications_immutable"
  BEFORE UPDATE ON "execution_approval_publications"
  FOR EACH ROW EXECUTE FUNCTION "guard_execution_approval_publication"();
