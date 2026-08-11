CREATE TABLE "message_thread_summaries" (
  "room_id" text NOT NULL,
  "thread_root_number" integer NOT NULL,
  "reply_count" integer NOT NULL,
  "latest_reply_number" integer NOT NULL,
  "participant_count" integer NOT NULL,
  CONSTRAINT "message_thread_summaries_pk" PRIMARY KEY ("room_id", "thread_root_number"),
  CONSTRAINT "message_thread_summaries_reply_count_check" CHECK ("reply_count" > 0),
  CONSTRAINT "message_thread_summaries_participant_count_check" CHECK ("participant_count" > 0)
);--> statement-breakpoint
CREATE INDEX "message_thread_summaries_latest_reply_idx"
  ON "message_thread_summaries" ("room_id", "latest_reply_number");--> statement-breakpoint

-- Participant identity is deliberately not part of a btree key. Sender and
-- source are user-controlled text and can exceed PostgreSQL's index-row limit.
-- The per-thread surrogate is allocated while holding the thread advisory lock.
CREATE TABLE "message_thread_participants" (
  "room_id" text NOT NULL,
  "thread_root_number" integer NOT NULL,
  "participant_number" integer NOT NULL,
  "identity_hash" text NOT NULL,
  "sender" text NOT NULL,
  "source" text,
  "message_count" integer NOT NULL,
  "latest_message_number" integer,
  "routing_message_count" integer NOT NULL,
  CONSTRAINT "message_thread_participants_pk"
    PRIMARY KEY ("room_id", "thread_root_number", "participant_number"),
  CONSTRAINT "message_thread_participants_message_count_check" CHECK ("message_count" >= 0),
  CONSTRAINT "message_thread_participants_routing_count_check" CHECK ("routing_message_count" > 0),
  CONSTRAINT "message_thread_participants_visible_latest_check"
    CHECK (("message_count" = 0) = ("latest_message_number" IS NULL))
);--> statement-breakpoint
CREATE INDEX "message_thread_participants_identity_idx"
  ON "message_thread_participants" ("room_id", "thread_root_number", "identity_hash");--> statement-breakpoint
CREATE INDEX "message_thread_participants_visible_latest_idx"
  ON "message_thread_participants" ("room_id", "thread_root_number", "latest_message_number" DESC)
  WHERE "message_count" > 0;--> statement-breakpoint

