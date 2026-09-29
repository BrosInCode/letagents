CREATE TABLE "execution_delegation_grants" (
  "delegation_instance_id" text NOT NULL,
  "revision" integer NOT NULL,
  "owner_account_id" text NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
  "admission_supervisor_grant_id" text NOT NULL REFERENCES "supervisor_host_grants"("grant_id") ON DELETE restrict ON UPDATE cascade,
  "host_id" text NOT NULL,
  "installation_id" text NOT NULL,
  "scope_key" text NOT NULL,
  "room_id" text NOT NULL REFERENCES "rooms"("id") ON DELETE cascade ON UPDATE cascade,
  "agent_key" text NOT NULL REFERENCES "agents"("canonical_key") ON DELETE cascade ON UPDATE cascade,
  "approver_account_id" text NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
  "category" text NOT NULL,
  "risk_ceiling" text NOT NULL,
  "scope_sha256" text NOT NULL,
  "client_request_id" text NOT NULL,
  "request_fingerprint" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "expired_at" timestamp with time zone,
  "retired_at" timestamp with time zone,
  "retired_by_revision" integer,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "execution_delegation_grants_pk" PRIMARY KEY ("delegation_instance_id", "revision"),
  CONSTRAINT "execution_delegation_grants_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "execution_delegation_grants_scope_key_check" CHECK ("scope_key" = 'owner'),
  CONSTRAINT "execution_delegation_grants_category_check" CHECK ("category" = 'file_change'),
  CONSTRAINT "execution_delegation_grants_risk_check" CHECK ("risk_ceiling" = 'low'),
  CONSTRAINT "execution_delegation_grants_scope_digest_check" CHECK ("scope_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "execution_delegation_grants_request_digest_check" CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "execution_delegation_grants_expiry_check" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "execution_delegation_grants_retirement_check" CHECK (
    ("retired_at" IS NULL AND "retired_by_revision" IS NULL)
    OR ("retired_at" IS NOT NULL AND "retired_by_revision" = "revision" + 1)
  ),
  CONSTRAINT "execution_delegation_grants_terminal_check" CHECK (
    NOT ("retired_at" IS NOT NULL AND ("revoked_at" IS NOT NULL OR "expired_at" IS NOT NULL))
    AND ("retired_at" IS NULL OR "retired_at" >= "created_at")
    AND ("expired_at" IS NULL OR "expired_at" >= "expires_at")
    AND ("revoked_at" IS NULL OR "revoked_at" >= "created_at")
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "execution_delegation_grants_owner_request_uq"
  ON "execution_delegation_grants" ("owner_account_id", "client_request_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "execution_delegation_grants_active_revision_uq"
  ON "execution_delegation_grants" ("delegation_instance_id")
  WHERE "retired_at" IS NULL AND "revoked_at" IS NULL AND "expired_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "execution_delegation_grants_active_scope_uq"
  ON "execution_delegation_grants" (
    "owner_account_id",
    "host_id",
    "installation_id",
    "scope_key",
    "room_id",
    "agent_key",
    "approver_account_id"
  )
  WHERE "retired_at" IS NULL AND "revoked_at" IS NULL AND "expired_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "execution_delegation_grants_owner_idx"
  ON "execution_delegation_grants" ("owner_account_id", "created_at");
--> statement-breakpoint
CREATE INDEX "execution_delegation_grants_approver_idx"
  ON "execution_delegation_grants" ("approver_account_id", "room_id", "created_at");
--> statement-breakpoint
CREATE INDEX "execution_delegation_grants_host_idx"
  ON "execution_delegation_grants" ("owner_account_id", "host_id", "installation_id", "scope_key", "created_at");
--> statement-breakpoint
CREATE INDEX "execution_delegation_grants_expiry_idx"
  ON "execution_delegation_grants" ("expires_at");
--> statement-breakpoint
CREATE FUNCTION "guard_execution_delegation_grant_revision"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW."delegation_instance_id",
    NEW."revision",
    NEW."owner_account_id",
    NEW."admission_supervisor_grant_id",
    NEW."host_id",
    NEW."installation_id",
    NEW."scope_key",
    NEW."approver_account_id",
    NEW."category",
    NEW."risk_ceiling",
    NEW."scope_sha256",
    NEW."client_request_id",
    NEW."request_fingerprint",
    NEW."created_at",
    NEW."expires_at"
  ) IS DISTINCT FROM ROW(
    OLD."delegation_instance_id",
    OLD."revision",
    OLD."owner_account_id",
    OLD."admission_supervisor_grant_id",
    OLD."host_id",
    OLD."installation_id",
    OLD."scope_key",
    OLD."approver_account_id",
    OLD."category",
    OLD."risk_ceiling",
    OLD."scope_sha256",
    OLD."client_request_id",
    OLD."request_fingerprint",
    OLD."created_at",
    OLD."expires_at"
  ) THEN
    RAISE EXCEPTION 'execution delegation revision identity is immutable';
  END IF;

  -- Canonical room and agent identifiers are foreign-key references rather
  -- than authority mutations. Permit only parent-key cascades: a direct move
  -- while the old canonical identity still exists remains forbidden. The
  -- immutable scope digest records the exact identifiers at admission time.
  IF NEW."room_id" IS DISTINCT FROM OLD."room_id" THEN
    PERFORM 1 FROM "rooms" WHERE "id" = OLD."room_id";
    IF FOUND THEN
      RAISE EXCEPTION 'execution delegation room authority is immutable';
    END IF;
  END IF;
  IF NEW."agent_key" IS DISTINCT FROM OLD."agent_key" THEN
    PERFORM 1 FROM "agents" WHERE "canonical_key" = OLD."agent_key";
    IF FOUND THEN
      RAISE EXCEPTION 'execution delegation agent authority is immutable';
    END IF;
  END IF;

  IF OLD."retired_at" IS NOT NULL AND ROW(NEW."retired_at", NEW."retired_by_revision")
    IS DISTINCT FROM ROW(OLD."retired_at", OLD."retired_by_revision") THEN
    RAISE EXCEPTION 'retired execution delegation revisions are terminal';
  END IF;

  IF OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at" THEN
    RAISE EXCEPTION 'revoked execution delegation revisions are terminal';
  END IF;

  IF OLD."expired_at" IS NOT NULL AND NEW."expired_at" IS DISTINCT FROM OLD."expired_at" THEN
    RAISE EXCEPTION 'expired execution delegation revisions are terminal';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "execution_delegation_grants_revision_guard"
  BEFORE UPDATE ON "execution_delegation_grants"
  FOR EACH ROW EXECUTE FUNCTION "guard_execution_delegation_grant_revision"();
