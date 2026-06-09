import { dialog } from "electron";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import type {
  DesktopDroppedAttachmentContent,
  DesktopStagedAttachment,
} from "../ipc-types.js";
import { apiFetch, readStoredAuth } from "./auth.js";
import { isLocalChatStorageEnabled } from "./chat-storage/settings.js";
import { apiUrl } from "./paths.js";
import { focusMainWindow, getMainWindow } from "./window.js";

export {
  mapRoomMessageAttachmentPayload,
  type RoomMessageAttachmentPayload,
} from "./attachments/mappers.js";

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
  if (await isLocalChatStorageEnabled()) {
    throw new Error("Attachments are not available while local chat storage is active.");
  }

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
      await stageDesktopAttachmentFile(trimmedRoomIdentifier, filePath),
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
  if (await isLocalChatStorageEnabled()) {
    throw new Error("Attachments are not available while local chat storage is active.");
  }

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
      await stageDesktopAttachmentBuffer(
        trimmedRoomIdentifier,
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
  if (await isLocalChatStorageEnabled()) return;
  await apiFetch(
    `/rooms/${encodeURIComponent(roomIdentifier.trim())}/attachments/uploads/${encodeURIComponent(uploadId.trim())}`,
    {
      method: "DELETE",
    },
  );
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
