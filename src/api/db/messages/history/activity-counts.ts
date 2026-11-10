/**
 * Per-room visible message counts by sender, kept up to date incrementally.
 *
 * The activity-history route asks for these counts on every room snapshot. A
 * full `GROUP BY sender` reads every message of the room, so this module keeps
 * the last answer per room with the highest message number it covers and, on
 * the next request, counts only the rows above that number.
 *
 * Why adding deltas is safe:
 * - Message numbers per room come from a row-locked `id_sequences` upsert in
 *   the insert transaction, so they commit in order: once number N is visible,
 *   every lower number is committed or rolled back.
 * - The application never rewrites `sender`, `text` or `agent_prompt_kind`.
 *   The only message delete outside a room delete removes blank auto prompts,
 *   which the visibility filter never counts.
 * - A room id can move (code rotation, repo rename) and an old id can be
 *   reused. Every read returns the room's `created_at`; a different value
 *   than the cached one forces a full recount.
 * - Anything outside those paths (manual SQL) is corrected by a full recount
 *   at least every ROOM_MESSAGE_COUNT_FULL_RECOUNT_MS.
 *
 * The cache holds no invalidation state of its own, so a second server
 * process is only slower (its own first full count), never more wrong.
 */
import { and, eq, gt, sql } from "drizzle-orm";

import { db } from "../../client.js";
import { messages, rooms } from "../../schema.js";
import type { RoomActivityActorCount } from "../../types.js";
import { visibleMessageCondition } from "../visibility.js";

export const ROOM_MESSAGE_COUNT_FULL_RECOUNT_MS = 10 * 60_000;
export const ROOM_MESSAGE_COUNT_CACHE_MAX_ROOMS = 2_000;

interface CachedRoomMessageCounts {
  roomCreatedAt: string;
  /** Highest message number already folded into `counts`; 0 for none. */
  coveredNumber: number;
  counts: ReadonlyMap<string, number>;
  fullCountAtMs: number;
}

const cache = new Map<string, CachedRoomMessageCounts>();

interface CountRead {
  roomCreatedAt: string | null;
  maxNumber: number;
  deltas: Map<string, number>;
}

async function readCountsAbove(roomId: string, coveredNumber: number): Promise<CountRead> {
  const above = and(eq(messages.room_id, roomId), gt(messages.number, coveredNumber));
  // One statement, one snapshot: the room fingerprint, the highest number and
  // the counts agree. The count keeps the original query's shape; the highest
  // number is a backward read of the primary key.
  const { rows } = await db.execute<{
    room_created_at: string;
    max_number: number | null;
    sender: string | null;
    count: number | null;
  }>(sql`
    WITH room AS (
      SELECT ${rooms.created_at}::text AS room_created_at FROM ${rooms} WHERE ${eq(rooms.id, roomId)}
    ), top AS (
      SELECT MAX(${messages.number}) AS max_number FROM ${messages} WHERE ${above}
    ), counts AS (
      SELECT ${messages.sender} AS sender, COUNT(*)::int AS count FROM ${messages}
       WHERE ${and(above, visibleMessageCondition(false))}
       GROUP BY ${messages.sender}
    )
    SELECT room.room_created_at, top.max_number, counts.sender, counts.count
      FROM room CROSS JOIN top LEFT JOIN counts ON TRUE
  `);

  const deltas = new Map<string, number>();
  for (const row of rows) {
    const count = Number(row.count) || 0;
    if (row.sender !== null && count > 0) deltas.set(row.sender, count);
  }
  const first = rows[0];
  const maxNumber = first?.max_number == null ? coveredNumber : Math.max(coveredNumber, Number(first.max_number));
  return { roomCreatedAt: first ? first.room_created_at : null, maxNumber, deltas };
}

function remember(roomId: string, entry: CachedRoomMessageCounts): void {
  const current = cache.get(roomId);
  // A slower concurrent request must not replace a newer answer.
  if (current
    && current.roomCreatedAt === entry.roomCreatedAt
    && current.coveredNumber > entry.coveredNumber) return;
  cache.delete(roomId);
  cache.set(roomId, entry);
  while (cache.size > ROOM_MESSAGE_COUNT_CACHE_MAX_ROOMS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Returns the same rows as
 * `SELECT sender, COUNT(*) FROM messages WHERE room_id = $1 AND <visible> GROUP BY sender`,
 * reading only the messages added since the previous call for the room.
 */
export async function readRoomMessageCountsBySender(
  roomId: string,
  nowMs: number = Date.now(),
): Promise<RoomActivityActorCount[]> {
  const cached = cache.get(roomId);
  const usable = cached && nowMs - cached.fullCountAtMs < ROOM_MESSAGE_COUNT_FULL_RECOUNT_MS
    ? cached
    : undefined;

  let base = usable;
  let read = await readCountsAbove(roomId, base?.coveredNumber ?? 0);
  if (read.roomCreatedAt === null) {
    cache.delete(roomId);
    return [];
  }
  if (base && base.roomCreatedAt !== read.roomCreatedAt) {
    // The id now names a different room: count it from the start.
    base = undefined;
    read = await readCountsAbove(roomId, 0);
    if (read.roomCreatedAt === null) {
      cache.delete(roomId);
      return [];
    }
  }

  const counts = new Map(base?.counts ?? []);
  for (const [sender, count] of read.deltas) counts.set(sender, (counts.get(sender) ?? 0) + count);
  remember(roomId, {
    roomCreatedAt: read.roomCreatedAt,
    coveredNumber: read.maxNumber,
    counts,
    fullCountAtMs: base ? base.fullCountAtMs : nowMs,
  });

  return [...counts].map(([actor_label, count]) => ({ actor_label, count }));
}

/** Test seam: forget every cached room. */
export function clearRoomMessageCountCache(): void {
  cache.clear();
}
