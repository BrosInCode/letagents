import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import {
  ROOM_HISTORY_BACKFILL_MESSAGES,
  ROOM_HISTORY_LINE_BYTES,
  clipUtf8,
  formatRoomHistoryNodeId,
  singleLine,
  utf8Bytes,
  type RoomHistoryLine,
  type RoomHistorySummaryState,
} from "../../../shared/room-history-summary.mjs";
import { db } from "../db/client.js";
import { formatMessageId } from "../db/utils.js";
import { planRoomHistoryView, type RoomHistoryPart } from "./view-plan.js";

type Executor = Pick<typeof db, "execute">;
type Row = Record<string, unknown>;

/** Messages a summary reads: visible to every participant, and not a blank agent prompt. */
const eligible = (alias: string): SQL => sql.raw(`${alias}.visibility IS NULL
  AND (${alias}.agent_prompt_kind IS NULL OR ${alias}.agent_prompt_kind <> 'auto' OR BTRIM(${alias}.text) <> '')`);

/** How many messages one worker turn reads into the tree. */
const INGEST_BATCH = 256;
/** A room with nothing to do is looked at again after this long, in case a wake was lost. */
const IDLE_RECHECK = sql`interval '10 minutes'`;
/** How long one worker turn may hold a room before another process may take it. */
const LEASE = sql`interval '3 minutes'`;

const iso = (value: unknown): string => value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
const rows = async (executor: Executor, query: SQL): Promise<Row[]> => (await executor.execute(query)).rows as Row[];

export interface RoomHistoryClaim { roomId: string; token: string }

/**
 * A room's summary starts the first time it is needed (a new message or a
 * read) while the room has summaries on. A room already started is woken:
 * looked at now, unless it is waiting after a failure or a worker holds it.
 */
export async function startOrWakeRoomHistory(roomId: string, executor: Executor = db): Promise<void> {
  await executor.execute(sql`
    INSERT INTO room_history_summary_state (room_id, next_number)
    SELECT r.id, 0 FROM rooms r
     WHERE r.id = ${roomId}
       AND COALESCE((SELECT s.history_summary_enabled FROM room_settings s WHERE s.room_id = r.id), true)
    ON CONFLICT (room_id) DO UPDATE SET available_at = LEAST(room_history_summary_state.available_at, now())
     WHERE room_history_summary_state.failures = 0 AND room_history_summary_state.claim_token IS NULL`);
}

/** Takes rooms that are due, for one worker turn. Another process skips them until the lease ends. */
export async function claimRoomHistoryRooms(limit: number): Promise<RoomHistoryClaim[]> {
  const token = randomUUID();
  const claimed = await rows(db, sql`
    WITH due AS (
      SELECT room_id FROM room_history_summary_state
       WHERE available_at <= now() ORDER BY available_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
    )
    UPDATE room_history_summary_state s
       SET claim_token = ${token}, available_at = now() + ${LEASE}, updated_at = now()
      FROM due WHERE s.room_id = due.room_id
    RETURNING s.room_id`);
  return claimed.map((row) => ({ roomId: String(row.room_id), token }));
}

/** Locks the state row for this turn's write; false when the lease was lost. */
async function holdsClaim(tx: Executor, claim: RoomHistoryClaim): Promise<Row | null> {
  const [row] = await rows(tx, sql`SELECT * FROM room_history_summary_state
    WHERE room_id = ${claim.roomId} AND claim_token = ${claim.token} FOR UPDATE`);
  return row ?? null;
}

/** The line a message gives when it fits as it is, or the text the summarizer reads. */
export function roomHistorySourceLine(message: { sender: string; text: string; thread_root_number: number | null }): string {
  const thread = message.thread_root_number ? `(thread ${formatMessageId(message.thread_root_number)}) ` : "";
  return singleLine(`${thread}${message.sender}: ${message.text}`);
}

/**
 * Gives node (level, idx) a parent once its sibling has text too, in the
 * caller's transaction, and goes on upward while two lines fit in one as
 * they are (no summary needed). A parent too long waits for the summarizer.
 */
