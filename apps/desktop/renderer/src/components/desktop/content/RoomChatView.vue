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
    <div class="room-chat-layout" :data-thread-open="Boolean(activeThreadParent)">
      <div class="room-chat-main">
        <div v-if="isDraggingAttachment" class="room-attachment-drop-overlay" data-testid="room-attachment-drop-overlay">
          <span>Drop files to attach</span>
        </div>

        <RoomMessageViewport
          ref="messageViewport"
          :active-search-message-id="activeTimelineMessageId"
          :active-thread-parent-id="activeThreadParentId"
          :has-older-messages="hasOlderMessages"
          :active="active"
          :loading-older-messages="loadingOlderMessages"
          :messages="messagesWithThreadOverrides"
          :thread-messages="threadMessagesWithThreadOverrides"
          :message-namespace="messageNamespace"
          :local-agent-work="localAgentWork"
          :has-filtered-room-activity="hasFilteredRoomActivity"
          :room-identifier="roomIdentifier"
          :github-activity-available="githubEventsAvailable"
          :room-loading="roomLoading"
          :search-query="searchQuery"
          :initial-scroll-top="initialScrollTop"
          @load-older="emit('load-older')"
          @open-agent="openAgentModal"
          @open-image="openImageViewer"
          @open-thread="openThread"
          @quote-reply="quoteReply"
          @open-github-event="emit('open-github-event', $event)"
          @scroll-position="emit('scroll-position', $event)"
        />

        <div
          v-if="roomLoading"
          class="desktop-composer desktop-composer-skeleton"
          data-testid="desktop-composer-loading"
          aria-label="Loading composer"
        >
          <div class="desktop-composer-skeleton-top" aria-hidden="true">
            <span></span>
            <span></span>
          </div>
          <div class="desktop-composer-skeleton-input" aria-hidden="true"></div>
          <div class="desktop-composer-skeleton-footer" aria-hidden="true">
            <span></span>
            <span></span>
          </div>
        </div>

        <RoomComposer
          v-else
          :attaching="attaching"
          :attachment-drafts="attachmentDrafts"
          :attachment-error="attachmentError"
          :initial-draft="initialDraft"
          :participants="participants"
          :pending-attachment-drafts="pendingAttachmentDrafts"
          :reply-to="replyTarget"
          :room-identifier="roomIdentifier"
          :room-loading="roomLoading"
          :send-error="sendError"
          :sending="sending"
          @clear-reply="clearReplyTarget"
          @draft-change="emit('draft-change', $event)"
          @open-add-agent="emit('open-add-agent')"
          @pick-attachments="pickAttachments"
          @remove-attachment="removeAttachment"
          @send-message="handleComposerSend"
        />

        <DesktopImageViewerModal
          v-if="activeImageId && roomImages.length"
          :images="roomImages"
          :active-image-id="activeImageId"
          @close="activeImageId = null"
          @next="shiftImage(1)"
          @previous="shiftImage(-1)"
        />
      </div>

      <Transition name="room-thread-backdrop">
        <button
          v-if="activeThreadParent"
          class="room-thread-backdrop"
          type="button"
          aria-label="Close thread"
          @click="closeThread"
        ></button>
      </Transition>

      <Transition name="room-thread-drawer">
        <RoomThreadPanel
          v-if="activeThreadPanelParent"
          :parent="activeThreadPanelParent"
          :initial-thread-summary="activeThreadInitialSummary"
          :replies="activeThreadReplies"
          :participants="participants"
          :room-identifier="roomIdentifier"
          :sending="sending"
          :send-error="sendError"
          :attaching="threadAttaching"
          :attachment-drafts="threadAttachmentDrafts"
          :attachment-error="threadAttachmentError"
          :pending-attachment-drafts="threadPendingAttachmentDrafts"
          :has-older-replies="activeThreadHasOlder"
          :loading-older-replies="loadingOlderThreadReplies"
          :search-query="searchQuery"
          :active-search-message-id="activeSearchMessageId"
          @close="closeThread"
          @open-image="openImageViewer"
          @open-agent="openAgentModal"
          @open-github-event="emit('open-github-event', $event)"
          @jump-message="jumpToMessage"
          @load-older-replies="loadOlderThreadReplies"
          @pick-attachments="pickThreadAttachments"
          @remove-attachment="removeThreadAttachment"
          @stage-dropped-attachments="stageThreadDroppedAttachments"
          @send-thread-message="sendThreadMessage"
        />
      </Transition>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, toRef, watch } from "vue";
