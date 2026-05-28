import { and, eq, inArray, sql } from "drizzle-orm";

import {
  assertAttachmentTotalByteSize,
  type NormalizedMessageAttachmentReference,
} from "../../message-attachments.js";
import {
  isPromptOnlyAgentMessage,
  normalizeAgentPromptKind,
  type AgentPromptKind,
} from "../../../shared/room-agent-prompts.js";
import { db } from "../client.js";
import { message_attachment_uploads, message_attachments, messages } from "../schema.js";
import {
  toMessageAttachment,
  toMessageReplyReference,
  toMessageWithReply,
} from "../mappers.js";
import type {
  Message,
  MessageAttachmentRow,
  MessageReplyReference,
  MessageRow,
} from "../types.js";
import { nextRoomScopedNumber, parseScopedId } from "../utils.js";
import {
  messageAttachmentUploadSelection,
  messageReplySelection,
} from "./selections.js";

export async function addMessage(
  roomId: string,
  sender: string,
  text: string,
  options?: {
    source?: string;
    agent_prompt_kind?: AgentPromptKind | null;
    reply_to_message_id?: string | null;
    attachments?: NormalizedMessageAttachmentReference[];
  },
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
        .select(messageReplySelection)
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
            sql`${message_attachment_uploads.expires_at} > ${message.timestamp}`,
          ),
        )
        .returning(messageAttachmentUploadSelection);
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
            sql`${messages.number} < ${message.number}`,
          ),
        );
    }

    return toMessageWithReply(message, replyReference, attachmentRows.map(toMessageAttachment));
  });
}
