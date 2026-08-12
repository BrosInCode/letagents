-- Replace whole-table minute liveness discovery with write-maintained due
-- timestamps. The minute runner remains a bounded repair clock; normal work
-- is selected through partial due indexes and claimed with SKIP LOCKED.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "room_agent_delivery_sessions"
  ADD COLUMN "next_liveness_check_at" timestamp with time zone;
ALTER TABLE "board_manager_assignments"
  ADD COLUMN "stall_check_at" timestamp with time zone;
ALTER TABLE "board_intents"
  ADD COLUMN "escalation_check_at" timestamp with time zone;
ALTER TABLE "room_board_settings"
  ADD COLUMN "open_task_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN "last_task_closed_at" timestamp with time zone,
  ADD COLUMN "stall_check_at" timestamp with time zone;

CREATE TABLE "due_time_liveness_rollout_state" (
  "rollout_key" text PRIMARY KEY,
  "completed_at" timestamp with time zone
);

-- Partial indexes are built CONCURRENTLY by the post-migration reconciler.
-- Drizzle wraps this file in one transaction, where ordinary CREATE INDEX
-- would block each table's writers for the duration of the build.

CREATE OR REPLACE FUNCTION schedule_room_agent_delivery_liveness()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A claim/retry changes only the due column; preserve the caller's backoff.
  IF TG_OP = 'UPDATE'
     AND NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at
     AND NEW.active_connection_count IS NOT DISTINCT FROM OLD.active_connection_count
     AND NEW.reconnect_grace_expires_at IS NOT DISTINCT FROM OLD.reconnect_grace_expires_at
     AND NEW.offline_announced_at IS NOT DISTINCT FROM OLD.offline_announced_at
     AND NEW.recovery_announced_at IS NOT DISTINCT FROM OLD.recovery_announced_at
     AND NEW.session_kind IS NOT DISTINCT FROM OLD.session_kind THEN
    RETURN NEW;
  END IF;
  IF NEW.session_kind <> 'worker' THEN
    NEW.next_liveness_check_at := NULL;
  ELSIF NEW.offline_announced_at IS NOT NULL
    AND (NEW.recovery_announced_at IS NULL OR NEW.recovery_announced_at < NEW.offline_announced_at) THEN
    -- A reconnect writes updated_at after the outage marker and must repair
    -- immediately. A still-offline, already-announced row sleeps until then.
    NEW.next_liveness_check_at := CASE
      WHEN NEW.active_connection_count > 0 AND NEW.updated_at > NEW.offline_announced_at THEN now()
      ELSE NULL
    END;
  ELSE
    -- Heartbeats continually push this deadline forward. If a process dies
    -- without disconnecting, the frozen heartbeat still becomes due.
    NEW.next_liveness_check_at := GREATEST(
      NEW.updated_at + interval '5 minutes',
      COALESCE(NEW.reconnect_grace_expires_at, '-infinity'::timestamptz)
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER room_agent_delivery_liveness_schedule
BEFORE INSERT OR UPDATE ON "room_agent_delivery_sessions"
FOR EACH ROW EXECUTE FUNCTION schedule_room_agent_delivery_liveness();

CREATE OR REPLACE FUNCTION schedule_board_manager_assignment_check()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  delivery_updated_at timestamptz;
  delivery_grace_at timestamptz;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.agent_session_id IS NOT DISTINCT FROM OLD.agent_session_id
     AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
     AND NEW.stall_check_at IS DISTINCT FROM OLD.stall_check_at THEN
    RETURN NEW;
  END IF;
  IF NEW.status <> 'active' THEN
    NEW.stall_check_at := NULL;
    RETURN NEW;
  END IF;
  SELECT delivery.updated_at, delivery.reconnect_grace_expires_at
    INTO delivery_updated_at, delivery_grace_at
    FROM room_agent_delivery_sessions AS delivery
   WHERE delivery.room_id = NEW.room_id
     AND delivery.agent_session_id = NEW.agent_session_id
     AND delivery.session_kind = 'worker'
   ORDER BY delivery.updated_at DESC
   LIMIT 1;
  NEW.stall_check_at := CASE
    WHEN delivery_updated_at IS NULL THEN NULL
    ELSE GREATEST(
      NEW.created_at + interval '5 minutes',
      delivery_updated_at + interval '5 minutes',
      COALESCE(delivery_grace_at, '-infinity'::timestamptz)
    )
  END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER board_manager_assignment_check_schedule
BEFORE INSERT OR UPDATE ON "board_manager_assignments"
FOR EACH ROW EXECUTE FUNCTION schedule_board_manager_assignment_check();

CREATE OR REPLACE FUNCTION reschedule_board_manager_from_delivery()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  manager_due timestamptz;
  manager_found boolean;
BEGIN
  manager_due := GREATEST(
    NEW.updated_at + interval '5 minutes',
    COALESCE(NEW.reconnect_grace_expires_at, '-infinity'::timestamptz)
  );
  UPDATE board_manager_assignments
     SET stall_check_at = GREATEST(board_manager_assignments.created_at + interval '5 minutes', manager_due)
   WHERE room_id = NEW.room_id
     AND agent_session_id = NEW.agent_session_id
     AND status = 'active';
  manager_found := FOUND;
  IF manager_found THEN
    -- An assignment is not reachability. Keep a drained room indexed at the
    -- first moment the manager's delivery may become stale; heartbeats push
    -- that deadline forward, while a dead channel lets it mature.
    UPDATE room_board_settings
       SET stall_check_at = GREATEST(
         last_task_closed_at + interval '30 minutes',
         NEW.updated_at + interval '90 seconds',
         COALESCE(NEW.reconnect_grace_expires_at, '-infinity'::timestamptz)
       )
     WHERE room_id = NEW.room_id
       AND open_task_count = 0
       AND last_task_closed_at IS NOT NULL
       AND (stall_nudged_at IS NULL OR stall_nudged_at < last_task_closed_at);
  ELSIF NEW.active_connection_count > 0 THEN
    -- A newly reachable non-manager may be the successor a previously empty
    -- failover pass was waiting for. Re-arm once on the 0 -> live edge, not
    -- on every heartbeat.
    IF TG_OP = 'INSERT' OR OLD.active_connection_count = 0 THEN
      UPDATE board_manager_assignments
         SET stall_check_at = LEAST(COALESCE(stall_check_at, now()), now())
       WHERE room_id = NEW.room_id AND status = 'active';
    END IF;
    UPDATE room_board_settings
       SET stall_check_at = GREATEST(last_task_closed_at + interval '30 minutes', now())
     WHERE room_id = NEW.room_id
       AND stall_check_at IS NULL
       AND open_task_count = 0
       AND last_task_closed_at IS NOT NULL
       AND (stall_nudged_at IS NULL OR stall_nudged_at < last_task_closed_at);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER board_manager_delivery_reschedule
AFTER INSERT OR UPDATE OF updated_at, reconnect_grace_expires_at, active_connection_count
ON "room_agent_delivery_sessions"
FOR EACH ROW WHEN (NEW.session_kind = 'worker')
EXECUTE FUNCTION reschedule_board_manager_from_delivery();

CREATE OR REPLACE FUNCTION reschedule_board_manager_from_session_end()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ended_at IS NOT NULL AND OLD.ended_at IS NULL THEN
    UPDATE board_manager_assignments
       SET stall_check_at = now()
     WHERE room_id = NEW.room_id
       AND agent_session_id = NEW.session_id
       AND status = 'active';
    IF FOUND THEN
      UPDATE room_board_settings
         SET stall_check_at = GREATEST(last_task_closed_at + interval '30 minutes', now())
       WHERE room_id = NEW.room_id
         AND open_task_count = 0
         AND last_task_closed_at IS NOT NULL
         AND (stall_nudged_at IS NULL OR stall_nudged_at < last_task_closed_at);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER board_manager_session_end_reschedule
AFTER UPDATE OF ended_at ON "room_agent_sessions"
FOR EACH ROW EXECUTE FUNCTION reschedule_board_manager_from_session_end();

CREATE OR REPLACE FUNCTION reschedule_delivery_from_session_authority()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ended_at IS NOT DISTINCT FROM OLD.ended_at
     AND NEW.supervisor_grant_id IS NOT DISTINCT FROM OLD.supervisor_grant_id THEN
    RETURN NULL;
  END IF;
  UPDATE room_agent_delivery_sessions
     SET next_liveness_check_at = CASE
       WHEN NEW.ended_at IS NOT NULL OR NEW.supervisor_grant_id IS NOT NULL THEN NULL
       ELSE now()
     END
   WHERE room_id = NEW.room_id
     AND agent_session_id = NEW.session_id
     AND session_kind = 'worker';
  RETURN NULL;
END;
$$;

CREATE TRIGGER room_agent_session_delivery_authority_schedule
AFTER UPDATE OF ended_at, supervisor_grant_id ON "room_agent_sessions"
FOR EACH ROW EXECUTE FUNCTION reschedule_delivery_from_session_authority();

CREATE OR REPLACE FUNCTION reschedule_delivery_from_suppression()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  room_key text := COALESCE(NEW.room_id, OLD.room_id);
  actor_key text := COALESCE(NEW.actor_label, OLD.actor_label);
BEGIN
  UPDATE room_agent_delivery_sessions
     SET next_liveness_check_at = CASE WHEN TG_OP = 'DELETE' THEN now() ELSE NULL END
   WHERE room_id = room_key
     AND actor_label = actor_key
     AND session_kind = 'worker';
  RETURN NULL;
END;
$$;

CREATE TRIGGER room_agent_delivery_suppression_schedule
AFTER INSERT OR DELETE ON "room_live_agent_suppressions"
FOR EACH ROW EXECUTE FUNCTION reschedule_delivery_from_suppression();

CREATE OR REPLACE FUNCTION reschedule_room_work_from_manager_assignment()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  room_key text := COALESCE(NEW.room_id, OLD.room_id);
  manager_active boolean := TG_OP <> 'DELETE' AND NEW.status = 'active';
BEGIN
  UPDATE room_board_settings
     SET stall_check_at = CASE
       WHEN open_task_count = 0 AND last_task_closed_at IS NOT NULL
         AND (stall_nudged_at IS NULL OR stall_nudged_at < last_task_closed_at)
       THEN GREATEST(last_task_closed_at + interval '30 minutes', now())
       ELSE stall_check_at
     END
   WHERE room_id = room_key;
  UPDATE board_intents
     SET escalation_check_at = CASE
       WHEN manager_active THEN GREATEST(created_at + interval '10 minutes', now() + interval '5 minutes')
       ELSE LEAST(COALESCE(escalation_check_at, now()), now())
     END
   WHERE room_id = room_key AND status = 'pending' AND escalated_at IS NULL;
  RETURN NULL;
END;
$$;

CREATE TRIGGER board_manager_assignment_room_work_schedule
AFTER INSERT OR UPDATE OF status OR DELETE ON "board_manager_assignments"
FOR EACH ROW EXECUTE FUNCTION reschedule_room_work_from_manager_assignment();

CREATE OR REPLACE FUNCTION reschedule_room_work_from_board_mode()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  failover_changed boolean := CASE
    WHEN TG_OP = 'INSERT' THEN NEW.manager_failover <> 'auto'
    ELSE NEW.manager_failover IS DISTINCT FROM OLD.manager_failover
  END;
  mode_changed boolean := CASE
    WHEN TG_OP = 'INSERT' THEN NEW.manager_mode <> 'manager_optional'
    ELSE NEW.manager_mode IS DISTINCT FROM OLD.manager_mode
  END;
BEGIN
  IF failover_changed THEN
    UPDATE board_manager_assignments
       SET stall_check_at = CASE
         WHEN NEW.manager_failover = 'off' THEN NULL
         ELSE LEAST(COALESCE(stall_check_at, now()), now())
       END
     WHERE room_id = NEW.room_id AND status = 'active';
  END IF;
  IF mode_changed THEN
    UPDATE board_intents
       SET escalation_check_at = CASE
         WHEN status = 'pending' AND escalated_at IS NULL
         THEN LEAST(COALESCE(escalation_check_at, now()), now())
         ELSE NULL
       END
     WHERE room_id = NEW.room_id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER room_board_mode_work_schedule
AFTER INSERT OR UPDATE OF manager_mode, manager_failover ON "room_board_settings"
FOR EACH ROW EXECUTE FUNCTION reschedule_room_work_from_board_mode();

CREATE OR REPLACE FUNCTION schedule_board_intent_escalation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  manager_due timestamptz;
BEGIN
  IF NEW.status = 'pending' AND NEW.escalated_at IS NULL THEN
    SELECT assignment.stall_check_at INTO manager_due
      FROM board_manager_assignments AS assignment
     WHERE assignment.room_id = NEW.room_id AND assignment.status = 'active'
     LIMIT 1;
    NEW.escalation_check_at := GREATEST(
      NEW.created_at + interval '10 minutes',
      COALESCE(manager_due, '-infinity'::timestamptz)
    );
  ELSE
    NEW.escalation_check_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER board_intent_escalation_schedule
BEFORE INSERT OR UPDATE OF status, escalated_at, created_at ON "board_intents"
FOR EACH ROW EXECUTE FUNCTION schedule_board_intent_escalation();

-- Room ids are mutable and cascade into every liveness source. Reconcile the
-- old key before the cascade so a row that moves behind the rollout's keyset
-- cursor carries a complete projection to its new key.
CREATE OR REPLACE FUNCTION reconcile_liveness_before_room_id_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  task_open_count integer;
  task_last_closed_at timestamptz;
BEGIN
  IF NEW.id IS NOT DISTINCT FROM OLD.id THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('room_task_liveness' || chr(31) || OLD.id, 0));
  SELECT count(*) FILTER (WHERE status NOT IN ('done', 'cancelled'))::integer,
         max(updated_at) FILTER (WHERE status IN ('done', 'cancelled'))
    INTO task_open_count, task_last_closed_at
    FROM tasks
   WHERE room_id = OLD.id;
  INSERT INTO room_board_settings (
    room_id, open_task_count, last_task_closed_at, stall_check_at, created_at, updated_at
  ) VALUES (
    OLD.id, COALESCE(task_open_count, 0), task_last_closed_at,
    CASE WHEN COALESCE(task_open_count, 0) = 0
      THEN task_last_closed_at + interval '30 minutes' ELSE NULL END,
    now(), now()
  ) ON CONFLICT (room_id) DO UPDATE
    SET open_task_count = EXCLUDED.open_task_count,
        last_task_closed_at = EXCLUDED.last_task_closed_at,
        stall_check_at = CASE
          WHEN EXCLUDED.open_task_count = 0
            AND (room_board_settings.stall_nudged_at IS NULL
              OR room_board_settings.stall_nudged_at < EXCLUDED.last_task_closed_at)
          THEN EXCLUDED.stall_check_at
          ELSE NULL
        END,
        updated_at = now();
  UPDATE room_agent_delivery_sessions AS delivery
     SET next_liveness_check_at = CASE
       WHEN delivery.session_kind <> 'worker' THEN NULL
       WHEN delivery.updated_at < now() - interval '1 hour' THEN NULL
       WHEN delivery.offline_announced_at IS NOT NULL
         AND (delivery.recovery_announced_at IS NULL
           OR delivery.recovery_announced_at < delivery.offline_announced_at)
       THEN CASE
         WHEN delivery.active_connection_count > 0
           AND delivery.updated_at > delivery.offline_announced_at THEN now()
         ELSE NULL
       END
       ELSE GREATEST(
         delivery.updated_at + interval '5 minutes',
         COALESCE(delivery.reconnect_grace_expires_at, '-infinity'::timestamptz)
       )
     END
   WHERE delivery.room_id = OLD.id;
  UPDATE board_manager_assignments AS assignment
     SET stall_check_at = CASE
       WHEN assignment.status <> 'active' THEN NULL
       ELSE (
         SELECT GREATEST(
           assignment.created_at + interval '5 minutes',
           delivery.updated_at + interval '5 minutes',
           COALESCE(delivery.reconnect_grace_expires_at, '-infinity'::timestamptz)
         )
           FROM room_agent_delivery_sessions AS delivery
          WHERE delivery.room_id = assignment.room_id
            AND delivery.agent_session_id = assignment.agent_session_id
            AND delivery.session_kind = 'worker'
          ORDER BY delivery.updated_at DESC
          LIMIT 1
       )
     END
   WHERE assignment.room_id = OLD.id;
  UPDATE board_intents AS intent
     SET escalation_check_at = CASE
       WHEN intent.status = 'pending' AND intent.escalated_at IS NULL
       THEN GREATEST(
         intent.created_at + interval '10 minutes',
         COALESCE((
           SELECT assignment.stall_check_at
             FROM board_manager_assignments AS assignment
            WHERE assignment.room_id = intent.room_id AND assignment.status = 'active'
            LIMIT 1
         ), '-infinity'::timestamptz)
       )
       ELSE NULL
     END
   WHERE intent.room_id = OLD.id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER room_id_liveness_reconcile
