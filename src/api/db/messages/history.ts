import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { RequestValidationError } from "../../validation-error.js";
import { db } from "../client.js";
import {
  message_agent_receipts,
  message_account_thread_read_stats,
  message_attachments,
  message_room_thread_stats,
  message_thread_participants,
  message_thread_reads,
  message_thread_summaries,
  messages,
  room_agent_sessions,
} from "../schema.js";
import {
  toMessageAttachment,
  toMessageReplyReference,
  toMessageWithReply,
} from "../mappers.js";
import type {
  Message,
  MessageAttachment,
  MessageReplyReference,
  MessageRow,
  MessageThreadParticipant,
  MessageThreadSummary,
  MessageRecipientAgentTarget,
  RoomActivityActorCount,
} from "../types.js";
import { clampLimit, formatMessageId, parseScopedId } from "../utils.js";
import {
  messageAttachmentSelection,
  messageReplySelection,
  messageRowSelection,
} from "./selections.js";
import { visibleMessageCondition } from "./visibility.js";
import {
  getMessageAccountAgentRouting,
  MAX_ACCOUNT_ROUTING_TARGET_BYTES,
  MAX_ACCOUNT_ROUTING_TARGETS,
} from "./account-agent-routing.js";

const MAX_BRIDGE_MESSAGE_RECIPIENTS = MAX_ACCOUNT_ROUTING_TARGETS;

interface MessageHydrationOptions {
  accountId?: string | null;
  accountAgentRouting?: boolean;
  threadSummaries?: ReadonlyMap<number, MessageThreadSummary>;
}

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

const materializedThreadKeySelection = {
  summary_thread_root_number: message_thread_summaries.thread_root_number,
  summary_reply_count: message_thread_summaries.reply_count,
  summary_latest_reply_number: message_thread_summaries.latest_reply_number,
  summary_participant_count: message_thread_summaries.participant_count,
  last_read_message_number: message_thread_reads.last_read_message_number,
  last_read_reply_count: message_thread_reads.last_read_reply_count,
};

interface MaterializedThreadKeySelection {
  summary_thread_root_number: number;
  summary_reply_count: number;
  summary_latest_reply_number: number;
  summary_participant_count: number;
  last_read_message_number: number | null;
  last_read_reply_count: number | null;
}

interface MaterializedThreadSummarySelection extends MaterializedThreadKeySelection {
  latest_reply_sender: string;
  latest_reply_text: string;
  latest_reply_source: string | null;
  latest_reply_timestamp: string;
}

type MessageHistoryOptions = {
  limit?: number;
  after?: string;
  include_prompt_only?: boolean;
  account_id?: string | null;
  account_agent_routing?: boolean;
};

export async function getMessages(
  roomId: string,
  options?: MessageHistoryOptions,
): Promise<{ messages: Message[]; has_more: boolean }> {
  const limit = clampLimit(options?.limit);
  const afterNumber = options?.after ? parseScopedId(options.after, "msg") : null;
  const visibilityCondition = visibleMessageCondition(options?.include_prompt_only);

  const rows = await db
    .select(messageRowSelection)
    .from(messages)
    .where(
      afterNumber
        ? and(eq(messages.room_id, roomId), sql`${messages.number} > ${afterNumber}`, visibilityCondition)
        : and(eq(messages.room_id, roomId), visibilityCondition),
    )
    .orderBy(asc(messages.number))
    .limit(limit + 1);

  const has_more = rows.length > limit;
  const bounded = has_more ? rows.slice(0, limit) : rows;
  const hydratedMessages = await hydrateMessageReplies(roomId, bounded, {
    accountId: options?.account_id,
    accountAgentRouting: options?.account_agent_routing,
  });

  return {
    messages: hydratedMessages,
    has_more,
  };
}

