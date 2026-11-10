import type { Pool, PoolClient } from "pg";

const ROLLOUT_KEY = "0146_github_webhook_integrity_v1";
const SEMANTIC_ID_INDEX = "github_room_events_semantic_id_unique";
const BUILD_ATTEMPTS = 3;

/**
 * Keep the earliest event of each semantic_id and clear the id on the later
 * copies, right before each build, so rows an older server wrote meanwhile
 * are cleared too. No event row is deleted: other rows and messages may name
 * an event by its id. Only duplicate rows are written, so only they are locked.
 */
const CLEAR_DUPLICATE_SEMANTIC_IDS = `UPDATE github_room_events AS event
     SET semantic_id = NULL
    FROM (
      SELECT id,
             row_number() OVER (PARTITION BY semantic_id ORDER BY created_at, id) AS position
        FROM github_room_events
       WHERE semantic_id IS NOT NULL
    ) AS ranked
   WHERE event.id = ranked.id
     AND ranked.position > 1`;

/**
 * Built here, after migration 0146 commits, with CREATE INDEX CONCURRENTLY:
 * every webhook writes these tables, and a plain build inside the migration
 * transaction would block those writes until it finished. Until the unique
 * index exists, semantic_id duplicates are suppressed by the read before the
 * insert, as before.
 */
export const GITHUB_WEBHOOK_INTEGRITY_INDEXES = [
  {
    name: SEMANTIC_ID_INDEX,
    sql: `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${SEMANTIC_ID_INDEX}
     ON github_room_events (semantic_id) WHERE semantic_id IS NOT NULL`,
  },
  {
    name: "github_webhook_deliveries_received_idx",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS github_webhook_deliveries_received_idx
     ON github_webhook_deliveries (claimed_at) WHERE status = 'received' AND payload IS NOT NULL`,
  },
] as const;

async function indexState(client: PoolClient, name: string): Promise<"valid" | "invalid" | "missing"> {
  const state = await client.query<{ valid: boolean }>(
    `SELECT pg_index.indisvalid AS valid
       FROM pg_index
       JOIN pg_class ON pg_class.oid = pg_index.indexrelid
       JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
      WHERE pg_namespace.nspname = current_schema()
        AND pg_class.relname = $1`,
    [name],
  );
  if (!state.rows[0]) return "missing";
  return state.rows[0].valid ? "valid" : "invalid";
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

function isLockTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "55P03";
}

export interface GitHubWebhookIntegrityRolloutOptions {
  /** How long one build may wait for older transactions before it is retried. */
  lockTimeout?: string;
  /** Pause before each retry after a lock timeout; its length bounds the retries. */
  lockRetryDelaysMs?: readonly number[];
  log?: (line: string) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Idempotent, post-commit rollout work for migration 0146. Returns the
 * indexes it (re)built.
 *
 * CREATE INDEX CONCURRENTLY waits for every older transaction in the
 * database, so one long transaction makes a build hit lock_timeout (55P03).
 * The build is retried a bounded number of times. If it still cannot run,
 * the rollout tries to drop the invalid shell (the drop can wait too; the
 * next run drops it), logs one line saying so, and returns without that
 * index: the server works without it (duplicates are
 * suppressed by the read before the insert, as before 0146, and the redrive
 * sweep scans instead of using its index). The next `npm run db:migrate`
 * builds it. Any other error stops the migrator.
 */
export async function reconcileGitHubWebhookIntegrityRollout(
  pool: Pool,
  options: GitHubWebhookIntegrityRolloutOptions = {},
): Promise<string[]> {
  // Worst case with one long transaction open: three 5 s waits, 20 s of
  // pauses and one 5 s drop, about 40 s, then the rest waits for the next run.
  // The deploy runs this inside its own time limit.
  const lockRetryDelaysMs = options.lockRetryDelaysMs ?? [5_000, 15_000];
  const log = options.log ?? ((line: string) => console.warn(line));
  const lockClient = await pool.connect();
  try {
    const acquired = await lockClient.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired`,
      [ROLLOUT_KEY],
    );
    if (!acquired.rows[0]?.acquired) {
      throw new Error("GitHub webhook integrity rollout is already running on another migrator");
    }
    const client = await pool.connect();
    try {
      await client.query("SET statement_timeout = '15min'");
      await client.query(`SET lock_timeout = '${options.lockTimeout ?? "5s"}'`);
      const built: string[] = [];
      let gaveUp = false;
      for (const index of GITHUB_WEBHOOK_INTEGRITY_INDEXES) {
        if (gaveUp) {
          // The same old transaction would hold this build too: leave it for
          // the next run instead of spending the deploy's time on it.
          log(`[migrate] index ${index.name} was not built in this run; npm run db:migrate builds it next time.`);
          continue;
        }
        let duplicateRetries = 0;
        let lockRetries = 0;
        while (true) {
          try {
            const state = await indexState(client, index.name);
            if (state === "valid") break;
            if (state === "invalid") {
              // A failed or cancelled CREATE INDEX CONCURRENTLY leaves an invalid
              // shell that IF NOT EXISTS would accept forever. Remove only that.
              await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${index.name}`);
            }
            if (index.name === SEMANTIC_ID_INDEX) await client.query(CLEAR_DUPLICATE_SEMANTIC_IDS);
            await client.query(index.sql);
            built.push(index.name);
            break;
          } catch (error) {
            if (isUniqueViolation(error) && duplicateRetries < BUILD_ATTEMPTS - 1) {
              // An older server inserted a duplicate during the build: clear it, build again.
              duplicateRetries += 1;
              continue;
            }
            if (!isLockTimeout(error)) throw error;
            const delay = lockRetryDelaysMs[lockRetries];
            if (delay === undefined) {
              gaveUp = true;
              await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${index.name}`).catch((dropError: unknown) => {
                log(`[migrate] the unfinished index ${index.name} was not dropped either (${dropError instanceof Error ? dropError.message : String(dropError)}); the next run drops it.`);
              });
              log(
                `[migrate] index ${index.name} was not built: a long transaction held it past `
                + `${lockRetries + 1} tries. The server works without it; run npm run db:migrate again to build it.`,
              );
              break;
            }
            lockRetries += 1;
            log(`[migrate] index ${index.name} is waiting for an older transaction; retry ${lockRetries} in ${delay} ms`);
            await sleep(delay);
          }
        }
      }
      return built;
    } finally {
      client.release();
    }
  } finally {
    await lockClient.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [ROLLOUT_KEY]).catch(() => {});
    lockClient.release();
  }
}
