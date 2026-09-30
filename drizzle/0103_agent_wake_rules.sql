CREATE TABLE agent_wake_rules (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE ON UPDATE CASCADE,
  agent_key text NOT NULL,
  agent_name text NOT NULL,
  created_by_session_id text,
  event text NOT NULL CONSTRAINT agent_wake_rules_event_check CHECK (event IN ('timer', 'task.status_changed', 'github.check_completed', 'github.review_submitted', 'github.pr_closed')),
  arguments jsonb NOT NULL,
  identity_key text NOT NULL,
  note text,
  repeat boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CONSTRAINT agent_wake_rules_status_check CHECK (status IN ('active', 'fired', 'expired', 'cancelled')),
  baseline jsonb,
  cursor_at timestamptz NOT NULL,
  next_check_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  fire_count integer NOT NULL DEFAULT 0,
  last_fired_at timestamptz,
  wake_message_number integer,
  cancelled_by jsonb,
  ended_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX agent_wake_rules_active_identity_uq ON agent_wake_rules(room_id, agent_key, identity_key) WHERE status = 'active';
--> statement-breakpoint
CREATE INDEX agent_wake_rules_active_room_idx ON agent_wake_rules(room_id, event) WHERE status = 'active';
--> statement-breakpoint
CREATE INDEX agent_wake_rules_next_check_idx ON agent_wake_rules(next_check_at) WHERE status = 'active';
--> statement-breakpoint
CREATE INDEX agent_wake_rules_recent_idx ON agent_wake_rules(room_id, ended_at) WHERE status <> 'active';
