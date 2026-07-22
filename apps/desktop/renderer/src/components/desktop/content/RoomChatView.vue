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
    <div
      ref="threadLayoutElement"
      class="room-chat-layout"
      :data-thread-open="Boolean(activeThreadParent)"
      :data-thread-overlay="threadPaneOverlay"
      :data-thread-resizing="isResizingThreadPane"
      :style="threadLayoutStyle"
    >
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
          :delivery-receipts-by-message="deliveryReceiptsByMessage"
          :delivery-recovery-available="deliveryRecoveryAvailable"
          :delivery-retry-keys="deliveryRetryKeys"
          :participants="participants"
          :presence="presence"
          :supervisor-entries="roomSupervisorEntries"
          @reveal-message="requestMessageReveal"
          :has-filtered-room-activity="hasFilteredRoomActivity"
          :room-identifier="roomIdentifier"
          :github-activity-available="githubEventsAvailable"
          :room-loading="roomLoading"
          :search-query="searchQuery"
          :task-reference-ids="taskReferenceIds"
          :initial-scroll-top="initialScrollTop"
          @load-older="emit('load-older')"
          @open-agent="openAgentModal"
          @open-image="openImageViewer"
          @open-thread="openThread"
          @quote-reply="quoteReply"
          @quote-selection="quoteSelectedText"
          @open-github-event="emit('open-github-event', $event)"
          @open-task="emit('open-task', $event)"
          @retry-delivery="(agentId, sourceMessageId) => emit('retry-delivery', agentId, sourceMessageId)"
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
          :event-previews="composerEventPreviews"
          :initial-draft="initialDraft"
          :participants="participants"
          :permission-approvals="permissionApprovals"
          :permission-error="permissionError"
          :pending-attachment-drafts="pendingAttachmentDrafts"
          :reply-to="replyTarget"
          :resolving-permission-ids="resolvingPermissionIds"
          :room-identifier="roomIdentifier"
          :room-loading="roomLoading"
          :send-error="sendError"
          :sending="sending"
          @clear-reply="clearReplyTarget"
          @draft-change="emit('draft-change', $event)"
          @open-add-agent="emit('open-add-agent')"
          @open-permission-detail="emit('open-permission-detail', $event)"
          @pick-attachments="pickAttachments"
          @remove-attachment="removeAttachment"
          @open-event-preview="openEventPreview"
          @dismiss-event-preview="emit('dismiss-event-preview', $event)"
          @resolve-permission="(approval, behavior) => emit('resolve-permission', approval, behavior)"
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

      <button
        v-if="activeThreadParent"
        class="room-thread-backdrop"
        type="button"
        aria-label="Close thread"
        @click="closeThread"
      ></button>

      <div
        v-if="activeThreadParent"
        class="room-thread-resize-handle"
        role="separator"
        tabindex="0"
        aria-label="Resize thread pane"
        aria-orientation="vertical"
        :aria-valuemin="threadPaneMinWidth"
        :aria-valuemax="maxThreadPaneWidth()"
        :aria-valuenow="threadPaneWidth"
        :data-resizing="isResizingThreadPane"
        title="Drag to resize thread pane"
        @pointerdown="startThreadPaneResize"
        @keydown.left.prevent="adjustThreadPaneWidth(threadResizeStep)"
        @keydown.right.prevent="adjustThreadPaneWidth(-threadResizeStep)"
        @keydown.home.prevent="setThreadPaneWidth(threadPaneMinWidth)"
        @keydown.end.prevent="setThreadPaneWidth(maxThreadPaneWidth())"
        @dblclick="resetThreadPaneWidth"
      ></div>

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
        :reveal-message-id="threadRevealTargetId"
        :search-query="searchQuery"
        :active-search-message-id="activeSearchMessageId"
        :task-reference-ids="taskReferenceIds"
        :delivery-receipts-by-message="deliveryReceiptsByMessage"
        :delivery-recovery-available="deliveryRecoveryAvailable"
        :delivery-retry-keys="deliveryRetryKeys"
        :presence="presence"
        :supervisor-entries="roomSupervisorEntries"
        @retry-delivery="(agentId, sourceMessageId) => emit('retry-delivery', agentId, sourceMessageId)"
        @close="closeThread"
        @open-image="openImageViewer"
        @open-agent="openAgentModal"
        @open-github-event="emit('open-github-event', $event)"
        @open-task="emit('open-task', $event)"
        @jump-message="jumpToMessage"
        @load-older-replies="loadOlderThreadReplies"
        @pick-attachments="pickThreadAttachments"
        @remove-attachment="removeThreadAttachment"
        @stage-dropped-attachments="stageThreadDroppedAttachments"
        @send-thread-message="sendThreadMessage"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRef, watch } from "vue";