-- Canonical routing aliases must be identical on projection writes and reads.
-- Only ASCII A-Z is folded: Unicode case conversion varies across JS, ICU,
-- PostgreSQL version, and locale, so non-ASCII labels are intentionally
-- case-sensitive. The explicit class is ECMAScript's stable whitespace set.
CREATE OR REPLACE FUNCTION "normalize_message_thread_routing_alias"(
  p_value text,
  p_handle boolean DEFAULT false
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE WHEN p_handle THEN
    REGEXP_REPLACE(normalized.alias_text, '[^a-z0-9_.:/-]+', '', 'g')
  ELSE normalized.alias_text END
    FROM (
      SELECT TRANSLATE(BTRIM(REGEXP_REPLACE(
        COALESCE(p_value, ''),
        U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+',
        ' ',
        'g'
      ), ' '), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') AS alias_text
    ) AS normalized
$$;--> statement-breakpoint

-- Durable agent keys use the same equality contract on every transport. A
-- pre-existing folded collision is ambiguous authority and cannot be merged
-- automatically, so fail the migration with an explicit repair requirement.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "agents"
     GROUP BY normalize_message_thread_routing_alias("canonical_key", true)
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'agents contain routing-equivalent canonical_key collisions',
      HINT = 'End/rename duplicate agent identities before retrying migration 0078.';
  END IF;
END
$$;--> statement-breakpoint
-- Routing aliases are split out from display participants so identity-specific
-- membership probes stay indexable even when a thread has thousands of
-- participants. User-controlled alias text is data, never a btree key; the
-- fixed-width digest narrows candidates and raw equality closes collisions.
-- Full sender plus at most 16 label segments bounds a malicious pipe-heavy
-- sender while covering the canonical display/owner/IDE actor-label shape.
CREATE TABLE "message_thread_participant_aliases" (
  "room_id" text NOT NULL,
  "thread_root_number" integer NOT NULL,
  "participant_number" integer NOT NULL,
  "alias_number" integer NOT NULL,
  "alias_hash" text NOT NULL,
  "alias_text" text NOT NULL,
  "is_full" boolean NOT NULL DEFAULT false,
  CONSTRAINT "message_thread_participant_aliases_pk"
    PRIMARY KEY ("room_id", "thread_root_number", "participant_number", "alias_number"),
  CONSTRAINT "message_thread_participant_aliases_hash_check"
    CHECK (LENGTH("alias_hash") = 32),
  CONSTRAINT "message_thread_participant_aliases_number_check"
    CHECK ("alias_number" BETWEEN 1 AND 17),
  CONSTRAINT "message_thread_participant_aliases_participant_fk"
    FOREIGN KEY ("room_id", "thread_root_number", "participant_number")
    REFERENCES "message_thread_participants" ("room_id", "thread_root_number", "participant_number")
    ON DELETE CASCADE ON UPDATE CASCADE
);--> statement-breakpoint
CREATE INDEX "message_thread_participant_aliases_active_lookup_idx"
  ON "message_thread_participant_aliases" ("room_id", "alias_hash", "thread_root_number");--> statement-breakpoint

-- Authenticated publisher identity is stronger thread-routing authority than
-- a mutable display label. Keep raw durable keys outside btree keys; a fixed
-- digest narrows candidates and exact key+owner equality closes collisions.
CREATE TABLE "message_thread_participant_agents" (
  "room_id" text NOT NULL,
  "thread_root_number" integer NOT NULL,
  "participant_number" integer NOT NULL,
  "agent_number" integer NOT NULL,
  "agent_key_hash" text NOT NULL,
  "agent_key" text NOT NULL,
  "owner_account_id" text NOT NULL,
  "message_count" integer NOT NULL,
  CONSTRAINT "message_thread_participant_agents_pk"
    PRIMARY KEY ("room_id", "thread_root_number", "participant_number", "agent_number"),
  CONSTRAINT "message_thread_participant_agents_participant_fk"
    FOREIGN KEY ("room_id", "thread_root_number", "participant_number")
    REFERENCES "message_thread_participants" ("room_id", "thread_root_number", "participant_number")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "message_thread_participant_agents_hash_check"
    CHECK (LENGTH("agent_key_hash") = 32),
  CONSTRAINT "message_thread_participant_agents_count_check"
    CHECK ("message_count" > 0)
);--> statement-breakpoint
CREATE INDEX "message_thread_participant_agents_lookup_idx"
  ON "message_thread_participant_agents" ("room_id", "agent_key_hash", "thread_root_number");--> statement-breakpoint

-- One fixed-width row makes reply ordinals and projection idempotency O(1).
-- Prompt-only replies are also recorded so send-time routing preserves the
-- historical multi-sender participant semantics without rescanning a thread.
CREATE TABLE "message_thread_projected_messages" (
  "room_id" text NOT NULL,
  "message_number" integer NOT NULL,
  "thread_root_number" integer NOT NULL,
  "participant_number" integer NOT NULL,
  "participant_agent_number" integer,
  "reply_ordinal" integer,
  "is_visible" boolean NOT NULL,
  CONSTRAINT "message_thread_projected_messages_pk" PRIMARY KEY ("room_id", "message_number"),
  CONSTRAINT "message_thread_projected_messages_visibility_check"
    CHECK ("is_visible" = ("reply_ordinal" IS NOT NULL)),
  CONSTRAINT "message_thread_projected_messages_participant_agent_fk"
    FOREIGN KEY ("room_id", "thread_root_number", "participant_number", "participant_agent_number")
    REFERENCES "message_thread_participant_agents" (
      "room_id", "thread_root_number", "participant_number", "agent_number"
    ) ON UPDATE CASCADE
);--> statement-breakpoint
CREATE INDEX "message_thread_projected_messages_thread_idx"
  ON "message_thread_projected_messages" ("room_id", "thread_root_number", "message_number");--> statement-breakpoint
CREATE UNIQUE INDEX "message_thread_projected_messages_ordinal_uq"
  ON "message_thread_projected_messages" ("room_id", "thread_root_number", "reply_ordinal")
  WHERE "reply_ordinal" IS NOT NULL;--> statement-breakpoint

CREATE TABLE "message_room_thread_stats" (
  "room_id" text PRIMARY KEY,
  "thread_count" integer NOT NULL DEFAULT 0,
  "reply_version" integer NOT NULL DEFAULT 0,
  CONSTRAINT "message_room_thread_stats_count_check" CHECK (
    "thread_count" >= 0 AND "reply_version" >= 0
  )
);--> statement-breakpoint

-- Cache account-level unread totals behind independent room-reply and
-- account-read generations. A reply only bumps one room row (no reader
-- fan-out); the first inbox read after a change refreshes the account cache,
-- and subsequent pages remain O(1).
CREATE TABLE "message_account_thread_read_stats" (
  "room_id" text NOT NULL,
  "account_id" text NOT NULL,
  "current_read_version" integer NOT NULL DEFAULT 0,
  "cached_read_version" integer NOT NULL DEFAULT -1,
  "cached_room_reply_version" integer NOT NULL DEFAULT -1,
  "read_thread_count" integer NOT NULL DEFAULT 0,
  "fully_read_thread_count" integer NOT NULL DEFAULT 0,
  CONSTRAINT "message_account_thread_read_stats_pk" PRIMARY KEY ("room_id", "account_id"),
  CONSTRAINT "message_account_thread_read_stats_count_check" CHECK (
    "current_read_version" >= 0
    AND "cached_read_version" >= -1
    AND "cached_room_reply_version" >= -1
    AND "read_thread_count" >= 0
    AND "fully_read_thread_count" >= 0
    AND "fully_read_thread_count" <= "read_thread_count"
  )
);--> statement-breakpoint

-- Post-commit reconciliation creates finite per-room watermarks in bounded
-- keyset batches. Until enumeration finishes, the global rollout row keeps
-- reads on the compatibility path while the triggers project every new write.
CREATE TABLE "message_thread_projection_watermarks" (
  "room_id" text PRIMARY KEY,
  "through_message_number" integer NOT NULL,
  "message_cursor" integer NOT NULL DEFAULT 0,
  "read_thread_root_cursor" integer NOT NULL DEFAULT 0,
  "read_account_cursor" text NOT NULL DEFAULT '',
  "reads_completed" boolean NOT NULL DEFAULT false,
  "completed_at" timestamp with time zone,
  CONSTRAINT "message_thread_projection_watermarks_number_check"
    CHECK ("through_message_number" >= 0 AND "message_cursor" >= 0)
);--> statement-breakpoint
CREATE INDEX "message_thread_projection_watermarks_pending_idx"
  ON "message_thread_projection_watermarks" ("room_id")
  WHERE "completed_at" IS NULL;--> statement-breakpoint

CREATE TABLE "message_thread_projection_rollout" (
  "singleton" boolean PRIMARY KEY DEFAULT true,
  "room_cursor" text NOT NULL DEFAULT '',
  "watermarks_created" boolean NOT NULL DEFAULT false,
  "completed_at" timestamp with time zone,
  CONSTRAINT "message_thread_projection_rollout_singleton_check" CHECK ("singleton")
);--> statement-breakpoint
INSERT INTO "message_thread_projection_rollout" ("singleton") VALUES (true);--> statement-breakpoint

CREATE OR REPLACE FUNCTION "upsert_message_thread_participant"(
  p_room_id text,
  p_thread_root_number integer,
  p_sender text,
  p_source text,
  p_message_number integer,
  p_visible boolean
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  participant_no integer;
  participant_message_count integer;
  participant_hash text := MD5(
    LENGTH(p_sender)::text || ':' || p_sender || ':' || COALESCE(p_source, '')
  );
BEGIN
  SELECT participant."participant_number", participant."message_count"
    INTO participant_no, participant_message_count
    FROM "message_thread_participants" AS participant
   WHERE participant."room_id" = p_room_id
     AND participant."thread_root_number" = p_thread_root_number
     AND participant."identity_hash" = participant_hash
     AND participant."sender" = p_sender
     AND COALESCE(participant."source", '') = COALESCE(p_source, '')
   LIMIT 1;

  IF participant_no IS NULL THEN
    SELECT COALESCE(MAX(participant."participant_number"), 0) + 1
      INTO participant_no
      FROM "message_thread_participants" AS participant
     WHERE participant."room_id" = p_room_id
       AND participant."thread_root_number" = p_thread_root_number;

    INSERT INTO "message_thread_participants" (
      "room_id", "thread_root_number", "participant_number", "identity_hash", "sender", "source",
      "message_count", "latest_message_number", "routing_message_count"
    ) VALUES (
      p_room_id, p_thread_root_number, participant_no, participant_hash, p_sender, p_source,
      CASE WHEN p_visible THEN 1 ELSE 0 END,
      CASE WHEN p_visible THEN p_message_number ELSE NULL END,
      1
    );
    -- Mutable sender aliases are routing authority only for rows whose stored
    -- provenance positively identifies a worker. NULL/unknown sources are
    -- display-only; durable publisher keys are projected independently below.
    IF p_source = 'agent' THEN
    INSERT INTO "message_thread_participant_aliases" (
      "room_id", "thread_root_number", "participant_number", "alias_number", "alias_hash", "alias_text",
      "is_full"
    )
    SELECT p_room_id,
           p_thread_root_number,
           participant_no,
           ROW_NUMBER() OVER (ORDER BY normalized.alias_text)::integer,
           MD5(normalized.alias_text),
           normalized.alias_text,
           normalized.is_full
      FROM (
        SELECT normalize_message_thread_routing_alias(piece.alias_text, false) AS alias_text,
               BOOL_OR(piece.is_full) AS is_full
          FROM (
            SELECT p_sender AS alias_text, true AS is_full
            UNION ALL
            SELECT segment.alias_text, false AS is_full
              FROM UNNEST(STRING_TO_ARRAY(p_sender, '|')) WITH ORDINALITY
                AS segment(alias_text, ordinal)
             WHERE segment.ordinal <= 16
          ) AS piece
         WHERE normalize_message_thread_routing_alias(piece.alias_text, false) <> ''
         GROUP BY normalize_message_thread_routing_alias(piece.alias_text, false)
      ) AS normalized;
    END IF;
  ELSE
    UPDATE "message_thread_participants"
       SET "message_count" = "message_count" + CASE WHEN p_visible THEN 1 ELSE 0 END,
           "latest_message_number" = CASE
             WHEN p_visible THEN GREATEST(COALESCE("latest_message_number", 0), p_message_number)
             ELSE "latest_message_number"
           END,
           "routing_message_count" = "routing_message_count" + 1
     WHERE "room_id" = p_room_id
       AND "thread_root_number" = p_thread_root_number
       AND "participant_number" = participant_no;
  END IF;

  IF p_visible AND (participant_message_count IS NULL OR participant_message_count = 0) THEN
    UPDATE "message_thread_summaries"
       SET "participant_count" = "participant_count" + 1
     WHERE "room_id" = p_room_id
       AND "thread_root_number" = p_thread_root_number;
  END IF;

  RETURN participant_no;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "upsert_message_thread_participant_agent"(
  p_room_id text,
  p_thread_root_number integer,
  p_participant_number integer,
  p_agent_key text,
  p_owner_account_id text
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  participant_agent_no integer;
  participant_agent_hash text;
BEGIN
  IF NULLIF(BTRIM(p_agent_key), '') IS NULL
     OR NULLIF(BTRIM(p_owner_account_id), '') IS NULL THEN
    RETURN NULL;
  END IF;
  participant_agent_hash := MD5(p_agent_key);

  SELECT agent."agent_number"
    INTO participant_agent_no
    FROM "message_thread_participant_agents" AS agent
   WHERE agent."room_id" = p_room_id
     AND agent."thread_root_number" = p_thread_root_number
     AND agent."participant_number" = p_participant_number
     AND agent."agent_key_hash" = participant_agent_hash
     AND agent."agent_key" = p_agent_key
     AND agent."owner_account_id" = p_owner_account_id
   LIMIT 1;

  IF participant_agent_no IS NULL THEN
    SELECT COALESCE(MAX(agent."agent_number"), 0) + 1
      INTO participant_agent_no
      FROM "message_thread_participant_agents" AS agent
     WHERE agent."room_id" = p_room_id
       AND agent."thread_root_number" = p_thread_root_number
       AND agent."participant_number" = p_participant_number;

    INSERT INTO "message_thread_participant_agents" (
      "room_id", "thread_root_number", "participant_number", "agent_number",
      "agent_key_hash", "agent_key", "owner_account_id", "message_count"
    ) VALUES (
      p_room_id, p_thread_root_number, p_participant_number, participant_agent_no,
      participant_agent_hash, p_agent_key, p_owner_account_id, 1
    );
  ELSE
    UPDATE "message_thread_participant_agents"
       SET "message_count" = "message_count" + 1
     WHERE "room_id" = p_room_id
       AND "thread_root_number" = p_thread_root_number
       AND "participant_number" = p_participant_number
       AND "agent_number" = participant_agent_no;
  END IF;

  RETURN participant_agent_no;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "project_message_thread_message"(
  p_room_id text,
  p_message_number integer
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  message_row "messages"%ROWTYPE;
  root_row "messages"%ROWTYPE;
  root_visible boolean;
  visible_reply boolean;
  root_participant_no integer;
  participant_no integer;
  participant_agent_no integer;
  reply_ordinal integer;
  previous_projected_message_number integer;
  previous_projected_ordinal integer;
  existing_count integer;
  visible_participant_count integer;
  incomplete_watermark integer;
  room_projection_incomplete boolean;
BEGIN
  SELECT watermark."through_message_number",
         CASE
           WHEN watermark."room_id" IS NULL THEN rollout."completed_at" IS NULL
           ELSE watermark."completed_at" IS NULL
         END
    INTO incomplete_watermark, room_projection_incomplete
    FROM "message_thread_projection_rollout" AS rollout
    LEFT JOIN "message_thread_projection_watermarks" AS watermark
      ON watermark."room_id" = p_room_id
   WHERE rollout."singleton";

  -- During online reconciliation, canonicalize room -> thread/shared-room
  -- projection lock ordering. Once complete, live writes skip the room lock.
  IF COALESCE(room_projection_incomplete, false) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_room_id, 7880079));
  END IF;

  SELECT * INTO message_row
    FROM "messages"
   WHERE "room_id" = p_room_id AND "number" = p_message_number;
  IF NOT FOUND OR message_row."thread_root_number" IS NULL THEN RETURN false; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_room_id || ':' || message_row."thread_root_number"::text,
    7880078
  ));

  IF EXISTS (
    SELECT 1 FROM "message_thread_projected_messages"
     WHERE "room_id" = p_room_id AND "message_number" = p_message_number
  ) THEN RETURN false; END IF;

  SELECT * INTO root_row
    FROM "messages"
   WHERE "room_id" = p_room_id AND "number" = message_row."thread_root_number";
  IF NOT FOUND THEN RETURN false; END IF;

  root_visible := NOT (
    COALESCE(root_row."agent_prompt_kind" = 'auto', false) AND BTRIM(root_row."text") = ''
  );

  -- Seed the root exactly once. This is also the bounded fallback for a thread
  -- whose first projected message is prompt-only.
  IF NOT EXISTS (
    SELECT 1 FROM "message_thread_participants"
     WHERE "room_id" = p_room_id
       AND "thread_root_number" = message_row."thread_root_number"
  ) THEN
    root_participant_no := "upsert_message_thread_participant"(
      p_room_id, message_row."thread_root_number", root_row."sender",
      root_row."source", root_row."number", root_visible
    );
    PERFORM "upsert_message_thread_participant_agent"(
      p_room_id, message_row."thread_root_number", root_participant_no,
      root_row."publisher_agent_key", root_row."publisher_account_id"
    );
  END IF;

  visible_reply := root_visible AND NOT (
    COALESCE(message_row."agent_prompt_kind" = 'auto', false) AND BTRIM(message_row."text") = ''
  );

  participant_no := "upsert_message_thread_participant"(
    p_room_id, message_row."thread_root_number", message_row."sender",
    message_row."source", p_message_number, visible_reply
  );
  participant_agent_no := "upsert_message_thread_participant_agent"(
    p_room_id, message_row."thread_root_number", participant_no,
    message_row."publisher_agent_key", message_row."publisher_account_id"
  );

  IF visible_reply THEN
    SELECT projected."message_number", projected."reply_ordinal"
      INTO previous_projected_message_number, previous_projected_ordinal
      FROM "message_thread_projected_messages" AS projected
     WHERE projected."room_id" = p_room_id
       AND projected."thread_root_number" = message_row."thread_root_number"
       AND projected."reply_ordinal" IS NOT NULL
       AND projected."message_number" < p_message_number
     ORDER BY projected."message_number" DESC
     LIMIT 1;
    IF COALESCE(room_projection_incomplete, false)
       AND (incomplete_watermark IS NULL OR p_message_number > incomplete_watermark) THEN
      IF previous_projected_message_number IS NOT NULL
         AND previous_projected_message_number > COALESCE(incomplete_watermark, 0) THEN
        reply_ordinal := previous_projected_ordinal + 1;
      ELSE
        -- Transitional old/new-binary overlap only: reconstruct the first live
        -- post-watermark ordinal. Later live writes advance that projected row.
        SELECT COUNT(*)::integer INTO reply_ordinal
          FROM "messages" AS reply
         WHERE reply."room_id" = p_room_id
           AND reply."thread_root_number" = message_row."thread_root_number"
           AND reply."number" <= p_message_number
           AND NOT (COALESCE(reply."agent_prompt_kind" = 'auto', false) AND BTRIM(reply."text") = '');
      END IF;
    ELSE
      reply_ordinal := COALESCE(previous_projected_ordinal + 1, 1);
    END IF;

    SELECT summary."reply_count" INTO existing_count
      FROM "message_thread_summaries" AS summary
     WHERE summary."room_id" = p_room_id
       AND summary."thread_root_number" = message_row."thread_root_number"
     FOR UPDATE;
    IF existing_count IS NULL THEN
      SELECT COUNT(*)::integer INTO visible_participant_count
        FROM "message_thread_participants" AS participant
       WHERE participant."room_id" = p_room_id
         AND participant."thread_root_number" = message_row."thread_root_number"
         AND participant."message_count" > 0;
    END IF;

    INSERT INTO "message_thread_summaries" (
      "room_id", "thread_root_number", "reply_count", "latest_reply_number", "participant_count"
    ) VALUES (
      p_room_id, message_row."thread_root_number", reply_ordinal,
      p_message_number, GREATEST(visible_participant_count, 1)
    )
    ON CONFLICT ("room_id", "thread_root_number") DO UPDATE SET
      "reply_count" = GREATEST("message_thread_summaries"."reply_count", reply_ordinal),
      "latest_reply_number" = GREATEST(
        "message_thread_summaries"."latest_reply_number", p_message_number
      );

    IF existing_count IS NULL THEN
      INSERT INTO "message_room_thread_stats" ("room_id", "thread_count", "reply_version")
      VALUES (p_room_id, 1, 1)
      ON CONFLICT ("room_id") DO UPDATE SET
        "thread_count" = "message_room_thread_stats"."thread_count" + 1,
        "reply_version" = "message_room_thread_stats"."reply_version" + 1;
    ELSE
      UPDATE "message_room_thread_stats"
         SET "reply_version" = "reply_version" + 1
       WHERE "room_id" = p_room_id;
    END IF;
  END IF;

  INSERT INTO "message_thread_projected_messages" (
    "room_id", "message_number", "thread_root_number", "participant_number",
    "participant_agent_number", "reply_ordinal", "is_visible"
  ) VALUES (
    p_room_id, p_message_number, message_row."thread_root_number", participant_no,
    participant_agent_no, CASE WHEN visible_reply THEN reply_ordinal ELSE NULL END, visible_reply
  );

  RETURN true;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "maintain_message_thread_projection"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."thread_root_number" IS NULL THEN RETURN NEW; END IF;
  PERFORM "project_message_thread_message"(NEW."room_id", NEW."number");
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "remove_prompt_thread_projection"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  projected record;
BEGIN
  IF OLD."thread_root_number" IS NULL
     OR NOT (COALESCE(OLD."agent_prompt_kind" = 'auto', false) AND BTRIM(OLD."text") = '') THEN
    RETURN OLD;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    OLD."room_id" || ':' || OLD."thread_root_number"::text,
    7880078
  ));
  SELECT * INTO projected
    FROM "message_thread_projected_messages"
   WHERE "room_id" = OLD."room_id" AND "message_number" = OLD."number";
  IF FOUND AND NOT projected."is_visible" THEN
    IF projected."participant_agent_number" IS NOT NULL THEN
      UPDATE "message_thread_projected_messages"
         SET "participant_agent_number" = NULL
       WHERE "room_id" = OLD."room_id" AND "message_number" = OLD."number";
      DELETE FROM "message_thread_participant_agents"
       WHERE "room_id" = OLD."room_id"
         AND "thread_root_number" = OLD."thread_root_number"
         AND "participant_number" = projected."participant_number"
         AND "agent_number" = projected."participant_agent_number"
         AND "message_count" = 1;
      IF NOT FOUND THEN
        UPDATE "message_thread_participant_agents"
           SET "message_count" = "message_count" - 1
         WHERE "room_id" = OLD."room_id"
           AND "thread_root_number" = OLD."thread_root_number"
           AND "participant_number" = projected."participant_number"
           AND "agent_number" = projected."participant_agent_number";
      END IF;
    END IF;
    DELETE FROM "message_thread_participants"
     WHERE "room_id" = OLD."room_id"
       AND "thread_root_number" = OLD."thread_root_number"
       AND "participant_number" = projected."participant_number"
       AND "message_count" = 0
       AND "routing_message_count" = 1;
    IF NOT FOUND THEN
      UPDATE "message_thread_participants"
         SET "routing_message_count" = "routing_message_count" - 1
       WHERE "room_id" = OLD."room_id"
         AND "thread_root_number" = OLD."thread_root_number"
         AND "participant_number" = projected."participant_number";
    END IF;
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint

