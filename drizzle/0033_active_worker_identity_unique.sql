WITH ranked AS (
  SELECT
    session_id,
    row_number() OVER (
      PARTITION BY room_id, agent_key
      ORDER BY last_seen_at DESC, created_at DESC, session_id DESC
    ) AS rank
  FROM room_agent_sessions
  WHERE session_kind = 'worker' AND ended_at IS NULL
)
UPDATE room_agent_delivery_sessions
SET
  active_connection_count = 0,
  last_disconnected_at = now(),
  reconnect_grace_expires_at = now(),
  updated_at = now()
WHERE agent_session_id IN (
  SELECT session_id
  FROM ranked
  WHERE rank > 1
);--> statement-breakpoint
WITH ranked AS (
  SELECT
    session_id,
    row_number() OVER (
      PARTITION BY room_id, agent_key
      ORDER BY last_seen_at DESC, created_at DESC, session_id DESC
    ) AS rank
  FROM room_agent_sessions
  WHERE session_kind = 'worker' AND ended_at IS NULL
)
UPDATE room_agent_sessions
SET
  ended_at = now(),
  updated_at = now(),
  last_seen_at = now()
WHERE session_id IN (
  SELECT session_id
  FROM ranked
  WHERE rank > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX "room_agent_sessions_active_worker_identity_idx"
  ON "room_agent_sessions" USING btree ("room_id", "agent_key")
  WHERE "room_agent_sessions"."session_kind" = 'worker'
    AND "room_agent_sessions"."ended_at" IS NULL;
