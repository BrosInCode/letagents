-- Bound the migration's foreign-key lock wait on the message table.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE message_pins (
  room_id text NOT NULL,
  message_number integer NOT NULL,
  pinned_by_account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE ON UPDATE CASCADE,
  pinned_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_pins_pk PRIMARY KEY (room_id, message_number),
  CONSTRAINT message_pins_message_fk FOREIGN KEY (room_id, message_number)
    REFERENCES messages(room_id, number) ON DELETE CASCADE ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE INDEX message_pins_account_idx ON message_pins (pinned_by_account_id);
