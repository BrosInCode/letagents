import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "../../client.js";
import {
  message_account_thread_read_stats,
  message_room_thread_stats,
  message_thread_participants,
  message_thread_reads,
  message_thread_summaries,
  messages,
} from "../../schema.js";
import type {
  MessageRow,
  MessageThreadParticipant,
  MessageThreadSummary,
} from "../../types.js";
import { formatMessageId } from "../../utils.js";
import { messageRowSelection } from "../selections.js";
import { visibleMessageCondition } from "../visibility.js";

export const materializedThreadKeySelection = {
  summary_thread_root_number: message_thread_summaries.thread_root_number,
  summary_reply_count: message_thread_summaries.reply_count,
  summary_latest_reply_number: message_thread_summaries.latest_reply_number,
  summary_participant_count: message_thread_summaries.participant_count,
  last_read_message_number: message_thread_reads.last_read_message_number,
  last_read_reply_count: message_thread_reads.last_read_reply_count,
};

export interface MaterializedThreadKeySelection {
  summary_thread_root_number: number;
  summary_reply_count: number;
  summary_latest_reply_number: number;
  summary_participant_count: number;
  last_read_message_number: number | null;
  last_read_reply_count: number | null;
}

export interface MaterializedThreadSummarySelection extends MaterializedThreadKeySelection {
  latest_reply_sender: string;
  latest_reply_text: string;
  latest_reply_source: string | null;
  latest_reply_timestamp: string;
}

export async function getVisibleMessageRow(
  roomId: string,
  messageNumber: number,
  includePromptOnly: boolean,
): Promise<MessageRow | null> {
  const [row] = await db
    .select(messageRowSelection)
    .from(messages)
    .where(and(eq(messages.room_id, roomId), eq(messages.number, messageNumber), visibleMessageCondition(includePromptOnly)))
    .limit(1);
  return row ?? null;
}

export async function buildThreadSummariesForRoots(
  roomId: string,
  rootNumbers: number[],
  accountId: string | null,
): Promise<Map<number, MessageThreadSummary>> {
  const uniqueRootNumbers = Array.from(new Set(rootNumbers));
  if (uniqueRootNumbers.length === 0) {
    return new Map();
  }

  const readJoin = materializedThreadReadJoin(accountId);
  const rows = await db
    .select(materializedThreadKeySelection)
    .from(message_thread_summaries)
    .leftJoin(message_thread_reads, readJoin)
    .where(and(
      eq(message_thread_summaries.room_id, roomId),
      inArray(message_thread_summaries.thread_root_number, uniqueRootNumbers),
    ));
  const [participants, latestMessages] = await Promise.all([
    loadThreadParticipants(roomId, rows.map((row) => row.summary_thread_root_number)),
    loadMessageRowsByNumber(roomId, rows.map((row) => row.summary_latest_reply_number)),
  ]);
  const summaries = new Map<number, MessageThreadSummary>();
  for (const row of rows) {
    const latest = latestMessages.get(row.summary_latest_reply_number);
    if (!latest) continue;
    summaries.set(
      row.summary_thread_root_number,
      toMaterializedThreadSummary(
        toMaterializedThreadSummaryRow(row, latest),
        participants.get(row.summary_thread_root_number) ?? [],
        accountId,
      ),
    );
  }

  return summaries;
}

export function materializedThreadReadJoin(accountId: string | null) {
  return accountId
    ? and(
      eq(message_thread_reads.room_id, message_thread_summaries.room_id),
      eq(message_thread_reads.thread_root_number, message_thread_summaries.thread_root_number),
      eq(message_thread_reads.account_id, accountId),
    )
    : sql`FALSE`;
}

export function toMaterializedThreadSummaryRow(
  key: MaterializedThreadKeySelection,
  latest: MessageRow,
): MaterializedThreadSummarySelection {
  return {
    ...key,
    latest_reply_sender: latest.sender,
    latest_reply_text: latest.text,
    latest_reply_source: latest.source,
    latest_reply_timestamp: latest.timestamp,
  };
}

