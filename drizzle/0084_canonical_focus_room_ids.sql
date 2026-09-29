-- Focus rooms have one opaque identity contract. Older Git branch focus rooms
-- embedded their repository and ref in rooms.id; rewrite those primary keys in
-- place so ON UPDATE CASCADE preserves all room-owned state and history.
ALTER TABLE "rental_sessions"
DROP CONSTRAINT "rental_sessions_target_room_fk",
ADD CONSTRAINT "rental_sessions_target_room_fk"
  FOREIGN KEY ("target_room_id") REFERENCES "rooms"("id") ON UPDATE CASCADE,
DROP CONSTRAINT "rental_sessions_room_fk",
ADD CONSTRAINT "rental_sessions_room_fk"
  FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON UPDATE CASCADE;--> statement-breakpoint

ALTER TABLE "rental_activity_events"
DROP CONSTRAINT "rental_activity_events_room_fk",
ADD CONSTRAINT "rental_activity_events_room_fk"
  FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON UPDATE CASCADE;--> statement-breakpoint

-- Updating rooms.id fans out through both the message hierarchy and the
-- projected-message idempotency rows. PostgreSQL is free to visit those
-- cascading paths in either order, so the projected row can briefly carry the
-- new room id before its composite participant-agent parent does. Defer this
-- cross-path check only while this migration performs the cascades; runtime
-- writes retain the original immediate integrity contract afterward.
ALTER TABLE "message_thread_projected_messages"
ALTER CONSTRAINT "message_thread_projected_messages_participant_agent_fk"
DEFERRABLE INITIALLY IMMEDIATE;--> statement-breakpoint
SET CONSTRAINTS "message_thread_projected_messages_participant_agent_fk" DEFERRED;--> statement-breakpoint

DO $$
DECLARE
  next_focus_number integer;
  focus_room record;
  next_focus_id text;
BEGIN
  LOCK TABLE "rooms" IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE "id_sequences" IN SHARE ROW EXCLUSIVE MODE;

  SELECT GREATEST(
    COALESCE((
      SELECT "value"
      FROM "id_sequences"
      WHERE "name" = 'focus_rooms'
    ), 0),
    COALESCE((
      SELECT MAX(SUBSTRING("id" FROM '^focus_([1-9][0-9]*)$')::integer)
      FROM "rooms"
      WHERE "kind" = 'focus'
        AND "id" ~ '^focus_[1-9][0-9]*$'
    ), 0)
  )
  INTO next_focus_number;

  FOR focus_room IN
    SELECT "id"
    FROM "rooms"
    WHERE "kind" = 'focus'
      AND "id" !~ '^focus_[1-9][0-9]*$'
    ORDER BY "created_at", "id"
  LOOP
    next_focus_number := next_focus_number + 1;
    next_focus_id := 'focus_' || next_focus_number;

    -- These columns intentionally are not foreign keys, but they still carry
    -- canonical room authority or durable audit context.
    UPDATE "github_app_repositories"
    SET "room_id" = next_focus_id
    WHERE "room_id" = focus_room."id";

    UPDATE "github_webhook_deliveries"
    SET "room_id" = next_focus_id
    WHERE "room_id" = focus_room."id";

    UPDATE "message_agent_receipt_events"
    SET "message_room_id" = next_focus_id
    WHERE "message_room_id" = focus_room."id";

    UPDATE "supervisor_host_grants"
    SET "allowed_room_ids" = ARRAY_REPLACE(
      "allowed_room_ids",
      focus_room."id",
      next_focus_id
    )
    WHERE focus_room."id" = ANY("allowed_room_ids");

    UPDATE "rooms"
    SET "id" = next_focus_id
    WHERE "id" = focus_room."id";

    -- Rename counters after the room so the existing room-rename trigger can
    -- read the old message high-water while establishing rollout state.
    UPDATE "id_sequences"
    SET "name" = 'messages:' || next_focus_id
    WHERE "name" = 'messages:' || focus_room."id";

    UPDATE "id_sequences"
    SET "name" = 'tasks:' || next_focus_id
    WHERE "name" = 'tasks:' || focus_room."id";
  END LOOP;

  INSERT INTO "id_sequences" ("name", "value")
  VALUES ('focus_rooms', next_focus_number)
  ON CONFLICT ("name") DO UPDATE
  SET "value" = EXCLUDED."value";
END
$$;--> statement-breakpoint

-- Validate the settled cascade before restoring the canonical runtime schema.
SET CONSTRAINTS "message_thread_projected_messages_participant_agent_fk" IMMEDIATE;--> statement-breakpoint
ALTER TABLE "message_thread_projected_messages"
ALTER CONSTRAINT "message_thread_projected_messages_participant_agent_fk"
NOT DEFERRABLE;--> statement-breakpoint

ALTER TABLE "rooms"
ADD CONSTRAINT "rooms_focus_id_check"
CHECK ("kind" <> 'focus' OR "id" ~ '^focus_[1-9][0-9]*$');
