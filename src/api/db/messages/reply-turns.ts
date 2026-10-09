import { sql } from "drizzle-orm";

import { db } from "../client.js";
import { message_agent_receipts } from "../schema.js";

// The pure reply-order rules live in reply-turn-plan.ts; this module holds the
// release transitions and the reads that need the database.
export * from "./reply-turn-plan.js";
import { REPLY_TURN_SWEEP_BATCH } from "./reply-turn-plan.js";

type ReplyTurnExecutor = Pick<typeof db, "execute">;

/** One released hold: the message, and the agent whose worker must wake. */
export interface ReleasedReplyTurn {
  room_id: string;
  message_number: number;
  agent_key: string;
}

function releasedRows(roomId: string | null, rows: readonly Record<string, unknown>[]): ReleasedReplyTurn[] {
  return rows.map((row) => ({
    room_id: roomId ?? String(row.message_room_id),
    message_number: Number(row.message_number),
    agent_key: String(row.agent_key),
  }));
}

/**
 * Release the lowest held position of each message once every earlier
 * position has finished its turn (replied, left, or reported no reply,
 * failure or interruption). A position released early by its deadline is
 * not finished, so the positions after it keep waiting for it or for their
 * own deadline. Idempotent.
 *
 * Deliberately lock-free: two transactions that finish turns on one message
 * at the same moment can each miss the other's commit. The deadline sweep
 * re-runs this rule, so such a miss costs at most one sweep interval.
 */
export async function releaseReadyReplyTurnsTx(
  tx: ReplyTurnExecutor,
  roomId: string,
  messageNumbers: readonly number[],
): Promise<ReleasedReplyTurn[]> {
  const numbers = [...new Set(messageNumbers)];
  if (numbers.length === 0) return [];
  const released = await tx.execute(sql`
    WITH lowest_held AS (
      SELECT DISTINCT ON (held.message_number) held.id, held.message_number, held.turn_position
        FROM ${message_agent_receipts} AS held
       WHERE held.message_room_id = ${roomId}
         AND held.message_number IN (
           SELECT value::integer FROM jsonb_array_elements_text(${JSON.stringify(numbers)}::jsonb)
         )
         AND held.hold_released_at IS NULL
         AND held.hold_release_after IS NOT NULL
       ORDER BY held.message_number, held.turn_position
    ), ready AS (
      SELECT lowest_held.id FROM lowest_held
       WHERE NOT EXISTS (
         SELECT 1 FROM ${message_agent_receipts} AS earlier
          WHERE earlier.message_room_id = ${roomId}
            AND earlier.message_number = lowest_held.message_number
            AND earlier.turn_position < lowest_held.turn_position
            AND earlier.turn_done_at IS NULL
       )
    )
    UPDATE ${message_agent_receipts} AS receipt
       SET hold_released_at = now(), hold_release_reason = 'turn'
      FROM ready
     WHERE receipt.id = ready.id AND receipt.hold_released_at IS NULL
    RETURNING receipt.message_number, receipt.agent_key
  `);
  return releasedRows(roomId, released.rows);
}

/**
 * These agents' turns on these messages are over. A turn that ends while
 * still held (the agent left before its turn) is skipped: its hold is
 * released so it never blocks the agent's frontier again. Then the next
 * position that is ready is released.
 */
