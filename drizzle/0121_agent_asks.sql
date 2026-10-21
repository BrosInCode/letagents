-- Additive: a new table for "Ask for an agent"; old servers never read it.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE TABLE agent_asks (
  id text PRIMARY KEY,
  link_token_hash text NOT NULL,
  room_id text NOT NULL,
  asker_account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE ON UPDATE CASCADE,
  provider_id text NOT NULL,
  model text,
  model_label text NOT NULL,
  amount_percent integer,
  note text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'claimed', 'on_hold', 'active', 'paused', 'ended', 'expired', 'cancelled')),
  expires_at timestamptz NOT NULL,
  giver_account_id text REFERENCES accounts(id) ON DELETE SET NULL ON UPDATE CASCADE,
  claim_expires_at timestamptz,
  given_provider_id text,
  given_model text,
  given_model_label text,
  given_amount_percent integer,
  agent_key text,
  grant_id text,
  room_agent_session_id text,
  paused_at timestamptz,
  hold_expires_at timestamptz,
  ended_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  CONSTRAINT agent_asks_amount_check CHECK ((amount_percent IS NULL OR amount_percent BETWEEN 1 AND 100) AND (given_amount_percent IS NULL OR given_amount_percent BETWEEN 1 AND 100))
);
--> statement-breakpoint
CREATE UNIQUE INDEX agent_asks_link_token_hash_uq ON agent_asks (link_token_hash);
--> statement-breakpoint
CREATE INDEX agent_asks_room_idx ON agent_asks (room_id, created_at);
--> statement-breakpoint
CREATE INDEX agent_asks_asker_open_idx ON agent_asks (asker_account_id) WHERE state IN ('open', 'claimed');
--> statement-breakpoint
CREATE INDEX agent_asks_giver_idx ON agent_asks (giver_account_id) WHERE state IN ('claimed', 'on_hold', 'active', 'paused');
--> statement-breakpoint
CREATE INDEX agent_asks_live_idx ON agent_asks (state, updated_at) WHERE state IN ('open', 'claimed', 'on_hold', 'active', 'paused');
--> statement-breakpoint
CREATE INDEX agent_asks_grant_idx ON agent_asks (grant_id) WHERE grant_id IS NOT NULL;
