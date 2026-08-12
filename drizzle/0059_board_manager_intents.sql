CREATE TABLE IF NOT EXISTS "room_board_settings" (
  "room_id" text PRIMARY KEY NOT NULL REFERENCES "rooms"("id") ON DELETE cascade ON UPDATE cascade,
  "manager_mode" text DEFAULT 'manager_optional' NOT NULL,
  "updated_by" text,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "room_board_settings_manager_mode_check"
    CHECK ("room_board_settings"."manager_mode" IN ('off', 'manager_optional', 'intent_required'))
);

CREATE TABLE IF NOT EXISTS "board_manager_assignments" (
  "id" text PRIMARY KEY NOT NULL,
  "room_id" text NOT NULL REFERENCES "rooms"("id") ON DELETE cascade ON UPDATE cascade,
  "agent_session_id" text NOT NULL REFERENCES "room_agent_sessions"("session_id") ON DELETE cascade ON UPDATE cascade,
  "agent_key" text NOT NULL,
  "actor_label" text NOT NULL,
  "runtime_source" text DEFAULT 'desktop_managed' NOT NULL,
  "assigned_by" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "last_heartbeat_at" timestamp with time zone,
  "released_by" text,
  "release_reason" text,
  "released_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "board_manager_assignments_status_check"
    CHECK ("board_manager_assignments"."status" IN ('active', 'released')),
  CONSTRAINT "board_manager_assignments_runtime_source_check"
    CHECK ("board_manager_assignments"."runtime_source" IN ('desktop_managed', 'open_model', 'external', 'unknown'))
);

CREATE TABLE IF NOT EXISTS "board_intents" (
  "id" text PRIMARY KEY NOT NULL,
  "room_id" text NOT NULL REFERENCES "rooms"("id") ON DELETE cascade ON UPDATE cascade,
  "task_id" text,
  "action_type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "payload_hash" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "proposer_actor_label" text,
  "proposer_actor_key" text,
  "proposer_actor_instance_id" text,
  "proposer_agent_session_id" text REFERENCES "room_agent_sessions"("session_id") ON DELETE set null ON UPDATE cascade,
  "decision_by" text,
  "decision_reason" text,
  "approval_token_hash" text,
  "decided_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "board_intents_status_check"
    CHECK ("board_intents"."status" IN ('pending', 'approved', 'denied', 'expired', 'used')),
  CONSTRAINT "board_intents_action_type_check"
    CHECK ("board_intents"."action_type" IN ('task_create', 'task_claim', 'task_close', 'task_override', 'task_update'))
);

CREATE INDEX IF NOT EXISTS "board_manager_assignments_room_idx"
  ON "board_manager_assignments" ("room_id", "status");
CREATE INDEX IF NOT EXISTS "board_manager_assignments_agent_session_idx"
  ON "board_manager_assignments" ("room_id", "agent_session_id");
CREATE UNIQUE INDEX IF NOT EXISTS "board_manager_assignments_active_room_unique_idx"
  ON "board_manager_assignments" ("room_id")
  WHERE "status" = 'active' AND "released_at" IS NULL;

CREATE INDEX IF NOT EXISTS "board_intents_room_status_idx"
  ON "board_intents" ("room_id", "status");
CREATE INDEX IF NOT EXISTS "board_intents_room_status_created_idx"
  ON "board_intents" ("room_id", "status", "created_at", "id");
CREATE INDEX IF NOT EXISTS "board_intents_room_task_idx"
  ON "board_intents" ("room_id", "task_id");
CREATE INDEX IF NOT EXISTS "board_intents_proposer_session_idx"
  ON "board_intents" ("room_id", "proposer_agent_session_id");
CREATE UNIQUE INDEX IF NOT EXISTS "board_intents_pending_action_payload_idx"
  ON "board_intents" ("room_id", "action_type", "payload_hash")
  WHERE "status" = 'pending';
