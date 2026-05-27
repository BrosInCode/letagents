import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { assertAttachmentTotalByteSize, type NormalizedMessageAttachmentReference } from "../message-attachments.js";
import { isPromptOnlyAgentMessage, normalizeAgentPromptKind, type AgentPromptKind } from "../../shared/room-agent-prompts.js";
import { db } from "./client.js";
import { message_attachment_uploads, message_attachments, messages } from "./schema.js";
import { clampLimit, nextRoomScopedNumber, parseScopedId } from "./utils.js";
import { toMessageAttachment, toMessageAttachmentData, toMessageAttachmentUpload, toMessageReplyReference, toMessageWithReply } from "./mappers.js";
import type { Message, MessageAttachment, MessageAttachmentData, MessageAttachmentRow, MessageAttachmentUpload, MessageAttachmentUploadRow, MessageReplyReference, MessageRow, RoomActivityActorCount } from "./types.js";

export async function addMessage(
  roomId: string,
  sender: string,
  text: string,
  options?: {
    source?: string;
    agent_prompt_kind?: AgentPromptKind | null;
    reply_to_message_id?: string | null;
    attachments?: NormalizedMessageAttachmentReference[];
  }
): Promise<Message> {
  const promptKind = options?.agent_prompt_kind ?? null;
  const attachmentRefs = options?.attachments ?? [];
  return db.transaction(async (tx) => {
    let replyReference: MessageReplyReference | null = null;
    const replyToNumber =
      options?.reply_to_message_id
        ? parseScopedId(options.reply_to_message_id, "msg")
        : null;

    if (options?.reply_to_message_id && !replyToNumber) {
      throw new Error("reply_to must be a valid message id");
    }

    if (replyToNumber) {
      const [replyTarget] = await tx
        .select({
          number: messages.number,
          sender: messages.sender,
          text: messages.text,
          agent_prompt_kind: messages.agent_prompt_kind,
          source: messages.source,
          timestamp: messages.timestamp,
        })
        .from(messages)
        .where(and(eq(messages.room_id, roomId), eq(messages.number, replyToNumber)))
        .limit(1);

      if (!replyTarget) {
        throw new Error("reply_to must reference an existing message in this room");
      }

      if (isPromptOnlyAgentMessage(replyTarget.text, normalizeAgentPromptKind(replyTarget.agent_prompt_kind))) {
        throw new Error("reply_to must reference a visible message");
      }

      replyReference = toMessageReplyReference(replyTarget);
    }

    const message: MessageRow = {
      room_id: roomId,
      number: await nextRoomScopedNumber("messages", roomId, tx),
      reply_to_number: replyToNumber,
      sender,
      text,
      agent_prompt_kind: promptKind,
      source: options?.source ?? null,
      timestamp: new Date().toISOString(),
    };

    await tx.insert(messages).values(message);
    let attachmentRows: MessageAttachmentRow[] = [];
    if (attachmentRefs.length > 0) {
      const uploadIds = attachmentRefs.map((attachment) => attachment.upload_id);
      const claimedUploadRows = await tx
        .update(message_attachment_uploads)
        .set({
          status: "attached",
          attached_message_number: message.number,
          attached_at: message.timestamp,
        })
        .where(
          and(
            eq(message_attachment_uploads.room_id, roomId),
            inArray(message_attachment_uploads.upload_id, uploadIds),
            eq(message_attachment_uploads.status, "pending"),
            sql`${message_attachment_uploads.expires_at} > ${message.timestamp}`
          )
        )
        .returning({
          upload_id: message_attachment_uploads.upload_id,
          room_id: message_attachment_uploads.room_id,
          filename: message_attachment_uploads.filename,
          content_type: message_attachment_uploads.content_type,
          byte_size: message_attachment_uploads.byte_size,
          storage_provider: message_attachment_uploads.storage_provider,
          bucket: message_attachment_uploads.bucket,
          object_key: message_attachment_uploads.object_key,
          status: message_attachment_uploads.status,
          expires_at: message_attachment_uploads.expires_at,
          attached_message_number: message_attachment_uploads.attached_message_number,
          created_at: message_attachment_uploads.created_at,
          attached_at: message_attachment_uploads.attached_at,
        });
      const uploadsById = new Map(claimedUploadRows.map((row) => [row.upload_id, row]));
      const orderedUploads = uploadIds.map((uploadId) => {
        const upload = uploadsById.get(uploadId);
        if (!upload) {
          throw new Error("attachment upload not found or expired");
        }
        return upload;
      });
      assertAttachmentTotalByteSize(orderedUploads);
      attachmentRows = orderedUploads.map((attachment, index) => ({
        room_id: roomId,
        message_number: message.number,
        attachment_number: index + 1,
        upload_id: attachment.upload_id,
        filename: attachment.filename,
        content_type: attachment.content_type,
        byte_size: attachment.byte_size,
        storage_provider: attachment.storage_provider,
        bucket: attachment.bucket,
        object_key: attachment.object_key,
        created_at: message.timestamp,
      }));
    }
    if (attachmentRows.length > 0) {
      await tx.insert(message_attachments).values(attachmentRows);
    }
    if (isPromptOnlyAgentMessage(message.text, promptKind)) {
      await tx
        .delete(messages)
        .where(
          and(
            eq(messages.room_id, roomId),
            eq(messages.sender, sender),
            eq(messages.agent_prompt_kind, "auto"),
            sql`BTRIM(${messages.text}) = ''`,
            sql`${messages.number} < ${message.number}`
          )
        );
    }

    return toMessageWithReply(message, replyReference, attachmentRows.map(toMessageAttachment));
  });
}

