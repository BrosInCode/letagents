<template>
  <article
    ref="messageElement"
    class="room-chat-message"
    tabindex="-1"
    :class="{
      'is-system-message': isSystem,
      'is-github-message': Boolean(githubEvent),
      'has-reply': Boolean(message.replyTo),
      'is-search-active': searchActive,
      'is-active-thread-root': activeThreadRoot,
      'is-compact-continuation': compactWithPrevious,
      'is-ambient-system-message': isAmbientSystem || isWakeNotice,
      'is-wake-notice': isWakeNotice,
      'is-arriving': animateArrival,
      'is-reacting': reactionPickerAnchor !== null,
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
    <WakeGlyph v-if="isWakeNotice" class="room-chat-wake-glyph" state="woke" :still="!animateArrival" />
    <div
      v-else
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
            v-if="reactable"
            class="room-message-reply-action room-message-react-action"
            type="button"
            title="Add reaction"
            aria-label="Add reaction"
            aria-haspopup="dialog"
            :aria-expanded="reactionPickerAnchor !== null"
            @click="openReactionPicker"
          >
            <SmilePlus :size="14" aria-hidden="true" />
          </button>
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
            v-if="!message.outgoing"
            class="room-message-reply-action room-message-quote-action"
            type="button"
            title="Quote reply"
            aria-label="Quote reply"
            @click="$emit('quote-reply', message.id)"
          >
            <CornerUpLeft :size="14" aria-hidden="true" />
          </button>
          <button
            v-if="!message.outgoing"
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
          <span v-if="pinned" class="message-pin-marker" role="img" aria-label="Pinned message" title="Pinned message"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 3 21 8M17 4 9 12 5 13 11 19 12 15 20 7M2 22 8 16" /></svg></span>
          <time :datetime="message.timestamp">{{ formattedTime }}</time>
        </div>
      </div>

      <div v-if="message.outgoing" class="room-message-outgoing" role="status" aria-live="polite">
        <span v-if="message.outgoing.attachmentCount">{{ message.outgoing.attachmentCount }} attachment{{ message.outgoing.attachmentCount === 1 ? "" : "s" }} · </span>
        <span>{{ message.outgoing.status === "pending" ? "Sending…" : "Delivery not confirmed" }}</span>
        <button v-if="message.outgoing.status === 'uncertain'" type="button" :title="message.outgoing.error || undefined" @click="retryDesktopOutgoingMessage(message.clientMessageId || '')">Retry safely</button>
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
          :text="visibleText || 'No message body.'"
          :html="renderedText"
          :message-id="message.id"
          :room-identifier="roomIdentifier"
          @message-reference-click="$emit('scroll-to-message', $event)"
          @task-reference-click="$emit('open-task', $event)"
        />

        <DesktopGitHubEventCard
          v-for="preview in linkPreviews"
          :key="preview.url"
          :event="linkPreviewPresentation(preview)"
          compact
        />
        <DesktopMessageAttachments
          v-if="message.attachments.length"
          :message-id="message.id"
          :attachments="message.attachments"
          @open-image="$emit('open-image', $event)"
        />
      </div>

      <MessageReactionBar
        v-if="reactions.length"
        :reactions="reactions"
        :viewer-login="reactionContext?.viewerLogin.value ?? null"
        :viewer-reacted="viewerReacted"
        :can-react="reactable"
        :picker-open="reactionPickerAnchor !== null"
        @toggle="toggleReaction"
        @add="openReactionPicker"
      />

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
              :title="!deliveryRecoveryAvailable ? 'Retry will be available when delivery recovery is connected'
                : receipt.retry === 'reread_saved_turn' ? 'Reads the finished turn’s answer again. The turn is not rerun.'
                : receipt.retry === 'publish_saved_reply' ? 'Posts the saved reply. The provider is not asked again.' : 'Retry delivery'"
              @click="deliveryRecoveryAvailable && !retryingReceipt(receipt.agentId) && $emit('retry-delivery', receipt.agentId, message.id)"
            >{{ retryingReceipt(receipt.agentId) ? "Retrying…" : !deliveryRecoveryAvailable ? "Retry unavailable"
              : receipt.retry === "reread_saved_turn" ? "Read again" : receipt.retry === "publish_saved_reply" ? "Post reply" : "Retry" }}</button>
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
          <button v-if="canCopyMessageLink" type="button" role="menuitem" @click="copyMessageLinkFromContext">
            <span>Copy link to message</span>
          </button>
          <button type="button" role="menuitem" @click="quoteReplyFromContext">
            <span>Quote reply</span>
          </button>
          <button type="button" role="menuitem" @click="tertiaryActionFromContext">
            <span>{{ tertiaryActionLabel }}</span>
          </button>
          <MessageReminderMenu v-if="remindable" :room="roomIdentifier ?? ''" :message="message.id" @scheduled="reminderScheduled" />
          <button v-if="pinnable" type="button" role="menuitem" :disabled="Boolean(pinContext?.state.value.pending)" @click="pinFromContext">
            <span>{{ pinned ? "Unpin message" : "Pin message" }}</span>
          </button>
          <button v-if="reactable" type="button" role="menuitem" @click="reactFromContext">
            <span>Add reaction…</span>
          </button>
          <button v-if="canMarkUnread" type="button" role="menuitem" @click="markUnreadFromContext">
            <span>Mark unread from here</span>
          </button>
          <div class="room-message-context-menu-separator" role="separator" />
          <button type="button" role="menuitem" @click="messageInfoFromContext">
            <span>Message info</span>
          </button>
        </template>
      </div>

      <MessageReactionPicker
        v-if="reactionPickerAnchor"
        :anchor="reactionPickerAnchor"
        :viewer-reacted="viewerReacted"
        :instant="reactionPickerInstant"
        @select="toggleReaction"
        @close="closeReactionPicker"
      />

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
import { unreadMenuKey } from "../../../../../../../shared/room-unread-client";
import MessageReminderMenu from "./MessageReminderMenu.vue";
import { reminderAccount } from "../../../composables/useMessageReminders";
import { retryDesktopOutgoingMessage } from "../../../domain/message-outbox";
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { attentionResponseAgentNamesKey, roomMessageVisibleText } from "../../../domain/attention-response";
import { Check, CircleAlert, Copy, CornerUpLeft, LocateFixed, MessageSquare, SmilePlus } from "@lucide/vue";
import type { DesktopRoomAgentDeliveryAttention, DesktopRoomMessage } from "../../../../../electron/ipc-types";
import { desktopIpc } from "../../../ipc/index.js";
import { useDesktopActionToasts } from "../../../composables/useDesktopActionToasts";
import { useCopyIndicator } from "../../../composables/useCopyIndicator";
import { safeUserVisibleErrorDetail } from "../../../domain/user-visible-error";
import { resolveExternalWebHref } from "./desktop-chat-message/message-links";
import {
  buildLetAgentsMessageUrl,
  isLocalRoomIdentifier,
  isValidMessageId,
} from "../../../domain/room-urls";
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
  highlightRenderedMessage,
  linkRenderedMessageReferences,
  renderMessageText,
  isAmbientSystemMessage,
  stripStatusPrefix,
  truncate,
} from "./desktop-chat-message/message-rendering";
import type { AgentModalTarget } from "./desktop-chat-message/types";
import type { ThreadIndicatorSummary } from "./room-chat/thread-utils";
import DesktopLongMessageContent from "./DesktopLongMessageContent.vue";
import MessageReactionBar from "../../../../../../../shared/ui/MessageReactionBar.vue";
import MessageReactionPicker, { type MessageReactionPickerAnchor } from "../../../../../../../shared/ui/MessageReactionPicker.vue";
import WakeGlyph from "../../../../../../../shared/ui/WakeGlyph.vue";
import { isPinMessageId } from "../../../../../../../shared/message-pins.mjs";
import { injectRoomMessageLinkPreviews } from "../../../composables/useRoomMessageLinkPreviews";
import { excludeGitHubEventLink, linkPreviewPresentation } from "../../../../../../../shared/message-link-previews.mjs";
import { injectRoomMessagePins } from "../../../composables/useRoomMessagePins";
import { injectRoomMessageReactions } from "../../../composables/useRoomMessageReactions";
import { WAKE_NOTICE_SOURCE } from "../../../../../../../shared/wake-rules.mjs";

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
  deliveryReceipts?: Array<{ agentId: string; agentName: string; state: string; blockedByMessageId: string | null; error: string | null; failureCode: string | null; terminalReason: string | null; attemptCount: number; providerTurnId: string | null; retry?: DesktopRoomAgentDeliveryAttention["retry"] | null }>;
  deliveryRecoveryAvailable?: boolean;
  continuationRepairAvailable?: boolean;
  roomDeliverySkipAvailable?: boolean;
  deliveryRetryKeys?: ReadonlySet<string>;
  continuationRepairKeys?: ReadonlySet<string>;
  roomDeliverySkipKeys?: ReadonlySet<string>;
  providerLabel?: string | null;
  roomIdentifier?: string | null;
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

