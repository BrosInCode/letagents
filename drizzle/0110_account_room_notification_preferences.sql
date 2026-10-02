SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE TABLE account_room_notification_preferences (
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE ON UPDATE CASCADE,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE ON UPDATE CASCADE,
  level text NOT NULL DEFAULT 'all' CHECK (level IN ('all', 'mentions', 'muted')),
  snoozed_until timestamptz,
  CONSTRAINT account_room_notification_preferences_pk PRIMARY KEY (account_id, room_id)
);