import type {
  DesktopAgentPresence,
  DesktopParticipantSummary,
  DesktopReasoningSession,
  DesktopRoomMessage,
  DesktopRoomMessageThreadSummary,
  DesktopTaskSummary,
} from "../../../../../electron/ipc-types";
import DesktopImageViewerModal from "./DesktopImageViewerModal.vue";
import type { ManagedAgentWorkIndicator } from "../../../domain/managed-agents";
import type { AgentModalTarget } from "./desktop-chat-message/types";
import {
  isGitHubRoomMessage,
  isLowSignalGitHubCheckMessage,
} from "./desktop-chat-message/github-event";
import RoomComposer from "./room-chat/RoomComposer.vue";
import RoomMessageViewport from "./room-chat/RoomMessageViewport.vue";
import RoomThreadPanel from "./room-chat/RoomThreadPanel.vue";
import {
  resolveThreadParent,
  threadParentId,
  threadReplies,
} from "./room-chat/thread-utils";
import { useAgentReasoningLauncher } from "./room-chat/useAgentReasoningLauncher";
import { useRoomAttachments } from "./room-chat/useRoomAttachments";
import { useRoomImages } from "./room-chat/useRoomImages";

const props = defineProps<{
  active: boolean;
  messages: DesktopRoomMessage[];
  threadMessages: DesktopRoomMessage[];
  messageNamespace: string;
  localAgentWork: ManagedAgentWorkIndicator[];
  hasFilteredRoomActivity: boolean;
  roomIdentifier: string | null;
  githubEventsVisible: boolean;
  githubEventsAvailable: boolean;
  roomLoading: boolean;
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
  initialDraft?: string;
  initialScrollTop?: number | null;
}>();

const emit = defineEmits<{
  "send-message": [text: string, replyTo: string | null, attachments: Array<{ upload_id: string }>, threadRootId?: string | null];
  "load-older": [];
  "discard-attachment": [uploadId: string];
  "open-reasoning": [sessionId: string];
  "open-agent-reasoning-fallback": [target: AgentModalTarget];
  "open-agent-detail": [target: AgentModalTarget];
  "open-add-agent": [];
  "draft-change": [text: string];
  "scroll-position": [scrollTop: number];
  "open-github-event": [url: string];
  "thread-read": [threadRootId: string, summary: DesktopRoomMessageThreadSummary];
}>();

