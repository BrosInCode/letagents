import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { db } from "./client.js";
import { rooms } from "./schema.js";

type FocusRoomRow = typeof rooms.$inferSelect;

/**
 * The one lookup for "the focus or branch room under this parent with this
 * key". The unique index `rooms_parent_focus_key_idx` allows one row that is
 * not archived and any number of archived rows for one key, so the order is
 * fixed here:
 *   1. the row that is not archived;
 *   2. else the most recently archived row (latest `focus_archived_at`);
 *   3. ties break on the newest `created_at`, then `id`.
 * With `includeArchived: false` only step 1 runs.
 */
export async function findFocusRoomRowByKey(
  input: {
    parentRoomId: string;
    focusKey: string;
    includeArchived: boolean;
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

  const [row] = await executor
    .select()
    .from(rooms)
    .where(and(...conditions))
    .orderBy(
      sql`${rooms.focus_archived_at} IS NOT NULL`,
      desc(rooms.focus_archived_at),
      desc(rooms.created_at),
      desc(rooms.id),
    )
    .limit(1);
  return row;
}
