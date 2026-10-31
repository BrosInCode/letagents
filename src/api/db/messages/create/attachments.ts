/** Claims the sender's pending uploads and attaches them to the new message. */
import { and, eq, inArray, sql } from "drizzle-orm";
import { assertAttachmentTotalByteSize, type NormalizedMessageAttachmentReference } from "../../../messages/attachments.js";
import { messageAttachmentUploadUsableBy } from "../attachments.js";
import { RequestValidationError } from "../../../validation-error.js";
import { message_attachment_uploads, message_attachments } from "../../schema.js";
import type { MessageAttachmentRow, MessageRow } from "../../types.js";
import { messageAttachmentUploadSelection } from "../selections.js";
import type { MessageCreateTransaction, AddMessageOptions } from "./types.js";

/** Claims each referenced pending upload for this message and writes its attachment rows. */
export async function attachMessageUploads(
  tx: MessageCreateTransaction,
  roomId: string,
  createdMessage: MessageRow,
  attachmentRefs: NormalizedMessageAttachmentReference[],
  options: AddMessageOptions | undefined,
): Promise<void> {
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
          messageAttachmentUploadUsableBy(options?.attachment_uploader),
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
}
