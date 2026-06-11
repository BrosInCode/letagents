<template>
  <div class="room-message-viewport" data-testid="room-chat-viewport">
    <div ref="messagesElement" class="room-message-list" data-testid="room-chat-list" @scroll="handleScroll">
      <button
        v-if="threadMessages.length && hasOlderMessages"
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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { DesktopRoomMessage } from "../../../../../../electron/ipc-types";
import DesktopChatMessage from "../DesktopChatMessage.vue";
import { parseSenderIdentity } from "../desktop-chat-message/identity";
import { truncate } from "../desktop-chat-message/message-rendering";
import type { AgentModalTarget } from "../desktop-chat-message/types";
import { compareRoomMessages } from "../room-shell/messages";
import { buildThreadSummaries, recentThreadActivities } from "./thread-utils";

interface ThreadActivityNotice {
  parentId: string;
  replyId: string;
  label: string;
  title: string;
  preview: string;
}

const props = defineProps<{
  activeSearchMessageId: string | null;
  activeThreadParentId: string | null;
  hasOlderMessages: boolean;
  loadingOlderMessages: boolean;
  messages: DesktopRoomMessage[];
  threadMessages: DesktopRoomMessage[];
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
  "scroll-position": [scrollTop: number];
}>();

const messagesElement = ref<HTMLElement | null>(null);
const unreadCount = ref(0);
const isScrolledFarUp = ref(false);
const threadActivityNotice = ref<ThreadActivityNotice | null>(null);
const dismissedThreadActivityKeys = ref<string[]>([]);
let isScrolledToBottom = false;
let hasAppliedInitialScroll = false;

const threadSummaries = computed(() => buildThreadSummaries(props.threadMessages));
const timelineMessageIds = computed(() => new Set(props.messages.map((message) => message.id)));
const fallbackThreadActivityNotice = computed(() => {
  const activity = recentThreadActivities(props.threadMessages, props.threadMessages.length)
    .filter((item) => item.parent.id !== props.activeThreadParentId)
    .find((item) =>
      !timelineMessageIds.value.has(item.parent.id) &&
      !dismissedThreadActivityKeys.value.includes(threadActivityKey(item.parent.id, item.latest.id))
    );
  return activity ? buildThreadActivityNotice(activity.latest, "Recent thread activity") : null;
});
const visibleThreadActivityNotice = computed(() => threadActivityNotice.value || fallbackThreadActivityNotice.value);

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
    if (messageId) {
      void nextTick(() => scrollToMessage(messageId));
    }
  },
);

watch(
  () => props.roomIdentifier,
  () => {
    unreadCount.value = 0;
    threadActivityNotice.value = null;
    dismissedThreadActivityKeys.value = [];
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
  const key = threadActivityKey(notice.parentId, notice.replyId);
  if (!dismissedThreadActivityKeys.value.includes(key)) {
    dismissedThreadActivityKeys.value = [...dismissedThreadActivityKeys.value, key];
  }
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

function threadActivityKey(parentId: string, replyId: string): string {
  return `${parentId}:${replyId}`;
}
</script>
