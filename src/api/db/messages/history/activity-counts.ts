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
 * - That holds only while the room's counter is at or above every number in
 *   the room. A room renamed before the counter moved with it can have no
 *   counter, or one below its highest message, and then hands out low numbers
 *   again. Every read also returns the counter. The incremental path runs, and
 *   the cache is written, only when the counter is at or above both the
 *   covered number and the room's highest number. Otherwise the request does
 *   the full count and the room is not cached.
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
import { id_sequences, messages, rooms } from "../../schema.js";
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
  /** The room's message counter, or null when it has none. */
  counter: number | null;
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
    counter: number | null;
    max_number: number | null;
    sender: string | null;
    count: number | null;
  }>(sql`
    WITH room AS (
      SELECT ${rooms.created_at}::text AS room_created_at FROM ${rooms} WHERE ${eq(rooms.id, roomId)}
    ), counter AS (
      SELECT ${id_sequences.value} AS counter FROM ${id_sequences}
       WHERE ${eq(id_sequences.name, `messages:${roomId}`)}
    ), top AS (
      SELECT MAX(${messages.number}) AS max_number FROM ${messages} WHERE ${above}
    ), counts AS (
      SELECT ${messages.sender} AS sender, COUNT(*)::int AS count FROM ${messages}
       WHERE ${and(above, visibleMessageCondition(false))}
       GROUP BY ${messages.sender}
    )
    SELECT room.room_created_at, counter.counter, top.max_number, counts.sender, counts.count
      FROM room CROSS JOIN top LEFT JOIN counter ON TRUE LEFT JOIN counts ON TRUE
  `);

  const deltas = new Map<string, number>();
  for (const row of rows) {
    const count = Number(row.count) || 0;
    if (row.sender !== null && count > 0) deltas.set(row.sender, count);
  }
  const first = rows[0];
  const maxNumber = first?.max_number == null ? coveredNumber : Math.max(coveredNumber, Number(first.max_number));
  return {
    roomCreatedAt: first ? first.room_created_at : null,
    counter: first?.counter == null ? null : Number(first.counter),
    maxNumber,
    deltas,
  };
}

/** The next number the counter hands out is above `number` and above every row read. */
function counterCovers(read: CountRead, number: number): boolean {
  return read.counter !== null && read.counter >= number && read.counter >= read.maxNumber;
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
  // Numbers above the covered one are guaranteed only while the counter is at
  // or above it. A different created_at means the id names another room.
  if (base && (base.roomCreatedAt !== read.roomCreatedAt || !counterCovers(read, base.coveredNumber))) {
    base = undefined;
    read = await readCountsAbove(roomId, 0);
    if (read.roomCreatedAt === null) {
      cache.delete(roomId);
      return [];
    }
  }

  const counts = new Map(base?.counts ?? []);
  for (const [sender, count] of read.deltas) counts.set(sender, (counts.get(sender) ?? 0) + count);
  if (!counterCovers(read, read.maxNumber)) {
    // A damaged counter can hand out a number below this answer's highest:
    // never build on it. The next request counts in full again.
    cache.delete(roomId);
    return [...counts].map(([actor_label, count]) => ({ actor_label, count }));
  }
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
