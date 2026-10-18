import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { localFilesPath } from "../chat-storage/settings.js";
import { localAttachmentRelativePath, realLocalAttachmentPath } from "./links.js";
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

const AGENT_IMAGE_DATA_URL = /^data:image\/(?:png|jpe?g|gif|webp);base64,/i;

/**
 * A local attachment's bytes for an agent's turn, read only when they fit in
 * `maxBytes`. A row with a file URL is read from that file alone, and only
 * inside the local files folder, both as written and after symlinks; an
 * older row without one may hold an inline copy (a base64 image data URL, or
 * bare base64). Only a regular file is read, and opening never waits (a named
 * pipe is refused, not opened for a writer). The caller still decides from
 * the bytes whether they are an image.
 */
export async function readLocalAttachmentBytesWithin(
  attachment: RoomMessageAttachmentPayload,
  maxBytes: number,
): Promise<{ bytes: Buffer } | "too_large" | "unavailable"> {
  if (attachment.url?.startsWith("file:")) {
    // The written path is checked first, so a row naming a path elsewhere
    // (an automounted network folder, say) is never touched.
    if (localAttachmentRelativePath(attachment.url) === null) return "unavailable";
    const realPath = await realLocalAttachmentPath(fileURLToPath(attachment.url));
    if (!realPath) return "unavailable";
    const handle = await open(realPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
    if (!handle) return "unavailable";
    try {
      const info = await handle.stat();
      if (!info.isFile()) return "unavailable";
      if (info.size > maxBytes) return "too_large";
      const bytes = Buffer.alloc(info.size);
      const { bytesRead } = await handle.read(bytes, 0, info.size, 0);
      return { bytes: bytes.subarray(0, bytesRead) };
    } catch {
      return "unavailable";
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
  const dataUrl = attachment.data_url?.trim() ?? "";
  const encoded = (AGENT_IMAGE_DATA_URL.test(dataUrl)
    ? dataUrl.slice(dataUrl.indexOf(",") + 1)
    : attachment.content_base64 ?? "").replace(/\s+/g, "");
  if (!encoded) return "unavailable";
  // Four base64 characters hold three bytes; refuse before decoding what cannot fit.
  if (Math.floor((encoded.length * 3) / 4) - 2 > maxBytes) return "too_large";
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength > maxBytes) return "too_large";
  return bytes.byteLength ? { bytes } : "unavailable";
}

function safePathSegment(value: string): string {
  return value.replace(/[^\w.-]/g, "_") || "room";
}