const remindable = computed(() => Boolean(reminderAccount.value && props.roomIdentifier && !isLocalRoomIdentifier(props.roomIdentifier) && isValidMessageId(props.message.id) && !props.message.outgoing));
const { pushActionToast } = useDesktopActionToasts();
function reminderScheduled(dueAt: string) {
  pushActionToast(`Reminder set for ${new Date(dueAt).toLocaleString()}`, "success");
  closeContextMenu("complete");
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
/** An agent's wake rule fired: a quiet line, not a conversation. */
const isWakeNotice = computed(() => props.message.source === WAKE_NOTICE_SOURCE);
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
const attentionResponseAgentNames = inject(attentionResponseAgentNamesKey, null);
const replyPreviewText = computed(() => truncate((props.message.replyTo
  ? roomMessageVisibleText(props.message.replyTo, attentionResponseAgentNames?.value)
  : "").replace(/\s+/g, " ").trim(), 160));
const visibleText = computed(() => roomMessageVisibleText(props.message, attentionResponseAgentNames?.value));
const formattedTime = computed(() => formatTimestamp(props.message.timestamp));
const renderedMessage = computed(() => {
  const text = visibleText.value || "No message body.";
  const urls: string[] = [];
  const html = renderMessageText(isAmbientSystem.value ? stripStatusPrefix(text) : text, "", undefined, undefined, (url) => urls.push(url));
  return { html, urls };
});
const previewUrls = computed(() => excludeGitHubEventLink(renderedMessage.value.urls, githubEvent.value?.url));
const previewContext = injectRoomMessageLinkPreviews();
const linkPreviews = computed(() => previewContext?.previewsFor(props.message.id) ?? []);
let stopTrackingPreviews: (() => void) | null = null;
watch(() => [props.message.id, previewUrls.value, previewContext?.contextKey.value], () => {
  stopTrackingPreviews?.();
  stopTrackingPreviews = previewContext?.track({ id: props.message.id, urls: previewUrls.value }) ?? null;
}, { immediate: true });
const linkedText = computed(() => linkRenderedMessageReferences(
  renderedMessage.value.html,
  props.messageReferenceIds,
  props.taskReferenceIds,
));
const renderedText = computed(() => highlightRenderedMessage(linkedText.value, props.highlightQuery));
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

const canCopyMessageLink = computed(() =>
  !isLocalRoomIdentifier(props.roomIdentifier) &&
  !props.message.outgoing &&
  isValidMessageId(props.message.id)
);

function openContextMenu(event: MouseEvent): void {
  if (props.message.outgoing) return;
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
  // Link variant: 3 rows + separator; message variant: 4 rows + separator,
  // plus a row for each available pin/reaction action. The estimate must
  // cover the tallest variant or the last row ("Message info") clips below
  // the viewport near the bottom edge.
  const menuHeight = linkHref ? 140 : 176 + (reactable.value ? 32 : 0) + (pinnable.value ? 32 : 0);
  const clampedMenuHeight = menuHeight + (!linkHref && remindable.value ? 32 : 0) + (!linkHref && canCopyMessageLink.value ? 32 : 0)
    + (!linkHref && canMarkUnread.value ? 32 : 0);
  contextMenuPosition.value = {
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - clampedMenuHeight - 8)),
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
  const items = Array.from(firstContextMenuButton.value?.parentElement?.querySelectorAll<HTMLButtonElement>(":scope > [role='menuitem']:not(:disabled)") ?? []);
  if (!items.length) return;
  const currentIndex = Math.max(0, items.findIndex((item) => item === document.activeElement));
  const nextIndex = (currentIndex + direction + items.length) % items.length;
  items[nextIndex]?.focus();
}

