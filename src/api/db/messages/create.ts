import { and, eq, inArray, sql } from "drizzle-orm";

import {
  assertAttachmentTotalByteSize,
  type NormalizedMessageAttachmentReference,
} from "../../messages/attachments.js";
import {
  isPromptOnlyAgentMessage,
  normalizeAgentPromptKind,
  type AgentPromptKind,
} from "../../../shared/room-agent-prompts.js";
import { RequestValidationError } from "../../validation-error.js";
import { db } from "../client.js";
import { message_attachment_uploads, message_attachments, messages } from "../schema.js";
import { toMessageWithReply } from "../mappers.js";
import type {
  Message,
  MessageAttachmentRow,
  MessageRow,
} from "../types.js";
import { nextRoomScopedNumber, parseScopedId } from "../utils.js";
import {
  messageRowSelection,
  messageAttachmentUploadSelection,
} from "./selections.js";
import { hydrateMessageReplies } from "./history.js";

function normalizeClientMessageId(value?: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 240) : null;
}

export interface AddMessageOptions {
  source?: string;
  agent_prompt_kind?: AgentPromptKind | null;
  reply_to_message_id?: string | null;
  thread_root_message_id?: string | null;
  attachments?: NormalizedMessageAttachmentReference[];
  client_message_id?: string | null;
  account_id?: string | null;
}

export interface AddMessageResult {
  message: Message;
  created: boolean;
}

interface AddMessageTransactionResult {
  messageRow: MessageRow;
  created: boolean;
}