export async function getMessages(
  roomId: string,
  options?: { limit?: number; after?: string; include_prompt_only?: boolean }
): Promise<{ messages: Message[]; has_more: boolean }> {
  const limit = clampLimit(options?.limit);
  const afterNumber = options?.after ? parseScopedId(options.after, "msg") : null;
  const visibilityCondition = options?.include_prompt_only
    ? sql`TRUE`
    : sql`NOT (${messages.agent_prompt_kind} = 'auto' AND BTRIM(${messages.text}) = '')`;

  const rows = await db
    .select({
      room_id: messages.room_id,
      number: messages.number,
      reply_to_number: messages.reply_to_number,
      sender: messages.sender,
      text: messages.text,
      agent_prompt_kind: messages.agent_prompt_kind,
      source: messages.source,
      timestamp: messages.timestamp,
    })
    .from(messages)
    .where(
      afterNumber
        ? and(eq(messages.room_id, roomId), sql`${messages.number} > ${afterNumber}`, visibilityCondition)
        : and(eq(messages.room_id, roomId), visibilityCondition)
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
  options?: { limit?: number; include_prompt_only?: boolean }
): Promise<{ messages: Message[]; has_more: boolean }> {
  const limit = clampLimit(options?.limit);
  const visibilityCondition = options?.include_prompt_only
    ? sql`TRUE`
    : sql`NOT (${messages.agent_prompt_kind} = 'auto' AND BTRIM(${messages.text}) = '')`;

  const rows = await db
    .select({
      room_id: messages.room_id,
      number: messages.number,
      reply_to_number: messages.reply_to_number,
      sender: messages.sender,
      text: messages.text,
      agent_prompt_kind: messages.agent_prompt_kind,
      source: messages.source,
      timestamp: messages.timestamp,
    })
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
  options?: { limit?: number; include_prompt_only?: boolean }
): Promise<{ messages: Message[]; has_more: boolean }> {
  const beforeNumber = beforeMessageId ? parseScopedId(beforeMessageId, "msg") : null;
  if (!beforeNumber) {
    return getLatestMessages(roomId, options);
  }

  const limit = clampLimit(options?.limit);
  const visibilityCondition = options?.include_prompt_only
    ? sql`TRUE`
    : sql`NOT (${messages.agent_prompt_kind} = 'auto' AND BTRIM(${messages.text}) = '')`;

  const rows = await db
    .select({
      room_id: messages.room_id,
      number: messages.number,
      reply_to_number: messages.reply_to_number,
      sender: messages.sender,
      text: messages.text,
      agent_prompt_kind: messages.agent_prompt_kind,
      source: messages.source,
      timestamp: messages.timestamp,
    })
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
        .filter((value): value is number => value !== null && Number.isInteger(value) && value > 0)
    )
  );

  const replyMap = new Map<number, MessageReplyReference>();
  if (replyToNumbers.length > 0) {
    const replyRows = await db
      .select({
        number: messages.number,
        sender: messages.sender,
        text: messages.text,
        source: messages.source,
        timestamp: messages.timestamp,
      })
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
      .select({
        room_id: message_attachments.room_id,
        message_number: message_attachments.message_number,
        attachment_number: message_attachments.attachment_number,
        upload_id: message_attachments.upload_id,
        filename: message_attachments.filename,
        content_type: message_attachments.content_type,
        byte_size: message_attachments.byte_size,
        storage_provider: message_attachments.storage_provider,
        bucket: message_attachments.bucket,
        object_key: message_attachments.object_key,
        created_at: message_attachments.created_at,
      })
      .from(message_attachments)
      .where(
        and(
          eq(message_attachments.room_id, roomId),
          inArray(message_attachments.message_number, messageNumbers)
        )
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
      attachmentMap.get(row.number) ?? []
    )
  );
}