export async function getLatestMessages(
  roomId: string,
  options?: Omit<MessageHistoryOptions, "after">,
): Promise<{ messages: Message[]; has_more: boolean }> {
  const limit = clampLimit(options?.limit);
  const visibilityCondition = visibleMessageCondition(options?.include_prompt_only);

  const rows = await db
    .select(messageRowSelection)
    .from(messages)
    .where(and(eq(messages.room_id, roomId), visibilityCondition))
    .orderBy(desc(messages.number))
    .limit(limit + 1);

  const has_more = rows.length > limit;
  const bounded = (has_more ? rows.slice(0, limit) : rows).reverse();
  const hydratedMessages = await hydrateMessageReplies(roomId, bounded, {
    accountId: options?.account_id,
    accountAgentRouting: options?.account_agent_routing,
  });

  return {
    messages: hydratedMessages,
    has_more,
  };
}

export async function getMessagesBefore(
  roomId: string,
  beforeMessageId: string | undefined,
  options?: Omit<MessageHistoryOptions, "after">,
): Promise<{ messages: Message[]; has_more: boolean }> {
  const beforeNumber = beforeMessageId ? parseScopedId(beforeMessageId, "msg") : null;
  if (!beforeNumber) {
    return getLatestMessages(roomId, options);
  }

  const limit = clampLimit(options?.limit);
  const visibilityCondition = visibleMessageCondition(options?.include_prompt_only);

  const rows = await db
    .select(messageRowSelection)
    .from(messages)
    .where(and(eq(messages.room_id, roomId), sql`${messages.number} < ${beforeNumber}`, visibilityCondition))
    .orderBy(desc(messages.number))
    .limit(limit + 1);

  const has_more = rows.length > limit;
  const bounded = (has_more ? rows.slice(0, limit) : rows).reverse();
  const hydratedMessages = await hydrateMessageReplies(roomId, bounded, {
    accountId: options?.account_id,
    accountAgentRouting: options?.account_agent_routing,
  });

  return {
    messages: hydratedMessages,
    has_more,
  };
}

export async function getMessageById(
  roomId: string,
  messageId: string,
  options?: {
    include_prompt_only?: boolean;
    account_id?: string | null;
    account_agent_routing?: boolean;
  },
): Promise<Message | null> {
  const messageNumber = parseScopedId(messageId, "msg");
  if (!messageNumber) {
    return null;
  }
  const visibilityCondition = visibleMessageCondition(options?.include_prompt_only);

  const rows = await db
    .select(messageRowSelection)
    .from(messages)
    .where(and(eq(messages.room_id, roomId), eq(messages.number, messageNumber), visibilityCondition))
    .limit(1);
  if (rows.length === 0) {
    return null;
  }

  const [hydrated] = await hydrateMessageReplies(roomId, rows, {
    accountId: options?.account_id,
    accountAgentRouting: options?.account_agent_routing,
  });
  return hydrated ?? null;
}