async function addParents(tx: Executor, roomId: string, startLevel: number, startIdx: number): Promise<void> {
  let level = startLevel;
  let idx = startIdx;
  for (;;) {
    const left = idx & ~1;
    const pair = await rows(tx, sql`SELECT idx, first_number, last_number, first_at, last_at, text
      FROM room_history_summary_nodes WHERE room_id = ${roomId} AND level = ${level} AND idx IN (${left}, ${left + 1})
      ORDER BY idx`);
    if (pair.length !== 2 || pair.some((node) => node.text === null)) return;
    const combined = `${pair[0]!.text} ${pair[1]!.text}`;
    const text = utf8Bytes(combined) <= ROOM_HISTORY_LINE_BYTES ? combined : null;
    await tx.execute(sql`INSERT INTO room_history_summary_nodes
      (room_id, level, idx, first_number, last_number, first_at, last_at, text, built_at)
      VALUES (${roomId}, ${level + 1}, ${left >> 1}, ${pair[0]!.first_number}, ${pair[1]!.last_number},
        ${iso(pair[0]!.first_at)}, ${iso(pair[1]!.last_at)}, ${text}, ${text === null ? null : sql`now()`})
      ON CONFLICT DO NOTHING`);
    if (text === null) return;
    level += 1;
    idx = left >> 1;
  }
}

/**
 * Reads new messages into the tree as leaves, oldest first. A message that
 * fits in one line is its own line; a longer one waits for the summarizer.
 * Only the newest ROOM_HISTORY_BACKFILL_MESSAGES are ever read: a room that
 * starts (or turns summaries back on) with more skips the older ones.
 */
export async function ingestRoomHistoryMessages(claim: RoomHistoryClaim): Promise<number> {
  return db.transaction(async (tx) => {
    const state = await holdsClaim(tx, claim);
    if (!state) return 0;
    const [floor] = await rows(tx, sql`SELECT m.number FROM messages m
      WHERE m.room_id = ${claim.roomId} AND ${eligible("m")}
      ORDER BY m.number DESC OFFSET ${ROOM_HISTORY_BACKFILL_MESSAGES - 1} LIMIT 1`);
    const from = Math.max(Number(state.next_number), floor ? Number(floor.number) : 0);
    const batch = await rows(tx, sql`SELECT m.number, m.sender, COALESCE(m.display_text, m.text) AS text,
        m.thread_root_number, m.timestamp
      FROM messages m WHERE m.room_id = ${claim.roomId} AND m.number >= ${from} AND ${eligible("m")}
      ORDER BY m.number LIMIT ${INGEST_BATCH}`);
    let leafCount = Number(state.leaf_count);
    for (const message of batch) {
      const source = roomHistorySourceLine({ sender: String(message.sender), text: String(message.text),
        thread_root_number: message.thread_root_number === null ? null : Number(message.thread_root_number) });
      const text = source && utf8Bytes(source) <= ROOM_HISTORY_LINE_BYTES ? source : null;
      const idx = leafCount;
      leafCount += 1;
      await tx.execute(sql`INSERT INTO room_history_summary_nodes
        (room_id, level, idx, first_number, last_number, first_at, last_at, text, built_at)
        VALUES (${claim.roomId}, 0, ${idx}, ${message.number}, ${message.number}, ${iso(message.timestamp)},
          ${iso(message.timestamp)}, ${text}, ${text === null ? null : sql`now()`})`);
      if (text !== null) await addParents(tx, claim.roomId, 0, idx);
    }
    const next = batch.length ? Number(batch.at(-1)!.number) + 1 : from;
    await tx.execute(sql`UPDATE room_history_summary_state
      SET next_number = ${next}, leaf_count = ${leafCount}, updated_at = now() WHERE room_id = ${claim.roomId}`);
    return batch.length;
  });
}

export type RoomHistoryWork =
  | { kind: "message"; level: 0; idx: number; message: { number: number; sender: string; text: string; timestamp: string; thread_root_number: number | null } | null }
  | { kind: "merge"; level: number; idx: number; firstNumber: number; lastNumber: number; left: string; right: string };

/** Lines waiting for the summarizer, lowest level first, newest first within a level. */
export async function nextRoomHistoryWork(roomId: string, limit: number): Promise<RoomHistoryWork[]> {
  const waiting = await rows(db, sql`SELECT level, idx, first_number, last_number FROM room_history_summary_nodes
    WHERE room_id = ${roomId} AND text IS NULL ORDER BY level, idx DESC LIMIT ${limit}`);
  const work: RoomHistoryWork[] = [];
  for (const node of waiting) {
    const level = Number(node.level);
    const idx = Number(node.idx);
    if (level === 0) {
      const [message] = await rows(db, sql`SELECT number, sender, COALESCE(display_text, text) AS text, timestamp,
        thread_root_number FROM messages WHERE room_id = ${roomId} AND number = ${node.first_number}`);
      work.push({ kind: "message", level: 0, idx, message: message ? {
        number: Number(message.number), sender: String(message.sender), text: String(message.text),
        timestamp: iso(message.timestamp),
        thread_root_number: message.thread_root_number === null ? null : Number(message.thread_root_number),
      } : null });
      continue;
    }
    const children = await rows(db, sql`SELECT text FROM room_history_summary_nodes
      WHERE room_id = ${roomId} AND level = ${level - 1} AND idx IN (${idx * 2}, ${idx * 2 + 1}) ORDER BY idx`);
    if (children.length !== 2 || children.some((child) => child.text === null)) continue;
    work.push({ kind: "merge", level, idx, firstNumber: Number(node.first_number), lastNumber: Number(node.last_number),
      left: String(children[0]!.text), right: String(children[1]!.text) });
  }
  return work;
}

