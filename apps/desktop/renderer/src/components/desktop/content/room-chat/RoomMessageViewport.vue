<template>
  <div class="room-message-viewport" data-testid="room-chat-viewport">
    <div ref="messagesElement" class="room-message-list" data-testid="room-chat-list" @scroll="handleScroll">
      <button
        v-if="(threadMessages.length || hasFilteredRoomActivity) && hasOlderMessages"
        class="room-load-older"
        type="button"
        :disabled="loadingOlderMessages"
        data-testid="desktop-load-older-messages"
        @click="$emit('load-older')"
      >
        {{ loadingOlderMessages ? "Loading earlier messages..." : "Load earlier messages" }}
      </button>

      <template v-for="entry in timelineEntries" :key="entry.id">
        <div
          v-if="entry.type === 'date'"
          class="room-date-separator"
          :datetime="entry.dateTime"
          data-testid="room-date-separator"
        >
          <span>{{ entry.label }}</span>
        </div>

        <DesktopChatMessage
          v-else
          :message="entry.message"
          :compact-with-previous="entry.compactWithPrevious"
          :thread-summary="threadIndicatorSummary(entry.message)"
          :active-thread-root="entry.message.id === activeThreadParentId"
          :highlight-query="searchQuery"
          :message-reference-ids="messageReferenceIds"
          :task-reference-ids="taskReferenceIds"
          :search-active="entry.message.id === activeSearchMessageId"
          :animate-arrival="arrivingMessageIds.has(entry.message.id)"
          @quote-reply="$emit('quote-reply', $event)"
          @quote-selection="(messageId, text) => $emit('quote-selection', messageId, text)"
          @open-thread="$emit('open-thread', $event)"
          @scroll-to-message="scrollToMessage"
          @open-image="$emit('open-image', $event)"
          @open-agent="$emit('open-agent', $event)"
          @open-github-event="$emit('open-github-event', $event)"
          @open-task="$emit('open-task', $event)"
        />
      </template>

      <div
        v-if="localAgentWork.length && !roomLoading"
        class="room-local-agent-work-list"
        data-testid="room-local-agent-work-list"
      >
        <article
          v-for="work in collapsedAgentWork.visible"
          :key="work.id"
          class="room-local-agent-work"
          data-testid="room-local-agent-work"
        >
          <span class="room-local-agent-work-pulse" aria-hidden="true"></span>
          <div>
            <strong>{{ work.displayName }}</strong>
            <span data-testid="room-local-agent-work-echo">{{ work.summary }}</span>
          </div>
          <span class="room-local-agent-work-dots" aria-hidden="true">
            <i></i>
            <i></i>
            <i></i>
          </span>
        </article>
        <p
          v-if="collapsedAgentWork.hiddenCount > 0"
          class="room-local-agent-work-overflow"
          data-testid="room-local-agent-work-overflow"
          aria-live="polite"
        >
          +{{ collapsedAgentWork.hiddenCount }} more {{ collapsedAgentWork.hiddenCount === 1 ? "agent" : "agents" }} working
        </p>
      </div>

      <div v-if="roomLoading" class="room-loading-state" data-testid="room-chat-loading" aria-label="Loading room messages">
        <div
          v-for="index in 4"
          :key="index"
          class="room-loading-message"
          :data-size="index"
          aria-hidden="true"
        >
          <span class="room-loading-avatar"></span>
          <span class="room-loading-lines">
            <span></span>
            <span></span>
          </span>
        </div>
      </div>

      <article v-else-if="!messages.length && !localAgentWork.length" class="room-empty-card" data-testid="room-chat-empty">
        <h3>{{ emptyStateTitle }}</h3>
        <p>{{ emptyStateDescription }}</p>
      </article>
    </div>
    <div
      v-if="threadActivityNotice && !roomLoading"
      class="room-thread-activity-pill"
      data-testid="room-thread-activity-pill"
    >
      <button class="room-thread-activity-open" type="button" @click="openThreadActivityNotice">
        <span>Thread reply</span>
        <strong>{{ threadActivityNotice.title }}</strong>
        <small>{{ threadActivityNotice.preview }}</small>
      </button>
      <button
        class="room-thread-activity-dismiss"
        type="button"
        aria-label="Dismiss thread activity"
        @click="dismissThreadActivityNotice()"
      >
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="m4.25 4.25 7.5 7.5M11.75 4.25l-7.5 7.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
      </button>
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
</template>

