import { and, eq, sql } from "drizzle-orm";

import { normalizeBoardManagerMode } from "./board-intents.js";
import { db } from "../client.js";
import { room_board_settings } from "../schema.js";
import type { BoardManagerMode } from "../types.js";

export interface StalledRoomCandidate {
  room_id: string;
  /** When the last task closed — the drain epoch the nudge is fenced on. */
  last_closed_at: string;
  stall_nudged_at: string | null;
  manager_mode: BoardManagerMode;
  claimed_check_at?: string | null;
}

/**
 * Rooms whose board previously had work but has drained to zero open tasks
 * for at least `stalledForMs`. One row per room; the nudge fence
 * (stall_nudged_at vs the drain epoch) is evaluated by the sweeper, so a new
 * work cycle that later drains again re-arms automatically.
 */
export async function listStalledRoomCandidates(input: {
  now?: number;
  limit?: number;
}): Promise<StalledRoomCandidate[]> {
  const now = input.now ?? Date.now();
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const retryAt = new Date(now + 60_000).toISOString();
  const result = await db.execute<{
    room_id: string;
    last_task_closed_at: string;
    stall_nudged_at: string | null;
    manager_mode: string;
    claimed_check_at: string;
  }>(sql`
    WITH due AS (
      SELECT ${room_board_settings.room_id}
        FROM ${room_board_settings}
       WHERE ${room_board_settings.open_task_count} = 0
         AND ${room_board_settings.last_task_closed_at} IS NOT NULL
         AND ${room_board_settings.stall_check_at} <= ${new Date(now).toISOString()}::timestamptz
         AND (${room_board_settings.stall_nudged_at} IS NULL
           OR ${room_board_settings.stall_nudged_at} < ${room_board_settings.last_task_closed_at})
       ORDER BY ${room_board_settings.stall_check_at}, ${room_board_settings.room_id}
       LIMIT ${limit}
       FOR UPDATE SKIP LOCKED
    )
    UPDATE ${room_board_settings} AS settings
       SET stall_check_at = ${retryAt}::timestamptz
      FROM due
     WHERE settings.room_id = due.room_id
    RETURNING settings.room_id, settings.last_task_closed_at,
              settings.stall_nudged_at, settings.manager_mode,
              settings.stall_check_at AS claimed_check_at
  `);
  const rows = result.rows;

  return rows.map((row) => ({
    room_id: row.room_id,
    last_closed_at: row.last_task_closed_at,
    stall_nudged_at: row.stall_nudged_at ?? null,
    manager_mode: normalizeBoardManagerMode(row.manager_mode ?? null),
    claimed_check_at: row.claimed_check_at,
  }));
}

/** CAS reschedule: a racing task/manager write owns any newer deadline. */
export async function rescheduleStalledRoomCandidate(input: {
  room_id: string;
  claimed_check_at: string;
  next_check_at: string | null;
}): Promise<void> {
  await db.update(room_board_settings)
    .set({ stall_check_at: input.next_check_at })
    .where(and(
      eq(room_board_settings.room_id, input.room_id),
      eq(room_board_settings.stall_check_at, input.claimed_check_at),
    ));
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
      stall_check_at: null,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: room_board_settings.room_id,
      set: { stall_nudged_at: nudgedAt, stall_check_at: null, updated_at: now },
      setWhere: sql`
        (${room_board_settings.stall_nudged_at} IS NULL
          OR ${room_board_settings.stall_nudged_at} < ${input.epoch}::timestamptz)
        AND ${room_board_settings.open_task_count} = 0
        AND ${room_board_settings.last_task_closed_at} = ${input.epoch}::timestamptz
        AND NOT EXISTS (
          SELECT 1 FROM board_manager_assignments AS manager
          JOIN room_agent_sessions AS manager_session
            ON manager_session.room_id = manager.room_id
           AND manager_session.session_id = manager.agent_session_id
           AND manager_session.session_kind = 'worker'
           AND manager_session.ended_at IS NULL
          JOIN room_agent_delivery_sessions AS manager_delivery
            ON manager_delivery.room_id = manager.room_id
           AND manager_delivery.delivery_key = 'agent_session:' || manager.agent_session_id
           WHERE manager.room_id = ${input.room_id}
             AND manager.status = 'active'
             AND (
               (manager_delivery.active_connection_count > 0
                 AND manager_delivery.updated_at >= now() - interval '90 seconds')
               OR manager_delivery.reconnect_grace_expires_at >= now()
             )
        )`,
    })
    .returning({ room_id: room_board_settings.room_id });

  return rows.length > 0;
}
