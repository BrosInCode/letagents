<template>
  <section class="room-tab-page room-chat-page" data-testid="room-chat-view">
    <div class="room-chat-layout">
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
            @reply="startReply"
            @scroll-to-message="scrollToMessage"
            @open-image="openImageViewer"
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
          <span>Sending from LetAgents Desktop</span>
          <span class="desktop-composer-shortcut">Enter to send · ⌘↵ for a new line</span>
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
          placeholder="Write a message..."
          :disabled="!roomIdentifier"
          data-testid="desktop-composer-input"
          @input="syncMentionQuery"
          @keydown.down.prevent="moveMentionSelection(1)"
          @keydown.up.prevent="moveMentionSelection(-1)"
          @keydown.enter="handleEnterKey"
          @keydown.escape="mentionOpen = false"
        />
        <div v-if="attachmentDrafts.length" class="desktop-attachment-drafts" data-testid="desktop-attachment-drafts">
          <div
            v-for="attachment in attachmentDrafts"
            :key="attachment.uploadId"
            class="desktop-attachment-draft"
            data-testid="desktop-attachment-draft"
          >
            <span>
              <img v-if="attachment.previewDataUrl" class="desktop-attachment-preview" :src="attachment.previewDataUrl" alt="">
              <strong>{{ attachment.fileName }}</strong>
              <small>{{ attachment.mimeType }} · {{ formatBytes(attachment.sizeBytes) }}</small>
            </span>
            <button type="button" @click="removeAttachment(attachment.uploadId)">Remove</button>
          </div>
        </div>
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
          <p v-if="sendError" class="desktop-composer-error" data-testid="desktop-composer-error">{{ sendError }}</p>
          <p v-else class="desktop-composer-hint">Use @ to bring a person or agent into the thread.</p>
          <button
            class="desktop-composer-attach"
            type="button"
            :disabled="sending || !roomIdentifier || attaching"
            data-testid="desktop-composer-attach"
            @click="pickAttachments"
          >
            {{ attaching ? "Attaching..." : "Attach" }}
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
import { computed, nextTick, ref, watch } from "vue";
import type { DesktopParticipantSummary, DesktopRoomMessage, DesktopStagedAttachment } from "../../../../../electron/ipc-types";
import DesktopChatMessage from "./DesktopChatMessage.vue";
import DesktopImageViewerModal, { type DesktopMessageImage } from "./DesktopImageViewerModal.vue";

const props = defineProps<{
  messages: DesktopRoomMessage[];
  roomIdentifier: string | null;
  sending: boolean;
  sendError: string | null;
  hasOlderMessages: boolean;
  loadingOlderMessages: boolean;
  participants: DesktopParticipantSummary[];
}>();

const emit = defineEmits<{
  "send-message": [text: string, replyTo: string | null, attachments: Array<{ upload_id: string }>];
  "load-older": [];
  "discard-attachment": [uploadId: string];
}>();

const draft = ref("");
const textareaElement = ref<HTMLTextAreaElement | null>(null);
const messagesElement = ref<HTMLElement | null>(null);
const replyTo = ref<DesktopRoomMessage | null>(null);
const activeImageId = ref<string | null>(null);
const mentionQuery = ref<string | null>(null);
const activeMentionIndex = ref(0);
const attachmentDrafts = ref<DesktopStagedAttachment[]>([]);
const attaching = ref(false);
const unreadCount = ref(0);
const isScrolledFarUp = ref(false);
let isScrolledToBottom = true;

const canSend = computed(() => Boolean(props.roomIdentifier && (draft.value.trim() || attachmentDrafts.value.length > 0)));
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
    if (isScrolledToBottom) {
      scrollToBottom();
      return;
    }
    if (oldLastId && newLastId && newLastId !== oldLastId) {
      unreadCount.value += Math.max(1, newMessages.length - (oldMessages?.length || 0));
    }
  },
  { immediate: true },
);

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
  replyTo.value = null;
  attachmentDrafts.value = [];
}

function insertNewlineAtCursor(): void {
  const input = textareaElement.value;
  if (!input) {
    draft.value = `${draft.value}\n`;
    return;
  }
  const start = input.selectionStart ?? draft.value.length;
  const end = input.selectionEnd ?? draft.value.length;
  draft.value = `${draft.value.slice(0, start)}\n${draft.value.slice(end)}`;
  void nextTick(() => {
    input.selectionStart = start + 1;
    input.selectionEnd = start + 1;
  });
}

async function pickAttachments(): Promise<void> {
  if (attaching.value || !props.roomIdentifier) return;
  attaching.value = true;
  try {
    const staged = await window.letagentsDesktop.room.pickAttachments(props.roomIdentifier);
    attachmentDrafts.value = [...attachmentDrafts.value, ...staged];
  } finally {
    attaching.value = false;
  }
}

async function removeAttachment(uploadId: string): Promise<void> {
  attachmentDrafts.value = attachmentDrafts.value.filter((attachment) => attachment.uploadId !== uploadId);
  emit("discard-attachment", uploadId);
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

function scrollToBottom(): void {
  if (!messagesElement.value) return;
  messagesElement.value.scrollTo({
    top: messagesElement.value.scrollHeight,
    behavior: "smooth",
  });
  unreadCount.value = 0;
  isScrolledFarUp.value = false;
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
  isScrolledFarUp.value = distanceToBottom > 900;
  if (isScrolledToBottom) {
    unreadCount.value = 0;
  }
  if (element.scrollTop < 180 && props.hasOlderMessages && !props.loadingOlderMessages) {
    emit("load-older");
  }
}

function insertMention(displayName: string): void {
  draft.value = draft.value.replace(/(^|\s)@([A-Za-z0-9._-]*)$/, `$1@${displayName} `);
  mentionQuery.value = null;
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
</script>