<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import type { DesktopRoomMessage } from "../../../../../../electron/ipc-types";
import {
  WORK_INDICATOR_ECHO_MIN_INTERVAL_MS,
  coalesceWorkIndicatorEchoes,
  collapseWorkIndicators,
  type ManagedAgentWorkIndicator,
  type WorkIndicatorEchoState,
} from "../../../../domain/managed-agents";
import DesktopChatMessage from "../DesktopChatMessage.vue";
import { parseSenderIdentity } from "../desktop-chat-message/identity";
import { truncate } from "../desktop-chat-message/message-rendering";
import type { AgentModalTarget } from "../desktop-chat-message/types";
import { compareRoomMessages } from "../room-shell/messages";
import { getAppendedMessageIds } from "./message-arrival";
import { buildThreadIndicatorSummary, buildThreadSummaries, threadParentId, threadQuotePreview } from "./thread-utils";
import { buildMessageTimelineEntries } from "./timeline";

interface ThreadActivityNotice {
  parentId: string;
  title: string;
  preview: string;
}

interface ScrollAnchor {
  messageId: string;
  offsetTop: number;
}

const maxAutoViewportBackfillPages = 5;
const viewportFillSlack = 32;

const props = defineProps<{
  active: boolean;
  activeSearchMessageId: string | null;
  activeThreadParentId: string | null;
  hasOlderMessages: boolean;
  loadingOlderMessages: boolean;
  messages: DesktopRoomMessage[];
  threadMessages: DesktopRoomMessage[];
  messageNamespace: string;
  localAgentWork: ManagedAgentWorkIndicator[];
  hasFilteredRoomActivity: boolean;
  roomIdentifier: string | null;
  githubActivityAvailable: boolean;
  roomLoading: boolean;
  searchQuery: string;
  taskReferenceIds: ReadonlySet<string>;
  initialScrollTop?: number | null;
}>();

const emit = defineEmits<{
  "load-older": [];
  "open-agent": [target: AgentModalTarget];
  "open-image": [imageId: string];
  "open-thread": [messageId: string];
  "quote-reply": [messageId: string];
  "quote-selection": [messageId: string, text: string];
  "scroll-position": [scrollTop: number];
  "open-github-event": [url: string];
  "open-task": [taskId: string];
}>();

const emptyStateTitle = computed(() => {
  if (!props.roomIdentifier) return "Open a room to begin";
  return props.hasFilteredRoomActivity ? "No chat messages visible" : "No messages yet";
});

const emptyStateDescription = computed(() => {
  if (!props.roomIdentifier) {
    return props.githubActivityAvailable
      ? "Messages from humans, agents, and GitHub will appear here as the room comes alive."
      : "Messages from humans and agents will appear here as the room comes alive.";
  }
  return props.hasFilteredRoomActivity
    ? "The loaded history contains activity that is hidden from Chat."
    : props.githubActivityAvailable
      ? "Messages from humans, agents, and GitHub will appear here."
      : "Messages from humans and agents will appear here.";
});

const messagesElement = ref<HTMLElement | null>(null);
const unreadCount = ref(0);
const isScrolledFarUp = ref(false);
const threadActivityNotice = ref<ThreadActivityNotice | null>(null);
const autoViewportBackfillCount = ref(0);
const arrivingMessageIds = ref<ReadonlySet<string>>(new Set());
const arrivalTimers = new Map<string, number>();
let isScrolledToBottom = false;
let hasAppliedInitialScroll = false;
let shouldRestoreInitialScroll = hasInitialScrollPosition();
let shouldJumpToLatestOnActivate = false;
let shouldRestoreKeepAliveScroll = false;
let lastKnownScrollAnchor: ScrollAnchor | null = null;
let lastKnownScrollTop: number | null = null;
let autoViewportBackfillFrame: number | null = null;
let layoutAnchorRestoreFrame: number | null = null;
let threadActivityNamespace = props.messageNamespace;
let suppressNextThreadActivityNotice = false;

