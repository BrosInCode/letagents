import electron from "electron";
import { Buffer } from "node:buffer";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

import { assertMessageAttachmentFits } from "../../../../shared/message-attachments.mjs";
import type {
  DesktopDroppedAttachmentContent,
  DesktopStagedAttachment,
} from "../ipc-types.js";
import { createCloudAttachmentStore } from "./attachments/cloud-store.js";
import {
  createLocalAttachmentStore,
  discardLocalStagedAttachment,
  isLocalUploadId,
  readLocalAttachmentBytes,
} from "./attachments/local-store.js";
import type { RoomMessageAttachmentPayload } from "./attachments/mappers.js";
import { attachmentFile, type AttachmentFile, type AttachmentStore } from "./attachments/store.js";
import {
  cloudRoomIdentifierForStorage,
  localRoomIdentifierForStorage,
  resolveLocalAwareRoomStorageMode,
} from "./rooms/local-store.js";
import { focusMainWindow } from "./window.js";

const { dialog } = electron as typeof import("electron");

export {
  mapRoomMessageAttachmentPayload,
  type RoomMessageAttachmentPayload,
} from "./attachments/mappers.js";
export { handleAttachmentProtocolRequest } from "./attachments/protocol.js";
export {
  readLocalStagedAttachments,
  releaseLocalStagedAttachments,
} from "./attachments/local-store.js";
export type { AttachmentStore } from "./attachments/store.js";

/** Resolve where this room's attachments live; the only place that checks the room's storage mode. */
export async function resolveAttachmentStore(roomIdentifier: string): Promise<AttachmentStore> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  if (!trimmedRoomIdentifier) {
    throw new Error("Choose a room before attaching files.");
  }
  const storage = await resolveLocalAwareRoomStorageMode(trimmedRoomIdentifier);
  return storage.effectiveMode === "local"
    ? createLocalAttachmentStore(localRoomIdentifierForStorage(storage, trimmedRoomIdentifier))
    : createCloudAttachmentStore(cloudRoomIdentifierForStorage(storage, trimmedRoomIdentifier));
}

export async function pickAndStageDesktopAttachments(
  roomIdentifier: string,
): Promise<DesktopStagedAttachment[]> {
  const store = await resolveAttachmentStore(roomIdentifier);
  focusMainWindow();
  const result = await dialog.showOpenDialog({
    title: "Attach files",
    buttonLabel: "Attach",
    properties: ["openFile", "multiSelections"],
  });
  if (result.canceled || result.filePaths.length === 0) return [];

  // Refuse an oversized pick before any file is read or staged.
  for (const filePath of result.filePaths) {
    assertMessageAttachmentFits(basename(filePath), (await stat(filePath)).size);
  }
  return stageAll(store, result.filePaths.map((filePath) => async () =>
    attachmentFile({ fileName: basename(filePath), bytes: await readFile(filePath) })));
}

export async function stageDroppedDesktopAttachmentContents(
  roomIdentifier: string,
  files: DesktopDroppedAttachmentContent[],
): Promise<DesktopStagedAttachment[]> {
  const store = await resolveAttachmentStore(roomIdentifier);
  return stageAll(store, files.filter((file) => file.contentBase64).map((file) => async () => attachmentFile({
    fileName: file.fileName,
    mimeType: file.mimeType,
    bytes: Buffer.from(file.contentBase64, "base64"),
  })));
}

/** Stage every file or none: a failure discards the files this call already staged. */
async function stageAll(store: AttachmentStore, files: Array<() => Promise<AttachmentFile>>): Promise<DesktopStagedAttachment[]> {
  const staged: DesktopStagedAttachment[] = [];
  try {
    for (const file of files) staged.push(await store.stage(await file()));
  } catch (error) {
    await Promise.all(staged.map((attachment) => store.discard(attachment.uploadId).catch(() => undefined)));
    throw error;
  }
  return staged;
}

export async function discardDesktopAttachment(
  roomIdentifier: string,
  uploadId: string,
): Promise<void> {
  const trimmedUploadId = uploadId.trim();
  if (!roomIdentifier.trim() || !trimmedUploadId) return;
  if (isLocalUploadId(trimmedUploadId)) {
    await discardLocalStagedAttachment(trimmedUploadId);
    return;
  }
  const store = await resolveAttachmentStore(roomIdentifier);
  if (store.kind === "local") return;
  await store.discard(trimmedUploadId);
}

/** Publishing a local room to the cloud re-stages each stored file in the cloud room. */
export async function publishLocalAttachmentPayload(
  cloudRoomIdentifier: string,
  attachment: RoomMessageAttachmentPayload,
): Promise<{ upload_id: string }> {
  const staged = await createCloudAttachmentStore(cloudRoomIdentifier).stage(attachmentFile({
    fileName: attachment.file_name || attachment.filename || attachment.name,
    mimeType: attachment.mime_type || attachment.content_type,
    bytes: await readLocalAttachmentBytes(attachment),
  }));
  return { upload_id: staged.uploadId };
}
