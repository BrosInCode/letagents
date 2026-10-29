import electron from "electron";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

import { assertMessageAttachmentFits, MESSAGE_ATTACHMENT_LIMITS } from "../../../../shared/message-attachments.mjs";
import type {
  DesktopChosenAttachment,
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
import { attachmentFile, stagedAttachment, type AttachmentFile, type AttachmentStore } from "./attachments/store.js";
import {
  cloudRoomIdentifierForStorage,
  localRoomIdentifierForStorage,
  resolveLocalAwareRoomStorageMode,
} from "./rooms/local-store.js";
import { focusMainWindow, getMainWindow } from "./window.js";

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

/**
 * Files chosen in the picker, held in main until the composer stages them.
 * The composer shows a chip as soon as the picker closes; the upload runs after.
 */
const chosenAttachments = new Map<string, AttachmentFile>();
// A choice the composer never stages (room switched, window closed) is dropped.
const CHOSEN_ATTACHMENT_TTL_MS = 10 * 60_000;

/** `limit` is how many files the composer still has room for; files past it are never read. */
export async function chooseDesktopAttachmentFiles(limit: number = MESSAGE_ATTACHMENT_LIMITS.maxFiles): Promise<DesktopChosenAttachment[]> {
  focusMainWindow();
  const parent = getMainWindow();
  const options: Electron.OpenDialogOptions = {
    title: "Attach files",
    buttonLabel: "Attach",
    properties: ["openFile", "multiSelections"],
  };
  // A sheet on the main window cannot fall behind it; a detached picker can,
  // and then the attach request never answers.
  const result = await (parent && !parent.isDestroyed()
    ? dialog.showOpenDialog(parent, options)
    : dialog.showOpenDialog(options));
  const cap = Math.max(0, Math.min(Math.floor(Number(limit) || 0), MESSAGE_ATTACHMENT_LIMITS.maxFiles));
  const filePaths = result.canceled ? [] : result.filePaths.slice(0, cap);
  if (filePaths.length === 0) return [];

  // Refuse an oversized pick before any file is read.
  for (const filePath of filePaths) {
    assertMessageAttachmentFits(basename(filePath), (await stat(filePath)).size);
  }
  const files = await Promise.all(filePaths.map(async (filePath) =>
    attachmentFile({ fileName: basename(filePath), bytes: await readFile(filePath) })));
  return files.map((file) => {
    const token = randomUUID();
    chosenAttachments.set(token, file);
    setTimeout(() => chosenAttachments.delete(token), CHOSEN_ATTACHMENT_TTL_MS).unref?.();
    const { uploadId: _unused, ...shown } = stagedAttachment(file, token);
    return { token, ...shown };
  });
}

/** Upload files chosen by chooseDesktopAttachmentFiles. Each token stages once. */
export async function stageChosenDesktopAttachments(
  roomIdentifier: string,
  tokens: string[],
): Promise<DesktopStagedAttachment[]> {
  const files = tokens.map((token) => chosenAttachments.get(token));
  for (const token of tokens) chosenAttachments.delete(token);
  if (files.some((file) => !file)) throw new Error("The chosen files are no longer available. Choose them again.");
  const store = await resolveAttachmentStore(roomIdentifier);
  const staged = await stageAll(store, (files as AttachmentFile[]).map((file) => async () => file));
  // The composer already has each image's preview from the choose step.
  return staged.map((attachment) => ({ ...attachment, previewDataUrl: null }));
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

/**
 * Stage every file or none, all at once: each upload is two round trips, so
 * one after another made a four-file message wait for eight. A failure
 * discards the files this call staged.
 */
async function stageAll(store: AttachmentStore, files: Array<() => Promise<AttachmentFile>>): Promise<DesktopStagedAttachment[]> {
  const results = await Promise.allSettled(files.map(async (file) => store.stage(await file())));
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  const staged = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  if (failed) {
    await Promise.all(staged.map((attachment) => store.discard(attachment.uploadId).catch(() => undefined)));
    throw failed.reason;
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
