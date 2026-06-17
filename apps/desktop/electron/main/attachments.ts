import { dialog } from "electron";
import { Buffer } from "node:buffer";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  DesktopDroppedAttachmentContent,
  DesktopStagedAttachment,
} from "../ipc-types.js";
import type { RoomMessageAttachmentPayload } from "./attachments/mappers.js";
import { apiFetch, readStoredAuth } from "./auth.js";
import { localFilesPath } from "./chat-storage/settings.js";
import {
  cloudRoomIdentifierForStorage,
  localRoomIdentifierForStorage,
  resolveLocalAwareRoomStorageMode,
} from "./rooms/local-store.js";
import { apiUrl } from "./paths.js";
import { focusMainWindow } from "./window.js";

export {
  mapRoomMessageAttachmentPayload,
  type RoomMessageAttachmentPayload,
} from "./attachments/mappers.js";

type LocalStagedAttachment = {
  uploadId: string;
  roomIdentifier: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  filePath: string;
  previewDataUrl: string | null;
};

const localStagedAttachments = new Map<string, LocalStagedAttachment>();

function resolveAttachmentProxyTarget(rawUrl: string): URL {
  const apiOrigin = new URL(apiUrl).origin;
  const target = rawUrl.startsWith("/")
    ? new URL(rawUrl, apiOrigin)
    : new URL(rawUrl);
  if (target.origin !== apiOrigin) {
    throw new Error("Attachment proxy target is outside LetAgents API.");
  }
  return target;
}

export async function handleAttachmentProtocolRequest(
  request: Request,
): Promise<Response> {
  try {
    const requestUrl = new URL(request.url);
    const encodedTarget = requestUrl.pathname.replace(/^\/+/, "");
    if (!encodedTarget) {
      return new Response("Missing attachment target.", { status: 400 });
    }

    const rawTarget = Buffer.from(encodedTarget, "base64url").toString("utf8");
    const target = resolveAttachmentProxyTarget(rawTarget);
    const storedAuth = await readStoredAuth();
    const headers = new Headers();
    if (storedAuth.token) {
      headers.set("Authorization", `Bearer ${storedAuth.token}`);
    }

    const response = await fetch(target, { headers });
    return response;
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : "Attachment unavailable.",
      { status: 502 },
    );
  }
}

export async function pickAndStageDesktopAttachments(
  roomIdentifier: string,
): Promise<DesktopStagedAttachment[]> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  if (!trimmedRoomIdentifier) {
    throw new Error("Choose a room before attaching files.");
  }
  const storage = await resolveLocalAwareRoomStorageMode(trimmedRoomIdentifier);
  const effectiveRoomIdentifier = storage.effectiveMode === "local"
    ? localRoomIdentifierForStorage(storage, trimmedRoomIdentifier)
    : cloudRoomIdentifierForStorage(storage, trimmedRoomIdentifier);

  focusMainWindow();
  const result = await dialog.showOpenDialog({
    title: "Attach files",
    buttonLabel: "Attach",
    properties: ["openFile", "multiSelections"],
  });
  if (result.canceled || result.filePaths.length === 0) return [];

  const staged: DesktopStagedAttachment[] = [];
  for (const filePath of result.filePaths) {
    staged.push(
      storage.effectiveMode === "local"
        ? await stageLocalDesktopAttachmentFile(effectiveRoomIdentifier, filePath)
        : await stageDesktopAttachmentFile(effectiveRoomIdentifier, filePath),
    );
  }
  return staged;
}

