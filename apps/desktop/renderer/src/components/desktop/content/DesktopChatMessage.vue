<template>
  <article
    class="room-chat-message"
    tabindex="-1"
    :class="{
      'is-system-message': isSystem,
      'is-github-message': Boolean(githubEvent),
      'has-reply': Boolean(message.replyTo),
      'is-search-active': searchActive,
      'is-active-thread-root': activeThreadRoot,
      'is-compact-continuation': compactWithPrevious,
      'is-ambient-system-message': isAmbientSystem,
      'is-arriving': animateArrival,
      'is-thread-context': context !== 'timeline',
      'is-thread-root-context': context === 'thread-root',
      'is-thread-reply-context': context === 'thread-reply',
    }"
    :style="{ '--message-accent': senderColor }"
    :data-owner-kind="ownerKind"
    :data-message-id="message.id"
    :data-thread-message-id="threadMessageId || undefined"
    :data-testid="testId || `room-message-${message.id}`"
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
          <ProviderBadge
            v-if="ideLabel"
            :label="ideLabel"
            :agent-key="message.agentIdentity?.agentKey"
          />
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
            :title="tertiaryActionLabel"
            :aria-label="tertiaryActionLabel"
            @click="handleTertiaryAction"
          >
            <LocateFixed v-if="context !== 'timeline'" :size="14" aria-hidden="true" />
            <MessageSquare v-else :size="14" aria-hidden="true" />
          </button>
          <span v-if="provenanceLabel" class="room-message-provenance" :data-kind="ownerKind">
            {{ provenanceLabel }}
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
          :task-link-enabled="Boolean(githubEvent.taskId && taskReferenceIds?.has(githubEvent.taskId))"
          @open-event="$emit('open-github-event', $event)"
          @open-task="$emit('open-task', $event)"
        />

        <DesktopLongMessageContent
          v-else
          :text="message.text || 'No message body.'"
          :html="renderedText"
          :message-id="message.id"
          @message-reference-click="$emit('scroll-to-message', $event)"
          @task-reference-click="$emit('open-task', $event)"
        />

        <DesktopMessageAttachments
          v-if="message.attachments.length"
          :message-id="message.id"
          :attachments="message.attachments"
          @open-image="$emit('open-image', $event)"
        />
      </div>

      <ul
        v-if="visibleDeliveryReceipts.length"
        class="room-message-delivery-receipts"
        aria-label="Agent response status"
        aria-live="polite"
      >
        <li
          v-for="receipt in visibleDeliveryReceipts"
          :key="receipt.agentId"
          :data-state="receipt.state"
          :aria-label="receiptLabel(receipt)"
        >
          <span class="room-message-delivery-indicator" aria-hidden="true">
            <span v-if="receiptIsAnimated(receipt.state)" class="room-message-delivery-dots">
              <i></i><i></i><i></i>
            </span>
            <CircleAlert v-else-if="receiptNeedsAttention(receipt.state) || receipt.state === 'acknowledged_failed'" :size="14" />
            <Check v-else :size="14" />
          </span>
          <strong>{{ receipt.agentName }}</strong>
          <small v-if="receiptStateLabel(receipt)">{{ receiptStateLabel(receipt) }}</small>
          <button
            v-if="receipt.state === 'queued_behind_blocked' && receipt.blockedByMessageId"
            type="button"
            class="room-message-delivery-link"
            @click="$emit('scroll-to-message', receipt.blockedByMessageId)"
          >
            View earlier message
          </button>
          <template
            v-if="receipt.state === 'blocked'
              && receipt.failureCode === 'provider_continuation_missing'
              && receipt.attemptCount === 0
              && !receipt.providerTurnId"
          >
            <button
              type="button"
              :disabled="!continuationRepairAvailable || restoringReceipt(receipt.agentId)"
              :aria-label="continuationRepairAvailable ? `Restore conversation for ${receipt.agentName}` : `Conversation restoration for ${receipt.agentName} is unavailable`"
              @click="continuationRepairAvailable && !restoringReceipt(receipt.agentId) && $emit('restore-conversation', receipt.agentId, message.id)"
            >{{ restoringReceipt(receipt.agentId) ? "Restoring…" : "Restore and retry" }}</button>
            <button
              type="button"
              :disabled="!roomDeliverySkipAvailable || skippingReceipt(receipt.agentId)"
              :aria-label="roomDeliverySkipAvailable ? `Skip blocked message for ${receipt.agentName}` : `Skip message for ${receipt.agentName} is unavailable`"
              @click="roomDeliverySkipAvailable && !skippingReceipt(receipt.agentId) && $emit('skip-delivery', receipt.agentId, message.id)"
            >{{ skippingReceipt(receipt.agentId) ? "Skipping…" : "Skip message" }}</button>
          </template>
          <template v-else-if="receipt.state === 'blocked'">
            <button
              type="button"
              :disabled="!deliveryRecoveryAvailable || retryingReceipt(receipt.agentId)"
              :aria-label="deliveryRecoveryAvailable && !retryingReceipt(receipt.agentId) ? `Retry delivery for ${receipt.agentName}` : `Retry delivery for ${receipt.agentName} is unavailable`"
              :title="deliveryRecoveryAvailable ? 'Retry delivery' : 'Retry will be available when delivery recovery is connected'"
              @click="deliveryRecoveryAvailable && !retryingReceipt(receipt.agentId) && $emit('retry-delivery', receipt.agentId, message.id)"
            >{{ retryingReceipt(receipt.agentId) ? "Retrying…" : deliveryRecoveryAvailable ? "Retry" : "Retry unavailable" }}</button>
            <small v-if="!deliveryRecoveryAvailable">Retry will be available when delivery recovery is connected.</small>
          </template>
        </li>
      </ul>

      <button
        v-if="context === 'timeline' && threadIndicatorVisible"
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

    <Teleport to="body">
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
        <template v-if="contextLinkHref">
          <button ref="firstContextMenuButton" type="button" role="menuitem" @click="openLinkFromContext">
            <span>Open link in browser</span>
          </button>
          <button type="button" role="menuitem" @click="copyLinkFromContext">
            <span>Copy link</span>
          </button>
          <div class="room-message-context-menu-separator" role="separator" />
          <button type="button" role="menuitem" @click="messageInfoFromContext">
            <span>Message info</span>
          </button>
        </template>
        <template v-else>
          <button ref="firstContextMenuButton" type="button" role="menuitem" @click="copyFromContext">
            <span>Copy message</span>
          </button>
          <button type="button" role="menuitem" @click="quoteReplyFromContext">
            <span>Quote reply</span>
          </button>
          <button type="button" role="menuitem" @click="tertiaryActionFromContext">
            <span>{{ tertiaryActionLabel }}</span>
          </button>
          <div class="room-message-context-menu-separator" role="separator" />
          <button type="button" role="menuitem" @click="messageInfoFromContext">
            <span>Message info</span>
          </button>
        </template>
      </div>

      <div
        v-if="selectionPopoverOpen"
        class="room-selection-popover"
        :style="{ left: `${selectionPopoverPosition.x}px`, top: `${selectionPopoverPosition.y}px` }"
        data-testid="room-selection-popover"
        @pointerdown.stop.prevent
      >
        <button type="button" @click="addSelectionToChat">
          {{ selectionActionLabel }}
        </button>
      </div>
    </Teleport>
  </article>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import { Check, CircleAlert, Copy, CornerUpLeft, LocateFixed, MessageSquare } from "@lucide/vue";