/** Gives a waiting line its text and adds the parents it completes. False when the lease was lost. */
export async function writeRoomHistoryLine(claim: RoomHistoryClaim, level: number, idx: number, text: string): Promise<boolean> {
  const line = clipUtf8(singleLine(text), ROOM_HISTORY_LINE_BYTES) || "(empty)";
  return db.transaction(async (tx) => {
    if (!await holdsClaim(tx, claim)) return false;
    const updated = await rows(tx, sql`UPDATE room_history_summary_nodes SET text = ${line}, built_at = now()
      WHERE room_id = ${claim.roomId} AND level = ${level} AND idx = ${idx} AND text IS NULL RETURNING idx`);
    if (updated.length) await addParents(tx, claim.roomId, level, idx);
    return true;
  });
}

/** Whether the room has messages to read in or lines waiting for the summarizer. */
export async function roomHistoryHasWork(roomId: string): Promise<boolean> {
  const [row] = await rows(db, sql`SELECT
      EXISTS (SELECT 1 FROM room_history_summary_nodes n WHERE n.room_id = ${roomId} AND n.text IS NULL)
      OR EXISTS (SELECT 1 FROM messages m, room_history_summary_state s
        WHERE s.room_id = ${roomId} AND m.room_id = s.room_id AND m.number >= s.next_number AND ${eligible("m")})
      AS has_work`);
  return row?.has_work === true;
}

/**
 * Ends a worker turn. After a failure the room waits, longer each time (30 s
 * doubling to 30 min; a refused key waits 30 min at once), and the wait and
 * its reason are shown in the room's setting.
 */
export async function releaseRoomHistoryRoom(
  claim: RoomHistoryClaim,
  outcome: { kind: "more" | "idle" } | { kind: "failed"; error: string; auth: boolean },
): Promise<void> {
  if (outcome.kind === "failed") {
    await db.execute(sql`UPDATE room_history_summary_state
      SET claim_token = NULL, failures = failures + 1, last_error = ${outcome.error.slice(0, 300)}, updated_at = now(),
          available_at = now() + ${outcome.auth ? sql`interval '30 minutes'`
            : sql`LEAST(interval '30 minutes', interval '30 seconds' * power(2, LEAST(failures, 6)))`}
      WHERE room_id = ${claim.roomId} AND claim_token = ${claim.token}`);
    return;
  }
  await db.execute(sql`UPDATE room_history_summary_state
    SET claim_token = NULL, failures = 0, last_error = NULL, updated_at = now(),
        available_at = ${outcome.kind === "more" ? sql`now()` : sql`now() + ${IDLE_RECHECK}`}
    WHERE room_id = ${claim.roomId} AND claim_token = ${claim.token}`);
}

export interface RoomHistoryStatus {
  state: Exclude<RoomHistorySummaryState, "off" | "unavailable">;
  summarized_messages: number;
  pending_lines: number;
  retry_at: string | null;
  last_error: string | null;
}

/** Where a started room stands; a room never started reads as building (it starts on this read). */
export async function readRoomHistoryStatus(roomId: string): Promise<RoomHistoryStatus> {
  const [row] = await rows(db, sql`SELECT s.leaf_count, s.failures, s.available_at, s.last_error,
      (SELECT count(*) FROM room_history_summary_nodes n WHERE n.room_id = s.room_id AND n.text IS NULL) AS pending
    FROM room_history_summary_state s WHERE s.room_id = ${roomId}`);
  if (!row) return { state: "building", summarized_messages: 0, pending_lines: 0, retry_at: null, last_error: null };
  const failures = Number(row.failures);
  const pending = Number(row.pending);
  const waiting = failures > 0;
  return {
    state: waiting ? "waiting" : pending > 0 || await roomHistoryHasWork(roomId) ? "building" : "ready",
    summarized_messages: Number(row.leaf_count),
    pending_lines: pending,
    retry_at: waiting ? iso(row.available_at) : null,
    last_error: waiting && row.last_error !== null ? String(row.last_error) : null,
  };
}