export async function stageDroppedDesktopAttachmentContents(
  roomIdentifier: string,
  files: DesktopDroppedAttachmentContent[],
): Promise<DesktopStagedAttachment[]> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  if (!trimmedRoomIdentifier) {
    throw new Error("Choose a room before attaching files.");
  }
  const storage = await resolveLocalAwareRoomStorageMode(trimmedRoomIdentifier);
  const effectiveRoomIdentifier = storage.effectiveMode === "local"
    ? localRoomIdentifierForStorage(storage, trimmedRoomIdentifier)
    : cloudRoomIdentifierForStorage(storage, trimmedRoomIdentifier);

  const droppedFiles = files
    .map((file) => ({
      fileName: file.fileName?.trim() || "attachment",
      mimeType:
        file.mimeType?.trim() || guessMimeType(file.fileName || "attachment"),
      sizeBytes: file.sizeBytes,
      contentBase64: file.contentBase64,
    }))
    .filter((file) => file.contentBase64);
  if (droppedFiles.length === 0) return [];

  const staged: DesktopStagedAttachment[] = [];
  for (const file of droppedFiles) {
    const fileBuffer = Buffer.from(file.contentBase64, "base64");
    staged.push(
      storage.effectiveMode === "local"
        ? await stageLocalDesktopAttachmentBuffer(
            effectiveRoomIdentifier,
            fileBuffer,
            file.fileName,
            file.mimeType || guessMimeType(file.fileName),
          )
        : await stageDesktopAttachmentBuffer(
            effectiveRoomIdentifier,
            fileBuffer,
            file.fileName,
            file.mimeType || guessMimeType(file.fileName),
          ),
    );
  }
  return staged;
}

async function stageDesktopAttachmentFile(
  roomIdentifier: string,
  filePath: string,
  displayFileName?: string,
): Promise<DesktopStagedAttachment> {
  const fileBuffer = await readFile(filePath);
  const fileName = displayFileName || basename(filePath);
  const mimeType = guessMimeType(fileName);
  return stageDesktopAttachmentBuffer(
    roomIdentifier,
    fileBuffer,
    fileName,
    mimeType,
  );
}