import type { DesktopRoomMessage } from "../../../../../electron/ipc-types";
import { desktopIpc } from "../../../ipc/index.js";
import { useCopyIndicator } from "../../../composables/useCopyIndicator";
import { safeUserVisibleErrorDetail } from "../../../domain/user-visible-error";
import { resolveExternalWebHref } from "./desktop-chat-message/message-links";
import DesktopGitHubEventCard from "./desktop-chat-message/DesktopGitHubEventCard.vue";
import DesktopMessageAttachments from "./desktop-chat-message/DesktopMessageAttachments.vue";
import ProviderBadge from "./desktop-chat-message/ProviderBadge.vue";
import {
  getSenderColor,
  parseSenderIdentity,
  resolveOwnerAttribution,
} from "./desktop-chat-message/identity";
import { parseGitHubEvent } from "./desktop-chat-message/github-event";
import {
  restoreContextMenuFocus,
  shouldRestoreContextMenuFocus,
  type ContextMenuCloseReason,
} from "./desktop-chat-message/context-menu-focus";
import {
  formatTimestamp,
  renderMessageText,
  isAmbientSystemMessage,
  stripStatusPrefix,
  truncate,
} from "./desktop-chat-message/message-rendering";
import type { AgentModalTarget } from "./desktop-chat-message/types";
import type { ThreadIndicatorSummary } from "./room-chat/thread-utils";
import DesktopLongMessageContent from "./DesktopLongMessageContent.vue";

