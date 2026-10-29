import { ref, watch, type Ref } from "vue";
import type {
  DesktopChosenAttachment,
  DesktopStagedAttachment,
} from "../../../../../../electron/ipc-types";
import type { PendingAttachmentDraft } from "../DesktopAttachmentDrafts.vue";
import { formatBytes } from "../attachments/formatting";
import { attachmentProblemFromError, type AttachmentProblem } from "./attachment-problems";
import { desktopIpc } from "../../../../ipc/index.js";
import {
  hasDraggedFiles,
  readDroppedAttachmentContent,
  releasePendingPreview,
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
  // The last attempt, for "Try again": the picker, or the same dropped files.
  let lastAttempt: { kind: "pick" } | { kind: "drop"; files: File[] } | null = null;
  // True while the file picker is open. Uploads show as pending chips instead.
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

  function availableSlots(): number {
    return Math.max(0, maxAttachments - attachmentDrafts.value.length - pendingAttachmentDrafts.value.length);
  }

  /** Keep what fits in the free slots; say so when some files do not fit. */
  function takeWhatFits<T>(files: T[]): T[] {
    const slots = availableSlots();
    if (files.length > slots) attachmentProblem.value = { kind: "too-many", max: maxAttachments };
    return files.slice(0, slots);
  }

  /**
   * Show the chips now and upload behind them. A chip appears the moment a file
   * is chosen, pasted or dropped; it becomes a sendable attachment when its
   * upload finishes. Several batches can upload at the same time.
   */
  async function uploadBehindChips(
    pendingDrafts: PendingAttachmentDraft[],
    stage: (roomIdentifier: string) => Promise<DesktopStagedAttachment[]>,
    failedFileName: string | null,
  ): Promise<void> {
    const roomIdentifier = options.roomIdentifier.value;
    if (!roomIdentifier || !pendingDrafts.length) return;
    pendingAttachmentDrafts.value = [...pendingAttachmentDrafts.value, ...pendingDrafts];
    try {
      const staged = await stage(roomIdentifier);
      // A room switch cleared the drafts; the server expires uploads nobody sends.
      if (options.roomIdentifier.value === roomIdentifier) attachmentDrafts.value = [...attachmentDrafts.value, ...staged];
    } catch (error) {
      if (options.roomIdentifier.value === roomIdentifier) attachmentProblem.value = attachmentProblemFromError(error, failedFileName);
    } finally {
      const pendingIds = new Set(pendingDrafts.map((attachment) => attachment.localId));
      pendingAttachmentDrafts.value = pendingAttachmentDrafts.value.filter((attachment) => !pendingIds.has(attachment.localId));
      for (const draft of pendingDrafts) releasePendingPreview(draft);
    }
  }

  async function pickAttachments(): Promise<void> {
    if (attaching.value || !options.roomIdentifier.value) return;
    attaching.value = true;
    attachmentProblem.value = null;
    lastAttempt = { kind: "pick" };
    let chosen: DesktopChosenAttachment[];
    try {
      chosen = await desktopIpc.room.chooseAttachments();
    } catch (error) {
      attachmentProblem.value = attachmentProblemFromError(error);
      return;
    } finally {
      attaching.value = false;
    }
    const accepted = takeWhatFits(chosen);
    await uploadBehindChips(
      accepted.map(({ token, fileName, mimeType, sizeBytes, previewDataUrl }) => ({ localId: token, fileName, mimeType, sizeBytes, previewDataUrl })),
      (roomIdentifier) => desktopIpc.room.stageChosenAttachments(roomIdentifier, accepted.map((file) => file.token)),
      accepted.length === 1 ? accepted[0]!.fileName : null,
    );
  }

  async function stageDroppedAttachments(files: File[]): Promise<void> {
    if (files.length === 0) return;
    if (!options.roomIdentifier.value) {
      attachmentProblem.value = { kind: "no-room" };
      return;
    }
    attachmentProblem.value = null;
    if (availableSlots() <= 0) {
      attachmentProblem.value = { kind: "too-many", max: maxAttachments };
      return;
    }
    const validFiles = takeWhatFits(files).filter((file) => {
      if (file.size <= maxAttachmentBytes) return true;
      attachmentProblem.value = { kind: "too-large", fileName: file.name || null, limit: formatBytes(maxAttachmentBytes) };
      return false;
    });
    if (!validFiles.length) return;
    lastAttempt = { kind: "drop", files: validFiles };
    await uploadBehindChips(validFiles.map(toPendingAttachmentDraft), async (roomIdentifier) => {
      const stageDroppedAttachmentContents = desktopIpc.room.stageDroppedAttachmentContents;
      if (!stageDroppedAttachmentContents) {
        throw new Error("Restart LetAgents Desktop to enable drag and drop attachments.");
      }
      const droppedFiles = await Promise.all(validFiles.map(readDroppedAttachmentContent));
      return stageDroppedAttachmentContents(roomIdentifier, droppedFiles);
    }, validFiles.length === 1 ? validFiles[0]!.name || null : null);
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
