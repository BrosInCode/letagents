import type { Pool } from "pg";

const ROLLOUT_KEY = "read_range_read_point_index_v1";
export const READ_RANGE_READ_POINT_INDEX = "message_human_read_ranges_read_point_idx";

/**
 * The index behind an account's read point in a room (`GET /account/unread`):
 * the highest `last_message_sequence` of the account's read ranges there is
 * one index read instead of a scan of every range the account reported.
 *
 * Built after the migrations commit, with CREATE INDEX CONCURRENTLY, so the
 * read reports of the web and the desktop are not blocked while it builds. It
 * needs no migration file. Until it exists the read point is still correct,
 * only slower. A build that cannot get its lock (a long transaction) is left
 * for the next `npm run db:migrate`; it never fails the deploy.
 */
export async function reconcileReadRangeIndexRollout(pool: Pool, log: (line: string) => void = (line) => console.warn(line)): Promise<string[]> {
  const client = await pool.connect();
  try {
    const acquired = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired`, [ROLLOUT_KEY]);
    if (!acquired.rows[0]?.acquired) return [];
    try {
      await client.query("SET statement_timeout = '15min'");
      await client.query("SET lock_timeout = '5s'");
      const state = await client.query<{ valid: boolean }>(
        `SELECT pg_index.indisvalid AS valid
           FROM pg_index
           JOIN pg_class ON pg_class.oid = pg_index.indexrelid
           JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
          WHERE pg_namespace.nspname = current_schema() AND pg_class.relname = $1`,
        [READ_RANGE_READ_POINT_INDEX],
      );
      if (state.rows[0]?.valid) return [];
      try {
        // A cancelled concurrent build leaves an invalid shell that IF NOT EXISTS would accept forever.
        if (state.rows[0]) await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${READ_RANGE_READ_POINT_INDEX}`);
        await client.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${READ_RANGE_READ_POINT_INDEX}
          ON message_human_read_ranges (room_id, account_id, last_message_sequence)`);
        return [READ_RANGE_READ_POINT_INDEX];
      } catch (error) {
        if ((error as { code?: string } | null)?.code !== "55P03") throw error;
        await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${READ_RANGE_READ_POINT_INDEX}`).catch(() => {});
        log(`[migrate] index ${READ_RANGE_READ_POINT_INDEX} was not built: a long transaction held it. Unread counts work without it; the next npm run db:migrate builds it.`);
        return [];
      }
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [ROLLOUT_KEY]).catch(() => {});
    }
  } finally {
    client.release();
  }
}