const props = withDefaults(defineProps<{
  message: DesktopRoomMessage;
  compactWithPrevious?: boolean;
  threadSummary: ThreadIndicatorSummary;
  activeThreadRoot: boolean;
  highlightQuery: string;
  messageReferenceIds?: ReadonlySet<string>;
  taskReferenceIds?: ReadonlySet<string>;
  searchActive: boolean;
  animateArrival?: boolean;
  context?: "timeline" | "thread-root" | "thread-reply";
  threadMessageId?: string;
  testId?: string;
  deliveryReceipts?: Array<{ agentId: string; agentName: string; state: string; blockedByMessageId: string | null; error: string | null; failureCode: string | null; terminalReason: string | null; attemptCount: number; providerTurnId: string | null }>;
  deliveryRecoveryAvailable?: boolean;
  continuationRepairAvailable?: boolean;
  roomDeliverySkipAvailable?: boolean;
  deliveryRetryKeys?: ReadonlySet<string>;
  continuationRepairKeys?: ReadonlySet<string>;
  roomDeliverySkipKeys?: ReadonlySet<string>;
  providerLabel?: string | null;
}>(), {
  context: "timeline",
  deliveryReceipts: () => [],
  deliveryRecoveryAvailable: false,
  continuationRepairAvailable: false,
  roomDeliverySkipAvailable: false,
});

function retryingReceipt(agentId: string): boolean {
  return props.deliveryRetryKeys?.has(`${agentId}:${props.message.id}`) === true;
}

function restoringReceipt(agentId: string): boolean {
  return props.continuationRepairKeys?.has(`${agentId}:${props.message.id}`) === true;
}

function skippingReceipt(agentId: string): boolean {
  return props.roomDeliverySkipKeys?.has(`${agentId}:${props.message.id}`) === true;
}

const emit = defineEmits<{
  "quote-reply": [messageId: string];
  "open-thread": [messageId: string];
  "scroll-to-message": [messageId: string | null];
  "open-image": [imageId: string];
  "open-agent": [target: AgentModalTarget];
  "open-github-event": [url: string];
  "open-task": [taskId: string];
  "quote-selection": [messageId: string, text: string];
  "jump-to-thread-root": [messageId: string];
  "retry-delivery": [agentId: string, sourceMessageId: string];
  "restore-conversation": [agentId: string, sourceMessageId: string];
  "skip-delivery": [agentId: string, sourceMessageId: string];
  "message-info": [messageId: string, context: "timeline" | "thread-root" | "thread-reply"];
}>();

const visibleDeliveryReceipts = computed(() => props.deliveryReceipts.filter((receipt) => [
  "retryable",
  "result_recovery",
  "blocked",
  "acknowledged_no_reply",
  "acknowledged_failed",
  "cancelled_by_room_move",
  "cancelled_by_user",
  "restoring_conversation",
  "queued_behind_blocked",
].includes(receipt.state)));

function receiptIsAnimated(state: string): boolean {
  return ["pending", "dispatching", "awaiting_result", "publishing", "retryable", "result_recovery", "restoring_conversation"].includes(state);
}

function receiptNeedsAttention(state: string): boolean {
  return state === "blocked" || state === "queued_behind_blocked";
}

function receiptErrorLabel(error: string | null): string | null {
  const normalized = safeUserVisibleErrorDetail(error, "");
  if (!normalized) return null;
  return normalized.length > 180 ? `${normalized.slice(0, 179)}…` : normalized;
}

function receiptStateLabel(receipt: { state: string; terminalReason: string | null; error: string | null }): string {
  if (receipt.terminalReason === "upgrade_authority_unavailable") return "Retired during safety upgrade";
  const state = receipt.state;
  if (state === "retryable") return "Retrying";
  if (state === "result_recovery") return "Recovering reply";
  if (state === "restoring_conversation") return "Restoring conversation";
  if (state === "blocked") return receiptErrorLabel(receipt.error) || "Needs attention";
  if (state === "queued_behind_blocked") return "Queued behind an issue";
  if (state === "acknowledged_no_reply") return "Read · no reply";
  if (state === "acknowledged_failed") return receiptErrorLabel(receipt.error) || "Work did not finish";
  if (state === "cancelled_by_room_move") return "Moved rooms";
  if (state === "cancelled_by_user") return "Skipped";
  return "";
}

