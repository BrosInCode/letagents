import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { RequestValidationError } from "../../validation-error.js";
import { db } from "../client.js";
import { message_attachments, message_thread_reads, messages } from "../schema.js";
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
  RoomActivityActorCount,
} from "../types.js";
import { clampLimit, formatMessageId, parseScopedId } from "../utils.js";
import {
  messageAttachmentSelection,
  messageReplySelection,
  messageRowSelection,
} from "./selections.js";
import { visibleMessageCondition } from "./visibility.js";

interface MessageHydrationOptions {
  accountId?: string | null;
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

export async function getMessages(
  roomId: string,
  options?: { limit?: number; after?: string; include_prompt_only?: boolean; account_id?: string | null },
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
  const hydratedMessages = await hydrateMessageReplies(roomId, bounded, { accountId: options?.account_id });

  return {
    messages: hydratedMessages,
    has_more,
  };
}

export async function getLatestMessages(
  roomId: string,
  options?: { limit?: number; include_prompt_only?: boolean; account_id?: string | null },
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
  const hydratedMessages = await hydrateMessageReplies(roomId, bounded, { accountId: options?.account_id });

  return {
    messages: hydratedMessages,
    has_more,
  };
}

export async function getMessagesBefore(
  roomId: string,
  beforeMessageId: string | undefined,
  options?: { limit?: number; include_prompt_only?: boolean; account_id?: string | null },
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
  const hydratedMessages = await hydrateMessageReplies(roomId, bounded, { accountId: options?.account_id });

  return {
    messages: hydratedMessages,
    has_more,
  };
}

export async function getMessageById(
  roomId: string,
  messageId: string,
  options?: { include_prompt_only?: boolean; account_id?: string | null },
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

  const [hydrated] = await hydrateMessageReplies(roomId, rows, { accountId: options?.account_id });
  return hydrated ?? null;
}

export async function hydrateMessageReplies(
  roomId: string,
  bounded: MessageRow[],
  options?: MessageHydrationOptions,
): Promise<Message[]> {
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

  const threadSummaries = await buildThreadSummariesForRoots(
    roomId,
    Array.from(new Set(bounded.map((row) => row.thread_root_number ?? row.number))),
    options?.accountId ?? null,
  );

  return bounded.map((row) => {
    const threadRootNumber = row.thread_root_number ?? row.number;
    const threadSummary = threadSummaries.get(threadRootNumber) ?? null;
    return toMessageWithReply(
      row,
      row.reply_to_number ? replyMap.get(row.reply_to_number) ?? null : null,
      attachmentMap.get(row.number) ?? [],
      threadSummary && (threadSummary.reply_count > 0 || row.thread_root_number) ? threadSummary : null,
    );
  });
}

export async function getMessagesAfter(
  roomId: string,
  afterMessageId: string | undefined,
  options?: { limit?: number; include_prompt_only?: boolean; account_id?: string | null },
): Promise<{ messages: Message[]; has_more: boolean }> {
  return getMessages(roomId, { ...options, after: afterMessageId });
}

export async function getMessageThread(
  roomId: string,
  rootMessageId: string,
  options?: { limit?: number; before?: string; include_prompt_only?: boolean; account_id?: string | null },
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
  const [root] = await hydrateMessageReplies(roomId, [rootRow], { accountId: options?.account_id });
  const replies = await hydrateMessageReplies(roomId, boundedReplies, { accountId: options?.account_id });
  const summary = (await buildThreadSummariesForRoots(roomId, [rootNumber], options?.account_id ?? null)).get(rootNumber);
  if (!root || !summary) return null;

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
    include_prompt_only?: boolean;
    account_id?: string | null;
  },
): Promise<MessageThreadInboxPage> {
  const filter = options?.filter ?? "all";
  const beforeNumber = options?.before ? parseScopedId(options.before, "msg") : null;
  if (options?.before && !beforeNumber) {
    throw new RequestValidationError("before must be a valid message id");
  }

  const limit = clampLimit(options?.limit);
  const latestReplyExpression = sql<number>`MAX(${messages.number})`;
  const candidateRows = await db
    .select({
      thread_root_number: messages.thread_root_number,
      latest_reply_number: latestReplyExpression,
    })
    .from(messages)
    .where(and(
      eq(messages.room_id, roomId),
      sql`${messages.thread_root_number} IS NOT NULL`,
      visibleMessageCondition(options?.include_prompt_only),
    ))
    .groupBy(messages.thread_root_number)
    .orderBy(desc(latestReplyExpression));

  const allCandidates = candidateRows
    .map((row) => ({
      rootNumber: Number(row.thread_root_number),
      latestReplyNumber: Number(row.latest_reply_number),
    }))
    .filter((row) =>
      Number.isInteger(row.rootNumber)
      && row.rootNumber > 0
      && Number.isInteger(row.latestReplyNumber)
      && row.latestReplyNumber > 0
    );
  const summaries = await buildThreadSummariesForRoots(
    roomId,
    allCandidates.map((row) => row.rootNumber),
    options?.account_id ?? null,
  );
  const inboxItems = allCandidates
    .map((candidate) => {
      const summary = summaries.get(candidate.rootNumber);
      return summary ? { ...candidate, summary } : null;
    })
    .filter((item): item is { rootNumber: number; latestReplyNumber: number; summary: MessageThreadSummary } =>
      Boolean(item?.summary.latest_reply)
    );
  const unread_thread_count = inboxItems.filter((item) => item.summary.unread_count > 0).length;
  const filteredByCursor = beforeNumber
    ? inboxItems.filter((item) => item.latestReplyNumber < beforeNumber)
    : inboxItems;
  const filtered = filter === "unread"
    ? filteredByCursor.filter((item) => item.summary.unread_count > 0)
    : filteredByCursor;
  const has_more = filtered.length > limit;
  const bounded = has_more ? filtered.slice(0, limit) : filtered;
  if (bounded.length === 0) {
    return { threads: [], has_more, unread_thread_count };
  }

  const rootRows = await db
    .select(messageRowSelection)
    .from(messages)
    .where(and(
      eq(messages.room_id, roomId),
      inArray(messages.number, bounded.map((item) => item.rootNumber)),
      visibleMessageCondition(options?.include_prompt_only),
    ));
  const rootRowsByNumber = new Map(rootRows.map((row) => [row.number, row]));
  const orderedRootRows = bounded
    .map((item) => rootRowsByNumber.get(item.rootNumber) ?? null)
    .filter((row): row is MessageRow => Boolean(row));
  const hydratedRoots = await hydrateMessageReplies(roomId, orderedRootRows, { accountId: options?.account_id });

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

  let lastReadNumber: number | null = null;
  if (options?.message_id) {
    lastReadNumber = parseScopedId(options.message_id, "msg");
    if (!lastReadNumber) {
      throw new RequestValidationError("message_id must be a valid message id");
    }
    const target = await getVisibleMessageRow(roomId, lastReadNumber, false);
    if (!target || (target.number !== rootNumber && target.thread_root_number !== rootNumber)) {
      throw new RequestValidationError("message_id must belong to the requested thread");
    }
  } else {
    const [latestReply] = await db
      .select(messageRowSelection)
      .from(messages)
      .where(and(eq(messages.room_id, roomId), eq(messages.thread_root_number, rootNumber), visibleMessageCondition(false)))
      .orderBy(desc(messages.number))
      .limit(1);
    lastReadNumber = latestReply?.number ?? rootRow.number;
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

  return (await buildThreadSummariesForRoots(roomId, [rootNumber], accountId)).get(rootNumber) ?? null;
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

  const rootRows = await db
    .select(messageRowSelection)
    .from(messages)
    .where(and(eq(messages.room_id, roomId), inArray(messages.number, uniqueRootNumbers), visibleMessageCondition(false)));
  const rootsByNumber = new Map(rootRows.map((row) => [row.number, row]));

  const replyRows = await db
    .select(messageRowSelection)
    .from(messages)
    .where(and(eq(messages.room_id, roomId), inArray(messages.thread_root_number, uniqueRootNumbers), visibleMessageCondition(false)))
    .orderBy(asc(messages.thread_root_number), asc(messages.number));

  const repliesByRoot = new Map<number, MessageRow[]>();
  for (const replyRow of replyRows) {
    const rootNumber = replyRow.thread_root_number;
    if (!rootNumber) continue;
    const replies = repliesByRoot.get(rootNumber) ?? [];
    replies.push(replyRow);
    repliesByRoot.set(rootNumber, replies);
  }

  const readMap = new Map<number, number>();
  if (accountId) {
    const readRows = await db
      .select({
        thread_root_number: message_thread_reads.thread_root_number,
        last_read_message_number: message_thread_reads.last_read_message_number,
      })
      .from(message_thread_reads)
      .where(and(
        eq(message_thread_reads.room_id, roomId),
        eq(message_thread_reads.account_id, accountId),
        inArray(message_thread_reads.thread_root_number, uniqueRootNumbers),
      ));
    for (const readRow of readRows) {
      readMap.set(readRow.thread_root_number, readRow.last_read_message_number);
    }
  }

  const summaries = new Map<number, MessageThreadSummary>();
  for (const rootNumber of uniqueRootNumbers) {
    const rootRow = rootsByNumber.get(rootNumber);
    if (!rootRow) continue;
    const replies = repliesByRoot.get(rootNumber) ?? [];
    const latestReply = replies.at(-1) ?? null;
    const lastReadNumber = readMap.get(rootNumber) ?? null;
    const unreadCount = !accountId
      ? 0
      : lastReadNumber === null
        ? replies.length
        : replies.filter((reply) => reply.number > lastReadNumber).length;
    summaries.set(rootNumber, {
      root_message_id: formatMessageId(rootNumber),
      reply_count: replies.length,
      unread_count: unreadCount,
      has_unread: unreadCount > 0,
      latest_reply: latestReply ? toMessageReplyReference(latestReply) : null,
      participants: buildThreadParticipants(rootRow, replies),
      last_read_message_id: lastReadNumber ? formatMessageId(lastReadNumber) : null,
    });
  }

  return summaries;
}

function buildThreadParticipants(root: MessageRow, replies: MessageRow[]): MessageThreadParticipant[] {
  const participants = new Map<string, MessageThreadParticipant & { latestNumber: number }>();
  for (const row of [root, ...replies]) {
    const key = `${row.sender}\0${row.source ?? ""}`;
    const current = participants.get(key);
    if (!current) {
      participants.set(key, {
        sender: row.sender,
        source: row.source ?? null,
        message_count: 1,
        latest_message_id: formatMessageId(row.number),
        latestNumber: row.number,
      });
      continue;
    }
    current.message_count += 1;
    if (row.number > current.latestNumber) {
      current.latest_message_id = formatMessageId(row.number);
      current.latestNumber = row.number;
    }
  }

  return Array.from(participants.values())
    .sort((left, right) => right.latestNumber - left.latestNumber)
    .map(({ latestNumber: _latestNumber, ...participant }) => participant);
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