-- The application never edits projection-defining message fields or deletes
-- visible thread members. Enforce that contract in the database so a future
-- writer cannot silently drift summaries/participants/ordinals. Prompt
-- supersession and parent-room cascades remain explicitly allowed.
CREATE OR REPLACE FUNCTION "guard_message_thread_projection_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  row_room_id text := CASE WHEN TG_OP = 'DELETE' THEN OLD."room_id" ELSE NEW."room_id" END;
  row_number integer := OLD."number";
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF COALESCE(OLD."agent_prompt_kind" = 'auto', false) AND BTRIM(OLD."text") = '' THEN
      RETURN OLD;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "rooms" WHERE "id" = OLD."room_id") THEN
      RETURN OLD;
    END IF;
  ELSIF NEW."number" IS DISTINCT FROM OLD."number" THEN
    RAISE EXCEPTION 'message numbers are immutable (room %, message %)',
      OLD."room_id", OLD."number"
      USING ERRCODE = '23514';
  ELSIF NEW."sender" IS NOT DISTINCT FROM OLD."sender"
        AND NEW."source" IS NOT DISTINCT FROM OLD."source"
        AND NEW."publisher_agent_key" IS NOT DISTINCT FROM OLD."publisher_agent_key"
        AND NEW."publisher_account_id" IS NOT DISTINCT FROM OLD."publisher_account_id"
        AND NEW."text" IS NOT DISTINCT FROM OLD."text"
        AND NEW."agent_prompt_kind" IS NOT DISTINCT FROM OLD."agent_prompt_kind"
        AND NEW."thread_root_number" IS NOT DISTINCT FROM OLD."thread_root_number" THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM "message_thread_projected_messages"
     WHERE "room_id" = row_room_id AND "message_number" = row_number
  ) OR EXISTS (
    SELECT 1 FROM "message_thread_participants"
     WHERE "room_id" = row_room_id AND "thread_root_number" = row_number
  ) THEN
    RAISE EXCEPTION 'projected thread messages are immutable (room %, message %)',
      row_room_id, row_number
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "maintain_message_thread_read_position"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  summary_count integer;
  summary_latest integer;
  projected_ordinal integer;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."last_read_message_number" = OLD."last_read_message_number" THEN
    NEW."last_read_reply_count" := OLD."last_read_reply_count";
    RETURN NEW;
  END IF;
  IF NEW."last_read_message_number" = NEW."thread_root_number" THEN
    NEW."last_read_reply_count" := 0;
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW."room_id" || ':' || NEW."thread_root_number"::text,
    7880078
  ));

  SELECT summary."reply_count", summary."latest_reply_number"
    INTO summary_count, summary_latest
    FROM "message_thread_summaries" AS summary
   WHERE summary."room_id" = NEW."room_id"
     AND summary."thread_root_number" = NEW."thread_root_number";
  IF NEW."last_read_message_number" = summary_latest THEN
    NEW."last_read_reply_count" := COALESCE(summary_count, 0);
    RETURN NEW;
  END IF;

  SELECT projected."reply_ordinal"
    INTO projected_ordinal
    FROM "message_thread_projected_messages" AS projected
   WHERE projected."room_id" = NEW."room_id"
     AND projected."thread_root_number" = NEW."thread_root_number"
     AND projected."message_number" <= NEW."last_read_message_number"
     AND projected."reply_ordinal" IS NOT NULL
   ORDER BY projected."message_number" DESC
   LIMIT 1;
  IF projected_ordinal IS NOT NULL THEN
    NEW."last_read_reply_count" := projected_ordinal;
    RETURN NEW;
  END IF;

  -- Only reachable while the online migration watermark is incomplete. It
  -- keeps an old binary's cursor write correct without making steady-state
  -- cursor updates scan the thread.
  IF EXISTS (
    SELECT 1 FROM "message_thread_projection_watermarks"
     WHERE "room_id" = NEW."room_id" AND "completed_at" IS NULL
  ) OR (
    NOT EXISTS (
      SELECT 1 FROM "message_thread_projection_watermarks"
       WHERE "room_id" = NEW."room_id"
    )
    AND EXISTS (
      SELECT 1 FROM "message_thread_projection_rollout"
       WHERE "singleton" AND "completed_at" IS NULL
    )
  ) THEN
    SELECT COUNT(*)::integer INTO NEW."last_read_reply_count"
      FROM "messages" AS reply
     WHERE reply."room_id" = NEW."room_id"
       AND reply."thread_root_number" = NEW."thread_root_number"
       AND reply."number" <= NEW."last_read_message_number"
       AND NOT (COALESCE(reply."agent_prompt_kind" = 'auto', false) AND BTRIM(reply."text") = '');
  ELSE
    NEW."last_read_reply_count" := 0;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "maintain_message_account_thread_read_stat"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  room_reply_version integer;
  summary_reply_count integer;
  read_delta integer := CASE WHEN TG_OP = 'INSERT' THEN 1 ELSE 0 END;
  new_fully_read integer;
  fully_read_delta integer;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."last_read_reply_count" = OLD."last_read_reply_count" THEN
    RETURN NEW;
  END IF;
  SELECT room_stats."reply_version", summary."reply_count"
    INTO room_reply_version, summary_reply_count
    FROM "message_room_thread_stats" AS room_stats
    JOIN "message_thread_summaries" AS summary
      ON summary."room_id" = room_stats."room_id"
     AND summary."thread_root_number" = NEW."thread_root_number"
   WHERE room_stats."room_id" = NEW."room_id";
  IF NOT FOUND THEN RETURN NEW; END IF;
  new_fully_read := CASE
    WHEN NEW."last_read_reply_count" >= summary_reply_count THEN 1 ELSE 0
  END;
  fully_read_delta := new_fully_read - CASE
    WHEN TG_OP = 'UPDATE' AND OLD."last_read_reply_count" >= summary_reply_count THEN 1 ELSE 0
  END;
  INSERT INTO "message_account_thread_read_stats" (
    "room_id", "account_id", "current_read_version", "cached_read_version",
    "cached_room_reply_version", "read_thread_count", "fully_read_thread_count"
  ) VALUES (
    NEW."room_id", NEW."account_id", 1,
    CASE WHEN TG_OP = 'INSERT' THEN 1 ELSE -1 END,
    CASE WHEN TG_OP = 'INSERT' THEN room_reply_version ELSE -1 END,
    CASE WHEN TG_OP = 'INSERT' THEN 1 ELSE 0 END,
    CASE WHEN TG_OP = 'INSERT' THEN new_fully_read ELSE 0 END
  ) ON CONFLICT ("room_id", "account_id") DO UPDATE SET
    "current_read_version" = "message_account_thread_read_stats"."current_read_version" + 1,
    "cached_read_version" = CASE
      WHEN "message_account_thread_read_stats"."cached_read_version"
             = "message_account_thread_read_stats"."current_read_version"
       AND "message_account_thread_read_stats"."cached_room_reply_version" = room_reply_version
      THEN "message_account_thread_read_stats"."current_read_version" + 1
      ELSE "message_account_thread_read_stats"."cached_read_version"
    END,
    "read_thread_count" = CASE
      WHEN "message_account_thread_read_stats"."cached_read_version"
             = "message_account_thread_read_stats"."current_read_version"
       AND "message_account_thread_read_stats"."cached_room_reply_version" = room_reply_version
      THEN "message_account_thread_read_stats"."read_thread_count" + read_delta
      ELSE "message_account_thread_read_stats"."read_thread_count"
    END,
    "fully_read_thread_count" = CASE
      WHEN "message_account_thread_read_stats"."cached_read_version"
             = "message_account_thread_read_stats"."current_read_version"
       AND "message_account_thread_read_stats"."cached_room_reply_version" = room_reply_version
      THEN "message_account_thread_read_stats"."fully_read_thread_count" + fully_read_delta
      ELSE "message_account_thread_read_stats"."fully_read_thread_count"
    END;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- Room codes are mutable. If a rename crosses behind the rollout keyset
