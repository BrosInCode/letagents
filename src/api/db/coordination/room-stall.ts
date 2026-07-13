import { and, eq, sql } from "drizzle-orm";

import { db } from "../client.js";
import { room_board_settings, tasks } from "../schema.js";

export interface StalledRoomCandidate {
  room_id: string;
  /** When the last task closed — the drain epoch the nudge is fenced on. */
  last_closed_at: string;
  stall_nudged_at: string | null;
}

/**
 * Rooms whose board previously had work but has drained to zero open tasks
 * for at least `stalledForMs`. One row per room; the nudge fence
 * (stall_nudged_at vs the drain epoch) is evaluated by the sweeper, so a new
 * work cycle that later drains again re-arms automatically.
 */
export async function listStalledRoomCandidates(input: {
  stalledForMs: number;
  now?: number;
}): Promise<StalledRoomCandidate[]> {
  const now = input.now ?? Date.now();
  const cutoff = new Date(now - input.stalledForMs).toISOString();

  const rows = await db
    .select({
      room_id: tasks.room_id,
      last_closed_at: sql<string>`max(${tasks.updated_at})`,
      stall_nudged_at: room_board_settings.stall_nudged_at,
    })
    .from(tasks)
    .leftJoin(room_board_settings, eq(room_board_settings.room_id, tasks.room_id))
    .groupBy(tasks.room_id, room_board_settings.stall_nudged_at)
    .having(
      and(
        sql`count(*) FILTER (WHERE ${tasks.status} NOT IN ('done', 'cancelled')) = 0`,
        sql`max(${tasks.updated_at}) <= ${cutoff}::timestamptz`
      )
    );

  return rows.map((row) => ({
    room_id: row.room_id,
    last_closed_at: row.last_closed_at,
    stall_nudged_at: row.stall_nudged_at ?? null,
  }));
}

/**
 * Fence the one stall nudge a drain epoch gets. Upserts the settings row
 * (rooms often have none) and succeeds only when no nudge exists for this
 * epoch yet, so concurrent sweepers cannot double-post.
 */
export async function markRoomStallNudgedTx(
  executor: Pick<typeof db, "insert">,
  input: {
    room_id: string;
    epoch: string;
    nudged_at?: string;
  }
): Promise<boolean> {
  const nudgedAt = input.nudged_at ?? new Date().toISOString();
  const now = new Date().toISOString();
  const rows = await executor
    .insert(room_board_settings)
    .values({
      room_id: input.room_id,
      stall_nudged_at: nudgedAt,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: room_board_settings.room_id,
      set: { stall_nudged_at: nudgedAt, updated_at: now },
      setWhere: sql`${room_board_settings.stall_nudged_at} IS NULL OR ${room_board_settings.stall_nudged_at} < ${input.epoch}::timestamptz`,
    })
    .returning({ room_id: room_board_settings.room_id });

  return rows.length > 0;
}