import type { CSSProperties } from "vue";
import type {
  DesktopAgentPresence,
  DesktopManagedAgentPermissionDecisionBehavior,
  DesktopParticipantSummary,
  DesktopReasoningSession,
  DesktopRoomMessage,
  DesktopRoomMessageThreadSummary,
  DesktopSupervisorManifestEntry,
  DesktopTaskSummary,
} from "../../../../../electron/ipc-types";
import DesktopImageViewerModal from "./DesktopImageViewerModal.vue";
import {
  normalizeManagedAgentRoomIdentifier,
  type ManagedAgentPermissionApproval,
  type ManagedAgentWorkIndicator,
} from "../../../domain/managed-agents";
import type { AgentModalTarget } from "./desktop-chat-message/types";
import {
  isGitHubRoomMessage,
  isLowSignalGitHubCheckMessage,
} from "./desktop-chat-message/github-event";
import RoomComposer from "./room-chat/RoomComposer.vue";
import type { ComposerEventPreview } from "./room-chat/RoomComposerEventChips.vue";
import RoomMessageViewport from "./room-chat/RoomMessageViewport.vue";
import RoomThreadPanel from "./room-chat/RoomThreadPanel.vue";
import {
  maxThreadPaneWidthForContainer,
  shouldOverlayThreadPane,
  threadPaneDefaultWidth,
  threadPaneHardMaxWidth,
  threadPaneMinWidth,
} from "./room-chat/thread-layout";
import {
  resolveThreadParent,
  threadParentId,
  threadReplies,
} from "./room-chat/thread-utils";
import { useAgentReasoningLauncher } from "./room-chat/useAgentReasoningLauncher";
import { useRoomAttachments } from "./room-chat/useRoomAttachments";
import { useRoomImages } from "./room-chat/useRoomImages";
import { desktopIpc } from "../../../ipc/index.js";
import { roomMessageRevealDestination } from "../../../domain/room-message-reveal";

const props = defineProps<{
  active: boolean;
  messages: DesktopRoomMessage[];
  threadMessages: DesktopRoomMessage[];
  messageNamespace: string;
  localAgentWork: ManagedAgentWorkIndicator[];
  deliveryReceiptsByMessage: Record<string, Array<{ agentId: string; agentName: string; state: string; blockedByMessageId: string | null }> >;
  deliveryRecoveryAvailable?: boolean;
  deliveryRetryKeys?: ReadonlySet<string>;
  revealedMessageId?: string | null;
  permissionApprovals: ManagedAgentPermissionApproval[];
  permissionError: string | null;
  composerEventPreviews: ComposerEventPreview[];
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
  supervisorEntries?: DesktopSupervisorManifestEntry[];
  resolvingPermissionIds: Record<string, DesktopManagedAgentPermissionDecisionBehavior>;
  reasoningSessions: DesktopReasoningSession[];
  tasks: DesktopTaskSummary[];
  searchQuery: string;
  activeSearchMessageId: string | null;
  initialDraft?: string;
  initialScrollTop?: number | null;
}>();

/*
 * Keep provider resolution anchored to the room currently being rendered.
 * The manifest is the authoritative local record even when older message and
 * participant snapshots contain only the generic "Supervisor worker" label.
 */
const roomSupervisorEntries = computed(() => {
  const roomIdentifier = normalizeManagedAgentRoomIdentifier(props.roomIdentifier);
  return (props.supervisorEntries ?? []).filter((entry) =>
    normalizeManagedAgentRoomIdentifier(entry.roomId) === roomIdentifier
  );
});

const emit = defineEmits<{
  "send-message": [text: string, replyTo: string | null, attachments: Array<{ upload_id: string }>, threadRootId?: string | null];
  "load-older": [];
  "discard-attachment": [uploadId: string];
  "open-reasoning": [sessionId: string];
  "open-agent-reasoning-fallback": [target: AgentModalTarget];
  "open-agent-detail": [target: AgentModalTarget];
  "open-add-agent": [];
  "open-permission-detail": [approval: ManagedAgentPermissionApproval];
  "draft-change": [text: string];
  "scroll-position": [scrollTop: number];
  "open-github-event": [url: string];
  "open-events": [];
  "open-task": [taskId: string];
  "retry-delivery": [agentId: string, sourceMessageId: string];
  "reveal-message": [messageId: string];
  "message-reveal-unavailable": [messageId: string];
  "dismiss-event-preview": [messageId: string];
  "resolve-permission": [
    approval: ManagedAgentPermissionApproval,
    behavior: DesktopManagedAgentPermissionDecisionBehavior,
  ];
  "thread-read": [threadRootId: string, summary: DesktopRoomMessageThreadSummary];
}>();

