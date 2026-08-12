import type { Pool, PoolClient } from "pg";

const ROLLOUT_BATCH_SIZE = 500;
const ROLLOUT_KEY = "0082_due_time_liveness_v1";

const DUE_INDEXES = [
  { name: "room_agent_delivery_sessions_liveness_due_idx", sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS room_agent_delivery_sessions_liveness_due_idx
     ON room_agent_delivery_sessions (next_liveness_check_at, room_id, delivery_key)
     WHERE session_kind = 'worker' AND next_liveness_check_at IS NOT NULL` },
  { name: "board_manager_assignments_stall_due_idx", sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS board_manager_assignments_stall_due_idx
     ON board_manager_assignments (stall_check_at, id, room_id)
     WHERE status = 'active' AND stall_check_at IS NOT NULL` },
  { name: "board_intents_escalation_due_idx", sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS board_intents_escalation_due_idx
     ON board_intents (escalation_check_at, id, room_id)
     WHERE status = 'pending' AND escalated_at IS NULL AND escalation_check_at IS NOT NULL` },
  { name: "board_intents_expiry_due_idx", sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS board_intents_expiry_due_idx
     ON board_intents (expires_at, id, room_id)
     WHERE status IN ('pending', 'approved') AND expires_at IS NOT NULL` },
  { name: "room_board_settings_stall_due_idx", sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS room_board_settings_stall_due_idx
     ON room_board_settings (stall_check_at, room_id)
     WHERE open_task_count = 0 AND stall_check_at IS NOT NULL` },
] as const;

async function withRolloutClient<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = '15min'");
    await client.query("SET lock_timeout = '5s'");
    return await work(client);
  } finally {
    client.release();
  }
}

async function buildDueIndexes(pool: Pool): Promise<void> {
  await withRolloutClient(pool, async (client) => {
    for (const index of DUE_INDEXES) {
      const state = await client.query<{ valid: boolean }>(
        `SELECT pg_index.indisvalid AS valid
           FROM pg_index
           JOIN pg_class ON pg_class.oid = pg_index.indexrelid
           JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
          WHERE pg_namespace.nspname = current_schema()
            AND pg_class.relname = $1`,
        [index.name],
      );
      if (state.rows[0] && !state.rows[0].valid) {
        // A cancelled CREATE INDEX CONCURRENTLY leaves an invalid shell that
        // IF NOT EXISTS would silently accept forever. Remove only that
        // unusable shell, then rebuild it below.
        await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${index.name}`);
      }
      await client.query(index.sql);
    }
  });
}

async function reconcileDeliveryRows(pool: Pool): Promise<number> {
  return withRolloutClient(pool, async (client) => {
    let processed = 0;
    let cursorRoom = "";
    let cursorKey = "";
    while (true) {
      const batch = await client.query<{ room_id: string; delivery_key: string }>(
        `SELECT room_id, delivery_key
           FROM room_agent_delivery_sessions
          WHERE (room_id, delivery_key) > ($1, $2)
          ORDER BY room_id, delivery_key
          LIMIT $3`,
        [cursorRoom, cursorKey, ROLLOUT_BATCH_SIZE],
      );
      if (batch.rows.length === 0) return processed;
      const result = await client.query(
        `UPDATE room_agent_delivery_sessions AS delivery
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
           FROM jsonb_to_recordset($1::jsonb) AS batch(room_id text, delivery_key text)
          WHERE delivery.room_id = batch.room_id
            AND delivery.delivery_key = batch.delivery_key
        RETURNING delivery.room_id`,
        [JSON.stringify(batch.rows)],
      );
      processed += result.rowCount ?? 0;
      const last = batch.rows.at(-1)!;
      cursorRoom = last.room_id;
      cursorKey = last.delivery_key;
    }
  });
}

async function reconcileSimpleRows(input: {
  pool: Pool;
  table: "board_manager_assignments" | "board_intents";
  touchSql: string;
}): Promise<number> {
  return withRolloutClient(input.pool, async (client) => {
    let processed = 0;
    let cursor = "";
    while (true) {
      const batch = await client.query<{ id: string }>(
        `SELECT id FROM ${input.table} WHERE id > $1 ORDER BY id LIMIT $2`,
        [cursor, ROLLOUT_BATCH_SIZE],
      );
      if (batch.rows.length === 0) return processed;
      const result = await client.query(
        `UPDATE ${input.table} AS target
            SET ${input.touchSql}
          WHERE target.id = ANY($1::text[])`,
        [batch.rows.map((row) => row.id)],
      );
      processed += result.rowCount ?? 0;
      cursor = batch.rows.at(-1)!.id;
    }
  });
}

