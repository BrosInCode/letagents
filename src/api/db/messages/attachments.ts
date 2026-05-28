import { and, eq } from "drizzle-orm";

import { db } from "../client.js";
import { message_attachment_uploads, message_attachments } from "../schema.js";
import { toMessageAttachmentData, toMessageAttachmentUpload } from "../mappers.js";
import type {
  MessageAttachmentData,
  MessageAttachmentUpload,
} from "../types.js";
import { parseScopedId } from "../utils.js";
import {
  messageAttachmentSelection,
  messageAttachmentUploadSelection,
} from "./selections.js";

export async function getMessageAttachment(
  roomId: string,
  messageId: string,
  attachmentId: string,
): Promise<MessageAttachmentData | undefined> {
  const messageNumber = parseScopedId(messageId, "msg");
  const attachmentNumber = parseScopedId(attachmentId, "att");
  if (!messageNumber || !attachmentNumber) {
    return undefined;
  }

  const [row] = await db
    .select(messageAttachmentSelection)
    .from(message_attachments)
    .where(
      and(
        eq(message_attachments.room_id, roomId),
        eq(message_attachments.message_number, messageNumber),
        eq(message_attachments.attachment_number, attachmentNumber),
      ),
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
  uploadId: string,
): Promise<MessageAttachmentUpload | undefined> {
  const [row] = await db
    .select(messageAttachmentUploadSelection)
    .from(message_attachment_uploads)
    .where(
      and(
        eq(message_attachment_uploads.room_id, roomId),
        eq(message_attachment_uploads.upload_id, uploadId),
      ),
    )
    .limit(1);

  return row ? toMessageAttachmentUpload(row) : undefined;
}

export async function deletePendingMessageAttachmentUpload(
  roomId: string,
  uploadId: string,
): Promise<MessageAttachmentUpload | undefined> {
  const [row] = await db
    .delete(message_attachment_uploads)
    .where(
      and(
        eq(message_attachment_uploads.room_id, roomId),
        eq(message_attachment_uploads.upload_id, uploadId),
        eq(message_attachment_uploads.status, "pending"),
      ),
    )
    .returning();

  return row ? toMessageAttachmentUpload(row) : undefined;
}
