-- Keep only replay keys after deletion, never deleted content.
CREATE TABLE deleted_content_keys (
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE ON UPDATE CASCADE,
  kind text NOT NULL CHECK (kind IN ('message', 'task', 'task_source', 'task_external')),
  client_key text NOT NULL,
  PRIMARY KEY (room_id, kind, client_key)
);
--> statement-breakpoint
CREATE TABLE attachment_deletion_queue (
  object_key text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE FUNCTION guard_deleted_content_replay() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE content_kind text; replay_key text;
BEGIN
  -- Coordinate inserts with deletion before taking message/projection locks.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.room_id, 9510));
  IF TG_TABLE_NAME = 'messages' THEN
    content_kind := 'message'; replay_key := NEW.client_message_id;
  ELSE
    content_kind := 'task'; replay_key := NEW.client_task_id;
    IF NEW.external_ref IS NOT NULL AND EXISTS (
      SELECT 1 FROM deleted_content_keys WHERE room_id=NEW.room_id AND kind='task_external' AND client_key=NEW.external_ref
    ) THEN RETURN NULL; END IF;
    IF replay_key IS NULL AND NEW.source_message_id IS NOT NULL THEN
      content_kind := 'task_source'; replay_key := NEW.source_message_id;
    END IF;
  END IF;
  IF replay_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM deleted_content_keys
    WHERE room_id = NEW.room_id AND kind = content_kind AND client_key = replay_key
  ) THEN
    RAISE EXCEPTION 'This content was permanently deleted and cannot be replayed.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER messages_deleted_replay_before_insert BEFORE INSERT ON messages
FOR EACH ROW EXECUTE FUNCTION guard_deleted_content_replay();
--> statement-breakpoint
CREATE TRIGGER tasks_deleted_replay_before_insert BEFORE INSERT ON tasks
FOR EACH ROW EXECUTE FUNCTION guard_deleted_content_replay();

--> statement-breakpoint
CREATE TABLE deleted_rooms (room_id text PRIMARY KEY, deleted_at timestamptz NOT NULL DEFAULT now());
--> statement-breakpoint
CREATE FUNCTION guard_deleted_room_replay() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.id, 9510));
  IF EXISTS (SELECT 1 FROM deleted_rooms WHERE room_id=NEW.id) THEN
    RAISE EXCEPTION 'This room was permanently deleted.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER rooms_deleted_replay_before_insert BEFORE INSERT ON rooms
FOR EACH ROW EXECUTE FUNCTION guard_deleted_room_replay();
--> statement-breakpoint
CREATE FUNCTION guard_deleted_task_lease() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.task_id IS NOT NULL AND NEW.status='active' THEN
    PERFORM 1 FROM tasks WHERE room_id=NEW.room_id AND 'task_' || number::text=NEW.task_id FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Task no longer exists.' USING ERRCODE = '23503'; END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER task_leases_existing_task BEFORE INSERT OR UPDATE OF status ON task_leases
FOR EACH ROW EXECUTE FUNCTION guard_deleted_task_lease();

--> statement-breakpoint
-- Preserve the existing orphan-retirement lifecycle for legacy room removals,
-- while preventing new asks from arriving after permanent deletion's preflight.
CREATE FUNCTION guard_deleted_ask_room() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.room_id, 9510));
  PERFORM 1 FROM rooms WHERE id=NEW.room_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Room no longer exists.' USING ERRCODE = '23503'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER agent_asks_existing_room BEFORE INSERT OR UPDATE OF room_id ON agent_asks
FOR EACH ROW EXECUTE FUNCTION guard_deleted_ask_room();
