<template>
  <article
    class="room-chat-message"
    :class="{
      'is-system-message': isSystem,
      'is-github-message': Boolean(githubEvent),
      'has-reply': Boolean(message.replyTo),
      'is-search-active': searchActive,
      'is-active-thread-root': activeThreadRoot,
      'is-compact-continuation': compactWithPrevious,
    }"
    :data-owner-kind="ownerKind"
    :data-message-id="message.id"
    :data-testid="`room-message-${message.id}`"
    @contextmenu="openContextMenu"
    @pointerup="handleSelectionPointerUp"
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
            class="room-message-reply-action room-message-copy-action"
            type="button"
            :title="copyButtonTitle"
            :aria-label="copyButtonTitle"
            @click="copyMessage"
          >
            <Check v-if="copied" :size="14" aria-hidden="true" />
            <Copy v-else :size="14" aria-hidden="true" />
          </button>
          <button
            class="room-message-reply-action room-message-quote-action"
            type="button"
            title="Quote reply"
            aria-label="Quote reply"
            @click="$emit('quote-reply', message.id)"
          >
            <CornerUpLeft :size="14" aria-hidden="true" />
          </button>
          <button
            class="room-message-reply-action room-message-thread-action"
            type="button"
            title="Reply in thread"
            aria-label="Reply in thread"
            @click="$emit('open-thread', message.id)"
          >
            <MessageSquare :size="14" aria-hidden="true" />
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
          @message-reference-click="$emit('scroll-to-message', $event)"
        />

        <DesktopMessageAttachments
          v-if="message.attachments.length"
          :message-id="message.id"
          :attachments="message.attachments"
          @open-image="$emit('open-image', $event)"
        />
      </div>

      <button
        v-if="threadIndicatorVisible"
        class="room-thread-marker"
        :class="{ 'is-active': activeThreadRoot }"
        type="button"
        :aria-label="threadMarkerAriaLabel"
        @click="$emit('open-thread', message.id)"
      >
        <span class="room-thread-marker-main">
          <MessageSquare :size="13" aria-hidden="true" />
          <strong>{{ threadMarkerCountLabel }}</strong>
          <span v-if="threadSummary.unreadCount > 0" class="room-thread-unread-count">
            {{ threadSummary.unreadCount }}
          </span>
          <span v-if="threadSummary.loadingEarlier" class="room-thread-loading-dot" aria-label="Loading thread"></span>
        </span>
        <span v-if="threadSummary.participants.length" class="room-thread-participants" aria-hidden="true">
          <span
            v-for="participant in threadSummary.participants"
            :key="participant.key"
            class="room-thread-participant-avatar"
            :style="{ '--thread-participant-color': participant.color || getSenderColor(participant.displayName, null) }"
            :title="participant.displayName"
          >
            {{ participantInitials(participant.displayName) }}
          </span>
        </span>
        <span v-if="threadMarkerPreview" class="room-thread-marker-preview">
          {{ threadMarkerPreview }}
        </span>
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
      <button ref="firstContextMenuButton" type="button" role="menuitem" @click="copyFromContext">
        <span>Copy message</span>
      </button>
      <button type="button" role="menuitem" @click="quoteReplyFromContext">
        <span>Quote reply</span>
      </button>
      <button type="button" role="menuitem" @click="openThreadFromContext">
        <span>Reply in thread</span>
      </button>
    </div>

    <Teleport to="body">
      <div
        v-if="selectionPopoverOpen"
        class="room-selection-popover"
        :style="{ left: `${selectionPopoverPosition.x}px`, top: `${selectionPopoverPosition.y}px` }"
        data-testid="room-selection-popover"
        @pointerdown.stop.prevent
      >
        <button type="button" @click="addSelectionToChat">
          Add to chat
        </button>
      </div>
    </Teleport>
  </article>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import { Check, Copy, CornerUpLeft, MessageSquare } from "@lucide/vue";
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
import type { ThreadIndicatorSummary } from "./room-chat/thread-utils";
import DesktopLongMessageContent from "./DesktopLongMessageContent.vue";

