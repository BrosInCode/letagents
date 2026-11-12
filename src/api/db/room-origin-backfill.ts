import type { Pool } from "pg";

import { originFromIdShape } from "../rooms/room-nature.js";

const BATCH_SIZE = 500;
const LOCK_TIMEOUT = "2s";

export interface RoomOriginFillResult {
  filled: number;
  /** Set when the step stopped early; the rows left read through the fallback. */
  error: string | null;
}

/**
 * Fill `rooms.origin` where migration 0148 left it NULL (ids with letters
 * outside ASCII, whose JavaScript upper-case form the SQL rule cannot copy)
 * and where an older server inserted a room without it.
 *
 * Runs after the migrations, outside their transaction, one short
 * transaction per batch:
 * - a row another transaction holds is skipped (FOR UPDATE SKIP LOCKED);
 * - a table lock it cannot get within 2 s ends the step (lock_timeout);
 * - it writes only `origin`, so no trigger on rooms fires.
 * A NULL origin is safe: rooms/room-nature.ts reads the same rule from the id,
 * and the next deploy fills the row. So this step never fails the deploy: an
 * error is logged in one line and returned.
 */
export async function reconcileRoomOriginBackfill(
  pool: Pick<Pool, "connect">,
  log: (line: string) => void = (line) => console.warn(line),
): Promise<RoomOriginFillResult> {
  let filled = 0;
  let after = "";
  try {
    while (true) {
      const client = await pool.connect();
      let failure: Error | undefined;
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
        const batch = await client.query<{ id: string; kind: string }>(
          `SELECT id, kind FROM rooms
            WHERE origin IS NULL AND id > $1
            ORDER BY id
            LIMIT ${BATCH_SIZE}
            FOR UPDATE SKIP LOCKED`,
          [after],
        );
        if (!batch.rows.length) {
          await client.query("COMMIT");
          return { filled, error: null };
        }
        after = batch.rows[batch.rows.length - 1]!.id;
        const updated = await client.query(
          `UPDATE rooms AS r
              SET origin = fill.origin
             FROM unnest($1::text[], $2::text[]) AS fill(id, origin)
            WHERE r.id = fill.id AND r.origin IS NULL`,
          [batch.rows.map((row) => row.id), batch.rows.map((row) => originFromIdShape(row))],
        );
        await client.query("COMMIT");
        filled += updated.rowCount ?? 0;
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        // After an error, pg destroys the connection instead of pooling it.
        client.release(failure);
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`[room origin fill] stopped after ${filled} rooms (${reason}); the rest read their origin from the id until the next deploy`);
    return { filled, error: reason };
  }
}
