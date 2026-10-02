-- Emoji reactions that people leave on room messages. A reaction is not a
-- message: it is never routed to an agent and never notifies anyone.

-- The foreign key to messages needs a lock that conflicts with every message
-- write. Give up rather than queue all of them behind a long transaction.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE message_reactions (
  room_id text NOT NULL,
  message_number integer NOT NULL,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE ON UPDATE CASCADE,
  emoji text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_reactions_pk PRIMARY KEY (room_id, message_number, account_id, emoji),
  CONSTRAINT message_reactions_message_fk FOREIGN KEY (room_id, message_number)
    REFERENCES messages(room_id, number) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT message_reactions_emoji_check CHECK (octet_length(emoji) BETWEEN 1 AND 64)
);
--> statement-breakpoint
CREATE INDEX message_reactions_account_idx ON message_reactions (account_id);