const props = defineProps<{
  message: DesktopRoomMessage;
  compactWithPrevious?: boolean;
  threadSummary: ThreadIndicatorSummary;
  activeThreadRoot: boolean;
  highlightQuery: string;
  messageReferenceIds?: ReadonlySet<string>;
  searchActive: boolean;
}>();

const emit = defineEmits<{
  "quote-reply": [messageId: string];
  "open-thread": [messageId: string];
  "scroll-to-message": [messageId: string | null];
  "open-image": [imageId: string];
  "open-agent": [target: AgentModalTarget];
  "open-github-event": [url: string];
  "quote-selection": [messageId: string, text: string];
}>();

const contextMenuOpen = ref(false);
const contextMenuPosition = ref({ x: 0, y: 0 });
const firstContextMenuButton = ref<HTMLButtonElement | null>(null);
const copied = ref(false);
const selectionPopoverOpen = ref(false);
const selectionPopoverPosition = ref({ x: 0, y: 0 });
const selectedQuoteText = ref("");
let copyResetTimeout: number | null = null;
let selectionOutsideListenerActive = false;
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
const renderedText = computed(() =>
  renderMessageText(props.message.text || "No message body.", props.highlightQuery, props.messageReferenceIds)
);
const copyButtonTitle = computed(() => copied.value ? "Copied" : "Copy message");
const threadIndicatorVisible = computed(() =>
  props.threadSummary.count > 0 || props.threadSummary.hasPartialHistory || props.threadSummary.loadingEarlier
);
const threadMarkerCountLabel = computed(() => {
  if (props.threadSummary.loadingEarlier && props.threadSummary.count === 0) return "Loading replies";
  if (props.threadSummary.count === 1) return "1 reply";
  return `${props.threadSummary.count} replies`;
});
const threadMarkerPreview = computed(() => {
  const latest = props.threadSummary.latest;
  const preview = truncate((props.threadSummary.latestPreview || "").replace(/\s+/g, " ").trim(), 92);
  const timestamp = props.threadSummary.latestTimestamp ? formatTimestamp(props.threadSummary.latestTimestamp) : null;
  if (!preview && !timestamp && !latest) return props.threadSummary.hasPartialHistory ? "Earlier replies are not fully loaded" : null;
  const latestName = latest ? parseSenderIdentity(latest).displayName : "Latest";
  const prefix = timestamp ? `${latestName} ${timestamp}` : latestName;
  return preview ? `${prefix}: ${preview}` : prefix;
});
const threadMarkerAriaLabel = computed(() => {
  const unread = props.threadSummary.unreadCount > 0 ? `, ${props.threadSummary.unreadCount} unread` : "";
  return `${threadMarkerCountLabel.value}${unread}. Open thread.`;
});
const agentModalTarget = computed<AgentModalTarget>(() => ({
  actorLabel: props.message.actorLabel || props.message.agentIdentity?.actorLabel || props.message.sender,
  displayName: displayName.value,
  ownerAttribution: ownerAttribution.value,
  ideLabel: ideLabel.value,
  sender: props.message.sender,
  agentKey: props.message.agentIdentity?.agentKey || null,
  agentSessionId: props.message.agentIdentity?.agentSessionId || null,
}));

function participantInitials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const initials = parts.length === 1
    ? parts[0].slice(0, 2)
    : `${parts[0][0]}${parts[parts.length - 1][0]}`;
  return initials.toUpperCase();
}

