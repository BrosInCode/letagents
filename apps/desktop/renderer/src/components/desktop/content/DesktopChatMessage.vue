<template>
  <article
    class="room-chat-message"
    :class="{
      'is-system-message': isSystem,
      'is-github-message': Boolean(githubEvent),
      'has-reply': Boolean(message.replyTo),
      'is-search-active': searchActive,
    }"
    :data-owner-kind="ownerKind"
    :data-message-id="message.id"
    :data-testid="`room-message-${message.id}`"
    @contextmenu="openContextMenu"
  >
    <div
      class="room-chat-avatar"
      :style="{ '--avatar-color': senderColor }"
      aria-hidden="true"
    />

    <div class="room-chat-message-content">
      <div class="room-message-meta">
        <div class="room-message-author-block">
          <button
            v-if="ownerKind === 'agent'"
            class="room-message-author-button"
            type="button"
            :title="`Show ${displayName} activity`"
            @click="$emit('open-agent', agentModalTarget)"
          >
            {{ displayName }}
          </button>
          <strong v-else>{{ displayName }}</strong>
          <span v-if="ownerAttribution" class="room-message-owner">{{ ownerAttribution }}</span>
          <span v-if="ideLabel" class="room-message-ide" :data-ide="ideLabel.toLowerCase()">
            {{ ideLabel }}
          </span>
        </div>
        <div class="room-message-meta-tail">
          <button
            class="room-message-reply-action room-message-thread-action"
            type="button"
            title="Reply in thread"
            aria-label="Reply in thread"
            @click="$emit('open-thread', message.id)"
          >
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5A1.5 1.5 0 0 1 11.5 11H8.25L5 13v-2H4.5A1.5 1.5 0 0 1 3 9.5v-5Z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" />
              <path d="M6 6.25h4M6 8.5h2.75" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
            </svg>
          </button>
          <span class="room-message-provenance" :data-kind="ownerKind">
            {{ ownerKind }}
          </span>
          <time :datetime="message.timestamp">{{ formattedTime }}</time>
        </div>
      </div>

      <div class="room-message-bubble">
        <button
          v-if="message.replyTo"
          class="room-message-reply"
          type="button"
          :aria-label="`Reply preview from ${replyDisplayName}`"
          @click="$emit('scroll-to-message', message.replyTo.id)"
        >
          <span class="room-message-reply-label">Replying to {{ replyDisplayName }}</span>
          <span class="room-message-reply-text">{{ replyPreviewText }}</span>
        </button>

        <DesktopGitHubEventCard
          v-if="githubEvent"
          :event="githubEvent"
          @open-event="$emit('open-github-event', $event)"
        />

        <DesktopLongMessageContent
          v-else
          :text="message.text || 'No message body.'"
          :html="renderedText"
          :message-id="message.id"
        />

        <DesktopMessageAttachments
          v-if="message.attachments.length"
          :message-id="message.id"
          :attachments="message.attachments"
          @open-image="$emit('open-image', $event)"
        />
      </div>

      <button
        v-if="threadCount > 0"
        class="room-thread-marker"
        type="button"
        @click="$emit('open-thread', message.id)"
      >
        {{ threadMarkerLabel }}
      </button>
    </div>

    <div
      v-if="contextMenuOpen"
      class="room-message-context-menu"
      :style="{ left: `${contextMenuPosition.x}px`, top: `${contextMenuPosition.y}px` }"
      role="menu"
      data-testid="room-message-context-menu"
      @keydown.down.prevent="focusContextMenuItem(1)"
      @keydown.up.prevent="focusContextMenuItem(-1)"
      @pointerdown.stop
      @contextmenu.prevent.stop
    >
      <button ref="firstContextMenuButton" type="button" role="menuitem" @click="openThreadFromContext">
        <span>Reply in thread</span>
      </button>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import type { DesktopRoomMessage } from "../../../../../electron/ipc-types";
import DesktopGitHubEventCard from "./desktop-chat-message/DesktopGitHubEventCard.vue";
import DesktopMessageAttachments from "./desktop-chat-message/DesktopMessageAttachments.vue";
import {
  getSenderColor,
  parseSenderIdentity,
} from "./desktop-chat-message/identity";
import { parseGitHubEvent } from "./desktop-chat-message/github-event";
import {
  formatTimestamp,
  renderMessageText,
  truncate,
} from "./desktop-chat-message/message-rendering";
import type { AgentModalTarget } from "./desktop-chat-message/types";
import DesktopLongMessageContent from "./DesktopLongMessageContent.vue";

