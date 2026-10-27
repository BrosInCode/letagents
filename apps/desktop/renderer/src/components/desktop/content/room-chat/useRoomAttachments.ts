import { ref, watch, type Ref } from "vue";
import type {
  DesktopDroppedAttachmentContent,
  DesktopStagedAttachment,
} from "../../../../../../electron/ipc-types";
import type { PendingAttachmentDraft } from "../DesktopAttachmentDrafts.vue";
import { formatBytes } from "../attachments/formatting";
import { attachmentProblemFromError, type AttachmentProblem } from "./attachment-problems";
import { desktopIpc } from "../../../../ipc/index.js";
import {
  hasDraggedFiles,
  readDroppedAttachmentContent,
  toPendingAttachmentDraft,
} from "./attachment-utils";
import { MESSAGE_ATTACHMENT_LIMITS } from "../../../../../../../../shared/message-attachments.mjs";

const maxAttachments = MESSAGE_ATTACHMENT_LIMITS.maxFiles;
const maxAttachmentBytes = MESSAGE_ATTACHMENT_LIMITS.maxFileBytes;

interface RoomAttachmentsOptions {
  roomIdentifier: Readonly<Ref<string | null>>;
  discardAttachment: (uploadId: string) => void;
}

export function useRoomAttachments(options: RoomAttachmentsOptions) {
  const attachmentDrafts = ref<DesktopStagedAttachment[]>([]);
  const pendingAttachmentDrafts = ref<PendingAttachmentDraft[]>([]);
  // Each problem is a new object, so the same problem twice shows twice.
  const attachmentProblem = ref<AttachmentProblem | null>(null);
  // The attempt that failed, for "Try again": the picker, or the same dropped files.
  let lastAttempt: { kind: "pick" } | { kind: "drop"; files: File[] } | null = null;
  const attaching = ref(false);
  const isDraggingAttachment = ref(false);
  let attachmentDragDepth = 0;

  watch(options.roomIdentifier, () => {
    attachmentProblem.value = null;
    lastAttempt = null;
    attachmentDrafts.value = [];
    pendingAttachmentDrafts.value = [];
    isDraggingAttachment.value = false;
    attachmentDragDepth = 0;
  });

  async function pickAttachments(): Promise<void> {
    if (attaching.value || !options.roomIdentifier.value) return;
    attaching.value = true;
    attachmentProblem.value = null;
    lastAttempt = { kind: "pick" };
    try {
      const staged = await desktopIpc.room.pickAttachments(options.roomIdentifier.value);
      attachmentDrafts.value = [...attachmentDrafts.value, ...staged];
    } catch (error) {
      attachmentProblem.value = attachmentProblemFromError(error);
    } finally {
      attaching.value = false;
    }
  }

  async function stageDroppedAttachments(files: File[]): Promise<void> {
    if (files.length === 0) return;
    if (attaching.value) {
      attachmentProblem.value = { kind: "busy" };
      return;
    }
    if (!options.roomIdentifier.value) {
      attachmentProblem.value = { kind: "no-room" };
      return;
    }
    attachmentProblem.value = null;
    const availableSlots = Math.max(0, maxAttachments - attachmentDrafts.value.length - pendingAttachmentDrafts.value.length);
    if (availableSlots <= 0) {
      attachmentProblem.value = { kind: "too-many", max: maxAttachments };
      return;
    }
    const acceptedFiles = files.slice(0, availableSlots);
    if (files.length > availableSlots) {
      attachmentProblem.value = { kind: "too-many", max: maxAttachments };
    }
    const validFiles = acceptedFiles.filter((file) => {
      if (file.size <= maxAttachmentBytes) return true;
      attachmentProblem.value = { kind: "too-large", fileName: file.name || null, limit: formatBytes(maxAttachmentBytes) };
      return false;
    });
    if (!validFiles.length) return;

    const pendingDrafts = validFiles.map(toPendingAttachmentDraft);
    pendingAttachmentDrafts.value = [...pendingAttachmentDrafts.value, ...pendingDrafts];
    attaching.value = true;
    lastAttempt = { kind: "drop", files: validFiles };
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
      attachmentProblem.value = attachmentProblemFromError(error, validFiles.length === 1 ? validFiles[0]!.name || null : null);
    } finally {
      const pendingIds = new Set(pendingDrafts.map((attachment) => attachment.localId));
      pendingAttachmentDrafts.value = pendingAttachmentDrafts.value.filter((attachment) => !pendingIds.has(attachment.localId));
      attaching.value = false;
    }
  }

  /** "Try again": repeat the attempt that failed, with the same files. */
  function retryAttachments(): Promise<void> {
    const attempt = lastAttempt;
    if (attempt?.kind === "drop") return stageDroppedAttachments(attempt.files);
    return pickAttachments();
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
    attachmentProblem,
    clearAttachmentDrafts,
    handleAttachmentDragEnter,
    handleAttachmentDragLeave,
    handleAttachmentDragOver,
    handleAttachmentDrop,
    isDraggingAttachment,
    pendingAttachmentDrafts,
    pickAttachments,
    removeAttachment,
    retryAttachments,
    stageDroppedAttachments,
  };
}
