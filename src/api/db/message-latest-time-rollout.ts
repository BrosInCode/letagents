import type { Pool, PoolClient } from "pg";

const ROLLOUT_KEY = "messages_room_timestamp_idx_v1";
export const MESSAGES_ROOM_TIMESTAMP_INDEX = "messages_room_timestamp_idx";

/**
 * Serves each room's latest visible message time in the room list (a backward
 * walk per room instead of a scan of its history). Built here, after the SQL
 * migrations commit, with CREATE INDEX CONCURRENTLY: every message send writes
 * `messages`, and a plain build inside the migration transaction would block
 * those writes until it finished. Until the index exists the room list is
 * still correct, only slower.
 */
const BUILD_SQL = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${MESSAGES_ROOM_TIMESTAMP_INDEX}
     ON messages (room_id, timestamp)`;

async function indexState(client: PoolClient): Promise<"valid" | "invalid" | "missing"> {
  const state = await client.query<{ valid: boolean }>(
    `SELECT pg_index.indisvalid AS valid
       FROM pg_index
       JOIN pg_class ON pg_class.oid = pg_index.indexrelid
       JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
      WHERE pg_namespace.nspname = current_schema()
        AND pg_class.relname = $1`,
    [MESSAGES_ROOM_TIMESTAMP_INDEX],
  );
  if (!state.rows[0]) return "missing";
  return state.rows[0].valid ? "valid" : "invalid";
}

function isLockTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "55P03";
}

export interface MessageLatestTimeRolloutOptions {
  /** How long one build may wait for older transactions before it is retried. */
  lockTimeout?: string;
  /** Pause before each retry after a lock timeout; its length bounds the retries. */
  lockRetryDelaysMs?: readonly number[];
  log?: (line: string) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Idempotent, post-migration rollout of messages_room_timestamp_idx. Returns
 * the indexes it (re)built.
 *
 * CREATE INDEX CONCURRENTLY waits for every older transaction, so one long
 * transaction makes the build hit lock_timeout (55P03). The build is retried
 * a bounded number of times; then the rollout drops the invalid shell (the
 * next run drops it if that waits too), logs one line and returns without the
 * index. The next `npm run db:migrate` builds it. Any other error stops the
 * migrator.
 */
export async function reconcileMessageLatestTimeRollout(
  pool: Pool,
  options: MessageLatestTimeRolloutOptions = {},
): Promise<string[]> {
  const lockRetryDelaysMs = options.lockRetryDelaysMs ?? [5_000, 15_000];
  const log = options.log ?? ((line: string) => console.warn(line));
  const lockClient = await pool.connect();
  try {
    const acquired = await lockClient.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired`,
      [ROLLOUT_KEY],
    );
    if (!acquired.rows[0]?.acquired) {
      throw new Error("message latest-time index rollout is already running on another migrator");
    }
    const client = await pool.connect();
    try {
      await client.query("SET statement_timeout = '15min'");
      await client.query(`SET lock_timeout = '${options.lockTimeout ?? "5s"}'`);
      let lockRetries = 0;
      while (true) {
        try {
          const state = await indexState(client);
          if (state === "valid") return [];
          if (state === "invalid") {
            // A failed or cancelled CREATE INDEX CONCURRENTLY leaves an invalid
            // shell that IF NOT EXISTS would accept forever. Remove only that.
            await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${MESSAGES_ROOM_TIMESTAMP_INDEX}`);
          }
          await client.query(BUILD_SQL);
          return [MESSAGES_ROOM_TIMESTAMP_INDEX];
        } catch (error) {
          if (!isLockTimeout(error)) throw error;
          const delay = lockRetryDelaysMs[lockRetries];
          if (delay === undefined) {
            await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${MESSAGES_ROOM_TIMESTAMP_INDEX}`).catch((dropError: unknown) => {
              log(`[migrate] the unfinished index ${MESSAGES_ROOM_TIMESTAMP_INDEX} was not dropped either (${dropError instanceof Error ? dropError.message : String(dropError)}); the next run drops it.`);
            });
            log(
              `[migrate] index ${MESSAGES_ROOM_TIMESTAMP_INDEX} was not built: a long transaction held it past `
              + `${lockRetries + 1} tries. The server works without it; run npm run db:migrate again to build it.`,
            );
            return [];
          }
          lockRetries += 1;
          log(`[migrate] index ${MESSAGES_ROOM_TIMESTAMP_INDEX} is waiting for an older transaction; retry ${lockRetries} in ${delay} ms`);
          await sleep(delay);
        }
      }
    } finally {
      client.release();
    }
  } finally {
    await lockClient.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [ROLLOUT_KEY]).catch(() => {});
    lockClient.release();
  }
}
