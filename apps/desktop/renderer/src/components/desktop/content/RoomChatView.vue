<template>
  <section
    class="room-tab-page room-chat-page"
    :data-dragging-attachments="isDraggingAttachment"
    data-testid="room-chat-view"
    @dragenter.prevent="handleAttachmentDragEnter"
    @dragover.prevent="handleAttachmentDragOver"
    @dragleave.prevent="handleAttachmentDragLeave"
    @drop.prevent="handleAttachmentDrop"
  >
    <div class="room-chat-layout">
      <div v-if="isDraggingAttachment" class="room-attachment-drop-overlay" data-testid="room-attachment-drop-overlay">
        <span>Drop files to attach</span>
      </div>
      <div class="room-message-viewport" data-testid="room-chat-viewport">
        <div ref="messagesElement" class="room-message-list" data-testid="room-chat-list" @scroll="handleScroll">
          <button
            v-if="messages.length && hasOlderMessages"
            class="room-load-older"
            type="button"
            :disabled="loadingOlderMessages"
            data-testid="desktop-load-older-messages"
            @click="$emit('load-older')"
          >
            {{ loadingOlderMessages ? "Loading earlier messages..." : "Load earlier messages" }}
          </button>

          <DesktopChatMessage
            v-for="message in messages"
            :key="message.id"
            :message="message"
            :thread-count="threadCount(message.id)"
            :latest-thread-message-id="latestThreadMessageId(message.id)"
            :highlight-query="searchQuery"
            :search-active="message.id === activeSearchMessageId"
            @reply="startReply"
            @scroll-to-message="scrollToMessage"
            @open-image="openImageViewer"
            @open-agent="openAgentModal"
          />

          <article v-if="!messages.length" class="room-empty-card" data-testid="room-chat-empty">
            <h3>Open a room to begin</h3>
            <p>Messages from humans, agents, and GitHub will appear here as the room comes alive.</p>
          </article>
        </div>
        <button
          v-if="unreadCount > 0 || isScrolledFarUp"
          class="room-new-messages-pill"
          type="button"
          data-testid="desktop-new-messages-pill"
          @click="scrollToBottom()"
        >
          {{ unreadCount > 0 ? `↓ ${unreadCount} new message${unreadCount === 1 ? "" : "s"}` : "↓ Scroll to latest" }}
        </button>
      </div>

      <form class="desktop-composer" data-testid="desktop-composer" @submit.prevent="submitMessage">
        <div class="desktop-composer-identity">
          <span>{{ composerTargetLabel }}</span>
          <span class="desktop-composer-shortcut">{{ composerPresenceLabel }}</span>
        </div>
        <div v-if="replyTo" class="desktop-composer-reply" data-testid="desktop-composer-reply">
          <div>
            <strong>Replying to {{ displaySender(replyTo.sender) }}</strong>
            <span>{{ replyPreview(replyTo.text) }}</span>
          </div>
          <button type="button" @click="replyTo = null">Cancel</button>
        </div>
        <textarea
          ref="textareaElement"
          v-model="draft"
          class="desktop-composer-input"
          rows="3"
          :placeholder="roomIdentifier ? 'Write a message...' : 'Choose a room to start writing'"
          :disabled="!roomIdentifier"
          data-testid="desktop-composer-input"
          @input="handleDraftInput"
          @keydown.down.prevent="moveMentionSelection(1)"
          @keydown.up.prevent="moveMentionSelection(-1)"
          @keydown.enter="handleEnterKey"
          @keydown.escape="mentionOpen = false"
        />
        <DesktopAttachmentDrafts
          :attachments="attachmentDrafts"
          :pending-attachments="pendingAttachmentDrafts"
          @remove="removeAttachment"
        />
        <div v-if="mentionOpen" class="desktop-mention-panel" data-testid="desktop-mention-panel">
          <button
            v-for="(candidate, index) in mentionCandidates"
            :key="candidate.participantKey"
            class="desktop-mention-option"
            :data-active="index === activeMentionIndex"
            :data-testid="`desktop-mention-option-${candidate.participantKey}`"
            type="button"
            @click="insertMention(candidate.displayName)"
          >
            <span>{{ candidate.displayName }}</span>
            <small>{{ candidate.kind === "agent" ? "Agent" : "Human" }}</small>
          </button>
        </div>
        <div class="desktop-composer-footer">
          <p v-if="sendError || attachmentError" class="desktop-composer-error" data-testid="desktop-composer-error">
            {{ sendError || attachmentError }}
          </p>
          <p v-else class="desktop-composer-hint">{{ composerHint }}</p>
          <button
            class="desktop-composer-attach"
            type="button"
            :disabled="sending || !roomIdentifier || attaching"
            :title="attaching ? 'Attaching' : 'Attach files'"
            :aria-label="attaching ? 'Attaching files' : 'Attach files'"
            data-testid="desktop-composer-attach"
            @click="pickAttachments"
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="m21.4 11.6-8.5 8.5a6 6 0 0 1-8.5-8.5l8.8-8.8a4 4 0 1 1 5.7 5.7l-8.9 8.9a2 2 0 0 1-2.8-2.8l8.1-8.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span class="sr-only">{{ attaching ? "Attaching files" : "Attach files" }}</span>
          </button>
          <button
            class="desktop-composer-send"
            type="submit"
            :disabled="sending || !canSend"
            data-testid="desktop-composer-send"
          >
            {{ sending ? "Sending..." : "Send" }}
          </button>
        </div>
      </form>
      <DesktopImageViewerModal
        v-if="activeImageId && roomImages.length"
        :images="roomImages"
        :active-image-id="activeImageId"
        @close="activeImageId = null"
        @next="shiftImage(1)"
        @previous="shiftImage(-1)"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref, watch } from "vue";
