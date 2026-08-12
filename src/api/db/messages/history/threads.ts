import { and, desc, eq, sql } from "drizzle-orm";

import { RequestValidationError } from "../../../validation-error.js";
import { db } from "../../client.js";
import { message_thread_reads, message_thread_summaries, messages } from "../../schema.js";
import type { Message, MessageRow, MessageThreadSummary } from "../../types.js";
import { clampLimit, parseScopedId } from "../../utils.js";
import { messageRowSelection } from "../selections.js";
import { visibleMessageCondition } from "../visibility.js";
import { hydrateMessageReplies } from "./message-history.js";
import {
  type MaterializedThreadKeySelection,
  buildEmptyThreadSummary,
  buildThreadSummariesForRoots,
  getUnreadThreadStats,
  getVisibleMessageRow,
  loadMessageRowsByNumber,
  loadThreadParticipants,
  loadUnreadThreadPageKeys,
  materializedThreadKeySelection,
  materializedThreadReadJoin,
  toMaterializedThreadSummary,
  toMaterializedThreadSummaryRow,
} from "./thread-summaries.js";

export interface MessageThreadPage {
  root: Message;
  replies: Message[];
  summary: MessageThreadSummary;
  has_older: boolean;
}

export type MessageThreadInboxFilter = "all" | "unread";

export interface MessageThreadInboxItem {
  root: Message;
  summary: MessageThreadSummary;
}

export interface MessageThreadInboxPage {
  threads: MessageThreadInboxItem[];
  has_more: boolean;
  unread_thread_count: number;
}

export async function getMessageThread(
  roomId: string,
  rootMessageId: string,
  options?: {
    limit?: number;
    before?: string;
    include_prompt_only?: boolean;
    account_id?: string | null;
    account_agent_routing?: boolean;
  },
): Promise<MessageThreadPage | null> {
  const requestedRootNumber = parseScopedId(rootMessageId, "msg");
  if (!requestedRootNumber) {
    throw new RequestValidationError("thread root must be a valid message id");
  }

  const visibilityCondition = visibleMessageCondition(options?.include_prompt_only);
  const [requestedRoot] = await db
    .select(messageRowSelection)
    .from(messages)
    .where(and(eq(messages.room_id, roomId), eq(messages.number, requestedRootNumber), visibilityCondition))
    .limit(1);
  if (!requestedRoot) return null;

  const rootNumber = requestedRoot.thread_root_number ?? requestedRoot.number;
  const rootRow = requestedRoot.number === rootNumber
    ? requestedRoot
    : await getVisibleMessageRow(roomId, rootNumber, Boolean(options?.include_prompt_only));
  if (!rootRow) return null;

  const beforeNumber = options?.before ? parseScopedId(options.before, "msg") : null;
  if (options?.before && !beforeNumber) {
    throw new RequestValidationError("before must be a valid message id");
  }

  const limit = clampLimit(options?.limit);
  const replyRows = await db
    .select(messageRowSelection)
    .from(messages)
    .where(
      beforeNumber
        ? and(
          eq(messages.room_id, roomId),
          eq(messages.thread_root_number, rootNumber),
          sql`${messages.number} < ${beforeNumber}`,
          visibilityCondition,
        )
        : and(
          eq(messages.room_id, roomId),
          eq(messages.thread_root_number, rootNumber),
          visibilityCondition,
        ),
    )
    .orderBy(desc(messages.number))
    .limit(limit + 1);

  const hasOlder = replyRows.length > limit;
  const boundedReplies = (hasOlder ? replyRows.slice(0, limit) : replyRows).reverse();
  const summaries = await buildThreadSummariesForRoots(roomId, [rootNumber], options?.account_id ?? null);
  const summary = summaries.get(rootNumber)
    ?? await buildEmptyThreadSummary(roomId, rootRow, options?.account_id ?? null);
  summaries.set(rootNumber, summary);
  const hydrationOptions = {
    accountId: options?.account_id,
    accountAgentRouting: options?.account_agent_routing,
    threadSummaries: summaries,
  };
  const [root, ...replies] = await hydrateMessageReplies(
    roomId,
    [rootRow, ...boundedReplies],
    hydrationOptions,
  );
  if (!root) return null;

  return {
    root,
    replies,
    summary,
    has_older: hasOlder,
  };
}

