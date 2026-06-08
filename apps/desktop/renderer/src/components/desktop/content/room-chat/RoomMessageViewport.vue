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
        @open-thread="$emit('open-thread', $event)"
        @scroll-to-message="scrollToMessage"
        @open-image="$emit('open-image', $event)"
        @open-agent="$emit('open-agent', $event)"
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
        <h3>{{ roomIdentifier ? "No messages yet" : "Open a room to begin" }}</h3>
        <p>
          {{
            roomIdentifier
              ? "Messages from humans, agents, and GitHub will appear here."
              : "Messages from humans, agents, and GitHub will appear here as the room comes alive."
          }}
        </p>
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
import DesktopChatMessage from "../DesktopChatMessage.vue";
import type { AgentModalTarget } from "../desktop-chat-message/types";
import { buildThreadSummaries } from "./thread-utils";

const props = defineProps<{
  activeSearchMessageId: string | null;
  hasOlderMessages: boolean;
  loadingOlderMessages: boolean;
  messages: DesktopRoomMessage[];
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
  "reply": [message: DesktopRoomMessage];
  "scroll-position": [scrollTop: number];
}>();

const messagesElement = ref<HTMLElement | null>(null);
const unreadCount = ref(0);
const isScrolledFarUp = ref(false);
let isScrolledToBottom = false;
let hasAppliedInitialScroll = false;

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
      updateScrollState();
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
    unreadCount.value = 0;
    isScrolledFarUp.value = false;
    isScrolledToBottom = false;
    hasAppliedInitialScroll = false;
    void nextTick(() => {
      if (!restoreInitialScrollPosition()) {
        scrollToBottom("auto");
      }
    });
  },
);

onMounted(() => {
  void nextTick(() => {
    if (!restoreInitialScrollPosition()) {
      updateScrollState();
    }
  });
});

onBeforeUnmount(() => {
  emitScrollPosition();
});

function scrollToBottom(behavior: ScrollBehavior = "smooth"): void {
  if (!messagesElement.value) return;
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
  const element = messagesElement.value;
  updateScrollState();
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
  if (hasAppliedInitialScroll || !messagesElement.value) return false;
  const scrollTop = props.initialScrollTop;
  if (typeof scrollTop !== "number" || !Number.isFinite(scrollTop)) return false;
  const element = messagesElement.value;
  element.scrollTop = Math.max(0, Math.min(scrollTop, element.scrollHeight));
  hasAppliedInitialScroll = true;
  updateScrollState();
  emitScrollPosition();
  return true;
}

function emitScrollPosition(): void {
  if (!messagesElement.value) return;
  emit("scroll-position", messagesElement.value.scrollTop);
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
