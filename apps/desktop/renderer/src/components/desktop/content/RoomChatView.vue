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

      <RoomMessageViewport
        :active-search-message-id="activeSearchMessageId"
        :has-older-messages="hasOlderMessages"
        :initial-scroll-top="initialScrollTop"
        :loading-older-messages="loadingOlderMessages"
        :messages="messages"
        :room-identifier="roomIdentifier"
        :search-query="searchQuery"
        @load-older="emit('load-older')"
        @open-agent="openAgentModal"
        @open-image="openImageViewer"
        @reply="startReply"
        @scroll-position="emit('scroll-position', $event)"
      />

      <RoomComposer
        :attaching="attaching"
        :attachment-drafts="attachmentDrafts"
        :attachment-error="attachmentError"
        :initial-draft="initialDraft"
        :participants="participants"
        :pending-attachment-drafts="pendingAttachmentDrafts"
        :reply-to="replyTo"
        :room-identifier="roomIdentifier"
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
  </section>
</template>

<script setup lang="ts">
import { ref, toRef, watch } from "vue";
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
import { useAgentReasoningLauncher } from "./room-chat/useAgentReasoningLauncher";
import { useRoomAttachments } from "./room-chat/useRoomAttachments";
import { useRoomImages } from "./room-chat/useRoomImages";

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

const replyTo = ref<DesktopRoomMessage | null>(null);

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
});
</script>
