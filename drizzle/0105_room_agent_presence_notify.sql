-- Announce, at commit, when an agent starts or stops working in a room.
-- NOTIFY inside a transaction is delivered only if it commits, so listeners
-- never see work that rolled back. Heartbeats that change nothing are silent.
CREATE OR REPLACE FUNCTION notify_room_agent_presence_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('working', 'reviewing') THEN
      PERFORM pg_notify('letagents_presence_changes', OLD.room_id);
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status IN ('working', 'reviewing') THEN
      PERFORM pg_notify('letagents_presence_changes', NEW.room_id);
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.room_id IS DISTINCT FROM NEW.room_id THEN
    PERFORM pg_notify('letagents_presence_changes', OLD.room_id);
    PERFORM pg_notify('letagents_presence_changes', NEW.room_id);
  ELSIF (OLD.status IN ('working', 'reviewing')) IS DISTINCT FROM (NEW.status IN ('working', 'reviewing'))
    OR (NEW.status IN ('working', 'reviewing') AND (
      OLD.display_name IS DISTINCT FROM NEW.display_name
      -- An agent that went quiet long enough to be shown as idle is working again.
      OR OLD.last_heartbeat_at < NEW.last_heartbeat_at - interval '90 seconds'
    ))
  THEN
    PERFORM pg_notify('letagents_presence_changes', NEW.room_id);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS room_agent_presence_notify ON room_agent_presence;
--> statement-breakpoint
CREATE TRIGGER room_agent_presence_notify
AFTER INSERT OR UPDATE OR DELETE ON room_agent_presence
FOR EACH ROW EXECUTE FUNCTION notify_room_agent_presence_change();
