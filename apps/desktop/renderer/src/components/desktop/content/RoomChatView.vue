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
          :has-older-messages="hasOlderMessages"
          :loading-older-messages="loadingOlderMessages"
          :messages="messages"
          :room-identifier="roomIdentifier"
          :room-loading="roomLoading"
          :search-query="searchQuery"
          :initial-scroll-top="initialScrollTop"
          @load-older="emit('load-older')"
          @open-agent="openAgentModal"
          @open-image="openImageViewer"
          @open-thread="openThread"
          @reply="startReply"
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
          :reply-to="replyTo"
          :room-identifier="roomIdentifier"
          :room-loading="roomLoading"
          :send-error="sendError"
          :sending="sending"
          @clear-reply="replyTo = null"
          @draft-change="emit('draft-change', $event)"
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
        @close="closeThread"
        @open-image="openImageViewer"
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
import { threadReplies } from "./room-chat/thread-utils";
import { useAgentReasoningLauncher } from "./room-chat/useAgentReasoningLauncher";
import { useRoomAttachments } from "./room-chat/useRoomAttachments";
import { useRoomImages } from "./room-chat/useRoomImages";

const props = defineProps<{
  messages: DesktopRoomMessage[];
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
  "draft-change": [text: string];
  "scroll-position": [scrollTop: number];
}>();

const replyTo = ref<DesktopRoomMessage | null>(null);
const activeThreadParentId = ref<string | null>(null);
const activeThreadParent = computed(() =>
  props.messages.find((message) => message.id === activeThreadParentId.value) || null
);
const activeThreadReplies = computed(() => threadReplies(props.messages, activeThreadParent.value?.id || null));

const {
  activeImageId,
  roomImages,
  openImageViewer,
  shiftImage,
} = useRoomImages(toRef(props, "messages"));

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
});

function startReply(message: DesktopRoomMessage): void {
  replyTo.value = message;
}

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
  replyTo.value = null;
}

watch(toRef(props, "roomIdentifier"), () => {
  replyTo.value = null;
  activeThreadParentId.value = null;
});

watch(
  () => props.messages,
  () => {
    if (activeThreadParentId.value && !activeThreadParent.value) {
      activeThreadParentId.value = null;
    }
  },
  { deep: true },
);
</script>
