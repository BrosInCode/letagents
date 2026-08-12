import crypto from "node:crypto";
import type { Express } from "express";

import {
  createMessageAttachmentUpload,
  deletePendingMessageAttachmentUpload,
  getMessageAttachment,
} from "../../../db.js";
import {
  respondWithBadRequest,
  type AuthenticatedRequest,
} from "../../../http/helpers.js";
import {
  createAttachmentObjectKey,
  deleteAttachmentObject,
  createPresignedAttachmentDownload,
  createPresignedAttachmentUpload,
  isAttachmentStorageConfigured,
} from "../../../messages/attachment-storage.js";
import {
  canStageMessageAttachment,
  normalizeAttachmentUploadRequest,
} from "../../../messages/attachments.js";
import {
  resolveParticipantRoom,
  routeParam,
} from "./helpers.js";
import type { RoomMessageRouteDeps } from "./types.js";

export function registerMessageAttachmentRoutes(
  app: Express,
  deps: RoomMessageRouteDeps
): void {
  app.get(/^\/rooms\/(.+)\/messages\/([^/]+)\/attachments\/([^/]+)$/, async (req: AuthenticatedRequest, res) => {
    const project = await resolveParticipantRoom(req, res, deps);
    if (!project) return;

    const messageId = routeParam(req, 1);
    const attachmentId = routeParam(req, 2);
    const attachment = await getMessageAttachment(project.id, messageId, attachmentId);
    if (!attachment) {
      res.status(404).json({ error: "Attachment not found", code: "ATTACHMENT_NOT_FOUND" });
      return;
    }

    if (!isAttachmentStorageConfigured()) {
      res.status(503).json({ error: "Attachment object storage is not configured" });
      return;
    }

    res.redirect(302, createPresignedAttachmentDownload(attachment));
  });

  app.post(/^\/rooms\/(.+)\/attachments\/uploads$/, async (req: AuthenticatedRequest, res) => {
    const project = await resolveParticipantRoom(req, res, deps);
    if (!project) return;

    if (!canStageMessageAttachment(req)) {
      res.status(401).json({
        error: "Authentication is required to upload attachments.",
        code: "NOT_AUTHENTICATED",
      });
      return;
    }

    if (!isAttachmentStorageConfigured()) {
      res.status(503).json({ error: "Attachment object storage is not configured" });
      return;
    }

    try {
      const attachment = normalizeAttachmentUploadRequest(req.body);
      const uploadId = `upl_${crypto.randomUUID().replace(/-/g, "")}`;
      const objectKey = createAttachmentObjectKey({
        roomId: project.id,
        uploadId,
        filename: attachment.filename,
      });
      const presigned = createPresignedAttachmentUpload({
        object_key: objectKey,
        filename: attachment.filename,
        content_type: attachment.content_type,
        byte_size: attachment.byte_size,
      });
      const upload = await createMessageAttachmentUpload({
        upload_id: uploadId,
        room_id: project.id,
        filename: attachment.filename,
        content_type: attachment.content_type,
        byte_size: attachment.byte_size,
        storage_provider: presigned.storage_provider,
        bucket: presigned.bucket,
        object_key: objectKey,
        expires_at: presigned.expires_at,
      });

      res.status(201).json({
        room_id: project.id,
        upload_id: upload.upload_id,
        upload_url: presigned.upload_url,
        method: "PUT",
        headers: presigned.headers,
        expires_at: upload.expires_at,
        attachment: {
          filename: upload.filename,
          file_name: upload.filename,
          content_type: upload.content_type,
          mime_type: upload.content_type,
          byte_size: upload.byte_size,
          size_bytes: upload.byte_size,
        },
      });
    } catch (error) {
      respondWithBadRequest(
        res,
        "POST /rooms/:room_id/attachments/uploads",
        error,
        "Attachment upload could not be staged."
      );
    }
  });

  app.delete(/^\/rooms\/(.+)\/attachments\/uploads\/([^/]+)$/, async (req: AuthenticatedRequest, res) => {
    const project = await resolveParticipantRoom(req, res, deps);
    if (!project) return;

    const uploadId = routeParam(req, 1);
    const upload = await deletePendingMessageAttachmentUpload(project.id, uploadId);
    if (!upload) {
      res.status(200).json({ ok: true, upload_id: uploadId });
      return;
    }

    if (isAttachmentStorageConfigured()) {
      try {
        await deleteAttachmentObject({ object_key: upload.object_key });
      } catch {
        // The draft row is already gone, so prefer a small object leak over reviving a raceable record.
      }
    }

    res.status(200).json({ ok: true, upload_id: uploadId });
  });
}