import type {
  DesktopAgentPresence,
  DesktopDroppedAttachmentContent,
  DesktopParticipantSummary,
  DesktopReasoningSession,
  DesktopRoomMessage,
  DesktopStagedAttachment,
  DesktopTaskSummary,
} from "../../../../../electron/ipc-types";
import DesktopAttachmentDrafts, { type PendingAttachmentDraft } from "./DesktopAttachmentDrafts.vue";
import DesktopChatMessage, { type AgentModalTarget } from "./DesktopChatMessage.vue";
import DesktopImageViewerModal, { type DesktopMessageImage } from "./DesktopImageViewerModal.vue";

const props = defineProps<{
  messages: DesktopRoomMessage[];
  roomIdentifier: string | null;
  sending: boolean;
  sendError: string | null;
  hasOlderMessages: boolean;
  loadingOlderMessages: boolean;
  participants: DesktopParticipantSummary[];
  presence: DesktopAgentPresence[];
  reasoningSessions: DesktopReasoningSession[];
  tasks: DesktopTaskSummary[];
  searchQuery: string;
  activeSearchMessageId: string | null;
  initialScrollTop?: number | null;
  initialDraft?: string;
}>();

const emit = defineEmits<{
  "send-message": [text: string, replyTo: string | null, attachments: Array<{ upload_id: string }>];
  "load-older": [];
  "discard-attachment": [uploadId: string];
  "open-reasoning": [sessionId: string];
  "open-agent-reasoning-fallback": [target: AgentModalTarget];
  "scroll-position": [scrollTop: number | null];
  "draft-change": [text: string];
}>();

const draft = ref(props.initialDraft || "");
const textareaElement = ref<HTMLTextAreaElement | null>(null);
const messagesElement = ref<HTMLElement | null>(null);
const replyTo = ref<DesktopRoomMessage | null>(null);
const activeImageId = ref<string | null>(null);
const mentionQuery = ref<string | null>(null);
const activeMentionIndex = ref(0);
const attachmentDrafts = ref<DesktopStagedAttachment[]>([]);
const pendingAttachmentDrafts = ref<PendingAttachmentDraft[]>([]);
const attachmentError = ref<string | null>(null);
const attaching = ref(false);
const isDraggingAttachment = ref(false);
const unreadCount = ref(0);
const isScrolledFarUp = ref(false);
let isScrolledToBottom = true;
let restoredScrollTop: number | null | undefined;
let attachmentDragDepth = 0;
let initialScrollSettled = false;
let pendingInitialScrollFrame: number | null = null;
let pendingInitialScrollToken = 0;
let componentUnmounted = false;
const maxAttachments = 4;
const maxAttachmentBytes = 25 * 1024 * 1024;

