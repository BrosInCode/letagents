import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";

import { db } from "./client.js";
import { rooms } from "./schema.js";

type FocusRoomRow = typeof rooms.$inferSelect;

/**
 * The one lookup for "the focus or branch room under this parent with this
 * key". The unique index `rooms_parent_focus_key_idx` allows one row that is
 * not archived and any number of archived rows for one key, so the order is
 * fixed here:
 *   1. the row that is not archived;
 *   2. else an archived row: the newest (default) or the oldest
 *      (`archivedOrder: "oldest"`, for a caller whose released response
 *      showed the first-created row);
 *   3. ties break on `created_at`, then `id`.
 * With `includeArchived: false` only step 1 runs.
 */
export async function findFocusRoomRowByKey(
  input: {
    parentRoomId: string;
    focusKey: string;
    includeArchived: boolean;
    archivedOrder?: "newest" | "oldest";
  },
  executor: Pick<typeof db, "select"> = db,
): Promise<FocusRoomRow | undefined> {
  const conditions = [
    eq(rooms.parent_room_id, input.parentRoomId),
    eq(rooms.focus_key, input.focusKey),
    eq(rooms.kind, "focus"),
  ];
  if (!input.includeArchived) {
    conditions.push(isNull(rooms.focus_archived_at));
  }

  const newest = (input.archivedOrder ?? "newest") === "newest";
  const [row] = await executor
    .select()
    .from(rooms)
    .where(and(...conditions))
    .orderBy(
      sql`${rooms.focus_archived_at} IS NOT NULL`,
      newest ? desc(rooms.focus_archived_at) : asc(rooms.focus_archived_at),
      newest ? desc(rooms.created_at) : asc(rooms.created_at),
      newest ? desc(rooms.id) : asc(rooms.id),
    )
    .limit(1);
  return row;
}
