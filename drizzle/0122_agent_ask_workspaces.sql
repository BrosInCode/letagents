-- Additive: code access for given agents.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE TABLE agent_ask_workspaces (
  ask_id text PRIMARY KEY REFERENCES agent_asks(id) ON DELETE CASCADE,
  repo_full_name text NOT NULL,
  base_branch text NOT NULL,
  base_sha text,
  work_branch text NOT NULL,
  pr_number integer,
  pr_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE agent_ask_reads (
  id text PRIMARY KEY,
  ask_id text NOT NULL REFERENCES agent_asks(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('file', 'list', 'search')),
  target text NOT NULL,
  blocked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX agent_ask_reads_ask_idx ON agent_ask_reads (ask_id, created_at);
--> statement-breakpoint
CREATE TABLE agent_ask_proposals (
  id text PRIMARY KEY,
  ask_id text NOT NULL REFERENCES agent_asks(id) ON DELETE CASCADE,
  summary text NOT NULL,
  files jsonb NOT NULL,
  state text NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'approved', 'declined', 'failed')),
  error text,
  pr_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
--> statement-breakpoint
CREATE INDEX agent_ask_proposals_ask_idx ON agent_ask_proposals (ask_id, created_at);
