import type { Pool, PoolClient } from "pg";

const ROLLOUT_KEY = "0112_sequential_reply_turns_v1";

/**
 * The held-only receipt indexes behind the per-agent read frontier and the
 * deadline sweep. They are built here, after the migration commits, with
 * CREATE INDEX CONCURRENTLY: message_agent_receipts is written by every
 * message send, and a plain build inside the migration transaction would
 * block those writes until it finished. Until they exist the frontier is
 * still correct, only slower.
 */
export const REPLY_TURN_HOLD_INDEXES = [
  { name: "message_agent_receipts_reply_turn_hold_idx", sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS message_agent_receipts_reply_turn_hold_idx
     ON message_agent_receipts (message_room_id, agent_key, message_number)
     WHERE hold_released_at IS NULL AND hold_release_after IS NOT NULL` },
  { name: "message_agent_receipts_reply_turn_due_idx", sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS message_agent_receipts_reply_turn_due_idx
     ON message_agent_receipts (hold_release_after)
     WHERE hold_released_at IS NULL AND hold_release_after IS NOT NULL` },
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

/** Idempotent, post-commit rollout work for migration 0112. Returns the indexes it (re)built. */
export async function reconcileReplyTurnHoldRollout(pool: Pool): Promise<string[]> {
  const lockClient = await pool.connect();
  try {
    const acquired = await lockClient.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired`,
      [ROLLOUT_KEY],
    );
    if (!acquired.rows[0]?.acquired) {
      throw new Error("reply turn hold rollout is already running on another migrator");
    }
    return await withRolloutClient(pool, async (client) => {
      const built: string[] = [];
      for (const index of REPLY_TURN_HOLD_INDEXES) {
        const state = await client.query<{ valid: boolean }>(
          `SELECT pg_index.indisvalid AS valid
             FROM pg_index
             JOIN pg_class ON pg_class.oid = pg_index.indexrelid
             JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
            WHERE pg_namespace.nspname = current_schema()
              AND pg_class.relname = $1`,
          [index.name],
        );
        if (state.rows[0]?.valid) continue;
        if (state.rows[0]) {
          // A cancelled CREATE INDEX CONCURRENTLY leaves an invalid shell that
          // IF NOT EXISTS would silently accept forever. Remove only that
          // unusable shell, then rebuild it below.
          await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${index.name}`);
        }
        await client.query(index.sql);
        built.push(index.name);
      }
      return built;
    });
  } finally {
    await lockClient.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [ROLLOUT_KEY]).catch(() => {});
    lockClient.release();
  }
}