function quoteReplyFromContext(): void {
  closeContextMenu("action");
  emit("quote-reply", props.message.id);
}

const unreadContext = inject(unreadMenuKey, null);
const canMarkUnread = computed(() => Boolean(unreadContext?.client.account.value)
  && props.context === "timeline" && !props.message.threadReplyToId
  && (!props.message.threadRootId || props.message.threadRootId === props.message.id)
  && !props.message.id.startsWith("pending:"));
function markUnreadFromContext(): void {
  closeContextMenu("complete");
  if (canMarkUnread.value) unreadContext?.client.mark(unreadContext.room.value, props.message.id);
}
const pinContext = injectRoomMessagePins();
const pinnable = computed(() => Boolean(pinContext?.canPin.value) && isPinMessageId(props.message.id));
const pinned = computed(() => pinContext?.isPinned(props.message.id) ?? false);
function pinFromContext(): void { closeContextMenu("complete"); pinContext?.toggle(props.message.id); }

// Reactions exist only inside a room that provides them (not in previews or
// tests), and only on a message the server sent with its reactions: a room
// kept on this computer, or an older server, has none.
const reactionContext = injectRoomMessageReactions();
const reactions = computed(() => reactionContext?.reactionsFor(props.message.id) ?? []);
const reactable = computed(() => Boolean(reactionContext?.canReact.value)
  && props.message.reactions !== undefined
  && !props.message.outgoing
  && !isWakeNotice.value
  && /^msg_\d+$/.test(props.message.id));