const activeThreadParentId = ref<string | null>(null);
const replyTarget = ref<DesktopRoomMessage | null>(null);
const messageViewport = ref<InstanceType<typeof RoomMessageViewport> | null>(null);
const threadReturnFocusElement = ref<HTMLElement | null>(null);
const transientHighlightMessageId = ref<string | null>(null);
const fetchedThreadRootId = ref<string | null>(null);
const fetchedThreadRoot = ref<DesktopRoomMessage | null>(null);
const fetchedThreadReplies = ref<DesktopRoomMessage[]>([]);
const fetchedThreadHasOlder = ref(false);
const loadingOlderThreadReplies = ref(false);
const threadSummaryOverrides = ref(new Map<string, DesktopRoomMessageThreadSummary>());
const openedThreadSummaries = ref(new Map<string, DesktopRoomMessageThreadSummary>());
const lastMarkedThreadReadKey = ref<string | null>(null);
let transientHighlightTimeout: number | null = null;
const messagesWithThreadOverrides = computed(() => applyThreadSummaryOverrides(props.messages));
const threadMessagesWithThreadOverrides = computed(() => applyThreadSummaryOverrides(props.threadMessages));
const activeThreadParent = computed(() =>
  fetchedThreadRootId.value === activeThreadParentId.value && fetchedThreadRoot.value
    ? applyThreadSummaryOverride(fetchedThreadRoot.value)
    : resolveThreadParent(threadMessagesWithThreadOverrides.value, activeThreadParentId.value)
);
const activeThreadPanelParent = computed(() => activeThreadParent.value);
const activeThreadInitialSummary = computed(() =>
  activeThreadPanelParent.value
    ? openedThreadSummaries.value.get(activeThreadPanelParent.value.id) ?? null
    : null
);
const activeThreadReplies = computed(() => {
  const parentId = activeThreadParent.value?.id || null;
  const liveReplies = threadReplies(threadMessagesWithThreadOverrides.value, parentId);
  if (!parentId || fetchedThreadRootId.value !== parentId) return liveReplies;
  return mergeThreadMessages(fetchedThreadReplies.value.filter(isThreadMessageVisible), liveReplies);
});
const activeThreadHasOlder = computed(() =>
  fetchedThreadHasOlder.value && fetchedThreadRootId.value === activeThreadParentId.value
);
const activeTimelineMessageId = computed(() => props.activeSearchMessageId || transientHighlightMessageId.value);
const threadImageMessages = computed(() => {
  const fetchedMessages = fetchedThreadRootId.value === activeThreadParentId.value
    ? [fetchedThreadRoot.value, ...fetchedThreadReplies.value]
      .filter((message): message is DesktopRoomMessage => Boolean(message))
      .filter(isThreadMessageVisible)
    : [];
  return mergeThreadMessages(threadMessagesWithThreadOverrides.value, fetchedMessages);
});

const {
  activeImageId,
  roomImages,
  openImageViewer,
  shiftImage,
} = useRoomImages(threadImageMessages);

const {
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
} = useRoomAttachments({
  roomIdentifier: toRef(props, "roomIdentifier"),
  discardAttachment: (uploadId) => emit("discard-attachment", uploadId),
});

const {
  attaching: threadAttaching,
  attachmentDrafts: threadAttachmentDrafts,
  attachmentError: threadAttachmentError,
  clearAttachmentDrafts: clearThreadAttachmentDrafts,
  pendingAttachmentDrafts: threadPendingAttachmentDrafts,
  pickAttachments: pickThreadAttachments,
  removeAttachment: removeThreadAttachment,
  stageDroppedAttachments: stageThreadDroppedAttachments,
} = useRoomAttachments({
  roomIdentifier: toRef(props, "roomIdentifier"),
  discardAttachment: (uploadId) => emit("discard-attachment", uploadId),
});

const { openAgentModal } = useAgentReasoningLauncher({
  presence: () => props.presence,
  reasoningSessions: () => props.reasoningSessions,
  openReasoning: (sessionId) => emit("open-reasoning", sessionId),
  openFallback: (target) => emit("open-agent-reasoning-fallback", target),
  openAgentDetail: (target) => emit("open-agent-detail", target),
});

function openThread(messageId: string): void {
  if (document.activeElement instanceof HTMLElement) {
    threadReturnFocusElement.value = document.activeElement;
  }
  if (activeThreadParentId.value !== messageId) {
    clearThreadAttachmentDrafts();
  }
  forgetOpenedThreadSummary(messageId);
  activeThreadParentId.value = messageId;
  void loadThread(messageId);
}

function quoteReply(messageId: string): void {
  replyTarget.value = threadMessagesWithThreadOverrides.value.find((message) => message.id === messageId) ?? null;
}

function clearReplyTarget(): void {
  replyTarget.value = null;
}

function closeThread(): void {
  activeThreadParentId.value = null;
  clearThreadAttachmentDrafts();
  void nextTick(() => {
    threadReturnFocusElement.value?.focus();
    threadReturnFocusElement.value = null;
  });
}

function sendThreadMessage(
  text: string,
  threadRootId: string,
  replyToId: string | null,
  attachments: Array<{ upload_id: string }>,
): void {
  emit("send-message", text, replyToId, attachments, threadRootId);
  clearThreadAttachmentDrafts();
}