-- cursor, explicitly carry/create its watermark using the old sequence key;
-- an already-created watermark follows the room FK's ON UPDATE CASCADE.
CREATE OR REPLACE FUNCTION "fence_message_thread_rollout_room_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Statement triggers run before UPDATE/DELETE takes a room tuple or cascade
  -- lock. Match the reconciler's singleton -> room order so neither direction
  -- can deadlock during projection drain.
  PERFORM 1
    FROM "message_thread_projection_rollout"
   WHERE "singleton"
   FOR SHARE;
  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "maintain_message_thread_rollout_room_rename"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  rollout_incomplete boolean;
  through_message_number integer;
BEGIN
  -- The BEFORE STATEMENT fence already holds the singleton share lock. Re-read
  -- rollout state under it: a rename before final ready contributes its
  -- watermark; one that starts after ready needs no legacy repair.
  SELECT rollout."completed_at" IS NULL
    INTO rollout_incomplete
    FROM "message_thread_projection_rollout" AS rollout
   WHERE rollout."singleton";

  IF rollout_incomplete AND NOT EXISTS (
    SELECT 1 FROM "message_thread_projection_watermarks"
     WHERE "room_id" = NEW."id"
  ) THEN
    SELECT GREATEST(
      COALESCE((
        SELECT sequence."value" FROM "id_sequences" AS sequence
         WHERE sequence."name" = 'messages:' || OLD."id"
      ), 0),
      COALESCE((
        SELECT message."number" FROM "messages" AS message
         WHERE message."room_id" IN (OLD."id", NEW."id")
         ORDER BY message."number" DESC LIMIT 1
      ), 0)
    ) INTO through_message_number;
    INSERT INTO "message_thread_projection_watermarks" (
      "room_id", "through_message_number", "completed_at"
    ) VALUES (
      NEW."id",
      through_message_number,
      NULL
    )
    ON CONFLICT ("room_id") DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "reconcile_message_thread_projection"(p_batch_limit integer DEFAULT 500)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  rollout_row "message_thread_projection_rollout"%ROWTYPE;
  watermark_row "message_thread_projection_watermarks"%ROWTYPE;
  candidate record;
  processed integer := 0;
  bounded_limit integer := LEAST(GREATEST(COALESCE(p_batch_limit, 500), 1), 2000);
  repaired_count integer;
  current_read_message_number integer;
  last_message_number integer;
  last_read_root integer;
  last_read_account text;