const props = defineProps<{
  message: DesktopRoomMessage;
  threadCount: number;
  latestThreadMessage: DesktopRoomMessage | null;
  highlightQuery: string;
  searchActive: boolean;
}>();

const emit = defineEmits<{
  "open-thread": [messageId: string];
  "scroll-to-message": [messageId: string | null];
  "open-image": [imageId: string];
  "open-agent": [target: AgentModalTarget];
  "open-github-event": [url: string];
}>();

const contextMenuOpen = ref(false);
const contextMenuPosition = ref({ x: 0, y: 0 });
const firstContextMenuButton = ref<HTMLButtonElement | null>(null);
const identity = computed(() => parseSenderIdentity(props.message));
const displayName = computed(() => props.message.agentIdentity?.displayName || identity.value.displayName);
const ownerAttribution = computed(() => props.message.agentIdentity?.ownerAttribution || identity.value.ownerAttribution);
const ideLabel = computed(() => props.message.agentIdentity?.ideLabel || identity.value.ideLabel);
const isSystem = computed(() => ["system", "letagents"].includes(props.message.sender.toLowerCase()));
const githubEvent = computed(() => parseGitHubEvent(props.message));
const senderColor = computed(() => getSenderColor(props.message.sender, props.message.source));
const ownerKind = computed(() => {
  if (isSystem.value) return "system";
  if (props.message.source === "github") return "github";
  if (props.message.source === "agent" || ownerAttribution.value || ideLabel.value) return "agent";
  if (props.message.source === "browser") return "human";
  return "room";
});
const replyDisplayName = computed(() =>
  props.message.replyTo ? parseSenderIdentity(props.message.replyTo).displayName : "unknown"
);
const replyPreviewText = computed(() => truncate((props.message.replyTo?.text || "").replace(/\s+/g, " ").trim(), 160));
const formattedTime = computed(() => formatTimestamp(props.message.timestamp));
const renderedText = computed(() => renderMessageText(props.message.text || "No message body.", props.highlightQuery));
const threadMarkerLabel = computed(() => {
  const base = props.threadCount === 1 ? "View 1 reply" : `View ${props.threadCount} replies`;
  if (!props.latestThreadMessage) return base;
  const latestName = parseSenderIdentity(props.latestThreadMessage).displayName;
  return `${base} · latest ${latestName} ${formatTimestamp(props.latestThreadMessage.timestamp)}`;
});
const agentModalTarget = computed<AgentModalTarget>(() => ({
  actorLabel: props.message.actorLabel || props.message.agentIdentity?.actorLabel || props.message.sender,
  displayName: displayName.value,
  ownerAttribution: ownerAttribution.value,
  ideLabel: ideLabel.value,
  sender: props.message.sender,
}));

function openContextMenu(event: MouseEvent): void {
  if (shouldUseNativeContextMenu(event)) {
    return;
  }
  event.preventDefault();
  const menuWidth = 180;
  const menuHeight = 50;
  contextMenuPosition.value = {
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
  };
  contextMenuOpen.value = true;
  void nextTick(() => firstContextMenuButton.value?.focus());
  window.setTimeout(() => {
    window.addEventListener("pointerdown", closeContextMenu, { once: true });
    window.addEventListener("keydown", handleContextMenuKeydown);
  }, 0);
}

function shouldUseNativeContextMenu(event: MouseEvent): boolean {
  const target = event.target instanceof Element ? event.target : null;
  return Boolean(target?.closest("a, button, input, textarea, select, [contenteditable='true']"));
}

function closeContextMenu(): void {
  contextMenuOpen.value = false;
  window.removeEventListener("keydown", handleContextMenuKeydown);
}

function handleContextMenuKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") closeContextMenu();
}

function focusContextMenuItem(direction: 1 | -1): void {
  const items = Array.from(document.querySelectorAll<HTMLButtonElement>(".room-message-context-menu [role='menuitem']"));
  if (!items.length) return;
  const currentIndex = Math.max(0, items.findIndex((item) => item === document.activeElement));
  const nextIndex = (currentIndex + direction + items.length) % items.length;
  items[nextIndex]?.focus();
}

function openThreadFromContext(): void {
  closeContextMenu();
  emit("open-thread", props.message.id);
}

onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleContextMenuKeydown);
});
</script>