function lineFromNode(node: Row, pendingText?: string): RoomHistoryLine {
  const level = Number(node.level);
  return {
    node: formatRoomHistoryNodeId(level, Number(node.idx)),
    level,
    first_message_id: formatMessageId(Number(node.first_number)),
    last_message_id: formatMessageId(Number(node.last_number)),
    first_at: iso(node.first_at),
    last_at: iso(node.last_at),
    messages: 2 ** level,
    text: node.text === null ? pendingText ?? "" : String(node.text),
    pending: node.text === null,
  };
}

/** A message not summarized yet, as a line: its source, clipped. */
async function pendingLeafTexts(roomId: string, numbers: number[]): Promise<Map<number, string>> {
  if (!numbers.length) return new Map();
  const found = await rows(db, sql`SELECT number, sender, COALESCE(display_text, text) AS text, thread_root_number
    FROM messages WHERE room_id = ${roomId} AND number IN (${sql.join(numbers.map((number) => sql`${number}`), sql`, `)})`);
  return new Map(found.map((message) => [Number(message.number), clipUtf8(roomHistorySourceLine({
    sender: String(message.sender), text: String(message.text),
    thread_root_number: message.thread_root_number === null ? null : Number(message.thread_root_number),
  }), ROOM_HISTORY_LINE_BYTES)]));
}

export async function readRoomHistoryView(roomId: string, maxLines: number): Promise<{
  lines: RoomHistoryLine[]; omitted_older_lines: number; covered_through_message_id: string | null;
}> {
  const [state] = await rows(db, sql`SELECT leaf_count FROM room_history_summary_state WHERE room_id = ${roomId}`);
  const leafCount = state ? Number(state.leaf_count) : 0;
  if (!leafCount) return { lines: [], omitted_older_lines: 0, covered_through_message_id: null };
  const unbuilt = (await rows(db, sql`SELECT level, idx FROM room_history_summary_nodes
    WHERE room_id = ${roomId} AND text IS NULL`)).map((node) => ({ level: Number(node.level), idx: Number(node.idx) }));
  const plan = planRoomHistoryView(leafCount, unbuilt, maxLines);
  const nodes = await readNodes(roomId, plan.parts);
  const pending = await pendingLeafTexts(roomId, nodes.filter((node) => node.text === null).map((node) => Number(node.first_number)));
  const lines = nodes.map((node) => lineFromNode(node, pending.get(Number(node.first_number)) ?? "(message unavailable)"));
  return { lines, omitted_older_lines: plan.omittedOlderLines,
    covered_through_message_id: lines.at(-1)?.last_message_id ?? null };
}

async function readNodes(roomId: string, parts: readonly RoomHistoryPart[]): Promise<Row[]> {
  if (!parts.length) return [];
  const keys = sql.join(parts.map((part) => sql`(${part.level}, ${part.idx})`), sql`, `);
  const found = await rows(db, sql`SELECT * FROM room_history_summary_nodes
    WHERE room_id = ${roomId} AND (level, idx) IN (${keys})`);
  const byKey = new Map(found.map((node) => [`${node.level}:${node.idx}`, node]));
  return parts.map((part) => byKey.get(`${part.level}:${part.idx}`)).filter((node): node is Row => Boolean(node));
}

/** The two lines a node was made from, or, for a single message, the message. Null for no such node. */
export async function readRoomHistoryExpansion(roomId: string, level: number, idx: number): Promise<{
  lines: RoomHistoryLine[];
  message: { id: string; sender: string; text: string; timestamp: string; thread_root_id: string | null } | null;
} | null> {
  const [node] = await readNodes(roomId, [{ level, idx }]);
  if (!node) return null;
  if (level === 0) {
    const [message] = await rows(db, sql`SELECT number, sender, COALESCE(display_text, text) AS text, timestamp, thread_root_number
      FROM messages WHERE room_id = ${roomId} AND number = ${node.first_number}`);
    return { lines: [], message: message ? {
      id: formatMessageId(Number(message.number)), sender: String(message.sender),
      text: clipUtf8(String(message.text), 64_000), timestamp: iso(message.timestamp),
      thread_root_id: message.thread_root_number === null ? null : formatMessageId(Number(message.thread_root_number)),
    } : null };
  }
  const children = await readNodes(roomId, [{ level: level - 1, idx: idx * 2 }, { level: level - 1, idx: idx * 2 + 1 }]);
  const pending = await pendingLeafTexts(roomId, children.filter((child) => child.text === null && Number(child.level) === 0)
    .map((child) => Number(child.first_number)));
  return { lines: children.map((child) => lineFromNode(child, pending.get(Number(child.first_number)) ?? "(not summarized yet)")), message: null };
}