export async function loadMessageRowsByNumber(
  roomId: string,
  messageNumbers: number[],
): Promise<Map<number, MessageRow>> {
  const uniqueNumbers = Array.from(new Set(messageNumbers));
  if (uniqueNumbers.length === 0) return new Map();
  const rows = await db
    .select(messageRowSelection)
    .from(messages)
    .where(and(eq(messages.room_id, roomId), inArray(messages.number, uniqueNumbers)));
  return new Map(rows.map((row) => [row.number, row]));
}

export function toMaterializedThreadSummary(
  row: MaterializedThreadSummarySelection,
  participants: MessageThreadParticipant[],
  accountId: string | null,
): MessageThreadSummary {
  const replyCount = Number(row.summary_reply_count) || 0;
  const readReplyCount = accountId ? Number(row.last_read_reply_count) || 0 : replyCount;
  const unreadCount = Math.max(0, replyCount - readReplyCount);
  return {
    root_message_id: formatMessageId(row.summary_thread_root_number),
    reply_count: replyCount,
    unread_count: unreadCount,
    has_unread: unreadCount > 0,
    latest_reply: {
      id: formatMessageId(row.summary_latest_reply_number),
      sender: row.latest_reply_sender,
      text: row.latest_reply_text,
      source: row.latest_reply_source,
      timestamp: row.latest_reply_timestamp,
      agent_identity: null,
    },
    participants,
    participant_count: Number(row.summary_participant_count) || participants.length,
    participants_truncated: participants.length < (Number(row.summary_participant_count) || 0),
    last_read_message_id: row.last_read_message_number
      ? formatMessageId(row.last_read_message_number)
      : null,
  };
}

export async function loadThreadParticipants(
  roomId: string,
  rootNumbers: number[],
): Promise<Map<number, MessageThreadParticipant[]>> {
  const uniqueRootNumbers = Array.from(new Set(rootNumbers));
  if (uniqueRootNumbers.length === 0) return new Map();

  const rows = await db.execute<{
    thread_root_number: number;
    sender: string;
    source: string | null;
    message_count: number;
    latest_message_number: number;
  }>(sql`
    SELECT roots.thread_root_number, participant.sender, participant.source,
           participant.message_count, participant.latest_message_number
      FROM (
        SELECT value::integer AS thread_root_number
          FROM jsonb_array_elements_text(${JSON.stringify(uniqueRootNumbers)}::jsonb)
      ) AS roots
      CROSS JOIN LATERAL (
        SELECT candidate.sender, candidate.source, candidate.message_count,
               candidate.latest_message_number
          FROM ${message_thread_participants} AS candidate
         WHERE candidate.room_id = ${roomId}
           AND candidate.thread_root_number = roots.thread_root_number
           AND candidate.message_count > 0
         ORDER BY candidate.latest_message_number DESC
         LIMIT 50
      ) AS participant
     ORDER BY roots.thread_root_number, participant.latest_message_number DESC
  `);

  const participants = new Map<number, MessageThreadParticipant[]>();
  for (const row of rows.rows) {
    if (row.latest_message_number === null) continue;
    const list = participants.get(row.thread_root_number) ?? [];
    list.push({
      sender: row.sender,
      source: row.source,
      message_count: row.message_count,
      latest_message_id: formatMessageId(row.latest_message_number),
    });
    participants.set(row.thread_root_number, list);
  }
  return participants;
}

export async function buildEmptyThreadSummary(
  roomId: string,
  root: MessageRow,
  accountId: string | null,
): Promise<MessageThreadSummary> {
  const reads = await loadThreadReadCursors(roomId, [root.number], accountId);
  return toEmptyThreadSummary(root, reads.get(root.number) ?? null);
}

