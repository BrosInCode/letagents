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
          :active-search-message-id="activeSearchMessageId"
          :active-thread-parent-id="activeThreadParentId"
          :has-older-messages="hasOlderMessages"
          :active="active"
          :loading-older-messages="loadingOlderMessages"
          :messages="messages"
          :thread-messages="threadMessages"
          :has-filtered-room-activity="hasFilteredRoomActivity"
          :room-identifier="roomIdentifier"
          :room-loading="roomLoading"
          :search-query="searchQuery"
          :initial-scroll-top="initialScrollTop"
          @load-older="emit('load-older')"
          @open-agent="openAgentModal"
          @open-image="openImageViewer"
          @open-thread="openThread"
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
          :reply-to="null"
          :room-identifier="roomIdentifier"
          :room-loading="roomLoading"
          :send-error="sendError"
          :sending="sending"
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

      <RoomThreadPanel
        v-if="activeThreadParent"
        :parent="activeThreadParent"
        :replies="activeThreadReplies"
        :room-identifier="roomIdentifier"
        :sending="sending"
        :search-query="searchQuery"
        :active-search-message-id="activeSearchMessageId"
        @close="closeThread"
        @open-image="openImageViewer"
        @open-agent="openAgentModal"
        @open-github-event="emit('open-github-event', $event)"
        @send-thread-message="sendThreadMessage"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, toRef, watch } from "vue";
import type {
  DesktopAgentPresence,
  DesktopParticipantSummary,
  DesktopReasoningSession,
  DesktopRoomMessage,
  DesktopTaskSummary,
} from "../../../../../electron/ipc-types";
import DesktopImageViewerModal from "./DesktopImageViewerModal.vue";
import type { AgentModalTarget } from "./desktop-chat-message/types";
import RoomComposer from "./room-chat/RoomComposer.vue";
import RoomMessageViewport from "./room-chat/RoomMessageViewport.vue";
import RoomThreadPanel from "./room-chat/RoomThreadPanel.vue";
import { resolveThreadParent, threadReplies } from "./room-chat/thread-utils";
import { useAgentReasoningLauncher } from "./room-chat/useAgentReasoningLauncher";
import { useRoomAttachments } from "./room-chat/useRoomAttachments";
import { useRoomImages } from "./room-chat/useRoomImages";

const props = defineProps<{
  active: boolean;
  messages: DesktopRoomMessage[];
  threadMessages: DesktopRoomMessage[];
  hasFilteredRoomActivity: boolean;
  roomIdentifier: string | null;
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
  "send-message": [text: string, replyTo: string | null, attachments: Array<{ upload_id: string }>];
  "load-older": [];
  "discard-attachment": [uploadId: string];
  "open-reasoning": [sessionId: string];
  "open-agent-reasoning-fallback": [target: AgentModalTarget];
  "open-agent-detail": [target: AgentModalTarget];
  "open-add-agent": [];
  "draft-change": [text: string];
  "scroll-position": [scrollTop: number];
  "open-github-event": [url: string];
}>();

const activeThreadParentId = ref<string | null>(null);
const activeThreadParent = computed(() =>
  resolveThreadParent(props.threadMessages, activeThreadParentId.value)
);
const activeThreadReplies = computed(() => threadReplies(props.threadMessages, activeThreadParent.value?.id || null));

const {
  activeImageId,
  roomImages,
  openImageViewer,
  shiftImage,
} = useRoomImages(toRef(props, "threadMessages"));

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

const { openAgentModal } = useAgentReasoningLauncher({
  presence: () => props.presence,
  reasoningSessions: () => props.reasoningSessions,
  openReasoning: (sessionId) => emit("open-reasoning", sessionId),
  openFallback: (target) => emit("open-agent-reasoning-fallback", target),
  openAgentDetail: (target) => emit("open-agent-detail", target),
});

function openThread(messageId: string): void {
  activeThreadParentId.value = messageId;
}

function closeThread(): void {
  activeThreadParentId.value = null;
}

function sendThreadMessage(text: string, parentId: string): void {
  emit("send-message", text, parentId, []);
}

function handleComposerSend(
  text: string,
  replyToId: string | null,
  attachments: Array<{ upload_id: string }>,
): void {
  emit("send-message", text, replyToId, attachments);
  clearAttachmentDrafts();
}

watch(toRef(props, "roomIdentifier"), () => {
  activeThreadParentId.value = null;
});

watch(
  () => props.activeSearchMessageId,
  (messageId) => {
    const searchResult = props.threadMessages.find((message) => message.id === messageId);
    const threadParentId = searchResult?.replyTo?.id || null;
    if (threadParentId) {
      activeThreadParentId.value = threadParentId;
    }
  },
);

watch(
  () => props.threadMessages,
  () => {
    if (activeThreadParentId.value && !activeThreadParent.value) {
      activeThreadParentId.value = null;
    }
  },
  { deep: true },
);
</script>