export async function addMessageWithCreateStatus(
  roomId: string,
  sender: string,
  text: string,
  options?: AddMessageOptions,
): Promise<AddMessageResult> {
  const promptKind = options?.agent_prompt_kind ?? null;
  const attachmentRefs = options?.attachments ?? [];
  const clientMessageId = normalizeClientMessageId(options?.client_message_id);
  const result = await db.transaction(async (tx): Promise<AddMessageTransactionResult> => {
    const replyToNumber =
      options?.reply_to_message_id
        ? parseScopedId(options.reply_to_message_id, "msg")
        : null;
    const explicitThreadRootNumber =
      options?.thread_root_message_id
        ? parseScopedId(options.thread_root_message_id, "msg")
        : null;

    if (clientMessageId) {
      const [existingMessage] = await tx
        .select(messageRowSelection)
        .from(messages)
        .where(and(eq(messages.room_id, roomId), eq(messages.client_message_id, clientMessageId)))
        .limit(1);

      if (existingMessage) {
        return {
          messageRow: existingMessage,
          created: false,
        };
      }
    }

    if (options?.reply_to_message_id && !replyToNumber) {
      throw new RequestValidationError("reply_to must be a valid message id");
    }
    if (options?.thread_root_message_id && !explicitThreadRootNumber) {
      throw new RequestValidationError("thread_root_id must be a valid message id");
    }

    let replyTargetRootNumber: number | null = null;
    if (replyToNumber) {
      const [replyTarget] = await tx
        .select(messageRowSelection)
        .from(messages)
        .where(and(eq(messages.room_id, roomId), eq(messages.number, replyToNumber)))
        .limit(1);

      if (!replyTarget) {
        throw new RequestValidationError("reply_to must reference an existing message in this room");
      }

      if (isPromptOnlyAgentMessage(replyTarget.text, normalizeAgentPromptKind(replyTarget.agent_prompt_kind))) {
        throw new RequestValidationError("reply_to must reference a visible message");
      }

      replyTargetRootNumber = replyTarget.thread_root_number ?? replyTarget.number;
    }

    let threadRootNumber = explicitThreadRootNumber;
    if (explicitThreadRootNumber) {
      const [threadRoot] = await tx
        .select(messageRowSelection)
        .from(messages)
        .where(and(eq(messages.room_id, roomId), eq(messages.number, explicitThreadRootNumber)))
        .limit(1);

      if (!threadRoot) {
        throw new RequestValidationError("thread_root_id must reference an existing message in this room");
      }

      if (isPromptOnlyAgentMessage(threadRoot.text, normalizeAgentPromptKind(threadRoot.agent_prompt_kind))) {
        throw new RequestValidationError("thread_root_id must reference a visible message");
      }

      threadRootNumber = threadRoot.thread_root_number ?? threadRoot.number;
      if (replyTargetRootNumber && replyTargetRootNumber !== threadRootNumber) {
        throw new RequestValidationError("reply_to must belong to the requested thread");
      }
    }

    const message: MessageRow = {
      room_id: roomId,
      number: await nextRoomScopedNumber("messages", roomId, tx),
      reply_to_number: replyToNumber,
      thread_root_number: threadRootNumber,
      sender,
      text,
      agent_prompt_kind: promptKind,
      source: options?.source ?? null,
      client_message_id: clientMessageId,
      timestamp: new Date().toISOString(),
    };

    let createdMessage = message;
    if (clientMessageId) {
      const [insertedMessage] = await tx
        .insert(messages)
        .values(message)
        .onConflictDoNothing()
        .returning(messageRowSelection);
      if (!insertedMessage) {
        const [existingMessage] = await tx
          .select(messageRowSelection)
          .from(messages)
          .where(and(eq(messages.room_id, roomId), eq(messages.client_message_id, clientMessageId)))
          .limit(1);
        if (!existingMessage) {
          throw new Error("message idempotency conflict could not be resolved");
        }
        return {
          messageRow: existingMessage,
          created: false,
        };
      }
      createdMessage = insertedMessage;
    } else {
      await tx.insert(messages).values(message);
    }
    let attachmentRows: MessageAttachmentRow[] = [];
    if (attachmentRefs.length > 0) {
      const uploadIds = attachmentRefs.map((attachment) => attachment.upload_id);
      const claimedUploadRows = await tx
        .update(message_attachment_uploads)
        .set({
          status: "attached",
          attached_message_number: createdMessage.number,
          attached_at: createdMessage.timestamp,
        })
        .where(
          and(
            eq(message_attachment_uploads.room_id, roomId),
            inArray(message_attachment_uploads.upload_id, uploadIds),
            eq(message_attachment_uploads.status, "pending"),
            sql`${message_attachment_uploads.expires_at} > ${createdMessage.timestamp}`,
          ),
        )
        .returning(messageAttachmentUploadSelection);
      const uploadsById = new Map(claimedUploadRows.map((row) => [row.upload_id, row]));
      const orderedUploads = uploadIds.map((uploadId) => {
        const upload = uploadsById.get(uploadId);
        if (!upload) {
          throw new RequestValidationError("attachment upload not found or expired");
        }
        return upload;
      });
      assertAttachmentTotalByteSize(orderedUploads);
      attachmentRows = orderedUploads.map((attachment, index) => ({
        room_id: roomId,
        message_number: createdMessage.number,
        attachment_number: index + 1,
        upload_id: attachment.upload_id,
        filename: attachment.filename,
        content_type: attachment.content_type,
        byte_size: attachment.byte_size,
        storage_provider: attachment.storage_provider,
        bucket: attachment.bucket,
        object_key: attachment.object_key,
        created_at: createdMessage.timestamp,
      }));
    }
    if (attachmentRows.length > 0) {
      await tx.insert(message_attachments).values(attachmentRows);
    }
    if (isPromptOnlyAgentMessage(createdMessage.text, promptKind)) {
      await tx
        .delete(messages)
        .where(
          and(
            eq(messages.room_id, roomId),
            eq(messages.sender, sender),
            eq(messages.agent_prompt_kind, "auto"),
            sql`BTRIM(${messages.text}) = ''`,
            sql`${messages.number} < ${createdMessage.number}`,
          ),
        );
    }

    return {
      messageRow: createdMessage,
      created: true,
    };
  });
  const [message] = await hydrateMessageReplies(roomId, [result.messageRow], {
    accountId: options?.account_id ?? null,
  });
  return {
    message: message ?? toMessageWithReply(result.messageRow, null),
    created: result.created,
  };
}

export async function addMessage(
  roomId: string,
  sender: string,
  text: string,
  options?: AddMessageOptions,
): Promise<Message> {
  const result = await addMessageWithCreateStatus(roomId, sender, text, options);
  return result.message;
}