/** Exact prompt audience used only for cross-instance reference hydration. */
export async function getMessageRecipientAgentTargets(
  roomId: string,
  messageNumber: number,
): Promise<MessageRecipientAgentTarget[]> {
  const rows = (await db.execute<{
    agent_key: string;
    agent_session_id: string;
    owner_account_id: string;
    successor_agent_session_id: string | null;
  }>(sql`
    WITH owned_receipt AS (
      SELECT receipt.agent_key,
             receipt.agent_session_id,
             captured.owner_account_id,
             captured.ended_at
        FROM ${message_agent_receipts} AS receipt
        JOIN ${room_agent_sessions} AS captured
          ON captured.room_id = receipt.room_id
         AND captured.session_id = receipt.agent_session_id
         AND captured.agent_key = receipt.agent_key
       WHERE receipt.message_room_id = ${roomId}
         AND receipt.message_number = ${messageNumber}
         AND captured.session_kind = 'worker'
    ), unique_live_successor AS (
      SELECT owned_receipt.owner_account_id,
             owned_receipt.agent_key,
             CASE WHEN COUNT(active.session_id) = 1
                    AND MIN(active.owner_account_id) = owned_receipt.owner_account_id
                    AND MAX(active.owner_account_id) = owned_receipt.owner_account_id
                    THEN MIN(active.session_id)
                  ELSE NULL END AS agent_session_id
        FROM owned_receipt
        LEFT JOIN ${room_agent_sessions} AS active
          ON active.room_id = ${roomId}
         AND active.agent_key = owned_receipt.agent_key
         AND active.session_kind = 'worker'
         AND active.ended_at IS NULL
       WHERE owned_receipt.ended_at IS NOT NULL
       GROUP BY owned_receipt.owner_account_id, owned_receipt.agent_key
    )
    SELECT owned_receipt.agent_key,
           owned_receipt.agent_session_id,
           owned_receipt.owner_account_id,
           CASE WHEN owned_receipt.ended_at IS NOT NULL
                  THEN unique_live_successor.agent_session_id
                ELSE NULL END AS successor_agent_session_id
      FROM owned_receipt
      LEFT JOIN unique_live_successor
        ON unique_live_successor.owner_account_id = owned_receipt.owner_account_id
       AND unique_live_successor.agent_key = owned_receipt.agent_key
     LIMIT ${MAX_BRIDGE_MESSAGE_RECIPIENTS + 1}
  `)).rows;
  if (rows.length > MAX_BRIDGE_MESSAGE_RECIPIENTS) {
    throw new Error("message recipient set exceeds the bridge hydration limit");
  }
  let bytes = 0;
  const result: MessageRecipientAgentTarget[] = [];
  for (const row of rows) {
    const target = {
      agent_key: row.agent_key,
      agent_session_id: row.agent_session_id,
      owner_account_id: row.owner_account_id,
      ...(row.successor_agent_session_id
        ? { successor_agent_session_id: row.successor_agent_session_id }
        : {}),
    };
    bytes += Buffer.byteLength(JSON.stringify(target), "utf8");
    if (bytes > MAX_ACCOUNT_ROUTING_TARGET_BYTES) {
      throw new Error("message recipient set exceeds the bridge hydration byte limit");
    }
    result.push(target);
  }
  return result;
}

/** Compatibility helper for diagnostics that need only durable keys. */
export async function getMessageRecipientAgentKeys(
  roomId: string,
  messageNumber: number,
): Promise<string[]> {
  return (await getMessageRecipientAgentTargets(roomId, messageNumber))
    .map((target) => target.agent_key);
}

export async function hydrateMessageReplies(
  roomId: string,
  bounded: MessageRow[],
  options?: MessageHydrationOptions,
): Promise<Message[]> {
  const accountRoutingPromise = options?.accountId && options.accountAgentRouting
    ? getMessageAccountAgentRouting(db, roomId, options.accountId, bounded)
    : Promise.resolve(new Map());
  const replyToNumbers = Array.from(new Set(
    bounded
      .map((row) => row.reply_to_number)
      .filter((value): value is number => value !== null),
  ));

  const replyMap = new Map<number, MessageReplyReference>();
  if (replyToNumbers.length > 0) {
    const replyRows = await db
      .select(messageReplySelection)
      .from(messages)
      .where(and(eq(messages.room_id, roomId), inArray(messages.number, replyToNumbers)));

    for (const replyRow of replyRows) {
      replyMap.set(replyRow.number, toMessageReplyReference(replyRow));
    }
  }

  const messageNumbers = bounded.map((row) => row.number);
  const attachmentMap = new Map<number, MessageAttachment[]>();
  if (messageNumbers.length > 0) {
    const attachmentRows = await db
      .select(messageAttachmentSelection)
      .from(message_attachments)
      .where(
        and(
          eq(message_attachments.room_id, roomId),
          inArray(message_attachments.message_number, messageNumbers),
        ),
      )
      .orderBy(asc(message_attachments.message_number), asc(message_attachments.attachment_number));

    for (const attachmentRow of attachmentRows) {
      const list = attachmentMap.get(attachmentRow.message_number) ?? [];
      list.push(toMessageAttachment(attachmentRow));
      attachmentMap.set(attachmentRow.message_number, list);
    }
  }

  const materializedSummaries = options?.threadSummaries ?? await buildThreadSummariesForRoots(
    roomId,
    Array.from(new Set(bounded.map((row) => row.thread_root_number ?? row.number))),
    options?.accountId ?? null,
  );
  const threadSummaries = new Map(materializedSummaries);
  const missingThreadRootNumbers = Array.from(new Set(
    bounded
      .filter((row) => row.thread_root_number !== null)
      .map((row) => row.thread_root_number!)
      .filter((rootNumber) => !threadSummaries.has(rootNumber)),
  ));
  if (missingThreadRootNumbers.length > 0) {
    const emptySummaries = await buildEmptyThreadSummariesForRoots(
      roomId,
      missingThreadRootNumbers,
      options?.accountId ?? null,
    );
    for (const [rootNumber, summary] of emptySummaries) {
      threadSummaries.set(rootNumber, summary);
    }
  }

  const accountRouting = await accountRoutingPromise;
  return bounded.map((row) => {
    const threadRootNumber = row.thread_root_number ?? row.number;
    const threadSummary = threadSummaries.get(threadRootNumber) ?? null;
    const message = toMessageWithReply(
      row,
      row.reply_to_number ? replyMap.get(row.reply_to_number) ?? null : null,
      attachmentMap.get(row.number) ?? [],
      threadSummary && (threadSummary.reply_count > 0 || row.thread_root_number) ? threadSummary : null,
    );
    return options?.accountId && options.accountAgentRouting
      ? { ...message, account_agent_routing: accountRouting.get(row.number) ?? null }
      : message;
  });
}

