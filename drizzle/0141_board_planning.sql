CREATE TABLE room_board_planning (
  room_id text PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE ON UPDATE CASCADE,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  document jsonb NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Existing imports need one normal full read to acquire iteration/estimate metadata.
-- Keep outstanding claims, backoff, and all GitHub imports unchanged.
UPDATE room_tracker_filters SET last_synced_at = NULL WHERE provider IN ('jira', 'linear');
