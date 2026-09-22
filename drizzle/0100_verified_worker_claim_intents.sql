ALTER TABLE board_intents ADD COLUMN proposer_worker_auth_kind text
  CHECK (proposer_worker_auth_kind IN ('bearer', 'session_token'));