BEGIN
  SELECT * INTO rollout_row
    FROM "message_thread_projection_rollout"
   WHERE "singleton"
   FOR UPDATE;

  IF NOT rollout_row."watermarks_created" THEN
    FOR candidate IN
      SELECT room."id" AS "room_id",
             GREATEST(COALESCE(sequence."value", 0), COALESCE(latest."number", 0))
               AS "through_message_number"
        FROM "rooms" AS room
        LEFT JOIN "id_sequences" AS sequence
          ON sequence."name" = 'messages:' || room."id"
        LEFT JOIN LATERAL (
          SELECT message."number"
            FROM "messages" AS message
           WHERE message."room_id" = room."id"
           ORDER BY message."number" DESC
           LIMIT 1
        ) AS latest ON true
       WHERE room."id" > rollout_row."room_cursor"
       ORDER BY room."id"
       LIMIT bounded_limit
    LOOP
      BEGIN
        INSERT INTO "message_thread_projection_watermarks" (
          "room_id", "through_message_number", "completed_at"
        ) VALUES (candidate."room_id", candidate."through_message_number", NULL)
        ON CONFLICT ("room_id") DO NOTHING;
      EXCEPTION WHEN foreign_key_violation THEN
        -- A room can commit a delete/rename after the keyset SELECT but before
        -- the FK check. Ignore only that confirmed disappearance; a rollback
        -- lets the INSERT succeed, and any other FK failure remains fatal.
        PERFORM 1 FROM "rooms" WHERE "id" = candidate."room_id";
        IF FOUND THEN RAISE; END IF;
      END;
      rollout_row."room_cursor" := candidate."room_id";
      processed := processed + 1;
    END LOOP;

    IF processed = 0 THEN
      UPDATE "message_thread_projection_rollout"
         SET "watermarks_created" = true
       WHERE "singleton";
      RETURN 1;
    END IF;
    UPDATE "message_thread_projection_rollout"
       SET "room_cursor" = rollout_row."room_cursor"
     WHERE "singleton";
    RETURN processed;
  END IF;

  SELECT * INTO watermark_row
    FROM "message_thread_projection_watermarks"
   WHERE "completed_at" IS NULL
   ORDER BY "room_id"
   LIMIT 1
   FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    UPDATE "message_thread_projection_rollout"
       SET "completed_at" = COALESCE("completed_at", NOW())
     WHERE "singleton";
    RETURN 0;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(watermark_row."room_id", 7880079));

  IF watermark_row."message_cursor" < watermark_row."through_message_number" THEN
    FOR candidate IN
      SELECT message."number", message."thread_root_number"
        FROM "messages" AS message
       WHERE message."room_id" = watermark_row."room_id"
         AND message."number" > watermark_row."message_cursor"
         AND message."number" <= watermark_row."through_message_number"
       ORDER BY message."number"
       LIMIT bounded_limit
    LOOP
      IF candidate."thread_root_number" IS NOT NULL THEN
        PERFORM "project_message_thread_message"(watermark_row."room_id", candidate."number");
      END IF;
      last_message_number := candidate."number";
      processed := processed + 1;
    END LOOP;

    UPDATE "message_thread_projection_watermarks"
       SET "message_cursor" = COALESCE(last_message_number, "through_message_number")
     WHERE "room_id" = watermark_row."room_id";
    RETURN GREATEST(processed, 1);
  END IF;

  IF NOT watermark_row."reads_completed" THEN
    FOR candidate IN
      SELECT thread_read."thread_root_number", thread_read."account_id"
        FROM "message_thread_reads" AS thread_read
       WHERE thread_read."room_id" = watermark_row."room_id"
         AND (thread_read."thread_root_number", thread_read."account_id")
             > (watermark_row."read_thread_root_cursor", watermark_row."read_account_cursor")
       ORDER BY thread_read."thread_root_number", thread_read."account_id"
       LIMIT bounded_limit
    LOOP
      -- Lock and re-read the cursor row. The room rollout advisory already
      -- stabilizes projected ordinals; taking a per-thread advisory here would
      -- retain it across readers and invert with a second reader's tuple lock.
      SELECT thread_read."last_read_message_number"
        INTO current_read_message_number
        FROM "message_thread_reads" AS thread_read
       WHERE thread_read."room_id" = watermark_row."room_id"
         AND thread_read."thread_root_number" = candidate."thread_root_number"
         AND thread_read."account_id" = candidate."account_id"
       FOR UPDATE;
      IF FOUND THEN
        IF current_read_message_number = candidate."thread_root_number" THEN
          repaired_count := 0;
        ELSE
          SELECT COALESCE(projected."reply_ordinal", 0)
            INTO repaired_count
            FROM (SELECT 1) AS singleton
            LEFT JOIN LATERAL (
              SELECT prior."reply_ordinal"
                FROM "message_thread_projected_messages" AS prior
               WHERE prior."room_id" = watermark_row."room_id"
                 AND prior."thread_root_number" = candidate."thread_root_number"
                 AND prior."message_number" <= current_read_message_number
                 AND prior."reply_ordinal" IS NOT NULL
               ORDER BY prior."message_number" DESC
               LIMIT 1
            ) AS projected ON true;
        END IF;
        UPDATE "message_thread_reads"
           SET "last_read_reply_count" = repaired_count
         WHERE "room_id" = watermark_row."room_id"
           AND "thread_root_number" = candidate."thread_root_number"
           AND "account_id" = candidate."account_id";
      END IF;
      last_read_root := candidate."thread_root_number";
      last_read_account := candidate."account_id";
      processed := processed + 1;
    END LOOP;
    IF processed = 0 THEN
      UPDATE "message_thread_projection_watermarks"
         SET "reads_completed" = true,
             "completed_at" = NOW()
       WHERE "room_id" = watermark_row."room_id";
      RETURN 1;
    END IF;
    UPDATE "message_thread_projection_watermarks"
       SET "read_thread_root_cursor" = last_read_root,
           "read_account_cursor" = last_read_account
     WHERE "room_id" = watermark_row."room_id";
    RETURN processed;
  END IF;

  UPDATE "message_thread_projection_watermarks"
     SET "completed_at" = NOW()
   WHERE "room_id" = watermark_row."room_id";
  RETURN 1;