const threadSummaries = computed(() => buildThreadSummaries(props.threadMessages));
const timelineEntries = computed(() => buildMessageTimelineEntries(props.messages));
const messageReferenceIds = computed(() =>
  new Set(props.messages.map((message) => message.id))
);

watch(
  () => props.messages,
  async (newMessages, oldMessages) => {
    const appendedIds = getAppendedMessageIds(
      (oldMessages || []).map((message) => message.id),
      newMessages.map((message) => message.id),
    );
    markMessagesArriving(appendedIds);
    const previousScrollHeight = messagesElement.value?.scrollHeight || 0;
    const oldFirstId = oldMessages?.[0]?.id;
    const oldLastId = oldMessages?.[oldMessages.length - 1]?.id;
    const oldLastMessage = oldMessages?.[oldMessages.length - 1] || null;
    const newLastMessage = newMessages[newMessages.length - 1] || null;
    const newLastId = newMessages[newMessages.length - 1]?.id;
    const oldFirstIndexInNew = oldFirstId
      ? newMessages.findIndex((message) => message.id === oldFirstId)
      : -1;
    const isPrepend = oldFirstIndexInNew > 0;
    const isNewLatestMessage = Boolean(
      oldLastMessage &&
      newLastMessage &&
      newLastMessage.id !== oldLastMessage.id &&
      compareRoomMessages(newLastMessage, oldLastMessage) > 0
    );
    const prependAnchor = isPrepend ? captureScrollAnchor() : null;

    await nextTick();

    if (!props.active) {
      if (isNewLatestMessage && isScrolledToBottom) {
        shouldJumpToLatestOnActivate = true;
      }
      return;
    }
    if (isPrepend && messagesElement.value) {
      if (!restoreScrollAnchor(prependAnchor)) {
        setInstantScrollTop(
          messagesElement.value,
          messagesElement.value.scrollTop + messagesElement.value.scrollHeight - previousScrollHeight,
        );
        updateScrollState();
        emitScrollPosition();
      }
      return;
    }
    if (!oldLastId) {
      if (newMessages.length) {
        if (restoreInitialScrollPosition()) {
          return;
        }
        scrollToBottom("auto");
        return;
      }
      updateScrollState();
      return;
    }
    if (newLastId === oldLastId) {
      updateScrollState();
      return;
    }
    if (isScrolledToBottom) {
      scrollToBottom("auto");
      return;
    }
    if (newLastId) {
      unreadCount.value += Math.max(1, newMessages.length - (oldMessages?.length || 0));
    }
  },
  { immediate: true },
);

// Rate-limit the live echo text: an entry's summary changes at most once per
// WORK_INDICATOR_ECHO_MIN_INTERVAL_MS. State persists across polls; a trailing
// timer flushes any summary held back inside the window so the latest value
// still surfaces if native updates stop arriving.
let echoState: WorkIndicatorEchoState = {};
let echoFlushTimer: number | null = null;
const displayedAgentWork = ref<ManagedAgentWorkIndicator[]>([]);

function applyEchoCoalescing(): void {
  const { state, indicators, hasPending } = coalesceWorkIndicatorEchoes(
    echoState,
    props.localAgentWork,
    Date.now(),
    WORK_INDICATOR_ECHO_MIN_INTERVAL_MS,
  );
  echoState = state;
  displayedAgentWork.value = indicators;
  if (echoFlushTimer !== null) {
    window.clearTimeout(echoFlushTimer);
    echoFlushTimer = null;
  }
  if (hasPending) {
    echoFlushTimer = window.setTimeout(applyEchoCoalescing, WORK_INDICATOR_ECHO_MIN_INTERVAL_MS);
  }
}