async function loadThread(threadRootId: string): Promise<void> {
  const roomIdentifier = props.roomIdentifier;
  const messageNamespace = props.messageNamespace;
  if (!roomIdentifier) return;
  const roomApi = window.letagentsDesktop?.room;
  if (!roomApi?.getThread) return;
  try {
    const page = await roomApi.getThread(roomIdentifier, threadRootId);
    if (!isActiveThreadContext(threadRootId, roomIdentifier, messageNamespace)) return;
    fetchedThreadRootId.value = threadRootId;
    rememberOpenedThreadSummary(threadRootId, page.root.thread ?? page.summary);
    applyThreadSummary(threadRootId, page.summary);
    fetchedThreadRoot.value = applyThreadSummaryOverride(page.root);
    fetchedThreadReplies.value = page.replies;
    fetchedThreadHasOlder.value = page.hasOlder;
    const lastMessageId = page.replies.at(-1)?.id || page.root.id;
    await markThreadRead(threadRootId, lastMessageId, roomIdentifier, messageNamespace);
  } catch {
    // Keep the already loaded room messages usable if the thread endpoint is unavailable.
  }
}

async function loadOlderThreadReplies(): Promise<void> {
  const threadRootId = activeThreadParentId.value;
  const roomIdentifier = props.roomIdentifier;
  const messageNamespace = props.messageNamespace;
  if (!threadRootId || !roomIdentifier || loadingOlderThreadReplies.value || !activeThreadHasOlder.value) return;
  const roomApi = window.letagentsDesktop?.room;
  if (!roomApi?.getThread) return;
  const beforeMessageId = fetchedThreadReplies.value[0]?.id || null;
  if (!beforeMessageId) return;

  loadingOlderThreadReplies.value = true;
  try {
    const page = await roomApi.getThread(roomIdentifier, threadRootId, beforeMessageId);
    if (!isActiveThreadContext(threadRootId, roomIdentifier, messageNamespace)) return;
    applyThreadSummary(threadRootId, page.summary);
    fetchedThreadRootId.value = threadRootId;
    fetchedThreadRoot.value = applyThreadSummaryOverride(page.root);
    fetchedThreadReplies.value = mergeThreadMessages(page.replies, fetchedThreadReplies.value);
    fetchedThreadHasOlder.value = page.hasOlder;
  } catch {
    // Leave the current thread page intact when older replies cannot be fetched.
  } finally {
    if (isActiveThreadContext(threadRootId, roomIdentifier, messageNamespace)) {
      loadingOlderThreadReplies.value = false;
    }
  }
}

async function markThreadRead(
  threadRootId: string,
  messageId: string,
  roomIdentifier = props.roomIdentifier,
  messageNamespace = props.messageNamespace,
): Promise<void> {
  if (!roomIdentifier || !props.active) return;
  const roomApi = window.letagentsDesktop?.room;
  if (!roomApi?.markThreadRead) return;
  const readKey = `${threadRootId}:${messageId}`;
  if (lastMarkedThreadReadKey.value === readKey) return;
  lastMarkedThreadReadKey.value = readKey;

  try {
    const readResult = await roomApi.markThreadRead(roomIdentifier, threadRootId, messageId);
    if (!props.active || !isActiveThreadContext(threadRootId, roomIdentifier, messageNamespace)) return;
    applyThreadSummary(threadRootId, readResult.thread);
    emit("thread-read", threadRootId, readResult.thread);
  } catch {
    lastMarkedThreadReadKey.value = null;
  }
}

function isThreadMessageVisible(message: DesktopRoomMessage): boolean {
  return !isLowSignalGitHubCheckMessage(message)
    && (props.githubEventsVisible || !isGitHubRoomMessage(message));
}

function isActiveThreadContext(
  threadRootId: string,
  roomIdentifier: string,
  messageNamespace: string,
): boolean {
  return activeThreadParentId.value === threadRootId
    && props.roomIdentifier === roomIdentifier
    && props.messageNamespace === messageNamespace;
}

function rememberOpenedThreadSummary(threadRootId: string, summary: DesktopRoomMessageThreadSummary): void {
  const next = new Map(openedThreadSummaries.value);
  next.set(threadRootId, summary);
  openedThreadSummaries.value = next;
}