const canSend = computed(() => Boolean(props.roomIdentifier && (draft.value.trim() || attachmentDrafts.value.length > 0)));
const reachableParticipantCount = computed(() =>
  props.participants.filter((participant) => participant.activityState !== "offline").length
);
const composerTargetLabel = computed(() => props.roomIdentifier ? "Message the room" : "No room selected");
const composerPresenceLabel = computed(() => {
  if (!props.roomIdentifier) return "Open a room before sending";
  if (reachableParticipantCount.value === 0) return "No reachable participants";
  if (reachableParticipantCount.value === 1) return "1 reachable participant";
  return `${reachableParticipantCount.value} reachable participants`;
});
const composerHint = computed(() =>
  props.roomIdentifier
    ? "Use @ to bring a person or agent into the thread."
    : "Select a room from the sidebar to enable chat."
);
const mentionOpen = computed({
  get: () => mentionQuery.value !== null && mentionCandidates.value.length > 0,
  set: (value: boolean) => {
    if (!value) mentionQuery.value = null;
  },
});
const mentionCandidates = computed(() => {
  const query = (mentionQuery.value || "").toLowerCase();
  return props.participants
    .filter((participant) => participant.activityState !== "offline")
    .filter((participant) => participant.displayName.toLowerCase().includes(query))
    .slice(0, 6);
});
const threadSummaries = computed(() => {
  const summaries = new Map<string, { count: number; latest: DesktopRoomMessage | null }>();
  for (const message of props.messages) {
    const parentId = message.replyTo?.id;
    if (!parentId) continue;
    const summary = summaries.get(parentId) || { count: 0, latest: null };
    summary.count += 1;
    summary.latest = message;
    summaries.set(parentId, summary);
  }
  return summaries;
});
const roomImages = computed<DesktopMessageImage[]>(() => {
  const images: DesktopMessageImage[] = [];
  for (const message of props.messages) {
    for (const attachment of message.attachments || []) {
      if (!isImageAttachment(attachment)) continue;
      images.push({
        id: `${message.id}:${attachmentKey(attachment)}`,
        href: attachmentHref(attachment),
        name: attachmentName(attachment),
        meta: attachmentMeta(attachment),
        sender: displaySender(message.sender),
        time: formatDateTime(message.timestamp),
      });
    }
  }
  return images;
});
watch(
  () => props.messages,
  async (newMessages, oldMessages) => {
    const previousScrollHeight = messagesElement.value?.scrollHeight || 0;
    const oldLastId = oldMessages?.[oldMessages.length - 1]?.id;
    const newLastId = newMessages[newMessages.length - 1]?.id;
    const isPrepend = Boolean(oldLastId && newLastId === oldLastId && newMessages[0]?.id !== oldMessages?.[0]?.id);

    await nextTick();

    if (isPrepend && messagesElement.value) {
      messagesElement.value.scrollTop += messagesElement.value.scrollHeight - previousScrollHeight;
      return;
    }
    if (!oldLastId) {
      if (props.initialScrollTop === null || props.initialScrollTop === undefined) {
        if (isScrolledToBottom) {
          scheduleInitialScrollToBottom();
        }
      } else {
        // Scroll restore is handled synchronously in onMounted; no need to
        // schedule here (messagesElement is not yet available before mount).
      }
      return;
    }
    if (newLastId === oldLastId) {
      return;
    }
    if (initialScrollSettled && isScrolledToBottom) {
      scrollToBottom();
      return;
    }
    if (newLastId) {
      unreadCount.value += Math.max(1, newMessages.length - (oldMessages?.length || 0));
    }
  },
  { immediate: true },
);

watch(
  () => props.activeSearchMessageId,
  (messageId) => {
    if (messageId) {
      void nextTick(() => scrollToMessage(messageId));
    }
  },
);