export async function buildEmptyThreadSummariesForRoots(
  roomId: string,
  rootNumbers: number[],
  accountId: string | null,
): Promise<Map<number, MessageThreadSummary>> {
  const uniqueRootNumbers = Array.from(new Set(rootNumbers));
  if (uniqueRootNumbers.length === 0) return new Map();
  const roots = await db
    .select(messageRowSelection)
    .from(messages)
    .where(and(
      eq(messages.room_id, roomId),
      inArray(messages.number, uniqueRootNumbers),
      visibleMessageCondition(false),
    ));
  const reads = await loadThreadReadCursors(roomId, roots.map((root) => root.number), accountId);
  return new Map(roots.map((root) => [
    root.number,
    toEmptyThreadSummary(root, reads.get(root.number) ?? null),
  ]));
}

async function loadThreadReadCursors(
  roomId: string,
  rootNumbers: number[],
  accountId: string | null,
): Promise<Map<number, number>> {
  if (!accountId || rootNumbers.length === 0) return new Map();
  const reads = await db
    .select({
      thread_root_number: message_thread_reads.thread_root_number,
      last_read_message_number: message_thread_reads.last_read_message_number,
    })
    .from(message_thread_reads)
    .where(and(
      eq(message_thread_reads.room_id, roomId),
      inArray(message_thread_reads.thread_root_number, Array.from(new Set(rootNumbers))),
      eq(message_thread_reads.account_id, accountId),
    ));
  return new Map(reads.map((read) => [read.thread_root_number, read.last_read_message_number]));
}

function toEmptyThreadSummary(
  root: MessageRow,
  lastReadMessageNumber: number | null,
): MessageThreadSummary {
  return {
    root_message_id: formatMessageId(root.number),
    reply_count: 0,
    unread_count: 0,
    has_unread: false,
    latest_reply: null,
    participants: [{
      sender: root.sender,
      source: root.source,
      message_count: 1,
      latest_message_id: formatMessageId(root.number),
    }],
    participant_count: 1,
    participants_truncated: false,
    last_read_message_id: lastReadMessageNumber
      ? formatMessageId(lastReadMessageNumber)
      : null,
  };
}

export interface UnreadThreadStats {
  total: number;
  readCount: number;
  unread: number;
}

export async function getUnreadThreadStats(roomId: string, accountId: string | null): Promise<UnreadThreadStats> {
  if (!accountId) return { total: 0, readCount: 0, unread: 0 };
  const cached = await db.execute<{
    total: number;
    room_reply_version: number;
    current_read_version: number;
    cached_read_version: number;
    cached_room_reply_version: number;
    read_count: number;
    fully_read: number;
    account_stats_exists: boolean;
  }>(sql`
    SELECT stats.thread_count::integer AS total,
           stats.reply_version::integer AS room_reply_version,
           COALESCE(account_stats.current_read_version, 0)::integer AS current_read_version,
           COALESCE(account_stats.cached_read_version, -1)::integer AS cached_read_version,
           COALESCE(account_stats.cached_room_reply_version, -1)::integer
             AS cached_room_reply_version,
           COALESCE(account_stats.read_thread_count, 0)::integer AS read_count,
           COALESCE(account_stats.fully_read_thread_count, 0)::integer AS fully_read
           ,(account_stats.account_id IS NOT NULL) AS account_stats_exists
      FROM ${message_room_thread_stats} AS stats
      LEFT JOIN ${message_account_thread_read_stats} AS account_stats
        ON account_stats.room_id = stats.room_id
       AND account_stats.account_id = ${accountId}
     WHERE stats.room_id = ${roomId}
     LIMIT 1
  `);
  const row = cached.rows[0];
  const total = Number(row?.total) || 0;
  if (!row) return { total: 0, readCount: 0, unread: 0 };
  if (!row.account_stats_exists) {
    return { total, readCount: 0, unread: total };
  }
  if (
    Number(row.cached_read_version) === Number(row.current_read_version)
    && Number(row.cached_room_reply_version) === Number(row.room_reply_version)
  ) {
    const readCount = Number(row.read_count) || 0;
    return {
      total,
      readCount,
      unread: Math.max(0, total - (Number(row.fully_read) || 0)),
    };
  }

  const refreshed = await db.execute<{ read_count: number; fully_read: number }>(sql`
    SELECT COUNT(*)::integer AS read_count,
           COUNT(*) FILTER (
             WHERE thread_read.last_read_reply_count >= summary.reply_count
           )::integer AS fully_read
      FROM ${message_thread_reads} AS thread_read
      JOIN ${message_thread_summaries} AS summary
        ON summary.room_id = thread_read.room_id
       AND summary.thread_root_number = thread_read.thread_root_number
     WHERE thread_read.room_id = ${roomId}
       AND thread_read.account_id = ${accountId}
  `);
  const readCount = Number(refreshed.rows[0]?.read_count) || 0;
  const fullyRead = Number(refreshed.rows[0]?.fully_read) || 0;
  await db.execute(sql`
    INSERT INTO ${message_account_thread_read_stats} (
      room_id, account_id, current_read_version, cached_read_version,
      cached_room_reply_version, read_thread_count, fully_read_thread_count
    ) VALUES (
      ${roomId}, ${accountId}, ${Number(row.current_read_version)},
      ${Number(row.current_read_version)}, ${Number(row.room_reply_version)},
      ${readCount}, ${fullyRead}
    )
    ON CONFLICT (room_id, account_id) DO UPDATE SET
      cached_read_version = EXCLUDED.cached_read_version,
      cached_room_reply_version = EXCLUDED.cached_room_reply_version,
      read_thread_count = EXCLUDED.read_thread_count,
      fully_read_thread_count = EXCLUDED.fully_read_thread_count
    WHERE ${message_account_thread_read_stats.current_read_version}
      = EXCLUDED.current_read_version
  `);
  return {
    total,
    readCount,
    unread: Math.max(0, total - fullyRead),
  };
}