export async function finishReplyTurnsTx(
  tx: ReplyTurnExecutor,
  roomId: string,
  finished: readonly { message_number: number; agent_key: string }[],
): Promise<ReleasedReplyTurn[]> {
  if (finished.length === 0) return [];
  // SET expressions read the row as it was: a hold already past its deadline
  // (released by the frontier, not yet by a sweep) counts as a deadline release.
  const marked = await tx.execute<{ message_number: number; turn_position: number; hold_release_reason: string | null }>(sql`
    UPDATE ${message_agent_receipts} AS receipt
       SET turn_done_at = COALESCE(receipt.turn_done_at, now()),
           hold_release_reason = CASE
             WHEN receipt.hold_released_at IS NOT NULL THEN receipt.hold_release_reason
             WHEN receipt.hold_release_after <= now() THEN 'deadline'
             ELSE 'skipped'
           END,
           hold_released_at = COALESCE(receipt.hold_released_at, now())
      FROM jsonb_to_recordset(${JSON.stringify(finished.map((turn) => ({
        message_number: turn.message_number,
        agent_key: turn.agent_key,
      })))}::jsonb) AS finished(message_number integer, agent_key text)
     WHERE receipt.message_room_id = ${roomId}
       AND receipt.message_number = finished.message_number
       AND receipt.agent_key = finished.agent_key
       AND receipt.turn_position IS NOT NULL
    RETURNING receipt.message_number, receipt.turn_position, receipt.hold_release_reason
  `);
  await closeTurnsBeforeDeadlineReleasesTx(tx, marked.rows
    .filter((row) => row.hold_release_reason === "deadline")
    .map((row) => ({ room_id: roomId, message_number: Number(row.message_number), turn_position: Number(row.turn_position) })));
  return releaseReadyReplyTurnsTx(tx, roomId, marked.rows.map((row) => Number(row.message_number)));
}

/**
 * A position released by its deadline gave up waiting for the ones before it.
 * Their turns count as over from then on, so the chain does not stall behind
 * an agent that never marks its receipt (a legacy top-level send_message).
 */
async function closeTurnsBeforeDeadlineReleasesTx(
  tx: ReplyTurnExecutor,
  released: readonly { room_id: string; message_number: number; turn_position: number }[],
): Promise<void> {
  if (released.length === 0) return;
  await tx.execute(sql`
    UPDATE ${message_agent_receipts} AS earlier
       SET turn_done_at = now()
      FROM jsonb_to_recordset(${JSON.stringify(released)}::jsonb)
        AS released(room_id text, message_number integer, turn_position integer)
     WHERE earlier.message_room_id = released.room_id
       AND earlier.message_number = released.message_number
       AND earlier.turn_position < released.turn_position
       AND earlier.turn_done_at IS NULL
  `);
}

/**
 * A new activation that the agent must see now (any receipt that is not a
 * held turn) ends every open hold of that agent in the room. Otherwise the
 * frontier, which hides everything after a held message, would also hide
 * the mention, reply, thread or task that was just addressed to it.
 */
export async function releaseAgentReplyTurnHoldsTx(
  tx: ReplyTurnExecutor,
  roomId: string,
  agentKeys: readonly string[],
): Promise<ReleasedReplyTurn[]> {
  const keys = [...new Set(agentKeys)];
  if (keys.length === 0) return [];
  const released = await tx.execute(sql`
    UPDATE ${message_agent_receipts} AS receipt
       SET hold_released_at = now(), hold_release_reason = 'activation'
     WHERE receipt.message_room_id = ${roomId}
       AND receipt.agent_key IN (
         SELECT value FROM jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb)
       )
       AND receipt.hold_released_at IS NULL
       AND receipt.hold_release_after IS NOT NULL
    RETURNING receipt.message_number, receipt.agent_key
  `);
  return releasedRows(roomId, released.rows);
}

/**
 * The sweep: release holds whose deadline passed (closing the turns before
 * them), then re-apply the ready rule to every message that still has a
 * hold (this repairs a release that two racing transactions both missed).
 * Each step is one bounded statement in one transaction; SKIP LOCKED lets
 * several API processes sweep at once.
 */