function receiptLabel(receipt: { agentName: string; state: string; blockedByMessageId: string | null; terminalReason: string | null; error: string | null }): string {
  if (receipt.terminalReason === "upgrade_authority_unavailable") return `A safety upgrade retired this legacy turn for ${receipt.agentName}; its exact authority could not be reconstructed`;
  if (receipt.state === "dispatching" || receipt.state === "awaiting_result") return `${receipt.agentName} is responding`;
  if (receipt.state === "publishing") return `${receipt.agentName} is sending a reply`;
  if (receipt.state === "pending") return `${receipt.agentName} is queued to respond`;
  if (receipt.state === "acknowledged") return `${receipt.agentName} replied`;
  if (receipt.state === "acknowledged_no_reply") return `${receipt.agentName} saw this and chose not to reply`;
  if (receipt.state === "acknowledged_failed") return `${receipt.agentName}: ${receiptErrorLabel(receipt.error) || "Work did not finish"}`;
  if (receipt.state === "retryable") return `${receipt.agentName} couldn’t finish; retrying`;
  if (receipt.state === "result_recovery") return `${receipt.agentName} answered, but LetAgents is re-reading the completed result`;
  if (receipt.state === "restoring_conversation") return `${receipt.agentName} is restoring its private conversation`;
  if (receipt.state === "blocked") return `${receipt.agentName}: ${receiptErrorLabel(receipt.error) || "Needs attention"}`;
  if (receipt.state === "cancelled_by_room_move") return `${receipt.agentName} moved to another room before handling this`;
  if (receipt.state === "cancelled_by_user") return `You skipped this message for ${receipt.agentName}`;
  if (receipt.state === "queued_behind_blocked") return `Waiting — ${receipt.agentName} needs attention on ${receipt.blockedByMessageId || "an earlier message"}`;
  return `Waiting for ${receipt.agentName}`;
}

const contextMenuOpen = ref(false);
const contextMenuPosition = ref({ x: 0, y: 0 });
const firstContextMenuButton = ref<HTMLButtonElement | null>(null);
const contextMenuInvoker = ref<HTMLElement | null>(null);
// When the right-click landed on an external web link, the menu shows link
// actions ("Open link in browser" / "Copy link") instead of message actions.
const contextLinkHref = ref<string | null>(null);
const { copied, copy: copyToClipboard } = useCopyIndicator(1400);
const selectionPopoverOpen = ref(false);
const selectionPopoverPosition = ref({ x: 0, y: 0 });
const selectedQuoteText = ref("");
let selectionOutsideListenerActive = false;
const identity = computed(() => parseSenderIdentity(props.message));
const displayName = computed(() => props.message.agentIdentity?.displayName || identity.value.displayName);
const ownerAttribution = computed(() => resolveOwnerAttribution({
  ownerAttribution: props.message.agentIdentity?.ownerAttribution,
  ownerLabel: props.message.agentIdentity?.ownerLabel,
  actorLabel: props.message.agentIdentity?.actorLabel || props.message.actorLabel,
  sender: props.message.sender,
}));
const ideLabel = computed(() => props.providerLabel || props.message.agentIdentity?.ideLabel || identity.value.ideLabel);
const isSystem = computed(() => ["system", "letagents"].includes(props.message.sender.toLowerCase()));
const isAmbientSystem = computed(() =>
  isAmbientSystemMessage(props.message.sender, props.message.text || "")
);
const githubEvent = computed(() => parseGitHubEvent(props.message));
const senderColor = computed(() => getSenderColor(props.message.sender, props.message.source));
const ownerKind = computed(() => {
  if (isSystem.value) return "system";
  if (props.message.source === "github") return "github";
  if (props.message.source === "agent" || ownerAttribution.value || ideLabel.value) return "agent";
  if (props.message.source === "browser") return "human";
  return "room";
});
const provenanceLabel = computed(() =>
  ownerKind.value === "agent" && ownerAttribution.value ? null : ownerKind.value
);
const replyDisplayName = computed(() =>
  props.message.replyTo ? parseSenderIdentity(props.message.replyTo).displayName : "unknown"
);
const replyPreviewText = computed(() => truncate((props.message.replyTo?.text || "").replace(/\s+/g, " ").trim(), 160));
const formattedTime = computed(() => formatTimestamp(props.message.timestamp));
const renderedText = computed(() => {
  const text = props.message.text || "No message body.";
  return renderMessageText(
    isAmbientSystem.value ? stripStatusPrefix(text) : text,
    props.highlightQuery,
    props.messageReferenceIds,
    props.taskReferenceIds,
  );
});
const copyButtonTitle = computed(() => copied.value ? "Copied" : "Copy message");
const tertiaryActionLabel = computed(() => props.context === "timeline" ? "Reply in thread" : "Jump to root");
const selectionActionLabel = computed(() => props.context === "timeline" ? "Add to chat" : "Add to thread");
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
  messageId: props.message.id,
  clientMessageId: props.message.clientMessageId ?? null,
  messageSource: props.message.source ?? null,
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
  const target = event.target instanceof HTMLElement ? event.target : null;
  const linkHref = resolveExternalWebHref(
    target?.closest("a[href]")?.getAttribute("href"),
    window.location.href,
  );
  // External web links get the app menu with link actions. Everything else on
  // an interactive/editable element (inputs, buttons, non-web anchors) keeps
  // the platform's native menu.
  if (!linkHref && shouldUseNativeContextMenu(event)) {
    return;
  }
  event.preventDefault();
  const article = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  contextLinkHref.value = linkHref;
  contextMenuInvoker.value = target?.closest<HTMLElement>("button, a, [tabindex]") || article;
  closeSelectionPopover();
  const menuWidth = 180;
  // Link variant: 3 rows + separator; message variant: 4 rows + separator.
  // The estimate must cover the tallest variant or the last row ("Message
  // info") clips below the viewport near the bottom edge.
  const menuHeight = linkHref ? 140 : 176;
  contextMenuPosition.value = {
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
  };
  contextMenuOpen.value = true;
  void nextTick(() => firstContextMenuButton.value?.focus());
  window.setTimeout(() => {
    window.addEventListener("pointerdown", closeContextMenuFromOutside, { once: true });
    window.addEventListener("keydown", handleContextMenuKeydown);
  }, 0);
}

