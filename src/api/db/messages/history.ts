import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "../client.js";
import { message_attachments, messages } from "../schema.js";
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
  RoomActivityActorCount,
} from "../types.js";
import { clampLimit, parseScopedId } from "../utils.js";
import {
  messageAttachmentSelection,
  messageReplySelection,
  messageRowSelection,
} from "./selections.js";
import { visibleMessageCondition } from "./visibility.js";

export async function getMessages(
  roomId: string,
  options?: { limit?: number; after?: string; include_prompt_only?: boolean },
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
  const hydratedMessages = await hydrateMessageReplies(roomId, bounded);

  return {
    messages: hydratedMessages,
    has_more,
  };
}

export async function getLatestMessages(
  roomId: string,
  options?: { limit?: number; include_prompt_only?: boolean },
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
  const hydratedMessages = await hydrateMessageReplies(roomId, bounded);

  return {
    messages: hydratedMessages,
    has_more,
  };
}

export async function getMessagesBefore(
  roomId: string,
  beforeMessageId: string | undefined,
  options?: { limit?: number; include_prompt_only?: boolean },
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
  const hydratedMessages = await hydrateMessageReplies(roomId, bounded);

  return {
    messages: hydratedMessages,
    has_more,
  };
}

export async function hydrateMessageReplies(roomId: string, bounded: MessageRow[]): Promise<Message[]> {
  const replyToNumbers = Array.from(
    new Set(
      bounded
        .map((row) => row.reply_to_number)
        .filter((value): value is number => value !== null && Number.isInteger(value) && value > 0),
    ),
  );

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

  return bounded.map((row) =>
    toMessageWithReply(
      row,
      row.reply_to_number ? replyMap.get(row.reply_to_number) ?? null : null,
      attachmentMap.get(row.number) ?? [],
    ),
  );
}

export async function getMessagesAfter(
  roomId: string,
  afterMessageId: string | undefined,
  options?: { limit?: number; include_prompt_only?: boolean },
): Promise<{ messages: Message[]; has_more: boolean }> {
  return getMessages(roomId, { ...options, after: afterMessageId });
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
