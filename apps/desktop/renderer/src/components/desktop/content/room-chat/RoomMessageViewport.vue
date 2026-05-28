<template>
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
        @reply="$emit('reply', $event)"
        @scroll-to-message="scrollToMessage"
        @open-image="$emit('open-image', $event)"
        @open-agent="$emit('open-agent', $event)"
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
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { DesktopRoomMessage } from "../../../../../../electron/ipc-types";
import DesktopChatMessage, { type AgentModalTarget } from "../DesktopChatMessage.vue";
import { buildThreadSummaries } from "./thread-utils";

const props = defineProps<{
  activeSearchMessageId: string | null;
  hasOlderMessages: boolean;
  initialScrollTop?: number | null;
  loadingOlderMessages: boolean;
  messages: DesktopRoomMessage[];
  roomIdentifier: string | null;
  searchQuery: string;
}>();

const emit = defineEmits<{
  "load-older": [];
  "open-agent": [target: AgentModalTarget];
  "open-image": [imageId: string];
  "reply": [message: DesktopRoomMessage];
  "scroll-position": [scrollTop: number | null];
}>();

const messagesElement = ref<HTMLElement | null>(null);
const unreadCount = ref(0);
const isScrolledFarUp = ref(false);
let isScrolledToBottom = true;
let restoredScrollTop: number | null | undefined;
let initialScrollSettled = false;
let pendingInitialScrollFrame: number | null = null;
let pendingInitialScrollToken = 0;
let componentUnmounted = false;

const threadSummaries = computed(() => buildThreadSummaries(props.messages));

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
  if (messagesElement.value) {
    emit("scroll-position", messagesElement.value.scrollTop);
  }
});

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
  // Chromium/Electron honors the CSS property even when JS says "auto".
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
