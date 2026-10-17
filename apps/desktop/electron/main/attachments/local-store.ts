import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { localFilesPath } from "../chat-storage/settings.js";
import { realLocalAttachmentPath } from "./links.js";
import type { RoomMessageAttachmentPayload } from "./mappers.js";
import { stagedAttachment, type AttachmentFile, type AttachmentStore } from "./store.js";

type LocalStagedAttachment = {
  uploadId: string;
  roomIdentifier: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  filePath: string;
};

const LOCAL_UPLOAD_PREFIX = "local:";
const localStagedAttachments = new Map<string, LocalStagedAttachment>();

export function isLocalUploadId(uploadId: string): boolean {
  return uploadId.startsWith(LOCAL_UPLOAD_PREFIX);
}

/** A local room keeps each file once, on disk. The database row stores only its file URL. */
export function createLocalAttachmentStore(roomIdentifier: string): AttachmentStore {
  return {
    kind: "local",
    roomIdentifier,
    async stage(file: AttachmentFile) {
      const uploadId = `${LOCAL_UPLOAD_PREFIX}${randomUUID()}`;
      const safeFileName = file.fileName.replace(/[^\w .@()-]/g, "_") || "attachment";
      const roomDir = join(localFilesPath, safePathSegment(roomIdentifier));
      await mkdir(roomDir, { recursive: true });
      const filePath = join(roomDir, `${uploadId.slice(LOCAL_UPLOAD_PREFIX.length)}-${safeFileName}`);
      await writeFile(filePath, file.bytes);
      localStagedAttachments.set(uploadId, {
        uploadId,
        roomIdentifier,
        fileName: file.fileName,
        mimeType: file.mimeType,
        sizeBytes: file.bytes.byteLength,
        filePath,
      });
      return stagedAttachment(file, uploadId);
    },
    discard: discardLocalStagedAttachment,
  };
}

/** A local upload id names its file wherever the room's storage mode has moved since staging. */
export async function discardLocalStagedAttachment(uploadId: string): Promise<void> {
  const staged = localStagedAttachments.get(uploadId);
  if (!staged) return;
  localStagedAttachments.delete(uploadId);
  await rm(staged.filePath, { force: true }).catch(() => undefined);
}

/** Turn staged local uploads into message attachment rows; throws when one is gone. */
export function readLocalStagedAttachments(
  roomIdentifier: string,
  attachments: Array<{ upload_id: string }>,
): RoomMessageAttachmentPayload[] {
  const consumed: RoomMessageAttachmentPayload[] = [];
  for (const attachment of attachments) {
    const uploadId = attachment.upload_id?.trim();
    if (!uploadId) continue;
    const staged = localStagedAttachments.get(uploadId);
    if (!staged || staged.roomIdentifier !== roomIdentifier) {
      throw new Error("One or more local attachments are no longer available.");
    }
    const fileUrl = pathToFileURL(staged.filePath).toString();
    consumed.push({
      id: staged.uploadId,
      file_name: staged.fileName,
      mime_type: staged.mimeType,
      size_bytes: staged.sizeBytes,
      url: fileUrl,
      download_url: fileUrl,
    });
  }
  return consumed;
}

export function releaseLocalStagedAttachments(roomIdentifier: string, attachments: Array<{ upload_id: string }>): void {
  for (const { upload_id } of attachments) {
    if (localStagedAttachments.get(upload_id)?.roomIdentifier === roomIdentifier) localStagedAttachments.delete(upload_id);
  }
}

/** Older local rows also carry inline copies; a file on disk always wins. */
export async function readLocalAttachmentBytes(attachment: RoomMessageAttachmentPayload): Promise<Buffer> {
  if (attachment.url?.startsWith("file:")) {
    const realPath = await realLocalAttachmentPath(fileURLToPath(attachment.url));
    if (!realPath) throw new Error("Local attachment file is outside the local files folder.");
    return readFile(realPath);
  }
  if (attachment.data_url?.startsWith("data:")) {
    const [, encoded] = attachment.data_url.split(",", 2);
    if (encoded) return Buffer.from(encoded, "base64");
  }
  if (attachment.content_base64) {
    return Buffer.from(attachment.content_base64, "base64");
  }
  throw new Error("Local attachment file is no longer available.");
}

function safePathSegment(value: string): string {
  return value.replace(/[^\w.-]/g, "_") || "room";
}
