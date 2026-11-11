import type { Pool } from "pg";

import { originFromIdShape } from "../rooms/room-nature.js";

const BATCH_SIZE = 500;

/**
 * Fill `rooms.origin` where migration 0148 left it NULL: ids with letters
 * outside ASCII, whose JavaScript upper-case form the SQL rule cannot copy.
 * Runs after the migrations, outside their transaction: each batch is one
 * UPDATE that locks only its own rows and writes only `origin`, so no
 * trigger on rooms fires. Rows an older server inserts later stay NULL and
 * read through the same rule (rooms/room-nature.ts) until the next deploy.
 */
export async function reconcileRoomOriginBackfill(pool: Pick<Pool, "query">): Promise<number> {
  let filled = 0;
  let after = "";
  while (true) {
    const batch = await pool.query<{ id: string; kind: string }>(
      `SELECT id, kind FROM rooms WHERE origin IS NULL AND id > $1 ORDER BY id LIMIT ${BATCH_SIZE}`,
      [after],
    );
    if (!batch.rows.length) return filled;
    after = batch.rows[batch.rows.length - 1]!.id;
    const ids = batch.rows.map((row) => row.id);
    const origins = batch.rows.map((row) => originFromIdShape(row));
    const updated = await pool.query(
      `UPDATE rooms AS r
          SET origin = fill.origin
         FROM unnest($1::text[], $2::text[]) AS fill(id, origin)
        WHERE r.id = fill.id AND r.origin IS NULL`,
      [ids, origins],
    );
    filled += updated.rowCount ?? 0;
  }
}
