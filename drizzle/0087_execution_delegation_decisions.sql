CREATE TABLE "execution_delegation_decisions" (
  "decision_id" text PRIMARY KEY NOT NULL,
  "delegation_instance_id" text NOT NULL,
  "delegation_revision" integer NOT NULL,
  "actor_account_id" text NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
  "request_id" text NOT NULL,
  "request_version" integer NOT NULL,
  "request_sha256" text NOT NULL,
  "projection_sha256" text NOT NULL,
  "decision" text NOT NULL,
  "client_request_id" text NOT NULL,
  "request_fingerprint" text NOT NULL,
  "decided_at" timestamp with time zone NOT NULL,
  CONSTRAINT "execution_delegation_decisions_grant_fk"
    FOREIGN KEY ("delegation_instance_id", "delegation_revision")
    REFERENCES "execution_delegation_grants"("delegation_instance_id", "revision")
    ON DELETE cascade,
  CONSTRAINT "execution_delegation_decisions_revision_check" CHECK ("delegation_revision" >= 1),
  CONSTRAINT "execution_delegation_decisions_request_version_check" CHECK ("request_version" >= 1),
  CONSTRAINT "execution_delegation_decisions_request_digest_check" CHECK ("request_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "execution_delegation_decisions_projection_digest_check" CHECK ("projection_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "execution_delegation_decisions_fingerprint_check" CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "execution_delegation_decisions_decision_check" CHECK ("decision" IN ('allow_once', 'deny'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "execution_delegation_decisions_actor_request_uq"
  ON "execution_delegation_decisions" ("actor_account_id", "client_request_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "execution_delegation_decisions_approval_uq"
  ON "execution_delegation_decisions" (
    "delegation_instance_id",
    "delegation_revision",
    "request_id",
    "request_version"
  );
--> statement-breakpoint
CREATE INDEX "execution_delegation_decisions_grant_idx"
  ON "execution_delegation_decisions" ("delegation_instance_id", "delegation_revision", "decision_id");
--> statement-breakpoint
CREATE FUNCTION "guard_execution_delegation_decision"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'execution delegation decisions are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "execution_delegation_decisions_immutable"
  BEFORE UPDATE ON "execution_delegation_decisions"
  FOR EACH ROW EXECUTE FUNCTION "guard_execution_delegation_decision"();