END;
$$;--> statement-breakpoint

-- Fresh databases have no legacy range and can start immediately. EXISTS
-- stops at the first room on upgraded databases; it is not a backfill scan.
UPDATE "message_thread_projection_rollout"
   SET "watermarks_created" = true, "completed_at" = NOW()
 WHERE "singleton" AND NOT EXISTS (SELECT 1 FROM "rooms");--> statement-breakpoint

-- Keep every lock on a hot legacy table in one final, retried cutover. The
-- projection tables are still empty and private to this migration transaction,
-- so validating the newly-added NOT VALID constraints is constant work. A
-- tighter caller-supplied lock_timeout is respected for tests/operators.
DO $$
DECLARE
  lock_attempt integer;
BEGIN
  IF current_setting('lock_timeout') = '0' THEN
    PERFORM set_config('lock_timeout', '1s', true);
  END IF;
  FOR lock_attempt IN 1..3 LOOP
    BEGIN
      EXECUTE $ddl$
        CREATE UNIQUE INDEX "agents_routing_canonical_key_idx"
          ON "agents" (normalize_message_thread_routing_alias("canonical_key", true))
      $ddl$;

      EXECUTE $ddl$
        ALTER TABLE "message_thread_reads"
          ADD COLUMN "last_read_reply_count" integer NOT NULL DEFAULT 0
      $ddl$;

      EXECUTE $ddl$
        CREATE TRIGGER "messages_thread_projection_after_insert"
        AFTER INSERT ON "messages"
        FOR EACH ROW EXECUTE FUNCTION "maintain_message_thread_projection"()
      $ddl$;
      EXECUTE $ddl$
        CREATE TRIGGER "messages_prompt_projection_before_delete"
        BEFORE DELETE ON "messages"
        FOR EACH ROW EXECUTE FUNCTION "remove_prompt_thread_projection"()
      $ddl$;
      EXECUTE $ddl$
        CREATE TRIGGER "messages_thread_projection_guard_before_delete"
        BEFORE DELETE ON "messages"
        FOR EACH ROW EXECUTE FUNCTION "guard_message_thread_projection_mutation"()
      $ddl$;
      EXECUTE $ddl$
        CREATE TRIGGER "messages_thread_projection_guard_before_update"
        BEFORE UPDATE OF "number", "sender", "source", "publisher_agent_key", "publisher_account_id",
          "text", "agent_prompt_kind", "thread_root_number"
        ON "messages"
        FOR EACH ROW EXECUTE FUNCTION "guard_message_thread_projection_mutation"()
      $ddl$;
      EXECUTE $ddl$
        CREATE TRIGGER "message_thread_reads_position_before_write"
        BEFORE INSERT OR UPDATE OF "last_read_message_number" ON "message_thread_reads"
        FOR EACH ROW EXECUTE FUNCTION "maintain_message_thread_read_position"()
      $ddl$;
      EXECUTE $ddl$
        CREATE TRIGGER "message_thread_reads_stats_after_write"
        AFTER INSERT OR UPDATE ON "message_thread_reads"
        FOR EACH ROW EXECUTE FUNCTION "maintain_message_account_thread_read_stat"()
      $ddl$;
      EXECUTE $ddl$
        CREATE TRIGGER "rooms_thread_rollout_rename_fence_before_update"
        BEFORE UPDATE OF "id" ON "rooms"
        FOR EACH STATEMENT EXECUTE FUNCTION "fence_message_thread_rollout_room_mutation"()
      $ddl$;
      EXECUTE $ddl$
        CREATE TRIGGER "rooms_thread_rollout_delete_fence_before_delete"
        BEFORE DELETE ON "rooms"
        FOR EACH STATEMENT EXECUTE FUNCTION "fence_message_thread_rollout_room_mutation"()
      $ddl$;
      EXECUTE $ddl$
        CREATE TRIGGER "rooms_thread_rollout_after_rename"
        AFTER UPDATE OF "id" ON "rooms"
        FOR EACH ROW EXECUTE FUNCTION "maintain_message_thread_rollout_room_rename"()
      $ddl$;

      EXECUTE $ddl$
        ALTER TABLE "message_thread_summaries"
          ADD CONSTRAINT "message_thread_summaries_root_fk"
          FOREIGN KEY ("room_id", "thread_root_number")
          REFERENCES "messages"("room_id", "number") ON DELETE cascade ON UPDATE cascade NOT VALID,
          ADD CONSTRAINT "message_thread_summaries_latest_reply_fk"
          FOREIGN KEY ("room_id", "latest_reply_number")
          REFERENCES "messages"("room_id", "number") ON DELETE cascade ON UPDATE cascade NOT VALID
      $ddl$;
      EXECUTE $ddl$
        ALTER TABLE "message_thread_participants"
          ADD CONSTRAINT "message_thread_participants_root_fk"
          FOREIGN KEY ("room_id", "thread_root_number")
          REFERENCES "messages"("room_id", "number") ON DELETE cascade ON UPDATE cascade NOT VALID
      $ddl$;
      EXECUTE $ddl$
        ALTER TABLE "message_thread_projected_messages"
          ADD CONSTRAINT "message_thread_projected_messages_message_fk"
          FOREIGN KEY ("room_id", "message_number")
          REFERENCES "messages"("room_id", "number") ON DELETE cascade ON UPDATE cascade NOT VALID,
          ADD CONSTRAINT "message_thread_projected_messages_root_fk"
          FOREIGN KEY ("room_id", "thread_root_number")
          REFERENCES "messages"("room_id", "number") ON DELETE cascade ON UPDATE cascade NOT VALID
      $ddl$;
      EXECUTE $ddl$
        ALTER TABLE "message_room_thread_stats"
          ADD CONSTRAINT "message_room_thread_stats_room_fk"
          FOREIGN KEY ("room_id") REFERENCES "rooms"("id")
          ON DELETE cascade ON UPDATE cascade NOT VALID
      $ddl$;
      EXECUTE $ddl$
        ALTER TABLE "message_thread_projection_watermarks"
          ADD CONSTRAINT "message_thread_projection_watermarks_room_fk"
          FOREIGN KEY ("room_id") REFERENCES "rooms"("id")
          ON DELETE cascade ON UPDATE cascade NOT VALID
      $ddl$;
      EXECUTE $ddl$
        ALTER TABLE "message_account_thread_read_stats"
          ADD CONSTRAINT "message_account_thread_read_stats_room_id_rooms_id_fk"
          FOREIGN KEY ("room_id") REFERENCES "rooms"("id")
          ON DELETE cascade ON UPDATE cascade NOT VALID,
          ADD CONSTRAINT "message_account_thread_read_stats_account_id_accounts_id_fk"
          FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
          ON DELETE cascade ON UPDATE cascade NOT VALID
      $ddl$;

      ALTER TABLE "message_thread_summaries"
        VALIDATE CONSTRAINT "message_thread_summaries_root_fk",
        VALIDATE CONSTRAINT "message_thread_summaries_latest_reply_fk";
      ALTER TABLE "message_thread_participants"
        VALIDATE CONSTRAINT "message_thread_participants_root_fk";
      ALTER TABLE "message_thread_projected_messages"
        VALIDATE CONSTRAINT "message_thread_projected_messages_message_fk",
        VALIDATE CONSTRAINT "message_thread_projected_messages_root_fk";
      ALTER TABLE "message_room_thread_stats"
        VALIDATE CONSTRAINT "message_room_thread_stats_room_fk";
      ALTER TABLE "message_thread_projection_watermarks"
        VALIDATE CONSTRAINT "message_thread_projection_watermarks_room_fk";
      ALTER TABLE "message_account_thread_read_stats"
        VALIDATE CONSTRAINT "message_account_thread_read_stats_room_id_rooms_id_fk",
        VALIDATE CONSTRAINT "message_account_thread_read_stats_account_id_accounts_id_fk";
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected OR serialization_failure THEN
      IF lock_attempt = 3 THEN RAISE; END IF;
      PERFORM pg_sleep(lock_attempt * 0.1);
    END;
  END LOOP;
END;
$$;