watch(
  () => props.roomIdentifier,
  () => {
    restoredScrollTop = undefined;
    initialScrollSettled = false;
    unreadCount.value = 0;
    isScrolledFarUp.value = false;
    isScrolledToBottom = true;
    draft.value = props.initialDraft || "";
    emit("draft-change", draft.value);
    mentionQuery.value = null;
    replyTo.value = null;
    attachmentError.value = null;
    attachmentDrafts.value = [];
    pendingAttachmentDrafts.value = [];
    void nextTick(() => {
      if (props.initialScrollTop === null || props.initialScrollTop === undefined) {
        scheduleInitialScrollToBottom();
      } else {
        restoreInitialScrollTop();
      }
    });
  },
);

onMounted(() => {
  componentUnmounted = false;
  window.addEventListener("keydown", handleGlobalKeydown);
  if (props.initialScrollTop !== null && props.initialScrollTop !== undefined) {
    // Restore saved scroll position synchronously before the first paint to
    // avoid a visible flash where the view briefly appears at scrollTop 0.
    restoreInitialScrollTop();
  } else {
    scheduleInitialScrollToBottom();
  }
});

onBeforeUnmount(() => {
  componentUnmounted = true;
  cancelPendingInitialScroll();
  emit("draft-change", draft.value);
  if (messagesElement.value) {
    emit("scroll-position", messagesElement.value.scrollTop);
  }
});

onUnmounted(() => {
  window.removeEventListener("keydown", handleGlobalKeydown);
});

function submitMessage(): void {
  const text = draft.value.trim();
  if (!text && attachmentDrafts.value.length === 0) return;
  emit(
    "send-message",
    text,
    replyTo.value?.id || null,
    attachmentDrafts.value.map((attachment) => ({ upload_id: attachment.uploadId })),
  );
  draft.value = "";
  syncDraftToShell();
  replyTo.value = null;
  attachmentDrafts.value = [];
}

function insertNewlineAtCursor(): void {
  const input = textareaElement.value;
  if (!input) {
    draft.value = `${draft.value}\n`;
    syncDraftToShell();
    return;
  }
  const start = input.selectionStart ?? draft.value.length;
  const end = input.selectionEnd ?? draft.value.length;
  draft.value = `${draft.value.slice(0, start)}\n${draft.value.slice(end)}`;
  syncDraftToShell();
  void nextTick(() => {
    input.selectionStart = start + 1;
    input.selectionEnd = start + 1;
  });
}

async function pickAttachments(): Promise<void> {
  if (attaching.value || !props.roomIdentifier) return;
  attaching.value = true;
  attachmentError.value = null;
  try {
    const staged = await window.letagentsDesktop.room.pickAttachments(props.roomIdentifier);
    attachmentDrafts.value = [...attachmentDrafts.value, ...staged];
  } catch (error) {
    attachmentError.value = error instanceof Error ? error.message : "Attachment could not be added.";
  } finally {
    attaching.value = false;
  }
}

async function stageDroppedAttachments(files: File[]): Promise<void> {
  if (attaching.value || files.length === 0) return;
  if (!props.roomIdentifier) {
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
    const stageDroppedAttachmentContents = window.letagentsDesktop.room.stageDroppedAttachmentContents;
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
    const staged = await stageDroppedAttachmentContents(props.roomIdentifier, droppedFiles);
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
  emit("discard-attachment", uploadId);
}

function handleAttachmentDragEnter(event: DragEvent): void {
  if (!hasDraggedFiles(event)) return;
  attachmentDragDepth += 1;
  isDraggingAttachment.value = true;
}

function handleAttachmentDragOver(event: DragEvent): void {
  if (!hasDraggedFiles(event)) return;
  if (event.dataTransfer) event.dataTransfer.dropEffect = props.roomIdentifier ? "copy" : "none";
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

function hasDraggedFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types || []).includes("Files");
}

function toPendingAttachmentDraft(file: File): PendingAttachmentDraft {
  return {
    localId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    fileName: file.name || "attachment",
    mimeType: file.type || "application/octet-stream",
    sizeBytes: file.size,
    previewDataUrl: null,
  };
}

