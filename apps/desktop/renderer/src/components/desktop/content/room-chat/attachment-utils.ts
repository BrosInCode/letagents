import type {
  DesktopDroppedAttachmentContent,
  DesktopRoomMessageAttachment,
} from "../../../../../../electron/ipc-types";
import type { PendingAttachmentDraft } from "../DesktopAttachmentDrafts.vue";

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
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

export function isImageAttachment(attachment: DesktopRoomMessageAttachment): boolean {
  return attachmentMimeType(attachment).startsWith("image/") && attachmentHref(attachment) !== "#";
}

export function hasDraggedFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types || []).includes("Files");
}

export function toPendingAttachmentDraft(file: File): PendingAttachmentDraft {
  return {
    localId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    fileName: file.name || "attachment",
    mimeType: file.type || "application/octet-stream",
    sizeBytes: file.size,
    previewDataUrl: null,
  };
}

export async function readDroppedAttachmentContent(file: File): Promise<DesktopDroppedAttachmentContent> {
  const dataUrl = await readFileAsDataUrl(file);
  const [, contentBase64 = ""] = dataUrl.split(",", 2);
  return {
    fileName: file.name || "attachment",
    mimeType: file.type || "application/octet-stream",
    sizeBytes: file.size,
    contentBase64,
  };
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")));
    reader.addEventListener("error", () => reject(reader.error || new Error(`${file.name || "Attachment"} could not be read.`)));
    reader.readAsDataURL(file);
  });
}
