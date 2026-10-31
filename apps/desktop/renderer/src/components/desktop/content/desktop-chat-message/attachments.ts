import type { DesktopRoomMessageAttachment } from "../../../../../../electron/ipc-types";
import { formatBytes } from "../attachments/formatting";

export function formatDisplayBytes(bytes: number): string {
  return bytes > 0 ? formatBytes(bytes) : "";
}

export function attachmentName(attachment: DesktopRoomMessageAttachment): string {
  return attachment.fileName;
}

export function attachmentMimeType(attachment: DesktopRoomMessageAttachment): string {
  return attachment.mimeType;
}

export function attachmentHref(attachment: DesktopRoomMessageAttachment): string {
  return attachment.href || "#";
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

/**
 * An HTML file opens as an interactive demo in its own locked window. Files
 * agents attached before HTML had a type arrive as octet-stream, so the name decides.
 */
export function isHtmlDemoAttachment(attachment: DesktopRoomMessageAttachment): boolean {
  const href = attachmentHref(attachment);
  if (!href.startsWith("letagents-attachment://")) return false;
  const mimeType = attachmentMimeType(attachment).toLowerCase();
  return mimeType === "text/html"
    || mimeType === "application/xhtml+xml"
    || (mimeType === "application/octet-stream" && /\.html?$/i.test(attachmentName(attachment)));
}

/** Main's reason a demo did not open, without Electron's IPC wrapper. */
export function htmlDemoErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const text = raw.replace(/^Error invoking remote method '[^']*':\s*/, "").replace(/^(?:[A-Za-z]*Error:\s*)+/, "").trim();
  return text || "The demo could not open.";
}
