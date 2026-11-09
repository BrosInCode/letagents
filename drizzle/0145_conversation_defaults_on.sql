-- Smart conversation routing and GIFs and agent reactions start on in rooms
-- made from now on. Rooms that already exist keep the value they hold: it
-- cannot tell a room that never chose from one whose admin turned it off.

-- rooms is read on almost every request. Give up rather than queue all of
-- them behind a long transaction.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE rooms ALTER COLUMN jev_routing_enabled SET DEFAULT true;
--> statement-breakpoint
ALTER TABLE room_settings ALTER COLUMN expressions_enabled SET DEFAULT true;
--> statement-breakpoint
-- Every room gets a settings row. The send path holds a shared lock on this
-- row while it reads a setting, so an admin's change waits for messages that
-- read the old value. With defaults that are on, a room with no row would let
-- a first "off" pass a message that is still being sent. A room that had no
-- row had chosen nothing, so its new row holds only the defaults.
INSERT INTO room_settings (room_id) SELECT id FROM rooms ON CONFLICT (room_id) DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_room_settings_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO room_settings (room_id) VALUES (NEW.id) ON CONFLICT (room_id) DO NOTHING;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER rooms_create_settings_row
AFTER INSERT ON rooms
FOR EACH ROW EXECUTE FUNCTION create_room_settings_row();