const viewerReacted = (emoji: string): boolean => reactionContext?.viewerReacted(props.message.id, emoji) ?? false;

// A row keeps its component when a sent message is confirmed and takes its
// server id, so the registration follows the id.
let stopTrackingReactions: (() => void) | null = null;
watch(() => [props.message.id, props.message.reactions !== undefined] as const, () => {
  stopTrackingReactions?.();
  stopTrackingReactions = reactionContext?.track(props.message) ?? null;
}, { immediate: true });

const messageElement = ref<HTMLElement | null>(null);
const reactionPickerAnchor = ref<MessageReactionPickerAnchor | null>(null);
const reactionPickerInstant = ref(false);
let reactionPickerInvoker: HTMLElement | null = null;
let reactionPickerClosedByPress: { invoker: HTMLElement; at: number } | null = null;

function toggleReaction(emoji: string): void {
  reactionContext?.toggle(props.message.id, emoji);
}

function showReactionPicker(anchor: MessageReactionPickerAnchor, invoker: HTMLElement | null, instant: boolean): void {
  if (!reactable.value) return;
  closeSelectionPopover();
  reactionPickerInvoker = invoker;
  reactionPickerInstant.value = instant;
  reactionPickerAnchor.value = anchor;
}

function openReactionPicker(event: MouseEvent): void {
  const trigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  if (!trigger) return;
  // The press that starts this click already closed the picker this control
  // had open: the control is a toggle, so do not open it again.
  const closed = reactionPickerClosedByPress;
  reactionPickerClosedByPress = null;
  if (closed?.invoker === trigger && performance.now() - closed.at < 500) return;
  // A click with no pointer detail came from the keyboard.
  showReactionPicker({ element: trigger }, trigger, event.detail === 0);
}

function closeReactionPicker(restoreFocus: boolean, pressed?: EventTarget | null): void {
  const invoker = reactionPickerInvoker;
  reactionPickerAnchor.value = null;
  reactionPickerInvoker = null;
  reactionPickerClosedByPress = invoker && pressed instanceof Node && invoker.contains(pressed)
    ? { invoker, at: performance.now() }
    : null;
  if (restoreFocus && invoker?.isConnected) invoker.focus({ preventScroll: true });
}

function reactFromContext(): void {
  const { x, y } = contextMenuPosition.value;
  const invoker = contextMenuInvoker.value;
  closeContextMenu("action");
  if (messageElement.value) showReactionPicker({ element: messageElement.value, point: { x, y } }, invoker, true);
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

async function copyMessageLinkFromContext(): Promise<void> {
  const invoker = contextMenuInvoker.value;
  closeContextMenu("copy");
  if (!props.roomIdentifier || !props.message.id) return;
  const url = buildLetAgentsMessageUrl(props.roomIdentifier, props.message.id);
  await copyToClipboard(url);
  restoreContextMenuFocus(invoker);
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
  const text = visibleText.value.trim();
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
  if (props.message.outgoing) return;
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
  stopTrackingReactions?.();
  stopTrackingPreviews?.();
  window.removeEventListener("keydown", handleContextMenuKeydown);
  window.removeEventListener("pointerdown", closeContextMenuFromOutside);
  removeSelectionOutsidePointerListener();
  window.removeEventListener("keydown", handleSelectionKeydown);
});
</script>