async function readDroppedAttachmentContent(file: File): Promise<DesktopDroppedAttachmentContent> {
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

function handleEnterKey(event: KeyboardEvent): void {
  event.preventDefault();
  if (mentionOpen.value) {
    const candidate = mentionCandidates.value[activeMentionIndex.value];
    if (candidate) insertMention(candidate.displayName);
    return;
  }
  if (event.metaKey || event.ctrlKey || event.shiftKey) {
    insertNewlineAtCursor();
    return;
  }
  submitMessage();
}

function scrollToBottom(behavior: ScrollBehavior = "smooth"): void {
  if (!messagesElement.value) return;
  messagesElement.value.scrollTo({
    top: messagesElement.value.scrollHeight,
    behavior,
  });
  isScrolledToBottom = true;
  unreadCount.value = 0;
  isScrolledFarUp.value = false;
  emit("scroll-position", null);
}

function startReply(message: DesktopRoomMessage): void {
  replyTo.value = message;
  void nextTick(() => textareaElement.value?.focus());
}

function syncMentionQuery(): void {
  const match = /(^|\s)@([A-Za-z0-9._-]*)$/.exec(draft.value);
  mentionQuery.value = match ? match[2] : null;
  activeMentionIndex.value = 0;
}

function handleDraftInput(): void {
  syncDraftToShell();
  syncMentionQuery();
}

function moveMentionSelection(delta: number): void {
  if (!mentionOpen.value) return;
  const count = mentionCandidates.value.length;
  if (!count) return;
  activeMentionIndex.value = (activeMentionIndex.value + delta + count) % count;
}

function handleScroll(): void {
  if (!messagesElement.value) return;
  const element = messagesElement.value;
  const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
  isScrolledToBottom = distanceToBottom < 80;
  emit("scroll-position", isScrolledToBottom ? null : element.scrollTop);
  isScrolledFarUp.value = distanceToBottom > 900;
  if (isScrolledToBottom) {
    unreadCount.value = 0;
  }
  if (initialScrollSettled && element.scrollTop < 180 && props.hasOlderMessages && !props.loadingOlderMessages) {
    emit("load-older");
  }
}

function restoreInitialScrollTop(): void {
  const element = messagesElement.value;
  const scrollTop = props.initialScrollTop;
  if (!element || scrollTop === null || scrollTop === undefined || restoredScrollTop === scrollTop) {
    initialScrollSettled = true;
    return;
  }
  restoredScrollTop = scrollTop;
  // Override CSS `scroll-behavior: smooth` to prevent animated scrolling.
  // Chromium/Electron honours the CSS property even when JS says "auto".
  const prev = element.style.scrollBehavior;
  element.style.scrollBehavior = "auto";
  element.scrollTop = Math.max(0, Math.min(scrollTop, element.scrollHeight));
  element.style.scrollBehavior = prev;
  initialScrollSettled = true;
  handleScroll();
}

function scheduleInitialScrollToBottom(): void {
  scheduleInitialScroll(() => {
    scrollToBottom("auto");
    initialScrollSettled = true;
  });
}

function scheduleInitialScrollRestore(): void {
  scheduleInitialScroll(() => restoreInitialScrollTop());
}

function scheduleInitialScroll(callback: () => void): void {
  cancelPendingInitialScroll();
  const token = ++pendingInitialScrollToken;
  void nextTick(() => {
    if (componentUnmounted || token !== pendingInitialScrollToken) return;
    pendingInitialScrollFrame = window.requestAnimationFrame(() => {
      pendingInitialScrollFrame = null;
      if (componentUnmounted || token !== pendingInitialScrollToken) return;
      callback();
    });
  });
}

function cancelPendingInitialScroll(): void {
  pendingInitialScrollToken += 1;
  if (pendingInitialScrollFrame === null) return;
  window.cancelAnimationFrame(pendingInitialScrollFrame);
  pendingInitialScrollFrame = null;
}

function insertMention(displayName: string): void {
  draft.value = draft.value.replace(/(^|\s)@([A-Za-z0-9._-]*)$/, `$1@${displayName} `);
  mentionQuery.value = null;
  syncDraftToShell();
  void nextTick(() => textareaElement.value?.focus());
}

function syncDraftToShell(): void {
  emit("draft-change", draft.value);
}

function displaySender(sender: string): string {
  const [name] = sender.split("|").map((part) => part.trim()).filter(Boolean);
  return name || "Unknown";
}

function replyPreview(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
}

function formatBytes(bytes: number): string {
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

function attachmentName(attachment: DesktopRoomMessage["attachments"][number]): string {
  return attachment.fileName || attachment.name || "attachment";
}

function attachmentMimeType(attachment: DesktopRoomMessage["attachments"][number]): string {
  return attachment.mimeType || "application/octet-stream";
}

function attachmentHref(attachment: DesktopRoomMessage["attachments"][number]): string {
  if (attachment.url) return attachment.url;
  if (attachment.downloadUrl) return attachment.downloadUrl;
  if (attachment.dataUrl) return attachment.dataUrl;
  if (attachment.contentBase64) return `data:${attachmentMimeType(attachment)};base64,${attachment.contentBase64}`;
  return "#";
}

function attachmentKey(attachment: DesktopRoomMessage["attachments"][number]): string {
  return attachment.id || `${attachmentName(attachment)}-${attachment.sizeBytes || 0}-${attachmentMimeType(attachment)}`;
}

function attachmentMeta(attachment: DesktopRoomMessage["attachments"][number]): string {
  return [attachmentMimeType(attachment), formatBytes(attachment.sizeBytes || 0)].filter(Boolean).join(" · ");
}

function isImageAttachment(attachment: DesktopRoomMessage["attachments"][number]): boolean {
  return attachmentMimeType(attachment).startsWith("image/") && attachmentHref(attachment) !== "#";
}

function openImageViewer(imageId: string): void {
  if (!roomImages.value.some((image) => image.id === imageId)) return;
  activeImageId.value = imageId;
}

function shiftImage(direction: 1 | -1): void {
  if (!roomImages.value.length || !activeImageId.value) return;
  const currentIndex = Math.max(0, roomImages.value.findIndex((image) => image.id === activeImageId.value));
  const nextIndex = (currentIndex + direction + roomImages.value.length) % roomImages.value.length;
  activeImageId.value = roomImages.value[nextIndex].id;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function threadCount(messageId: string): number {
  return threadSummaries.value.get(messageId)?.count || 0;
}

function latestThreadMessageId(messageId: string): string | null {
  return threadSummaries.value.get(messageId)?.latest?.id || null;
}

function scrollToMessage(messageId: string | null): void {
  if (!messageId || !messagesElement.value) return;
  const target = messagesElement.value.querySelector(`[data-testid="room-message-${messageId}"]`) as HTMLElement | null;
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.add("jump-target");
  window.setTimeout(() => target.classList.remove("jump-target"), 1500);
}

function openAgentModal(target: AgentModalTarget): void {
  const session = latestReasoningForAgent(target);
  if (session) {
    emit("open-reasoning", session.id);
    return;
  }
  emit("open-agent-reasoning-fallback", target);
}

function handleGlobalKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") return;
}

function latestReasoningForAgent(target: AgentModalTarget): DesktopReasoningSession | null {
  const keys = agentIdentityKeys(target);
  if (!keys.length) return null;

  return props.reasoningSessions
    .filter((session) => reasoningSessionKeys(session).some((key) => keys.includes(key)))
    .sort((left, right) =>
      reasoningTime(right) - reasoningTime(left)
      || String(right.id).localeCompare(String(left.id))
    )[0] || null;
}

function agentIdentityKeys(target: AgentModalTarget): string[] {
  return [
    target.actorLabel,
    target.sender,
    target.displayName,
    displayNameFromActorLabel(target.actorLabel),
  ].map(normalizeAgentIdentity).filter(Boolean);
}

function reasoningSessionKeys(session: DesktopReasoningSession): string[] {
  return [
    session.actorLabel,
    displayNameFromActorLabel(session.actorLabel),
    session.agentKey,
  ].map(normalizeAgentIdentity).filter(Boolean);
}

function normalizeAgentIdentity(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
}

function displayNameFromActorLabel(value: string | null | undefined): string {
  return String(value || "").split("|")[0]?.trim() || "";
}

function reasoningTime(session: DesktopReasoningSession): number {
  const parsed = Date.parse(String(session.updatedAt || session.createdAt || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

</script>
