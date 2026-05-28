import { Buffer } from "node:buffer";

import type { DesktopRoomMessage } from "../../ipc-types.js";
import { apiUrl, attachmentProtocolScheme } from "../paths.js";

export type RoomMessageAttachmentPayload = {
  id?: string | null;
  name?: string | null;
  file_name?: string | null;
  filename?: string | null;
  mime_type?: string | null;
  content_type?: string | null;
  size_bytes?: number | null;
  byte_size?: number | null;
  url?: string | null;
  download_url?: string | null;
  data_url?: string | null;
  content_base64?: string | null;
};

export function mapRoomMessageAttachmentPayload(
  attachment: RoomMessageAttachmentPayload,
): DesktopRoomMessage["attachments"][number] {
  const rawUrl = attachment.url || null;
  const rawDownloadUrl = attachment.download_url || null;
  return {
    id: attachment.id || null,
    name: attachment.name || null,
    fileName: attachment.file_name || attachment.filename || null,
    mimeType: attachment.mime_type || attachment.content_type || null,
    sizeBytes: attachment.size_bytes ?? attachment.byte_size ?? null,
    url: rawUrl ? proxiedAttachmentUrl(rawUrl) : null,
    downloadUrl: rawDownloadUrl ? proxiedAttachmentUrl(rawDownloadUrl) : null,
    dataUrl: attachment.data_url || null,
    contentBase64: attachment.content_base64 || null,
  };
}

function proxiedAttachmentUrl(rawUrl: string): string {
  if (!shouldProxyAttachmentUrl(rawUrl)) return rawUrl;
  const encoded = Buffer.from(rawUrl, "utf8").toString("base64url");
  return `${attachmentProtocolScheme}://download/${encoded}`;
}

function shouldProxyAttachmentUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/")) return true;
  try {
    const target = new URL(trimmed);
    return target.origin === new URL(apiUrl).origin;
  } catch {
    return false;
  }
}