export async function loadUnreadThreadPageKeys(
  roomId: string,
  accountId: string,
  limit: number,
  beforeNumber: number | null,
  hasNeverReadThreads: boolean,
): Promise<MaterializedThreadKeySelection[]> {
  const staleReadQuery = db
    .select(materializedThreadKeySelection)
    .from(message_thread_reads)
    .innerJoin(
      message_thread_summaries,
      and(
        eq(message_thread_summaries.room_id, message_thread_reads.room_id),
        eq(message_thread_summaries.thread_root_number, message_thread_reads.thread_root_number),
      ),
    )
    .where(and(
      eq(message_thread_reads.room_id, roomId),
      eq(message_thread_reads.account_id, accountId),
      sql`${message_thread_reads.last_read_reply_count} < ${message_thread_summaries.reply_count}`,
      beforeNumber
        ? sql`${message_thread_summaries.latest_reply_number} < ${beforeNumber}`
        : sql`TRUE`,
    ))
    .orderBy(desc(message_thread_summaries.latest_reply_number))
    .limit(limit);

  const neverReadQuery = hasNeverReadThreads
    ? db
      .select(materializedThreadKeySelection)
      .from(message_thread_summaries)
      .leftJoin(message_thread_reads, materializedThreadReadJoin(accountId))
      .where(and(
        eq(message_thread_summaries.room_id, roomId),
        sql`${message_thread_reads.thread_root_number} IS NULL`,
        beforeNumber
          ? sql`${message_thread_summaries.latest_reply_number} < ${beforeNumber}`
          : sql`TRUE`,
      ))
      .orderBy(desc(message_thread_summaries.latest_reply_number))
      .limit(limit)
    : Promise.resolve([] as MaterializedThreadKeySelection[]);

  const [staleRead, neverRead] = await Promise.all([staleReadQuery, neverReadQuery]);
  const byRoot = new Map<number, MaterializedThreadKeySelection>();
  for (const row of [...staleRead, ...neverRead]) {
    byRoot.set(row.summary_thread_root_number, row);
  }
  return Array.from(byRoot.values())
    .sort((left, right) => right.summary_latest_reply_number - left.summary_latest_reply_number)
    .slice(0, limit);
}
