import type { Buffer } from "node:buffer";

import {
  assertMessageAttachmentFits,
  guessMessageAttachmentMimeType,
} from "../../../../../shared/message-attachments.mjs";
import type { DesktopStagedAttachment } from "../../ipc-types.js";

export interface AttachmentFile {
  fileName: string;
  mimeType: string;
  bytes: Buffer;
}

/**
 * Where one room's attachments live. A cloud room stages files in the room's
 * object storage; a local room keeps them in the local files folder. Callers
 * resolve the store once and never branch on the room's storage mode.
 */
export interface AttachmentStore {
  readonly kind: "cloud" | "local";
  /** The room identifier after local/cloud storage resolution. */
  readonly roomIdentifier: string;
  stage(file: AttachmentFile): Promise<DesktopStagedAttachment>;
  discard(uploadId: string): Promise<void>;
}

export function attachmentFile(input: { fileName?: string | null; mimeType?: string | null; bytes: Buffer }): AttachmentFile {
  const fileName = input.fileName?.trim() || "attachment";
  assertMessageAttachmentFits(fileName, input.bytes.byteLength);
  return {
    fileName,
    mimeType: input.mimeType?.trim() || guessMessageAttachmentMimeType(fileName),
    bytes: input.bytes,
  };
}

/** The composer shows an image draft before the message exists, so only drafts carry inline preview bytes. */
export function stagedAttachment(file: AttachmentFile, uploadId: string): DesktopStagedAttachment {
  return {
    uploadId,
    fileName: file.fileName,
    mimeType: file.mimeType,
    sizeBytes: file.bytes.byteLength,
    previewDataUrl: file.mimeType.startsWith("image/")
      ? `data:${file.mimeType};base64,${file.bytes.toString("base64")}`
      : null,
  };
}