BEFORE UPDATE OF id ON "rooms"
FOR EACH ROW EXECUTE FUNCTION reconcile_liveness_before_room_id_change();

-- The aggregate owns room-stall discovery. Locking the settings row makes
-- concurrent task transitions update the count and drain epoch exactly once.
CREATE OR REPLACE FUNCTION maintain_room_task_liveness_summary()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  was_open boolean := FALSE;
  is_open boolean := FALSE;
  room_key text;
  event_at timestamptz;
BEGIN
  room_key := COALESCE(NEW.room_id, OLD.room_id);
  event_at := now();
  PERFORM pg_advisory_xact_lock(hashtextextended('room_task_liveness' || chr(31) || room_key, 0));
  -- A room DELETE cascades to tasks after the parent row is gone. Do not
  -- recreate its settings projection through the task DELETE trigger.
  IF NOT EXISTS (SELECT 1 FROM rooms WHERE id = room_key) THEN
    RETURN NULL;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    was_open := OLD.status NOT IN ('done', 'cancelled');
  END IF;
  IF TG_OP <> 'DELETE' THEN
    is_open := NEW.status NOT IN ('done', 'cancelled');
  END IF;

  INSERT INTO room_board_settings (
    room_id, open_task_count, last_task_closed_at, stall_check_at, created_at, updated_at
  ) VALUES (
    room_key, 0, NULL, NULL, now(), now()
  ) ON CONFLICT (room_id) DO NOTHING;

  UPDATE room_board_settings
     SET open_task_count = GREATEST(open_task_count
       + CASE WHEN is_open THEN 1 ELSE 0 END
       - CASE WHEN was_open THEN 1 ELSE 0 END, 0),
         last_task_closed_at = CASE
           WHEN GREATEST(open_task_count
             + CASE WHEN is_open THEN 1 ELSE 0 END
             - CASE WHEN was_open THEN 1 ELSE 0 END, 0) = 0
             AND was_open AND NOT is_open
           THEN event_at
           ELSE last_task_closed_at
         END,
         stall_check_at = CASE
           WHEN GREATEST(open_task_count
             + CASE WHEN is_open THEN 1 ELSE 0 END
             - CASE WHEN was_open THEN 1 ELSE 0 END, 0) = 0
             AND was_open AND NOT is_open
           THEN event_at + interval '30 minutes'
           WHEN is_open THEN NULL
           ELSE stall_check_at
         END,
         updated_at = now()
   WHERE room_id = room_key;
  RETURN NULL;
END;
$$;

CREATE TRIGGER room_task_liveness_summary
AFTER INSERT OR UPDATE OF status OR DELETE ON "tasks"
FOR EACH ROW EXECUTE FUNCTION maintain_room_task_liveness_summary();

-- Existing rows are reconciled in bounded post-commit batches by
-- reconcileDueTimeLivenessRollout. Keeping that work out of this transaction
-- makes the ALTER/TRIGGER locks short-lived while the triggers cover writes
-- that race the backfill.
