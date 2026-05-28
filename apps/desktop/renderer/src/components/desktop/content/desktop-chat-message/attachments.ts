import type { DesktopRoomMessageAttachment } from "../../../../../../electron/ipc-types";
import { formatBytes } from "../attachments/formatting";

export function formatDisplayBytes(bytes: number): string {
  return bytes > 0 ? formatBytes(bytes) : "";
}

export function attachmentName(attachment: DesktopRoomMessageAttachment): string {
  return attachment.fileName || attachment.name || "attachment";
}

export function attachmentMimeType(attachment: DesktopRoomMessageAttachment): string {
  return attachment.mimeType || "application/octet-stream";
}

export function attachmentHref(attachment: DesktopRoomMessageAttachment): string {
  if (attachment.url) return attachment.url;
  if (attachment.downloadUrl) return attachment.downloadUrl;
  if (attachment.dataUrl) return attachment.dataUrl;
  if (attachment.contentBase64) return `data:${attachmentMimeType(attachment)};base64,${attachment.contentBase64}`;
  return "#";
}

export function attachmentKey(attachment: DesktopRoomMessageAttachment): string {
  return attachment.id || `${attachmentName(attachment)}-${attachment.sizeBytes || 0}-${attachmentMimeType(attachment)}`;
}

export function imageAttachmentId(messageId: string, attachment: DesktopRoomMessageAttachment): string {
  return `${messageId}:${attachmentKey(attachment)}`;
}

export function attachmentMeta(attachment: DesktopRoomMessageAttachment): string {
  return [attachmentMimeType(attachment), formatBytes(attachment.sizeBytes || 0)].filter(Boolean).join(" · ");
}

export function attachmentDisplayMeta(attachment: DesktopRoomMessageAttachment): string {
  return [
    attachmentMimeType(attachment),
    formatDisplayBytes(attachment.sizeBytes || 0),
  ].filter(Boolean).join(" · ");
}

export function isImageAttachment(attachment: DesktopRoomMessageAttachment): boolean {
  return attachmentMimeType(attachment).startsWith("image/") && attachmentHref(attachment) !== "#";
}
