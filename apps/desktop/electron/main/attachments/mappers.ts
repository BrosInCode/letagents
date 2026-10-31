import type { DesktopRoomMessage } from "../../ipc-types.js";
import { cloudAttachmentHref, localAttachmentHref } from "./links.js";

/** The stored or wire shape of a message attachment: cloud payloads and local rows both use it. */
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

/** Every alias and storage variant ends here: the screen gets one name, one type and one link. */
export function mapRoomMessageAttachmentPayload(
  attachment: RoomMessageAttachmentPayload,
): DesktopRoomMessage["attachments"][number] {
  const mimeType = attachment.mime_type || attachment.content_type || "application/octet-stream";
  return {
    id: attachment.id || null,
    fileName: attachment.file_name || attachment.filename || attachment.name || "attachment",
    mimeType,
    sizeBytes: attachment.size_bytes ?? attachment.byte_size ?? null,
    href: attachmentHref(attachment, mimeType),
  };
}

function attachmentHref(attachment: RoomMessageAttachmentPayload, mimeType: string): string | null {
  const link = attachment.download_url || attachment.url || null;
  if (link?.startsWith("file:")) {
    const localHref = localAttachmentHref(link);
    if (localHref) return localHref;
  } else if (link) {
    const cloudHref = cloudAttachmentHref(link);
    if (cloudHref) return cloudHref;
  }
  // Rows written before local files were stored once keep an inline copy.
  if (attachment.data_url?.startsWith("data:")) return attachment.data_url;
  if (attachment.content_base64) return `data:${mimeType};base64,${attachment.content_base64}`;
  return null;
}