export async function getMessagesAfter(
  roomId: string,
  afterMessageId: string | undefined,
  options?: { limit?: number; include_prompt_only?: boolean }
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
      sql`NOT (${messages.agent_prompt_kind} = 'auto' AND BTRIM(${messages.text}) = '')`
    ))
    .groupBy(messages.sender);

  return rows.map((row) => ({
    actor_label: row.actor_label,
    count: Number(row.count) || 0,
  }));
}

export async function getMessageAttachment(
  roomId: string,
  messageId: string,
  attachmentId: string
): Promise<MessageAttachmentData | undefined> {
  const messageNumber = parseScopedId(messageId, "msg");
  const attachmentNumber = parseScopedId(attachmentId, "att");
  if (!messageNumber || !attachmentNumber) {
    return undefined;
  }

  const [row] = await db
    .select({
      room_id: message_attachments.room_id,
      message_number: message_attachments.message_number,
      attachment_number: message_attachments.attachment_number,
      upload_id: message_attachments.upload_id,
      filename: message_attachments.filename,
      content_type: message_attachments.content_type,
      byte_size: message_attachments.byte_size,
      storage_provider: message_attachments.storage_provider,
      bucket: message_attachments.bucket,
      object_key: message_attachments.object_key,
      created_at: message_attachments.created_at,
    })
    .from(message_attachments)
    .where(
      and(
        eq(message_attachments.room_id, roomId),
        eq(message_attachments.message_number, messageNumber),
        eq(message_attachments.attachment_number, attachmentNumber)
      )
    )
    .limit(1);

  return row ? toMessageAttachmentData(row) : undefined;
}

export async function createMessageAttachmentUpload(input: {
  upload_id: string;
  room_id: string;
  filename: string;
  content_type: string;
  byte_size: number;
  storage_provider: string;
  bucket: string;
  object_key: string;
  expires_at: string;
}): Promise<MessageAttachmentUpload> {
  const createdAt = new Date().toISOString();
  const [row] = await db
    .insert(message_attachment_uploads)
    .values({
      upload_id: input.upload_id,
      room_id: input.room_id,
      filename: input.filename,
      content_type: input.content_type,
      byte_size: input.byte_size,
      storage_provider: input.storage_provider,
      bucket: input.bucket,
      object_key: input.object_key,
      status: "pending",
      expires_at: input.expires_at,
      attached_message_number: null,
      created_at: createdAt,
      attached_at: null,
    })
    .returning();

  return toMessageAttachmentUpload(row);
}

export async function getMessageAttachmentUpload(
  roomId: string,
  uploadId: string
): Promise<MessageAttachmentUpload | undefined> {
  const [row] = await db
    .select({
      upload_id: message_attachment_uploads.upload_id,
      room_id: message_attachment_uploads.room_id,
      filename: message_attachment_uploads.filename,
      content_type: message_attachment_uploads.content_type,
      byte_size: message_attachment_uploads.byte_size,
      storage_provider: message_attachment_uploads.storage_provider,
      bucket: message_attachment_uploads.bucket,
      object_key: message_attachment_uploads.object_key,
      status: message_attachment_uploads.status,
      expires_at: message_attachment_uploads.expires_at,
      attached_message_number: message_attachment_uploads.attached_message_number,
      created_at: message_attachment_uploads.created_at,
      attached_at: message_attachment_uploads.attached_at,
    })
    .from(message_attachment_uploads)
    .where(
      and(
        eq(message_attachment_uploads.room_id, roomId),
        eq(message_attachment_uploads.upload_id, uploadId)
      )
    )
    .limit(1);

  return row ? toMessageAttachmentUpload(row) : undefined;
}

export async function deletePendingMessageAttachmentUpload(
  roomId: string,
  uploadId: string
): Promise<MessageAttachmentUpload | undefined> {
  const [row] = await db
    .delete(message_attachment_uploads)
    .where(
      and(
        eq(message_attachment_uploads.room_id, roomId),
        eq(message_attachment_uploads.upload_id, uploadId),
        eq(message_attachment_uploads.status, "pending")
      )
    )
    .returning();

  return row ? toMessageAttachmentUpload(row) : undefined;
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