watch(
  () => props.localAgentWork,
  () => applyEchoCoalescing(),
  { immediate: true, deep: true },
);

const collapsedAgentWork = computed(() => collapseWorkIndicators(displayedAgentWork.value));

watch(
  () => props.localAgentWork.map((work) => `${work.id}:${work.summary}`).join("|"),
  async (nextKey, previousKey) => {
    if (nextKey === previousKey) {
      return;
    }
    await nextTick();
    if (!messagesElement.value) {
      return;
    }
    if (!previousKey || isScrolledToBottom) {
      scrollToBottom("auto");
      return;
    }
    updateScrollState();
  },
);

watch(
  () => props.messageNamespace,
  (namespace, previousNamespace) => {
    if (namespace === previousNamespace) return;
    threadActivityNamespace = namespace;
    suppressNextThreadActivityNotice = true;
    threadActivityNotice.value = null;
  },
);

watch(
  () => props.threadMessages,
  (newMessages, oldMessages = []) => {
    if (
      suppressNextThreadActivityNotice ||
      threadActivityNamespace !== props.messageNamespace
    ) {
      suppressNextThreadActivityNotice = false;
      threadActivityNamespace = props.messageNamespace;
      threadActivityNotice.value = null;
      return;
    }
    if (!oldMessages.length) return;

    const previousNewestMessage = newestMessage(oldMessages);
    const oldReplyIds = new Set(
      oldMessages
        .filter((message) => threadParentId(message))
        .map((message) => message.id),
    );
    const newThreadReplies = newMessages.filter((message) =>
      threadParentId(message) &&
      !oldReplyIds.has(message.id) &&
      (!previousNewestMessage || compareRoomMessages(message, previousNewestMessage) > 0)
    );
    const latestReply = newestMessage(newThreadReplies);
    const parentId = latestReply ? threadParentId(latestReply) : null;
    if (!latestReply || !parentId || parentId === props.activeThreadParentId) return;

    threadActivityNotice.value = buildThreadActivityNotice(latestReply, parentId);
  },
);

watch(
  () => props.activeThreadParentId,
  (parentId) => {
    if (parentId && threadActivityNotice.value?.parentId === parentId) {
      threadActivityNotice.value = null;
    }
  },
);

watch(
  () => props.activeSearchMessageId,
  (messageId) => {
    if (!props.active) return;
    if (messageId) {
      void nextTick(() => scrollToMessage(messageId));
    }
  },
);

watch(
  () => props.active,
  async (active) => {
    if (!active) {
      emitScrollPosition();
      return;
    }
    await nextTick();
    if (shouldJumpToLatestOnActivate) {
      shouldJumpToLatestOnActivate = false;
      shouldRestoreKeepAliveScroll = false;
      scrollToBottom("auto");
      return;
    }
    if (shouldRestoreKeepAliveScroll && restoreKnownScrollPosition()) {
      shouldRestoreKeepAliveScroll = false;
      return;
    }
    if (!restoreInitialScrollPosition()) {
      updateScrollState();
    }
  },
);

watch(
  [
    () => props.active,
    () => props.roomLoading,
    () => props.hasOlderMessages,
    () => props.loadingOlderMessages,
    () => props.messages.length,
    () => props.threadMessages.length,
    () => props.hasFilteredRoomActivity,
    () => props.roomIdentifier,
  ],
  () => scheduleAutoFillViewport(),
  { immediate: true, flush: "post" },
);

watch(
  () => props.roomIdentifier,
  () => {
    clearMessageArrivals();
    unreadCount.value = 0;
    threadActivityNotice.value = null;
    isScrolledFarUp.value = false;
    isScrolledToBottom = false;
    hasAppliedInitialScroll = false;
    shouldRestoreInitialScroll = hasInitialScrollPosition();
    shouldJumpToLatestOnActivate = false;
    shouldRestoreKeepAliveScroll = false;
    autoViewportBackfillCount.value = 0;
    cancelAutoFillViewport();
    void nextTick(() => {
      if (!restoreInitialScrollPosition()) {
        scrollToBottom("auto");
      }
    });
  },
);