export async function getMessageThreads(
  roomId: string,
  options?: {
    filter?: MessageThreadInboxFilter;
    limit?: number;
    before?: string;
    account_id?: string | null;
    account_agent_routing?: boolean;
  },
): Promise<MessageThreadInboxPage> {
  const filter = options?.filter ?? "all";
  const beforeNumber = options?.before ? parseScopedId(options.before, "msg") : null;
  if (options?.before && !beforeNumber) {
    throw new RequestValidationError("before must be a valid message id");
  }

  const limit = clampLimit(options?.limit);
  const accountId = options?.account_id ?? null;
  const readJoin = materializedThreadReadJoin(accountId);

  // Page only fixed-width projection/read keys before touching message rows.
  // Deep keyset pages therefore hydrate at most limit+1 roots and latest
  // replies instead of joining every preceding message before LIMIT.
  const pageQuery = db
    .select(materializedThreadKeySelection)
    .from(message_thread_summaries)
    .leftJoin(message_thread_reads, readJoin)
    .where(and(
      eq(message_thread_summaries.room_id, roomId),
      beforeNumber
        ? sql`${message_thread_summaries.latest_reply_number} < ${beforeNumber}`
        : sql`TRUE`,
    ))
    .orderBy(desc(message_thread_summaries.latest_reply_number))
    .limit(limit + 1);

  let candidateRows: MaterializedThreadKeySelection[];
  let unread_thread_count: number;
  if (filter === "unread") {
    const unreadStats = await getUnreadThreadStats(roomId, accountId);
    unread_thread_count = unreadStats.unread;
    if (unread_thread_count === 0) {
      return { threads: [], has_more: false, unread_thread_count };
    }
    candidateRows = await loadUnreadThreadPageKeys(
      roomId,
      accountId!,
      limit + 1,
      beforeNumber,
      unreadStats.readCount < unreadStats.total,
    );
  } else {
    const [rows, unreadStats] = await Promise.all([
      pageQuery,
      getUnreadThreadStats(roomId, accountId),
    ]);
    candidateRows = rows;
    unread_thread_count = unreadStats.unread;
  }
  const has_more = candidateRows.length > limit;
  const bounded = has_more ? candidateRows.slice(0, limit) : candidateRows;
  if (bounded.length === 0) {
    return { threads: [], has_more, unread_thread_count };
  }

  const rootNumbers = bounded.map((row) => row.summary_thread_root_number);
  const messageRows = await loadMessageRowsByNumber(
    roomId,
    bounded.flatMap((row) => [row.summary_thread_root_number, row.summary_latest_reply_number]),
  );
  const participants = await loadThreadParticipants(roomId, rootNumbers);
  const summaries = new Map<number, MessageThreadSummary>();
  for (const row of bounded) {
    const latest = messageRows.get(row.summary_latest_reply_number);
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
  const rootRows = bounded
    .map((row) => messageRows.get(row.summary_thread_root_number))
    .filter((row): row is MessageRow => Boolean(row));
  const hydratedRoots = await hydrateMessageReplies(roomId, rootRows, {
    accountId,
    accountAgentRouting: options?.account_agent_routing,
    threadSummaries: summaries,
  });

  return {
    threads: hydratedRoots
      .map((root) => {
        const rootNumber = parseScopedId(root.id, "msg") ?? 0;
        const summary = summaries.get(rootNumber) ?? root.thread;
        return summary ? { root, summary } : null;
      })
      .filter((item): item is MessageThreadInboxItem => Boolean(item)),
    has_more,
    unread_thread_count,
  };
}

export async function markMessageThreadRead(
  roomId: string,
  rootMessageId: string,
  accountId: string,
  options?: { message_id?: string | null },
): Promise<MessageThreadSummary | null> {
  const requestedRootNumber = parseScopedId(rootMessageId, "msg");
  if (!requestedRootNumber) {
    throw new RequestValidationError("thread root must be a valid message id");
  }

  const requestedRoot = await getVisibleMessageRow(roomId, requestedRootNumber, false);
  if (!requestedRoot) return null;

  const rootNumber = requestedRoot.thread_root_number ?? requestedRoot.number;
  const rootRow = requestedRoot.number === rootNumber
    ? requestedRoot
    : await getVisibleMessageRow(roomId, rootNumber, false);
  if (!rootRow) return null;

  let lastReadNumber: number;
  if (options?.message_id) {
    const requestedReadNumber = parseScopedId(options.message_id, "msg");
    if (!requestedReadNumber) {
      throw new RequestValidationError("message_id must be a valid message id");
    }
    lastReadNumber = requestedReadNumber;
    const target = await getVisibleMessageRow(roomId, lastReadNumber, false);
    if (!target || (target.number !== rootNumber && target.thread_root_number !== rootNumber)) {
      throw new RequestValidationError("message_id must belong to the requested thread");
    }
  } else {
    const materialized = (await buildThreadSummariesForRoots(roomId, [rootNumber], accountId)).get(rootNumber) ?? null;
    lastReadNumber = materialized?.latest_reply
      ? parseScopedId(materialized.latest_reply.id, "msg") ?? rootRow.number
      : rootRow.number;
  }

  const now = new Date().toISOString();
  await db
    .insert(message_thread_reads)
    .values({
      room_id: roomId,
      thread_root_number: rootNumber,
      account_id: accountId,
      last_read_message_number: lastReadNumber,
      read_at: now,
    })
    .onConflictDoUpdate({
      target: [
        message_thread_reads.room_id,
        message_thread_reads.thread_root_number,
        message_thread_reads.account_id,
      ],
      set: {
        last_read_message_number: sql`GREATEST(${message_thread_reads.last_read_message_number}, ${lastReadNumber})`,
        read_at: now,
      },
    });

  return (await buildThreadSummariesForRoots(roomId, [rootNumber], accountId)).get(rootNumber)
    ?? buildEmptyThreadSummary(roomId, rootRow, accountId);
}