export async function getMessagesAfter(
  roomId: string,
  afterMessageId: string | undefined,
  options?: Omit<MessageHistoryOptions, "after">,
): Promise<{ messages: Message[]; has_more: boolean }> {
  return getMessages(roomId, { ...options, after: afterMessageId });
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

async function getVisibleMessageRow(
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

async function buildThreadSummariesForRoots(
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

function materializedThreadReadJoin(accountId: string | null) {
  return accountId
    ? and(
      eq(message_thread_reads.room_id, message_thread_summaries.room_id),
      eq(message_thread_reads.thread_root_number, message_thread_summaries.thread_root_number),
      eq(message_thread_reads.account_id, accountId),
    )
    : sql`FALSE`;
}

function toMaterializedThreadSummaryRow(
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

async function loadMessageRowsByNumber(
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

function toMaterializedThreadSummary(
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

async function loadThreadParticipants(
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

async function buildEmptyThreadSummary(
  roomId: string,
  root: MessageRow,
  accountId: string | null,
): Promise<MessageThreadSummary> {
  const reads = await loadThreadReadCursors(roomId, [root.number], accountId);
  return toEmptyThreadSummary(root, reads.get(root.number) ?? null);
}

async function buildEmptyThreadSummariesForRoots(
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

interface UnreadThreadStats {
  total: number;
  readCount: number;
  unread: number;
}

async function getUnreadThreadStats(roomId: string, accountId: string | null): Promise<UnreadThreadStats> {
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

async function loadUnreadThreadPageKeys(
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

export async function getRoomMessageCountsBySender(roomId: string): Promise<RoomActivityActorCount[]> {
  const rows = await db
    .select({
      actor_label: messages.sender,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(messages)
    .where(and(
      eq(messages.room_id, roomId),
      visibleMessageCondition(false),
    ))
    .groupBy(messages.sender);

  return rows.map((row) => ({
    actor_label: row.actor_label,
    count: Number(row.count) || 0,
  }));
}

export async function hasMessagesFromSender(roomId: string, sender: string): Promise<boolean> {
  const [row] = await db
    .select({
      count: sql<number>`COUNT(*)::int`,
    })
    .from(messages)
    .where(and(eq(messages.room_id, roomId), sql`LOWER(${messages.sender}) = LOWER(${sender})`));

  return (row?.count ?? 0) > 0;
}
