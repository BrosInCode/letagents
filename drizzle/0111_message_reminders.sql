-- Additive: old servers retain their original outbox table and unique index.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE TABLE message_reminders (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE ON UPDATE CASCADE,
  room_id text NOT NULL,
  message_number integer NOT NULL,
  due_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'due')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (room_id, message_number) REFERENCES messages(room_id, number) ON DELETE CASCADE ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE INDEX message_reminders_pending_idx ON message_reminders (due_at, id) WHERE state = 'pending';
--> statement-breakpoint
CREATE INDEX message_reminders_account_idx ON message_reminders (account_id, due_at, id);
--> statement-breakpoint
CREATE TABLE desktop_reminder_deliveries (
  id text PRIMARY KEY,
  reminder_id text NOT NULL REFERENCES message_reminders(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES desktop_push_devices(id) ON DELETE CASCADE ON UPDATE CASCADE,
  room_id text NOT NULL,
  message_number integer NOT NULL,
  thread_root_number integer,
  room_display_name text NOT NULL DEFAULT '',
  sender text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'processing', 'retry', 'delivered', 'dead')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  claimed_by text,
  apns_id text,
  last_status integer,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX desktop_reminder_deliveries_device_reminder_uq ON desktop_reminder_deliveries (device_id, reminder_id);
--> statement-breakpoint
CREATE INDEX desktop_reminder_deliveries_ready_idx ON desktop_reminder_deliveries (state, next_attempt_at, created_at);
--> statement-breakpoint
CREATE INDEX desktop_reminder_deliveries_reminder_idx ON desktop_reminder_deliveries (reminder_id);