export async function releaseDueReplyTurnHolds(
  limit = REPLY_TURN_SWEEP_BATCH,
  database: Pick<typeof db, "transaction"> = db,
): Promise<{ released: number; turns: ReleasedReplyTurn[] }> {
  return database.transaction(async (executor) => {
    const due = await executor.execute(sql`
      WITH due AS (
        SELECT id FROM ${message_agent_receipts}
         WHERE hold_released_at IS NULL
           AND hold_release_after IS NOT NULL
           AND hold_release_after <= now()
         ORDER BY hold_release_after
         LIMIT ${limit}
         FOR UPDATE SKIP LOCKED
      )
      UPDATE ${message_agent_receipts} AS receipt
         SET hold_released_at = now(), hold_release_reason = 'deadline'
        FROM due
       WHERE receipt.id = due.id
      RETURNING receipt.message_room_id, receipt.message_number, receipt.agent_key, receipt.turn_position
    `);
    await closeTurnsBeforeDeadlineReleasesTx(executor, due.rows.map((row) => ({
      room_id: String(row.message_room_id),
      message_number: Number(row.message_number),
      turn_position: Number(row.turn_position),
    })));
    // Bounded to the first `limit` messages that still hold a turn (by room and
    // number). Beyond that many open held messages, a message left out of this
    // pass falls back to its deadline.
    const ready = await executor.execute(sql`
      WITH lowest_held AS (
        SELECT DISTINCT ON (held.message_room_id, held.message_number)
               held.id, held.message_room_id, held.message_number, held.turn_position
          FROM ${message_agent_receipts} AS held
         WHERE held.hold_released_at IS NULL
           AND held.hold_release_after IS NOT NULL
         ORDER BY held.message_room_id, held.message_number, held.turn_position
         LIMIT ${limit}
      ), ready AS (
        SELECT lowest_held.id FROM lowest_held
         WHERE NOT EXISTS (
           SELECT 1 FROM ${message_agent_receipts} AS earlier
            WHERE earlier.message_room_id = lowest_held.message_room_id
              AND earlier.message_number = lowest_held.message_number
              AND earlier.turn_position < lowest_held.turn_position
              AND earlier.turn_done_at IS NULL
         )
      )
      UPDATE ${message_agent_receipts} AS receipt
         SET hold_released_at = now(), hold_release_reason = 'turn'
        FROM ready
       WHERE receipt.id = ready.id AND receipt.hold_released_at IS NULL
      RETURNING receipt.message_room_id, receipt.message_number, receipt.agent_key
    `);
    return {
      released: due.rows.length,
      turns: [...releasedRows(null, due.rows), ...releasedRows(null, ready.rows)],
    };
  });
}

/**
 * Labels of the agents that answered before each given position, in turn
 * order. One query for a page: keys are message numbers, values map a
 * position to the speakers before it.
 */
export async function loadReplyTurnPriorSpeakers(
  roomId: string,
  messageNumbers: readonly number[],
  executor: Pick<typeof db, "execute"> = db,
): Promise<Map<number, Array<{ turn_position: number; actor_label: string }>>> {
  const numbers = [...new Set(messageNumbers)];
  const byMessage = new Map<number, Array<{ turn_position: number; actor_label: string }>>();
  if (numbers.length === 0) return byMessage;
  const rows = await executor.execute<{ message_number: number; turn_position: number; actor_label: string }>(sql`
    SELECT message_number, turn_position, actor_label
      FROM ${message_agent_receipts}
     WHERE message_room_id = ${roomId}
       AND message_number IN (
         SELECT value::integer FROM jsonb_array_elements_text(${JSON.stringify(numbers)}::jsonb)
       )
       AND turn_position IS NOT NULL
       AND receipt_state = 'replied'
     ORDER BY message_number, turn_position
  `);
  for (const row of rows.rows) {
    const number = Number(row.message_number);
    const list = byMessage.get(number) ?? [];
    list.push({ turn_position: Number(row.turn_position), actor_label: row.actor_label });
    byMessage.set(number, list);
  }
  return byMessage;
}

/**
 * After commit: wake the released agents. Fire-and-forget; a lost wake is
 * recovered by the agent's next poll, and the frontier itself honours the
 * deadline. Dynamic import: the server event module transitively imports
 * the database layer.
 */
export function queueReplyTurnWakes(turns: readonly ReleasedReplyTurn[]): void {
  if (turns.length === 0) return;
  void import("../../server/reply-turn-holds.js")
    .then(({ publishReleasedReplyTurns }) => publishReleasedReplyTurns(turns))
    .catch((error) => {
      console.error("[reply turns] failed to wake released agents", error);
    });
}
