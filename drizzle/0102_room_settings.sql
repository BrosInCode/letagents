CREATE TABLE room_settings (
  room_id text PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE ON UPDATE CASCADE,
  github_chat_event_kinds jsonb,
  agent_guidelines text,
  agent_guidelines_updated_by text,
  agent_guidelines_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT room_settings_github_chat_event_kinds_check
    CHECK (github_chat_event_kinds IS NULL OR jsonb_typeof(github_chat_event_kinds) = 'array'),
  CONSTRAINT room_settings_agent_guidelines_length_check
    CHECK (agent_guidelines IS NULL OR octet_length(agent_guidelines) BETWEEN 1 AND 8000)
);