function shouldUseNativeContextMenu(event: MouseEvent): boolean {
  const target = event.target instanceof Element ? event.target : null;
  return Boolean(target?.closest("a, button, input, textarea, select, [contenteditable='true']"));
}

function closeContextMenu(reason: ContextMenuCloseReason): void {
  contextMenuOpen.value = false;
  window.removeEventListener("keydown", handleContextMenuKeydown);
  window.removeEventListener("pointerdown", closeContextMenuFromOutside);
  if (shouldRestoreContextMenuFocus(reason)) {
    const invoker = contextMenuInvoker.value;
    void nextTick(() => restoreContextMenuFocus(invoker));
  }
  contextMenuInvoker.value = null;
  contextLinkHref.value = null;
}

function closeContextMenuFromOutside(): void {
  closeContextMenu("outside");
}

function handleContextMenuKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") closeContextMenu("escape");
}

function focusContextMenuItem(direction: 1 | -1): void {
  const items = Array.from(document.querySelectorAll<HTMLButtonElement>(".room-message-context-menu [role='menuitem']"));
  if (!items.length) return;
  const currentIndex = Math.max(0, items.findIndex((item) => item === document.activeElement));
  const nextIndex = (currentIndex + direction + items.length) % items.length;
  items[nextIndex]?.focus();
}

function quoteReplyFromContext(): void {
  closeContextMenu("action");
  emit("quote-reply", props.message.id);
}

function tertiaryActionFromContext(): void {
  closeContextMenu("action");
  handleTertiaryAction();
}

function handleTertiaryAction(): void {
  if (props.context === "timeline") {
    emit("open-thread", props.message.id);
    return;
  }
  emit("jump-to-thread-root", props.message.id);
}

function messageInfoFromContext(): void {
  closeContextMenu("action");
  emit("message-info", props.message.id, props.context);
}

async function copyFromContext(): Promise<void> {
  closeContextMenu("copy");
  await copyMessage();
}

async function openLinkFromContext(): Promise<void> {
  const href = contextLinkHref.value;
  closeContextMenu("action");
  if (!href) return;
  try {
    await desktopIpc.app?.openExternalUrl?.(href);
  } catch {
    // Opening the system browser is best-effort; a stale bridge or a rejected
    // shell.openExternal shouldn't surface as an unhandled rejection.
  }
}

async function copyLinkFromContext(): Promise<void> {
  const href = contextLinkHref.value;
  closeContextMenu("copy");
  if (href) await copyToClipboard(href);
}

async function copyMessage(): Promise<void> {
  const text = messageCopyText();
  if (!text) return;
  await copyToClipboard(text);
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
  window.removeEventListener("pointerdown", closeContextMenuFromOutside);
  removeSelectionOutsidePointerListener();
  window.removeEventListener("keydown", handleSelectionKeydown);
});
</script>
