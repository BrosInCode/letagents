import { ref, watch, type Ref } from "vue";
import type {
  DesktopDroppedAttachmentContent,
  DesktopStagedAttachment,
} from "../../../../../../electron/ipc-types";
import type { PendingAttachmentDraft } from "../DesktopAttachmentDrafts.vue";
import { formatBytes } from "../attachments/formatting";
import { desktopIpc } from "../../../../ipc/index.js";
import {
  hasDraggedFiles,
  readDroppedAttachmentContent,
  toPendingAttachmentDraft,
} from "./attachment-utils";

const maxAttachments = 4;
const maxAttachmentBytes = 25 * 1024 * 1024;

interface RoomAttachmentsOptions {
  roomIdentifier: Readonly<Ref<string | null>>;
  discardAttachment: (uploadId: string) => void;
}

export function useRoomAttachments(options: RoomAttachmentsOptions) {
  const attachmentDrafts = ref<DesktopStagedAttachment[]>([]);
  const pendingAttachmentDrafts = ref<PendingAttachmentDraft[]>([]);
  const attachmentError = ref<string | null>(null);
  const attaching = ref(false);
  const isDraggingAttachment = ref(false);
  let attachmentDragDepth = 0;

  watch(options.roomIdentifier, () => {
    attachmentError.value = null;
    attachmentDrafts.value = [];
    pendingAttachmentDrafts.value = [];
    isDraggingAttachment.value = false;
    attachmentDragDepth = 0;
  });

  async function pickAttachments(): Promise<void> {
    if (attaching.value || !options.roomIdentifier.value) return;
    attaching.value = true;
    attachmentError.value = null;
    try {
      const staged = await desktopIpc.room.pickAttachments(options.roomIdentifier.value);
      attachmentDrafts.value = [...attachmentDrafts.value, ...staged];
    } catch (error) {
      attachmentError.value = error instanceof Error ? error.message : "Attachment could not be added.";
    } finally {
      attaching.value = false;
    }
  }

  async function stageDroppedAttachments(files: File[]): Promise<void> {
    if (attaching.value || files.length === 0) return;
    if (!options.roomIdentifier.value) {
      attachmentError.value = "Choose a room before attaching files.";
      return;
    }
    attachmentError.value = null;
    const availableSlots = Math.max(0, maxAttachments - attachmentDrafts.value.length - pendingAttachmentDrafts.value.length);
    if (availableSlots <= 0) {
      attachmentError.value = `Attach up to ${maxAttachments} files per message.`;
      return;
    }
    const acceptedFiles = files.slice(0, availableSlots);
    if (files.length > availableSlots) {
      attachmentError.value = `Attach up to ${maxAttachments} files per message.`;
    }
    const validFiles = acceptedFiles.filter((file) => {
      if (file.size <= maxAttachmentBytes) return true;
      attachmentError.value = `${file.name || "Attachment"} is larger than ${formatBytes(maxAttachmentBytes)}.`;
      return false;
    });
    if (!validFiles.length) return;

    const pendingDrafts = validFiles.map(toPendingAttachmentDraft);
    pendingAttachmentDrafts.value = [...pendingAttachmentDrafts.value, ...pendingDrafts];
    attaching.value = true;
    try {
      const stageDroppedAttachmentContents = desktopIpc.room.stageDroppedAttachmentContents;
      if (!stageDroppedAttachmentContents) {
        throw new Error("Restart LetAgents Desktop to enable drag and drop attachments.");
      }
      const droppedFiles: DesktopDroppedAttachmentContent[] = [];
      for (const file of validFiles) {
        droppedFiles.push(await readDroppedAttachmentContent(file));
      }
      pendingAttachmentDrafts.value = pendingAttachmentDrafts.value.map((attachment) => {
        const draftIndex = pendingDrafts.findIndex((draft) => draft.localId === attachment.localId);
        if (draftIndex < 0) return attachment;
        const droppedFile = droppedFiles[draftIndex];
        if (!droppedFile?.contentBase64 || !droppedFile.mimeType.startsWith("image/")) return attachment;
        return {
          ...attachment,
          previewDataUrl: `data:${droppedFile.mimeType};base64,${droppedFile.contentBase64}`,
        };
      });
      const staged = await stageDroppedAttachmentContents(options.roomIdentifier.value, droppedFiles);
      attachmentDrafts.value = [...attachmentDrafts.value, ...staged];
    } catch (error) {
      attachmentError.value = error instanceof Error ? error.message : "Attachment could not be added.";
    } finally {
      const pendingIds = new Set(pendingDrafts.map((attachment) => attachment.localId));
      pendingAttachmentDrafts.value = pendingAttachmentDrafts.value.filter((attachment) => !pendingIds.has(attachment.localId));
      attaching.value = false;
    }
  }

  async function removeAttachment(uploadId: string): Promise<void> {
    attachmentDrafts.value = attachmentDrafts.value.filter((attachment) => attachment.uploadId !== uploadId);
    options.discardAttachment(uploadId);
  }

  function clearAttachmentDrafts(): void {
    attachmentDrafts.value = [];
  }

  function handleAttachmentDragEnter(event: DragEvent): void {
    if (!hasDraggedFiles(event)) return;
    attachmentDragDepth += 1;
    isDraggingAttachment.value = true;
  }

  function handleAttachmentDragOver(event: DragEvent): void {
    if (!hasDraggedFiles(event)) return;
    if (event.dataTransfer) event.dataTransfer.dropEffect = options.roomIdentifier.value ? "copy" : "none";
    isDraggingAttachment.value = true;
  }

  function handleAttachmentDragLeave(event: DragEvent): void {
    if (!hasDraggedFiles(event)) return;
    attachmentDragDepth = Math.max(0, attachmentDragDepth - 1);
    if (attachmentDragDepth === 0) {
      isDraggingAttachment.value = false;
    }
  }

  function handleAttachmentDrop(event: DragEvent): void {
    if (!hasDraggedFiles(event)) return;
    attachmentDragDepth = 0;
    isDraggingAttachment.value = false;
    const files = Array.from(event.dataTransfer?.files || []);
    void stageDroppedAttachments(files);
  }

  return {
    attaching,
    attachmentDrafts,
    attachmentError,
    clearAttachmentDrafts,
    handleAttachmentDragEnter,
    handleAttachmentDragLeave,
    handleAttachmentDragOver,
    handleAttachmentDrop,
    isDraggingAttachment,
    pendingAttachmentDrafts,
    pickAttachments,
    removeAttachment,
    stageDroppedAttachments,
  };
}