interface RoomReplyTarget extends DesktopRoomMessage {
  isSelection?: boolean;
  sourceMessageId?: string | null;
}

const threadLayoutAnimationMs = 250;
const taskReferenceIds = computed<ReadonlySet<string>>(() =>
  new Set(props.tasks.map((task) => task.id))
);
const threadResizeStep = 24;
const activeThreadParentId = ref<string | null>(null);
const threadRevealTargetId = ref<string | null>(null);
const replyTarget = ref<RoomReplyTarget | null>(null);
const messageViewport = ref<InstanceType<typeof RoomMessageViewport> | null>(null);
const threadLayoutElement = ref<HTMLElement | null>(null);
const threadLayoutWidth = ref(0);
const threadReturnFocusElement = ref<HTMLElement | null>(null);
const transientHighlightMessageId = ref<string | null>(null);
const threadPaneWidth = ref(threadPaneDefaultWidth);
const isResizingThreadPane = ref(false);
const fetchedThreadRootId = ref<string | null>(null);
const fetchedThreadRoot = ref<DesktopRoomMessage | null>(null);
const fetchedThreadReplies = ref<DesktopRoomMessage[]>([]);
const fetchedThreadHasOlder = ref(false);
const loadingOlderThreadReplies = ref(false);
const threadSummaryOverrides = ref(new Map<string, DesktopRoomMessageThreadSummary>());
const openedThreadSummaries = ref(new Map<string, DesktopRoomMessageThreadSummary>());
const lastMarkedThreadReadKey = ref<string | null>(null);
let transientHighlightTimeout: number | null = null;
let threadPaneResizeState: { startX: number; startWidth: number; cursor: string; userSelect: string } | null = null;
let threadLayoutResizeObserver: ResizeObserver | null = null;
const messagesWithThreadOverrides = computed(() => applyThreadSummaryOverrides(props.messages));
const threadMessagesWithThreadOverrides = computed(() => applyThreadSummaryOverrides(props.threadMessages));
const threadLayoutStyle = computed<CSSProperties>(() => ({
  "--room-thread-pane-width": `${threadPaneWidth.value}px`,
}));
const threadPaneOverlay = computed(() => shouldOverlayThreadPane(threadLayoutWidth.value));
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

function openThread(messageId: string, refresh = true): void {
  if (document.activeElement instanceof HTMLElement) {
    threadReturnFocusElement.value = document.activeElement;
  }
  if (activeThreadParentId.value !== messageId) {
    messageViewport.value?.preserveScrollAnchorOnNextLayout(threadLayoutAnimationMs);
    clearThreadAttachmentDrafts();
  }
  forgetOpenedThreadSummary(messageId);
  activeThreadParentId.value = messageId;
  if (refresh) void loadThread(messageId);
}

function quoteReply(messageId: string): void {
  replyTarget.value = threadMessagesWithThreadOverrides.value.find((message) => message.id === messageId) ?? null;
}

function quoteSelectedText(messageId: string, selectedText: string): void {
  const target = threadMessagesWithThreadOverrides.value.find((message) => message.id === messageId) ?? null;
  const text = selectedText.trim();
  replyTarget.value = target && text
    ? {
        ...target,
        id: `selection:${target.id}`,
        text,
        attachments: [],
        threadRootId: `selection:${target.id}`,
        threadReplyToId: null,
        thread: null,
        replyTo: null,
        isSelection: true,
        sourceMessageId: target.id,
      }
    : null;
}

function openEventPreview(event: ComposerEventPreview): void {
  if (event.url) {
    emit("open-github-event", event.url);
    return;
  }
  emit("open-events");
}

function clearReplyTarget(): void {
  replyTarget.value = null;
}

function closeThread(): void {
  messageViewport.value?.preserveScrollAnchorOnNextLayout(threadLayoutAnimationMs);
  activeThreadParentId.value = null;
  threadRevealTargetId.value = null;
  clearThreadAttachmentDrafts();
  void nextTick(() => {
    threadReturnFocusElement.value?.focus({ preventScroll: true });
    threadReturnFocusElement.value = null;
  });
}

function startThreadPaneResize(event: PointerEvent): void {
  if (event.button !== 0) return;
  event.preventDefault();
  messageViewport.value?.preserveScrollAnchorOnNextLayout(threadLayoutAnimationMs);
  threadPaneResizeState = {
    startX: event.clientX,
    startWidth: threadPaneWidth.value,
    cursor: document.body.style.cursor,
    userSelect: document.body.style.userSelect,
  };
  isResizingThreadPane.value = true;
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  window.addEventListener("pointermove", handleThreadPaneResize);
  window.addEventListener("pointerup", stopThreadPaneResize);
  window.addEventListener("pointercancel", stopThreadPaneResize);
}