function forgetOpenedThreadSummary(threadRootId: string): void {
  if (!openedThreadSummaries.value.has(threadRootId)) return;
  const next = new Map(openedThreadSummaries.value);
  next.delete(threadRootId);
  openedThreadSummaries.value = next;
}

function applyThreadSummary(threadRootId: string, summary: DesktopRoomMessageThreadSummary): void {
  const nextOverrides = new Map(threadSummaryOverrides.value);
  nextOverrides.set(threadRootId, summary);
  threadSummaryOverrides.value = nextOverrides;
  if (fetchedThreadRoot.value?.id === threadRootId) {
    fetchedThreadRoot.value = applyThreadSummaryOverride(fetchedThreadRoot.value);
  }
}

function applyThreadSummaryOverrides(messages: DesktopRoomMessage[]): DesktopRoomMessage[] {
  if (!threadSummaryOverrides.value.size) return messages;
  return messages.map((message) => applyThreadSummaryOverride(message));
}

function applyThreadSummaryOverride(message: DesktopRoomMessage): DesktopRoomMessage {
  const summary = threadSummaryOverrides.value.get(message.id);
  return summary ? { ...message, thread: summary } : message;
}

function mergeThreadMessages(
  left: readonly DesktopRoomMessage[],
  right: readonly DesktopRoomMessage[],
): DesktopRoomMessage[] {
  const byId = new Map<string, DesktopRoomMessage>();
  for (const message of [...left, ...right]) {
    const existing = byId.get(message.id);
    byId.set(message.id, existing ? { ...existing, ...message } : message);
  }
  return [...byId.values()].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id),
  );
}

function jumpToMessage(messageId: string): void {
  transientHighlightMessageId.value = messageId;
  messageViewport.value?.scrollToMessage(messageId);
  if (transientHighlightTimeout !== null) {
    window.clearTimeout(transientHighlightTimeout);
  }
  transientHighlightTimeout = window.setTimeout(() => {
    transientHighlightMessageId.value = null;
    transientHighlightTimeout = null;
  }, 1800);
}

function handleComposerSend(
  text: string,
  replyToId: string | null,
  attachments: Array<{ upload_id: string }>,
): void {
  emit("send-message", text, replyToId, attachments);
  clearReplyTarget();
  clearAttachmentDrafts();
}

watch(toRef(props, "messageNamespace"), () => {
  activeThreadParentId.value = null;
  fetchedThreadRootId.value = null;
  fetchedThreadRoot.value = null;
  fetchedThreadReplies.value = [];
  fetchedThreadHasOlder.value = false;
  loadingOlderThreadReplies.value = false;
  threadSummaryOverrides.value = new Map();
  openedThreadSummaries.value = new Map();
  lastMarkedThreadReadKey.value = null;
  clearReplyTarget();
  clearThreadAttachmentDrafts();
});

watch(
  () => props.activeSearchMessageId,
  (messageId) => {
    const searchResult = threadMessagesWithThreadOverrides.value.find((message) => message.id === messageId);
    const parentId = searchResult ? threadParentId(searchResult) : null;
    if (parentId) {
      activeThreadParentId.value = parentId;
      void loadThread(parentId);
    }
  },
);

watch(
  () => props.threadMessages,
  () => {
    if (activeThreadParentId.value && !activeThreadParent.value) {
      activeThreadParentId.value = null;
    }
    if (replyTarget.value && !threadMessagesWithThreadOverrides.value.some((message) => message.id === replyTarget.value?.id)) {
      clearReplyTarget();
    }
  },
);

watch(
  () => [activeThreadParent.value?.id || null, activeThreadReplies.value.at(-1)?.id || null] as const,
  ([threadRootId, latestReplyId]) => {
    if (!threadRootId || !latestReplyId) return;
    void markThreadRead(threadRootId, latestReplyId);
  },
);

defineExpose({ openThread });

onBeforeUnmount(() => {
  if (transientHighlightTimeout !== null) {
    window.clearTimeout(transientHighlightTimeout);
  }
});
</script>