function openContextMenu(event: MouseEvent): void {
  if (shouldUseNativeContextMenu(event)) {
    return;
  }
  event.preventDefault();
  closeSelectionPopover();
  const menuWidth = 180;
  const menuHeight = 122;
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

function quoteReplyFromContext(): void {
  closeContextMenu();
  emit("quote-reply", props.message.id);
}

function openThreadFromContext(): void {
  closeContextMenu();
  emit("open-thread", props.message.id);
}

async function copyFromContext(): Promise<void> {
  closeContextMenu();
  await copyMessage();
}

async function copyMessage(): Promise<void> {
  const text = messageCopyText();
  if (!text) return;
  const clipboard = navigator.clipboard;
  if (!clipboard?.writeText) {
    copied.value = false;
    return;
  }
  try {
    await clipboard.writeText(text);
    copied.value = true;
    if (copyResetTimeout !== null) {
      window.clearTimeout(copyResetTimeout);
    }
    copyResetTimeout = window.setTimeout(() => {
      copied.value = false;
      copyResetTimeout = null;
    }, 1400);
  } catch {
    copied.value = false;
  }
}

function messageCopyText(): string {
  const text = props.message.text.trim();
  if (text) return text;
  if (props.message.attachments.length === 1) {
    return props.message.attachments[0]?.fileName || props.message.attachments[0]?.name || "1 attachment";
  }
  if (props.message.attachments.length > 1) {
    return props.message.attachments
      .map((attachment) => attachment.fileName || attachment.name || "attachment")
      .join("\n");
  }
  return "";
}

function handleSelectionPointerUp(event: PointerEvent): void {
  if (event.button !== 0) return;
  const article = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  window.setTimeout(() => {
    const selection = window.getSelection();
    const selectedText = normalizedSelectedText(selection);
    if (!selection || !selectedText || !selection.rangeCount) {
      closeSelectionPopover();
      return;
    }

    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const containerElement = container.nodeType === Node.ELEMENT_NODE
      ? container as Element
      : container.parentElement;
    if (!article || !containerElement || !article.contains(containerElement)) {
      closeSelectionPopover();
      return;
    }

    const bounds = range.getBoundingClientRect();
    if (!bounds.width && !bounds.height) {
      closeSelectionPopover();
      return;
    }

    selectedQuoteText.value = selectedText;
    selectionPopoverPosition.value = {
      x: Math.max(8, Math.min(bounds.left + bounds.width / 2, window.innerWidth - 112)),
      y: Math.max(8, bounds.top - 42),
    };
    contextMenuOpen.value = false;
    selectionPopoverOpen.value = true;
    addSelectionOutsidePointerListener();
    window.addEventListener("keydown", handleSelectionKeydown);
  }, 0);
}

function addSelectionToChat(): void {
  const text = selectedQuoteText.value.trim();
  if (!text) return;
  emit("quote-selection", props.message.id, text);
  window.getSelection()?.removeAllRanges();
  closeSelectionPopover();
}

function handleSelectionOutsidePointerDown(event: PointerEvent): void {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(".room-selection-popover")) {
    return;
  }
  closeSelectionPopover();
}

function handleSelectionKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    closeSelectionPopover();
  }
}

function closeSelectionPopover(): void {
  selectionPopoverOpen.value = false;
  selectedQuoteText.value = "";
  removeSelectionOutsidePointerListener();
  window.removeEventListener("keydown", handleSelectionKeydown);
}

function addSelectionOutsidePointerListener(): void {
  if (selectionOutsideListenerActive) return;
  selectionOutsideListenerActive = true;
  window.addEventListener("pointerdown", handleSelectionOutsidePointerDown);
}

function removeSelectionOutsidePointerListener(): void {
  if (!selectionOutsideListenerActive) return;
  selectionOutsideListenerActive = false;
  window.removeEventListener("pointerdown", handleSelectionOutsidePointerDown);
}

function normalizedSelectedText(selection: Selection | null): string {
  return selection?.toString().replace(/\r\n?/g, "\n").trim() || "";
}

onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleContextMenuKeydown);
  removeSelectionOutsidePointerListener();
  window.removeEventListener("keydown", handleSelectionKeydown);
  if (copyResetTimeout !== null) {
    window.clearTimeout(copyResetTimeout);
  }
});
</script>