async function stageDesktopAttachmentBuffer(
  roomIdentifier: string,
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string,
): Promise<DesktopStagedAttachment> {
  const target = await apiFetch<{
    upload_id?: string;
    upload_url?: string;
    url?: string;
    method?: string;
    fields?: Record<string, string>;
    headers?: Record<string, string>;
    attachment?: { upload_id?: string };
  }>(`/rooms/${encodeURIComponent(roomIdentifier)}/attachments/uploads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      file_name: fileName,
      mime_type: mimeType,
      size_bytes: fileBuffer.byteLength,
    }),
  });

  const uploadId = target.upload_id || target.attachment?.upload_id;
  const uploadUrl = target.upload_url || target.url;
  if (!uploadId || !uploadUrl) {
    throw new Error(`${fileName} could not be staged.`);
  }

  const uploadResponse = target.fields
    ? await uploadDesktopAttachmentForm(uploadUrl, target.fields, fileBuffer, fileName, mimeType)
    : await uploadDesktopAttachmentPut(uploadUrl, target, fileBuffer, mimeType);
  if (!uploadResponse.ok) {
    await discardDesktopAttachment(roomIdentifier, uploadId).catch(
      () => undefined,
    );
    throw new Error(
      `${fileName} upload failed with HTTP ${uploadResponse.status}.`,
    );
  }

  return {
    uploadId,
    fileName,
    mimeType,
    sizeBytes: fileBuffer.byteLength,
    previewDataUrl: mimeType.startsWith("image/")
      ? `data:${mimeType};base64,${fileBuffer.toString("base64")}`
      : null,
  };
}

async function stageLocalDesktopAttachmentFile(
  roomIdentifier: string,
  filePath: string,
  displayFileName?: string,
): Promise<DesktopStagedAttachment> {
  const fileBuffer = await readFile(filePath);
  const fileName = displayFileName || basename(filePath);
  return stageLocalDesktopAttachmentBuffer(
    roomIdentifier,
    fileBuffer,
    fileName,
    guessMimeType(fileName),
  );
}

async function stageLocalDesktopAttachmentBuffer(
  roomIdentifier: string,
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string,
): Promise<DesktopStagedAttachment> {
  const uploadId = `local:${randomUUID()}`;
  const safeFileName = fileName.replace(/[^\w .@()-]/g, "_") || "attachment";
  const roomDir = join(localFilesPath, safePathSegment(roomIdentifier));
  await mkdir(roomDir, { recursive: true });
  const filePath = join(roomDir, `${uploadId.replace(/^local:/, "")}-${safeFileName}`);
  await writeFile(filePath, fileBuffer);
  const previewDataUrl = mimeType.startsWith("image/")
    ? `data:${mimeType};base64,${fileBuffer.toString("base64")}`
    : null;
  localStagedAttachments.set(uploadId, {
    uploadId,
    roomIdentifier,
    fileName,
    mimeType,
    sizeBytes: fileBuffer.byteLength,
    filePath,
    previewDataUrl,
  });
  return {
    uploadId,
    fileName,
    mimeType,
    sizeBytes: fileBuffer.byteLength,
    previewDataUrl,
  };
}

export function consumeLocalStagedAttachments(
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
    localStagedAttachments.delete(uploadId);
    const fileUrl = pathToFileURL(staged.filePath).toString();
    consumed.push({
      id: staged.uploadId,
      file_name: staged.fileName,
      mime_type: staged.mimeType,
      size_bytes: staged.sizeBytes,
      url: fileUrl,
      download_url: fileUrl,
      data_url: staged.previewDataUrl,
    });
  }
  return consumed;
}

export async function publishLocalAttachmentPayload(
  cloudRoomIdentifier: string,
  attachment: RoomMessageAttachmentPayload,
): Promise<{ upload_id: string }> {
  const fileName =
    attachment.file_name ||
    attachment.filename ||
    attachment.name ||
    "attachment";
  const mimeType =
    attachment.mime_type ||
    attachment.content_type ||
    guessMimeType(fileName);
  const fileBuffer = await readLocalAttachmentBuffer(attachment);
  const staged = await stageDesktopAttachmentBuffer(
    cloudRoomIdentifier,
    fileBuffer,
    fileName,
    mimeType,
  );
  return { upload_id: staged.uploadId };
}

async function readLocalAttachmentBuffer(
  attachment: RoomMessageAttachmentPayload,
): Promise<Buffer> {
  if (attachment.url?.startsWith("file:")) {
    return readFile(fileURLToPath(attachment.url));
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

async function uploadDesktopAttachmentForm(
  uploadUrl: string,
  fields: Record<string, string>,
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string,
): Promise<Response> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  const fileBytes = new ArrayBuffer(fileBuffer.byteLength);
  new Uint8Array(fileBytes).set(fileBuffer);
  form.append("file", new Blob([fileBytes], { type: mimeType }), fileName);
  return fetch(uploadUrl, {
    method: "POST",
    body: form,
  });
}

async function uploadDesktopAttachmentPut(
  uploadUrl: string,
  target: { method?: string; headers?: Record<string, string> },
  fileBuffer: Buffer,
  mimeType: string,
): Promise<Response> {
  const uploadHeaders = new Headers(target.headers || {});
  if (
    ![...uploadHeaders.keys()].some(
      (key) => key.toLowerCase() === "content-type",
    )
  ) {
    uploadHeaders.set("Content-Type", mimeType);
  }
  const uploadBody = new Uint8Array(fileBuffer).buffer;
  return fetch(uploadUrl, {
    method: target.method || "PUT",
    headers: uploadHeaders,
    body: uploadBody,
  });
}

export async function discardDesktopAttachment(
  roomIdentifier: string,
  uploadId: string,
): Promise<void> {
  if (!roomIdentifier.trim() || !uploadId.trim()) return;
  if (uploadId.startsWith("local:")) {
    const staged = localStagedAttachments.get(uploadId);
    if (staged) {
      localStagedAttachments.delete(uploadId);
      await rm(staged.filePath, { force: true }).catch(() => undefined);
    }
    return;
  }
  const storage = await resolveLocalAwareRoomStorageMode(roomIdentifier);
  if (storage.effectiveMode === "local") return;
  const cloudRoomIdentifier = cloudRoomIdentifierForStorage(storage, roomIdentifier);
  await apiFetch(
    `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/attachments/uploads/${encodeURIComponent(uploadId.trim())}`,
    {
      method: "DELETE",
    },
  );
}

function safePathSegment(value: string): string {
  return value.replace(/[^\w.-]/g, "_") || "room";
}

function guessMimeType(fileName: string): string {
  const extension = fileName.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    gif: "image/gif",
    heic: "image/heic",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    json: "application/json",
    md: "text/markdown",
    pdf: "application/pdf",
    png: "image/png",
    txt: "text/plain",
    webp: "image/webp",
  };
  return extension
    ? map[extension] || "application/octet-stream"
    : "application/octet-stream";
}