function handleThreadPaneResize(event: PointerEvent): void {
  const state = threadPaneResizeState;
  if (!state) return;
  event.preventDefault();
  messageViewport.value?.preserveScrollAnchorOnNextLayout(80);
  setThreadPaneWidth(state.startWidth + state.startX - event.clientX, false);
}

function stopThreadPaneResize(): void {
  const state = threadPaneResizeState;
  if (state) {
    document.body.style.cursor = state.cursor;
    document.body.style.userSelect = state.userSelect;
  }
  threadPaneResizeState = null;
  isResizingThreadPane.value = false;
  window.removeEventListener("pointermove", handleThreadPaneResize);
  window.removeEventListener("pointerup", stopThreadPaneResize);
  window.removeEventListener("pointercancel", stopThreadPaneResize);
}

function adjustThreadPaneWidth(delta: number): void {
  setThreadPaneWidth(threadPaneWidth.value + delta);
}

function resetThreadPaneWidth(): void {
  setThreadPaneWidth(threadPaneDefaultWidth);
}

function setThreadPaneWidth(width: number, preserveAnchor = true): void {
  const nextWidth = clampThreadPaneWidth(width);
  if (nextWidth === threadPaneWidth.value) return;
  if (preserveAnchor) {
    messageViewport.value?.preserveScrollAnchorOnNextLayout(threadLayoutAnimationMs);
  }
  threadPaneWidth.value = nextWidth;
}

function clampThreadPaneWidth(width: number): number {
  return Math.round(Math.min(Math.max(width, threadPaneMinWidth), maxThreadPaneWidth()));
}

function maxThreadPaneWidth(): number {
  const containerWidth = threadLayoutWidth.value || threadLayoutElement.value?.clientWidth || 0;
  return containerWidth
    ? maxThreadPaneWidthForContainer(containerWidth)
    : threadPaneHardMaxWidth;
}

function clampThreadPaneToViewport(): void {
  if (threadPaneOverlay.value) return;
  threadPaneWidth.value = clampThreadPaneWidth(threadPaneWidth.value);
}

function syncThreadLayoutWidth(): void {
  const width = threadLayoutElement.value?.clientWidth || 0;
  threadLayoutWidth.value = width;
  if (!shouldOverlayThreadPane(width)) clampThreadPaneToViewport();
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
  const roomApi = desktopIpc.room;
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
  const roomApi = desktopIpc.room;
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
  const roomApi = desktopIpc.room;
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
  const destination = roomMessageRevealDestination(
    messageId,
    messagesWithThreadOverrides.value,
    threadMessagesWithThreadOverrides.value,
  );
  if (destination.kind === "thread") {
    // The source graph already contains this exact reply. Render it directly;
    // a refresh RPC must not be allowed to turn a known link into a no-op.
    threadRevealTargetId.value = messageId;
    openThread(destination.threadRootId, false);
    return;
  }
  if (destination.kind === "history") {
    emit("reveal-message", messageId);
    return;
  }
  transientHighlightMessageId.value = messageId;
  if (!messageViewport.value?.scrollToMessage(messageId)) {
    emit("reveal-message", messageId);
    return;
  }
  if (transientHighlightTimeout !== null) {
    window.clearTimeout(transientHighlightTimeout);
  }
  transientHighlightTimeout = window.setTimeout(() => {
    transientHighlightMessageId.value = null;
    transientHighlightTimeout = null;
  }, 1800);
}

function requestMessageReveal(messageId: string): void {
  emit("reveal-message", messageId);
}

watch(
  () => props.revealedMessageId,
  (messageId) => {
    if (messageId) void nextTick(() => jumpToMessage(messageId));
  },
);

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
    if (
      replyTarget.value &&
      !replyTarget.value.isSelection &&
      !threadMessagesWithThreadOverrides.value.some((message) => message.id === replyTarget.value?.id)
    ) {
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

onMounted(() => {
  syncThreadLayoutWidth();
  if (typeof ResizeObserver !== "undefined" && threadLayoutElement.value) {
    threadLayoutResizeObserver = new ResizeObserver(syncThreadLayoutWidth);
    threadLayoutResizeObserver.observe(threadLayoutElement.value);
  }
  window.addEventListener("resize", syncThreadLayoutWidth);
});

defineExpose({ openThread });

onBeforeUnmount(() => {
  window.removeEventListener("resize", syncThreadLayoutWidth);
  threadLayoutResizeObserver?.disconnect();
  threadLayoutResizeObserver = null;
  stopThreadPaneResize();
  if (transientHighlightTimeout !== null) {
    window.clearTimeout(transientHighlightTimeout);
  }
});
</script>