watch(
  () => props.initialScrollTop,
  () => {
    if (hasAppliedInitialScroll) return;
    shouldRestoreInitialScroll = hasInitialScrollPosition();
  },
);

onMounted(() => {
  void nextTick(() => {
    if (!restoreInitialScrollPosition()) {
      updateScrollState();
    }
    scheduleAutoFillViewport();
  });
});

onDeactivated(() => {
  rememberScrollAnchor();
  shouldRestoreKeepAliveScroll = true;
  emitScrollPosition();
});

onActivated(() => {
  void nextTick(() => {
    if (!props.active) return;
    if (restoreKnownScrollPosition()) {
      shouldRestoreKeepAliveScroll = false;
    }
  });
});

onBeforeUnmount(() => {
  clearMessageArrivals();
  cancelAutoFillViewport();
  cancelLayoutAnchorRestore();
  rememberScrollAnchor();
  emitScrollPosition();
  if (echoFlushTimer !== null) {
    window.clearTimeout(echoFlushTimer);
    echoFlushTimer = null;
  }
});

function markMessagesArriving(messageIds: readonly string[]): void {
  if (!messageIds.length) return;
  const nextIds = new Set(arrivingMessageIds.value);
  for (const messageId of messageIds) {
    nextIds.add(messageId);
    const existingTimer = arrivalTimers.get(messageId);
    if (existingTimer !== undefined) window.clearTimeout(existingTimer);
    arrivalTimers.set(messageId, window.setTimeout(() => {
      arrivalTimers.delete(messageId);
      const remainingIds = new Set(arrivingMessageIds.value);
      remainingIds.delete(messageId);
      arrivingMessageIds.value = remainingIds;
    }, 320));
  }
  arrivingMessageIds.value = nextIds;
}

function clearMessageArrivals(): void {
  for (const timer of arrivalTimers.values()) window.clearTimeout(timer);
  arrivalTimers.clear();
  arrivingMessageIds.value = new Set();
}

function scheduleAutoFillViewport(): void {
  cancelAutoFillViewport();
  if (!canAutoFillViewport()) return;
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    void nextTick(() => maybeAutoFillViewport());
    return;
  }
  autoViewportBackfillFrame = window.requestAnimationFrame(() => {
    autoViewportBackfillFrame = null;
    void nextTick(() => maybeAutoFillViewport());
  });
}

function cancelAutoFillViewport(): void {
  if (autoViewportBackfillFrame === null) return;
  if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(autoViewportBackfillFrame);
  }
  autoViewportBackfillFrame = null;
}

function cancelLayoutAnchorRestore(): void {
  if (layoutAnchorRestoreFrame === null) return;
  if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(layoutAnchorRestoreFrame);
  }
  layoutAnchorRestoreFrame = null;
}

function canAutoFillViewport(): boolean {
  return Boolean(
    props.active
    && props.roomIdentifier
    && !props.roomLoading
    && props.hasOlderMessages
    && !props.loadingOlderMessages
    && autoViewportBackfillCount.value < maxAutoViewportBackfillPages
  );
}

function maybeAutoFillViewport(): void {
  if (!canAutoFillViewport()) return;
  const element = messagesElement.value;
  if (!element || !isMeasurableScrollViewport(element)) return;
  const hasLoadedTimelineActivity = props.messages.length > 0
    || props.threadMessages.length > 0
    || props.hasFilteredRoomActivity;
  if (!hasLoadedTimelineActivity) return;
  if (element.scrollHeight > element.clientHeight + viewportFillSlack) return;

  autoViewportBackfillCount.value += 1;
  emit("load-older");
}

function scrollToBottom(behavior: ScrollBehavior = "smooth"): void {
  if (!messagesElement.value) return;
  shouldRestoreInitialScroll = false;
  if (behavior === "auto") {
    jumpToBottom();
    return;
  }
  messagesElement.value.scrollTo({
    top: messagesElement.value.scrollHeight,
    behavior,
  });
  isScrolledToBottom = true;
  unreadCount.value = 0;
  isScrolledFarUp.value = false;
  emitScrollPosition();
}