async function reconcileTaskSummaries(pool: Pool): Promise<number> {
  let processed = 0;
  let cursor = "";
  while (true) {
    const rooms = await pool.query<{ room_id: string }>(
      `SELECT room_id
         FROM tasks
        WHERE room_id > $1
        GROUP BY room_id
        ORDER BY room_id
        LIMIT $2`,
      [cursor, ROLLOUT_BATCH_SIZE],
    );
    if (rooms.rows.length === 0) return processed;
    // Preserve the database's ORDER BY collation. JS locale ordering is not a
    // valid keyset cursor for PostgreSQL text and can skip punctuation/case.
    const roomIds = rooms.rows.map((row) => row.room_id);
    await withRolloutClient(pool, async (client) => {
      await client.query("BEGIN");
      try {
        // Acquire every room lock in one stable order. The following command
        // gets a fresh READ COMMITTED snapshot after any racing task mutation
        // that held the same lock has committed.
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtextextended('room_task_liveness' || chr(31) || room_id, 0))
             FROM unnest($1::text[]) AS room_id ORDER BY room_id`,
          [roomIds],
        );
        await client.query(
          `WITH summary AS (
             SELECT room_id,
                    count(*) FILTER (WHERE status NOT IN ('done', 'cancelled'))::integer AS open_task_count,
                    max(updated_at) FILTER (WHERE status IN ('done', 'cancelled')) AS last_task_closed_at
               FROM tasks
              WHERE room_id = ANY($1::text[])
              GROUP BY room_id
           )
           INSERT INTO room_board_settings (
             room_id, open_task_count, last_task_closed_at, stall_check_at, created_at, updated_at
           )
           SELECT room_id, open_task_count, last_task_closed_at,
                  CASE WHEN open_task_count = 0
                       THEN last_task_closed_at + interval '30 minutes' ELSE NULL END,
                  now(), now()
             FROM summary
           ON CONFLICT (room_id) DO UPDATE
             SET open_task_count = EXCLUDED.open_task_count,
                 last_task_closed_at = EXCLUDED.last_task_closed_at,
                 stall_check_at = CASE
                   WHEN EXCLUDED.open_task_count = 0
                     AND (room_board_settings.stall_nudged_at IS NULL
                       OR room_board_settings.stall_nudged_at < EXCLUDED.last_task_closed_at)
                   THEN EXCLUDED.stall_check_at
                   ELSE NULL
                 END,
                 updated_at = now()`,
          [roomIds],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
    processed += roomIds.length;
    cursor = roomIds.at(-1)!;
  }
}

export interface DueTimeLivenessRolloutResult {
  delivery_rows: number;
  manager_rows: number;
  intent_rows: number;
  task_rooms: number;
}

/** Idempotent, post-commit rollout work for migration 0082. */
export async function reconcileDueTimeLivenessRollout(pool: Pool): Promise<DueTimeLivenessRolloutResult> {
  const lockClient = await pool.connect();
  try {
    const acquired = await lockClient.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired`,
      [ROLLOUT_KEY],
    );
    if (!acquired.rows[0]?.acquired) {
      throw new Error("due-time liveness rollout is already running on another migrator");
    }
    const completed = await lockClient.query(
      `SELECT 1 FROM due_time_liveness_rollout_state
        WHERE rollout_key = $1 AND completed_at IS NOT NULL`,
      [ROLLOUT_KEY],
    );
    if (completed.rowCount) {
      await buildDueIndexes(pool);
      return { delivery_rows: 0, manager_rows: 0, intent_rows: 0, task_rooms: 0 };
    }

    await buildDueIndexes(pool);
    const deliveryRows = await reconcileDeliveryRows(pool);
    const managerRows = await reconcileSimpleRows({
      pool,
      table: "board_manager_assignments",
      touchSql: "updated_at = target.updated_at",
    });
    const intentRows = await reconcileSimpleRows({
      pool,
      table: "board_intents",
      touchSql: "created_at = target.created_at",
    });
    const taskRooms = await reconcileTaskSummaries(pool);
    await lockClient.query(
      `INSERT INTO due_time_liveness_rollout_state (rollout_key, completed_at)
       VALUES ($1, now())
       ON CONFLICT (rollout_key) DO UPDATE SET completed_at = EXCLUDED.completed_at`,
      [ROLLOUT_KEY],
    );
    return {
      delivery_rows: deliveryRows,
      manager_rows: managerRows,
      intent_rows: intentRows,
      task_rooms: taskRooms,
    };
  } finally {
    await lockClient.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [ROLLOUT_KEY]).catch(() => {});
    lockClient.release();
  }
}
