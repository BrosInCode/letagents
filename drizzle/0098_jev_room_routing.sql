ALTER TABLE rooms ADD COLUMN jev_routing_enabled boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE jev_routing_jobs (
  room_id text NOT NULL,
  message_number integer NOT NULL,
  plan jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'completed')),
  claim_token text,
  available_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '8 seconds'),
  attempts integer NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, message_number),
  FOREIGN KEY (room_id, message_number) REFERENCES messages(room_id, number) ON DELETE CASCADE ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE INDEX jev_routing_jobs_pending_idx ON jev_routing_jobs(available_at) WHERE state <> 'completed';
--> statement-breakpoint
CREATE INDEX jev_routing_jobs_frontier_idx ON jev_routing_jobs(room_id, message_number) WHERE state <> 'completed' AND plan->>'mode' = 'active';
--> statement-breakpoint
ALTER TABLE message_agent_receipts DROP COLUMN deferred_delivered_at;