function jumpToBottom(): void {
  if (!messagesElement.value) return;
  const element = messagesElement.value;
  const previousScrollBehavior = element.style.scrollBehavior;
  element.style.scrollBehavior = "auto";
  element.scrollTop = element.scrollHeight;
  element.style.scrollBehavior = previousScrollBehavior;
  isScrolledToBottom = true;
  unreadCount.value = 0;
  isScrolledFarUp.value = false;
  emitScrollPosition();
}

function handleScroll(): void {
  if (!messagesElement.value) return;
  if (!props.active) return;
  shouldRestoreInitialScroll = false;
  const element = messagesElement.value;
  updateScrollState();
  rememberScrollAnchor();
  if (isScrolledToBottom) {
    unreadCount.value = 0;
  }
  emitScrollPosition();
  if (element.scrollTop < 180 && props.hasOlderMessages && !props.loadingOlderMessages) {
    emit("load-older");
  }
}

function updateScrollState(): void {
  const element = messagesElement.value;
  if (!element) return;
  const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
  isScrolledToBottom = distanceToBottom < 80;
  isScrolledFarUp.value = distanceToBottom > 900;
}

function restoreInitialScrollPosition(): boolean {
  if (hasAppliedInitialScroll || !shouldRestoreInitialScroll || !messagesElement.value) return false;
  const scrollTop = props.initialScrollTop;
  if (typeof scrollTop !== "number" || !Number.isFinite(scrollTop)) return false;
  if (!props.messages.length) return false;
  const element = messagesElement.value;
  const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
  if (scrollTop > maxScrollTop + 24) {
    hasAppliedInitialScroll = true;
    shouldRestoreInitialScroll = false;
    return false;
  }
  setInstantScrollTop(element, Math.max(0, Math.min(scrollTop, maxScrollTop)));
  hasAppliedInitialScroll = true;
  shouldRestoreInitialScroll = false;
  updateScrollState();
  emitScrollPosition();
  return true;
}

function hasInitialScrollPosition(): boolean {
  const scrollTop = props.initialScrollTop;
  return typeof scrollTop === "number" && Number.isFinite(scrollTop);
}

function emitScrollPosition(): void {
  const element = messagesElement.value;
  if (!element) return;
  lastKnownScrollTop = element.scrollTop;
  if (props.active && element.isConnected && element.clientHeight > 0) {
    lastKnownScrollAnchor = captureScrollAnchor();
  }
  emit("scroll-position", element.scrollTop);
}

function rememberScrollAnchor(): void {
  const element = messagesElement.value;
  if (!element) return;
  const nextAnchor = captureScrollAnchor();
  if (nextAnchor) {
    lastKnownScrollAnchor = nextAnchor;
  }
  lastKnownScrollTop = element.scrollTop;
}

function restoreKnownScrollPosition(): boolean {
  const element = messagesElement.value;
  if (!element || !isMeasurableScrollViewport(element)) return false;
  if (restoreScrollAnchor(lastKnownScrollAnchor)) {
    return true;
  }
  if (lastKnownScrollTop === null) return false;
  setInstantScrollTop(element, lastKnownScrollTop);
  updateScrollState();
  emitScrollPosition();
  return true;
}

function preserveScrollAnchorOnNextLayout(durationMs = 0): void {
  const element = messagesElement.value;
  if (!element || !isMeasurableScrollViewport(element)) return;
  const anchor = captureScrollAnchor();
  const scrollTop = element.scrollTop;
  cancelLayoutAnchorRestore();
  void nextTick(() => {
    const startedAt = currentTimeMs();
    const restore = (): void => {
      const currentElement = messagesElement.value;
      if (!currentElement || !isMeasurableScrollViewport(currentElement)) {
        layoutAnchorRestoreFrame = null;
        return;
      }
      if (!restoreScrollAnchor(anchor)) {
        setInstantScrollTop(currentElement, scrollTop);
        updateScrollState();
        emitScrollPosition();
      }
      if (
        durationMs <= 0 ||
        currentTimeMs() - startedAt >= durationMs ||
        typeof window === "undefined" ||
        typeof window.requestAnimationFrame !== "function"
      ) {
        layoutAnchorRestoreFrame = null;
        return;
      }
      layoutAnchorRestoreFrame = window.requestAnimationFrame(restore);
    };
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      layoutAnchorRestoreFrame = window.requestAnimationFrame(restore);
      return;
    }
    restore();
  });
}

function currentTimeMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function captureScrollAnchor(): ScrollAnchor | null {
  const element = messagesElement.value;
  if (!element || !isMeasurableScrollViewport(element)) return null;
  const viewportTop = element.getBoundingClientRect().top;
  const messageElements = [...element.querySelectorAll<HTMLElement>("[data-message-id]")];
  const anchorElement = messageElements.find((messageElement) =>
    messageElement.getBoundingClientRect().bottom > viewportTop
  );
  const messageId = anchorElement?.dataset.messageId;
  if (!anchorElement || !messageId) return null;
  return {
    messageId,
    offsetTop: anchorElement.getBoundingClientRect().top - viewportTop,
  };
}

function restoreScrollAnchor(anchor: ScrollAnchor | null): boolean {
  const element = messagesElement.value;
  if (!element || !anchor || !isMeasurableScrollViewport(element)) return false;
  const anchorElement = [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
    .find((messageElement) => messageElement.dataset.messageId === anchor.messageId);
  if (!anchorElement) return false;
  const viewportTop = element.getBoundingClientRect().top;
  const nextOffsetTop = anchorElement.getBoundingClientRect().top - viewportTop;
  setInstantScrollTop(element, element.scrollTop + nextOffsetTop - anchor.offsetTop);
  updateScrollState();
  emitScrollPosition();
  return true;
}

function isMeasurableScrollViewport(element: HTMLElement): boolean {
  return element.isConnected && element.clientHeight > 0 && element.getClientRects().length > 0;
}

function setInstantScrollTop(element: HTMLElement, scrollTop: number): void {
  const previousScrollBehavior = element.style.scrollBehavior;
  element.style.scrollBehavior = "auto";
  element.scrollTop = scrollTop;
  element.style.scrollBehavior = previousScrollBehavior;
}

function threadIndicatorSummary(message: DesktopRoomMessage) {
  return buildThreadIndicatorSummary(message, threadSummaries.value.get(message.id) || null);
}

defineExpose({
  preserveScrollAnchorOnNextLayout,
  scrollToMessage,
});

function openThreadActivityNotice(): void {
  const notice = threadActivityNotice.value;
  if (!notice) return;
  threadActivityNotice.value = null;
  emit("open-thread", notice.parentId);
}

function scrollToMessage(messageId: string | null): void {
  if (!messageId || !messagesElement.value) return;
  const target = messagesElement.value.querySelector(`[data-testid="room-message-${messageId}"]`) as HTMLElement | null;
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.add("jump-target");
  window.setTimeout(() => target.classList.remove("jump-target"), 1500);
}

function dismissThreadActivityNotice(): void {
  threadActivityNotice.value = null;
}

function buildThreadActivityNotice(reply: DesktopRoomMessage, parentId: string): ThreadActivityNotice {
  const senderName = parseSenderIdentity(reply).displayName;
  const replyCount = threadSummaries.value.get(parentId)?.count || 1;
  return {
    parentId,
    title: `${senderName} replied`,
    preview: `${replyCount} ${replyCount === 1 ? "reply" : "replies"} · ${truncate(threadQuotePreview(reply), 92)}`,
  };
}

function newestMessage(messages: readonly DesktopRoomMessage[]): DesktopRoomMessage | null {
  return messages.reduce<DesktopRoomMessage | null>((latest, message) => {
    if (!latest) return message;
    return compareRoomMessages(message, latest) >= 0 ? message : latest;
  }, null);
}

</script>
