import { and, asc, eq, isNull, lt, or, sql, type SQL } from "drizzle-orm";

import { db } from "../client.js";
import { message_attachment_uploads, message_attachments } from "../schema.js";
import { toMessageAttachmentData, toMessageAttachmentUpload } from "../mappers.js";
import type {
  MessageAttachmentData,
  MessageAttachmentUpload,
} from "../types.js";
import { parseScopedId } from "../utils.js";
import type { MessageAttachmentUploader } from "../../messages/attachments.js";
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

/**
 * Pending uploads the given uploader may discard or attach: its own, plus
 * rows staged before uploads had an owner, which stay open to any room
 * participant until they expire. Without an uploader only those old rows match.
 */
export function messageAttachmentUploadUsableBy(uploader: MessageAttachmentUploader | null | undefined): SQL {
  const unowned = and(
    isNull(message_attachment_uploads.uploader_account_id),
    isNull(message_attachment_uploads.uploader_agent_session_id),
  )!;
  if (uploader?.agent_session_id) {
    return or(unowned, eq(message_attachment_uploads.uploader_agent_session_id, uploader.agent_session_id))!;
  }
  if (uploader?.account_id) {
    return or(unowned, eq(message_attachment_uploads.uploader_account_id, uploader.account_id))!;
  }
  return unowned;
}

export async function createMessageAttachmentUpload(input: {
  upload_id: string;
  room_id: string;
  /** Null only stages an unowned row, as uploads were before ownership. */
  uploader: MessageAttachmentUploader | null;
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
      uploader_account_id: input.uploader?.agent_session_id ? null : input.uploader?.account_id ?? null,
      uploader_agent_session_id: input.uploader?.agent_session_id ?? null,
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
  uploader: MessageAttachmentUploader | null,
): Promise<MessageAttachmentUpload | undefined> {
  const [row] = await db
    .delete(message_attachment_uploads)
    .where(
      and(
        eq(message_attachment_uploads.room_id, roomId),
        eq(message_attachment_uploads.upload_id, uploadId),
        eq(message_attachment_uploads.status, "pending"),
        messageAttachmentUploadUsableBy(uploader),
      ),
    )
    .returning();

  return row ? toMessageAttachmentUpload(row) : undefined;
}

/** Where an expired-upload cleanup pass stopped: the last row it looked at. */
export interface ExpiredMessageAttachmentUploadCursor {
  expires_at: string;
  upload_id: string;
}

/**
 * Pending uploads that expired before `expired_before`, oldest first, after
 * `after` when a pass resumes. Reads only: a row is removed by
 * deleteExpiredPendingMessageAttachmentUpload once its object is gone.
 */
export async function listExpiredPendingMessageAttachmentUploads(input: {
  expired_before: string;
  after: ExpiredMessageAttachmentUploadCursor | null;
  limit: number;
}): Promise<MessageAttachmentUpload[]> {
  const rows = await db
    .select(messageAttachmentUploadSelection)
    .from(message_attachment_uploads)
    .where(
      and(
        eq(message_attachment_uploads.status, "pending"),
        lt(message_attachment_uploads.expires_at, input.expired_before),
        input.after
          ? sql`(${message_attachment_uploads.expires_at}, ${message_attachment_uploads.upload_id}) > (${input.after.expires_at}::timestamptz, ${input.after.upload_id})`
          : undefined,
      ),
    )
    .orderBy(asc(message_attachment_uploads.expires_at), asc(message_attachment_uploads.upload_id))
    .limit(input.limit);

  return rows.map(toMessageAttachmentUpload);
}

/** Delete one expired upload row if it is still pending and expired. Returns whether it was deleted. */
export async function deleteExpiredPendingMessageAttachmentUpload(input: {
  upload_id: string;
  expired_before: string;
}): Promise<boolean> {
  const rows = await db
    .delete(message_attachment_uploads)
    .where(
      and(
        eq(message_attachment_uploads.upload_id, input.upload_id),
        eq(message_attachment_uploads.status, "pending"),
        lt(message_attachment_uploads.expires_at, input.expired_before),
      ),
    )
    .returning({ upload_id: message_attachment_uploads.upload_id });

  return rows.length > 0;
}
