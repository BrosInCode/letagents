import type { DesktopDroppedAttachmentContent } from "../../../../../../electron/ipc-types";
import type { PendingAttachmentDraft } from "../DesktopAttachmentDrafts.vue";

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
