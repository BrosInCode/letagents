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

      <DesktopChatMessage
        v-for="message in messages"
        :key="message.id"
        :message="message"
        :thread-count="threadCount(message.id)"
        :latest-thread-message="latestThreadMessage(message.id)"
        :highlight-query="searchQuery"
        :search-active="message.id === activeSearchMessageId"
        @quote-reply="$emit('quote-reply', $event)"
        @open-thread="$emit('open-thread', $event)"
        @scroll-to-message="scrollToMessage"
        @open-image="$emit('open-image', $event)"
        @open-agent="$emit('open-agent', $event)"
        @open-github-event="$emit('open-github-event', $event)"
      />

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

      <article v-else-if="!messages.length" class="room-empty-card" data-testid="room-chat-empty">
        <h3>{{ emptyStateTitle }}</h3>
        <p>{{ emptyStateDescription }}</p>
      </article>
    </div>
    <div
      v-if="visibleThreadActivityNotice && !roomLoading"
      class="room-thread-activity-pill"
      data-testid="room-thread-activity-pill"
    >
      <button class="room-thread-activity-open" type="button" @click="openThreadActivityNotice">
        <span>{{ visibleThreadActivityNotice.label }}</span>
        <strong>{{ visibleThreadActivityNotice.title }}</strong>
        <small>{{ visibleThreadActivityNotice.preview }}</small>
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
import DesktopChatMessage from "../DesktopChatMessage.vue";
import { parseSenderIdentity } from "../desktop-chat-message/identity";
import { truncate } from "../desktop-chat-message/message-rendering";
import type { AgentModalTarget } from "../desktop-chat-message/types";
import { compareRoomMessages } from "../room-shell/messages";
import { buildThreadSummaries } from "./thread-utils";

interface ThreadActivityNotice {
  parentId: string;
  replyId: string;
  label: string;
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
  hasFilteredRoomActivity: boolean;
  roomIdentifier: string | null;
  roomLoading: boolean;
  searchQuery: string;
  initialScrollTop?: number | null;
}>();

const emit = defineEmits<{
  "load-older": [];
  "open-agent": [target: AgentModalTarget];
  "open-image": [imageId: string];
  "open-thread": [messageId: string];
  "quote-reply": [messageId: string];
  "scroll-position": [scrollTop: number];
  "open-github-event": [url: string];
}>();

const emptyStateTitle = computed(() => {
  if (!props.roomIdentifier) return "Open a room to begin";
  return props.hasFilteredRoomActivity ? "No chat messages visible" : "No messages yet";
});

const emptyStateDescription = computed(() => {
  if (!props.roomIdentifier) {
    return "Messages from humans, agents, and GitHub will appear here as the room comes alive.";
  }
  return props.hasFilteredRoomActivity
    ? "The loaded history contains activity that is hidden from Chat."
    : "Messages from humans, agents, and GitHub will appear here.";
});

const messagesElement = ref<HTMLElement | null>(null);
const unreadCount = ref(0);
const isScrolledFarUp = ref(false);
const threadActivityNotice = ref<ThreadActivityNotice | null>(null);
const autoViewportBackfillCount = ref(0);
let isScrolledToBottom = false;
let hasAppliedInitialScroll = false;
let shouldRestoreInitialScroll = hasInitialScrollPosition();
let shouldJumpToLatestOnActivate = false;
let shouldRestoreKeepAliveScroll = false;
let lastKnownScrollAnchor: ScrollAnchor | null = null;
let lastKnownScrollTop: number | null = null;
let autoViewportBackfillFrame: number | null = null;

const threadSummaries = computed(() => buildThreadSummaries(props.threadMessages));
const visibleThreadActivityNotice = computed(() => threadActivityNotice.value);

watch(
  () => props.messages,
  async (newMessages, oldMessages) => {
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

watch(
  () => props.threadMessages,
  (newMessages, oldMessages = []) => {
    if (!oldMessages.length) return;

    const previousNewestMessage = newestMessage([...oldMessages]);
    const oldReplyIds = new Set(
      oldMessages
        .filter((message) => message.replyTo?.id)
        .map((message) => message.id),
    );
    const newThreadReplies = newMessages.filter((message) =>
      message.replyTo?.id &&
      !oldReplyIds.has(message.id) &&
      isNewerThan(message, previousNewestMessage)
    );
    const latestReply = newestMessage(newThreadReplies);
    const parentId = latestReply?.replyTo?.id || null;
    if (!latestReply || !parentId || parentId === props.activeThreadParentId) return;

    threadActivityNotice.value = buildThreadActivityNotice(latestReply);
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
  cancelAutoFillViewport();
  rememberScrollAnchor();
  emitScrollPosition();
});

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

function threadCount(messageId: string): number {
  return threadSummaries.value.get(messageId)?.count || 0;
}

function latestThreadMessage(messageId: string): DesktopRoomMessage | null {
  return threadSummaries.value.get(messageId)?.latest || null;
}

function openThreadActivityNotice(): void {
  const notice = visibleThreadActivityNotice.value;
  if (!notice) return;
  threadActivityNotice.value = null;
  dismissThreadActivityNotice(notice);
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

function dismissThreadActivityNotice(notice: ThreadActivityNotice | null = visibleThreadActivityNotice.value): void {
  if (!notice) return;
  threadActivityNotice.value = null;
}

function buildThreadActivityNotice(reply: DesktopRoomMessage, label = "Thread reply"): ThreadActivityNotice | null {
  const parentId = reply.replyTo?.id;
  if (!parentId) return null;
  const senderName = parseSenderIdentity(reply).displayName;
  const summary = threadSummaries.value.get(parentId);
  return {
    parentId,
    replyId: reply.id,
    label,
    title: `${senderName} replied`,
    preview: `${summary?.count || 1} ${(summary?.count || 1) === 1 ? "reply" : "replies"} · ${messagePreview(reply)}`,
  };
}

function messagePreview(message: DesktopRoomMessage): string {
  const text = (message.text || "").replace(/\s+/g, " ").trim();
  if (text) return truncate(text, 92);
  if (message.attachments.length === 1) return "1 attachment";
  if (message.attachments.length > 1) return `${message.attachments.length} attachments`;
  return "No message body.";
}

function newestMessage(messages: DesktopRoomMessage[]): DesktopRoomMessage | null {
  return messages.reduce<DesktopRoomMessage | null>((latest, message) => {
    if (!latest) return message;
    return compareRoomMessages(message, latest) >= 0 ? message : latest;
  }, null);
}

function isNewerThan(message: DesktopRoomMessage, previous: DesktopRoomMessage | null): boolean {
  return !previous || compareRoomMessages(message, previous) > 0;
}

</script>
