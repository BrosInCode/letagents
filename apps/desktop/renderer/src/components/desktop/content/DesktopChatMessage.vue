<template>
  <article
    ref="messageElement"
    class="room-chat-message"
    tabindex="-1"
    :class="{
      'is-github-history': githubHistory,
      'is-system-message': isSystem,
      'is-github-message': Boolean(githubEvent),
      'has-reply': Boolean(message.replyTo),
      'is-search-active': searchActive,
      'is-active-thread-root': activeThreadRoot,
      'has-thread': showThreadMarker,
      'is-compact-continuation': compactWithPrevious,
      'is-ambient-system-message': isAmbientSystem || isWakeNotice,
      'is-wake-notice': isWakeNotice,
      'is-arriving': animateArrival,
      'is-thread-context': context !== 'timeline',
      'is-thread-root-context': context === 'thread-root',
      'is-thread-reply-context': context === 'thread-reply',
    }"
    :style="{ '--message-accent': senderColor, ...chatStyling.styleFor(senderRole) }"
    :data-owner-kind="ownerKind"
    :data-chat-role="senderRole"
    :data-outgoing-status="message.outgoing?.status || undefined"
    :data-message-id="message.id"
    :data-thread-message-id="threadMessageId || undefined"
    :data-testid="testId || `room-message-${message.id}`"
    @contextmenu.stop="openContextMenu"
    @pointerup.stop="handleSelectionPointerUp"
  >
    <WakeGlyph v-if="isWakeNotice" class="room-chat-wake-glyph" state="woke" :still="!animateArrival" />
    <div v-else-if="!senderRole" class="room-chat-avatar" :style="{ '--avatar-color': senderColor }" aria-hidden="true" />

    <div class="room-chat-message-content">
      <div v-if="!githubHistory" class="room-message-meta">
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
          <button
            v-else-if="personTarget"
            class="room-message-author-button is-person-author"
            type="button"
            :title="`Options for ${displayName}`"
            @click="openPersonMenu"
          >
            {{ displayName }}
          </button>
          <strong v-else>{{ displayName }}</strong>
          <span v-if="ownerKind === 'agent' && ownerAttribution" class="room-message-owner">{{ ownerAttribution }}</span>
        </div>
        <div class="room-message-meta-tail">
          <span v-if="provenanceLabel" class="room-message-provenance" :data-kind="ownerKind">
            {{ provenanceLabel }}
          </span>
          <span v-if="pinned" class="message-pin-marker" role="img" aria-label="Pinned message" title="Pinned message"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 3 21 8M17 4 9 12 5 13 11 19 12 15 20 7M2 22 8 16" /></svg></span>
          <time :datetime="message.timestamp">{{ formattedTime }}</time>
          <div v-if="!isAmbientSystem && !isWakeNotice" class="room-message-actions">
            <RoomMessageReceiptMark v-if="showsReceipt" ref="receiptMark" :message-id="message.id" :context="context" :thread-root-id="message.threadRootId && message.threadRootId !== message.id ? message.threadRootId : null" />
            <button
              v-if="showQuickActions && reactable"
              ref="reactionAction"
              class="room-message-quick-action"
              type="button"
              title="Add reaction"
              aria-label="Add reaction"
              aria-haspopup="dialog"
              :aria-expanded="reactionPickerAnchor?.element === reactionAction"
              @click="openReactionPicker"
            >
              <SmilePlus :size="14" aria-hidden="true" />
            </button>
            <button
              v-if="message.outgoing || showQuickActions"
              :class="message.outgoing ? 'room-message-meta-action' : 'room-message-quick-action'"
              type="button"
              :title="copyButtonTitle"
              :aria-label="copyButtonTitle"
              @click="copyMessage"
            >
              <Check v-if="copied" :size="14" aria-hidden="true" />
              <Copy v-else :size="14" aria-hidden="true" />
            </button>
            <template v-if="showQuickActions">
              <button class="room-message-quick-action" type="button" title="Quote reply" aria-label="Quote reply" @click="$emit('quote-reply', message.id)">
                <CornerUpLeft :size="14" aria-hidden="true" />
              </button>
              <button class="room-message-quick-action" type="button" title="Reply in thread" aria-label="Reply in thread" @click="$emit('open-thread', message.id)">
                <MessageSquare :size="14" aria-hidden="true" />
              </button>
              <button
                v-if="pinnable"
                class="room-message-quick-action"
                type="button"
                :title="pinned ? 'Unpin message' : 'Pin message'"
                :aria-label="pinned ? 'Unpin message' : 'Pin message'"
                :aria-pressed="pinned"
                :disabled="Boolean(pinContext?.state.value.pending)"
                @click="pinContext?.toggle(message.id)"
              >
                <Pin :size="14" aria-hidden="true" />
              </button>
            </template>
            <button
              v-if="!message.outgoing"
              ref="messageActionsTrigger"
              class="room-message-meta-action"
              type="button"
              title="Message actions"
              aria-label="Message actions"
              aria-haspopup="menu"
              :aria-expanded="contextMenuOpen && contextMenuInvoker === messageActionsTrigger"
              @click="openMessageActions"
            >
              <Ellipsis :size="14" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      <div
        v-if="message.outgoing"
        class="room-message-outgoing"
        :data-status="message.outgoing.status"
        :data-tone="outgoingTone"
        role="status"
        aria-live="polite"
      >
        <span class="room-message-outgoing-status">
          <Clock v-if="message.outgoing.status === 'pending'" class="room-message-outgoing-icon" :size="12" aria-hidden="true" />
          <CircleAlert v-else class="room-message-outgoing-icon" :size="12" aria-hidden="true" />
          <span class="room-message-outgoing-label">{{ outgoingStatusText }}</span>
        </span>
        <span v-if="outgoingAttachmentSummary" class="room-message-outgoing-meta">{{ outgoingAttachmentSummary }}</span>
        <div v-if="message.outgoing.status === 'uncertain' || message.outgoing.status === 'refused'" class="room-message-outgoing-actions">
          <button
            v-if="message.outgoing.status === 'uncertain'"
            type="button"
            class="room-message-outgoing-retry"
            :title="message.outgoing.error || undefined"
            data-testid="room-message-outgoing-retry"
            @click="retryDesktopOutgoingMessage(message.clientMessageId || '')"
          >
            <RotateCw :size="12" aria-hidden="true" />
            <span>Retry safely</span>
          </button>
          <template v-else-if="message.gif && message.outgoing.error?.includes('expressions_disabled:')">
            <button v-if="message.text.trim() || message.outgoing.attachmentCount" type="button" class="room-message-outgoing-secondary" @click="sendDesktopOutgoingWithoutGif(message.clientMessageId || '')">Send without GIF</button>
            <button v-else type="button" class="room-message-outgoing-secondary" @click="discardRefusedDesktopGif(message.clientMessageId || '')">Remove unsent GIF</button>
          </template>
          <template v-else>
            <button
              type="button"
              class="room-message-outgoing-discard"
              :title="message.outgoing.error || undefined"
              data-testid="room-message-outgoing-discard"
              @click="discardRefusedDesktopOutgoingMessage(message.clientMessageId || '')"
            >
              <span>{{ message.text.trim() ? "Discard & edit" : "Discard" }}</span>
            </button>
            <button
              type="button"
              class="room-message-outgoing-secondary"
              :title="message.outgoing.error || undefined"
              data-testid="room-message-outgoing-retry"
              @click="retryDesktopOutgoingMessage(message.clientMessageId || '')"
            >
              <RotateCw :size="12" aria-hidden="true" />
              <span>Retry</span>
            </button>
          </template>
        </div>
      </div>
      <div class="room-message-line">
        <ChatAvatar v-if="senderRole" :name="displayName" :avatar-url="avatarUrl" :agent="ownerKind === 'agent'" :provider="ideLabel" :agent-key="message.agentIdentity?.agentKey" :avatar="message.agentIdentity?.avatar" />
        <div class="room-message-bubble" :data-thread-wide="threadWide || undefined">
          <button
            v-if="message.replyTo && (context !== 'thread-reply' || message.replyTo.id !== message.threadRootId)"
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
            :history="githubHistory"
            :timestamp="message.timestamp"
            room
            :event="githubEvent"
            :task-link-enabled="Boolean(githubEvent.taskId && taskReferenceIds?.has(githubEvent.taskId))"
            @open-event="$emit('open-github-event', $event)"
            @open-task="$emit('open-task', $event)"
          />

          <DesktopLongMessageContent
            v-else-if="(!message.gif || visibleText) && (!message.outgoing?.attachmentCount || visibleText) && !(message.gif?.text_fallback_only && gifState !== 'unavailable')"
            ref="longMessageContent"
            :text="visibleText || 'No message body.'"
            :html="renderedText"
            :message-id="message.id"
            :room-identifier="roomIdentifier"
            :sender="readerSender"
            @message-reference-click="$emit('scroll-to-message', $event)"
            @task-reference-click="$emit('open-task', $event)"
            @mention-click="openMention"
          />

          <DesktopGitHubEventCard
            v-for="preview in linkPreviews"
            :key="preview.url"
            :event="linkPreviewPresentation(preview)"
            compact
          />
          <RoomGif v-if="message.gif" :gif="message.gif" :room-identifier="roomIdentifier" @state="gifState = $event" />
          <ul
            v-if="message.outgoing && !message.attachments.length && outgoingAttachmentItems.length"
            class="room-message-outgoing-attachments"
            aria-label="Queued attachments"
          >
            <li v-for="item in outgoingAttachmentItems" :key="item.upload_id" class="room-message-outgoing-attachment">
              <Paperclip :size="13" aria-hidden="true" />
              <strong>{{ item.fileName || "Attachment" }}</strong>
              <small v-if="item.sizeLabel">{{ item.sizeLabel }}</small>
            </li>
          </ul>
          <DesktopMessageAttachments
            v-if="message.attachments.length"
            :message-id="message.id"
            :attachments="message.attachments"
            :sender-label="displayName"
            :room-identifier="roomIdentifier"
            :thread-root-id="message.threadRootId || message.id"
            @open-image="$emit('open-image', $event)"
          />
          <button
            v-if="showThreadMarker"
            class="room-thread-marker"
            :class="{ 'is-active': activeThreadRoot }"
            type="button"
            :aria-label="threadMarkerAriaLabel"
            :aria-expanded="activeThreadRoot"
            :aria-controls="`room-inline-thread-${message.id}`"
            @click="$emit('open-thread', message.id)"
          >
            <span class="room-thread-marker-main">
              <MessageSquare :size="13" aria-hidden="true" />
              <strong>{{ threadMarkerCountLabel }}</strong>
              <span v-if="threadSummary.unreadCount > 0" class="room-thread-unread-count">
                {{ threadSummary.unreadCount }}
              </span>
              <span v-if="threadSummary.loadingEarlier" class="room-thread-loading-dot" aria-label="Loading thread"></span>
              <span
                v-if="threadSummary.hasRefusedOutgoing || threadSummary.hasUncertainOutgoing || threadSummary.hasPendingOutgoing"
                class="room-thread-outgoing-badge"
                :data-status="threadSummary.hasRefusedOutgoing ? 'refused' : threadSummary.hasUncertainOutgoing ? 'uncertain' : 'pending'"
              >
                <CircleAlert v-if="threadSummary.hasRefusedOutgoing || threadSummary.hasUncertainOutgoing" :size="11" aria-hidden="true" />
                <Clock v-else :size="11" aria-hidden="true" />
                <span>{{ threadSummary.hasRefusedOutgoing ? "Not sent" : threadSummary.hasUncertainOutgoing ? "Delivery not confirmed" : "Sending…" }}</span>
              </span>
            </span>
            <span v-if="threadSummary.participants.length" class="room-thread-participants" aria-hidden="true">
              <span
                v-for="participant in threadSummary.participants"
                :key="participant.key"
                class="room-thread-participant-avatar"
                :style="{ '--thread-participant-color': participant.color || getSenderColor(participant.sender || participant.displayName, null) }"
                :title="participant.displayName"
              >
                {{ participantInitials(participant.displayName) }}
              </span>
            </span>
            <ChevronDown class="room-thread-marker-chevron" :size="14" aria-hidden="true" />
          </button>
          <ThreadTransition reveal @settled="finishThreadMotion">
            <div v-if="activeThreadRoot" :id="`room-inline-thread-${message.id}`" class="room-inline-thread"><slot name="thread"><component :is="inlineThread" v-if="inlineThread" /></slot></div>
          </ThreadTransition>
        </div>
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
          v-for="{ receipt, modelRecovery } in deliveryReceiptRows"
          :key="receipt.agentId"
          :data-state="receipt.state"
          :data-follow-up="receipt.scheduledRetry ? 'scheduled' : receipt.followUpNote?.state"
          :data-limit="inlineDeliveryLimits.has(receipt.agentId) || undefined"
          :data-model-recovery="modelRecovery ? (modelRecovery.modelLabel && !modelRecovery.retryError ? 'ready' : 'limit') : undefined"
          :aria-label="inlineDeliveryLimits.has(receipt.agentId) || modelRecovery ? undefined : receiptLabel(receipt)"
        >
          <ClaudeLimitNotice
            v-if="inlineDeliveryLimits.has(receipt.agentId)"
            :notice="deliveryLimitNotices.get(receipt.agentId)!"
            :agent-name="receipt.agentName"
            :can-switch="Boolean(deliveryLimitNotices.get(receipt.agentId)?.modelFamily && agentLaunchHost?.openAgent)"
            @switch-model="agentLaunchHost?.openAgent?.(receipt.agentId, 'settings')"
          />
          <template v-else>
          <span class="room-message-delivery-indicator" aria-hidden="true">
            <span v-if="receiptIsAnimated(receipt.state)" class="room-message-delivery-dots">
              <i></i><i></i><i></i>
            </span>
            <Check v-else-if="modelRecovery?.modelLabel && !modelRecovery.retryError" :size="14" />
            <CircleAlert v-else-if="receiptNeedsAttention(receipt.state) || receipt.state === 'acknowledged_failed'" :size="14" />
            <Check v-else :size="14" />
          </span>
          <strong>{{ receipt.agentName }}</strong>
          <small v-if="modelRecovery?.retryError">Couldn’t retry</small>
          <small v-else-if="modelRecovery?.modelLabel">{{ modelRecovery.modelLabel }} ready</small>
          <small v-else-if="receiptStateLabel(receipt)">{{ receiptStateLabel(receipt) }}</small>
          <button
            v-if="modelRecovery"
            class="room-message-model-recovery-action"
            type="button"
            :disabled="modelRecovery.disabled || modelRecovery.retrying"
            @click.stop="modelRecovery.activate()"
          >
            {{ modelRecovery.retrying ? "Retrying…" : modelRecovery.modelLabel ? "Retry original message" : "Change model" }}
            <ChevronRight v-if="!modelRecovery.modelLabel" :size="12" aria-hidden="true" />
          </button>
          </template>
          <template v-if="receipt.scheduledRetry">
            <small class="room-message-delivery-countdown" aria-hidden="true"><span>{{ scheduledRetryParts(receipt)[0] }}</span> <span>{{ scheduledRetryParts(receipt)[1] }}</span></small>
            <button
              type="button"
              :disabled="!deliveryRecoveryAvailable || retryingReceipt(receipt.agentId, receipt.scheduledRetry.sourceMessageId)"
              :aria-label="`Try again now for ${receipt.agentName}`"
              title="Asks the agent to start this attempt now instead of waiting."
              @click="tryRetryNow(receipt)"
            >{{ retryingReceipt(receipt.agentId, receipt.scheduledRetry.sourceMessageId) ? "Asking…" : "Try now" }}</button>
            <button
              type="button"
              :disabled="!roomDeliverySkipAvailable || skippingReceipt(receipt.agentId, receipt.scheduledRetry.sourceMessageId)"
              :aria-label="`Stop the automatic attempts for ${receipt.agentName}`"
              title="No more automatic attempts. Later messages go ahead. The task stays assigned to the agent: send it a message to continue."
              @click="stopRetrying(receipt)"
            >{{ skippingReceipt(receipt.agentId, receipt.scheduledRetry.sourceMessageId) ? "Stopping…" : "Stop trying" }}</button>
            <small class="room-message-delivery-outcome">{{ scheduledRetryOutcome(receipt.scheduledRetry) }}</small>
          </template>
          <template v-else-if="receipt.followUpNote">
            <small>{{ followUpNoteLabel(receipt.followUpNote) }}</small>
            <button
              v-if="receipt.followUpNote.canRetry"
              type="button"
              :disabled="!deliveryRecoveryAvailable || retryingReceipt(receipt.agentId, receipt.followUpNote.sourceMessageId)"
              :aria-label="deliveryRecoveryAvailable ? `Retry delivery for ${receipt.agentName}` : `Retry delivery for ${receipt.agentName} is unavailable`"
              title="Retry delivery"
              @click="retryFollowUp(receipt)"
            >{{ retryingReceipt(receipt.agentId, receipt.followUpNote.sourceMessageId) ? "Retrying…" : deliveryRecoveryAvailable ? "Retry" : "Retry unavailable" }}</button>
          </template>
          <button
            v-if="(receipt.state === 'queued_behind_blocked' || receipt.state === 'queued_behind_retry') && receipt.blockedByMessageId"
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


    </div>

    <Teleport to="body">
      <div
        v-if="contextMenuOpen"
        class="room-message-context-menu"
        :style="{ left: `${contextMenuPosition.x}px`, top: `${contextMenuPosition.y}px` }"
        role="menu"
        aria-label="Message actions"
        data-testid="room-message-context-menu"
        @keydown.down.prevent="focusContextMenuItem(1)"
        @keydown.up.prevent="focusContextMenuItem(-1)"
        @keydown.tab="tabFromContextMenu"
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
          <template v-if="hasReceipt">
            <div class="room-message-context-menu-separator" role="separator" />
            <button type="button" role="menuitem" @click="messageInfoFromContext">
              <span>Message info</span>
            </button>
          </template>
        </template>
        <template v-else>
          <button ref="firstContextMenuButton" type="button" role="menuitem" @click="copyFromContext">
            <span>Copy message</span>
          </button>
          <button v-if="canCopyMessageLink" type="button" role="menuitem" @click="copyMessageLinkFromContext">
            <span>Copy link to message</span>
          </button>
          <button v-if="longMessageContent?.canOpenReader" type="button" role="menuitem" @click="openMessageReader">
            <span>Open reader</span>
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
          <template v-if="hasReceipt">
            <div class="room-message-context-menu-separator" role="separator" />
            <button type="button" role="menuitem" @click="messageInfoFromContext">
              <span>Message info</span>
            </button>
          </template>
        </template>
        <template v-if="deleteContent && !contextLinkHref">
          <div class="room-message-context-menu-separator" role="separator" />
          <button type="button" role="menuitem" @click="removeContent(threadSummary.count > 0 && (!message.threadRootId || message.threadRootId === message.id) ? 'thread' : 'message')">
            {{ threadSummary.count > 0 && (!message.threadRootId || message.threadRootId === message.id) ? 'Delete thread…' : 'Delete message…' }}
          </button>
          <button v-for="attachment in message.attachments" :key="attachment.id || attachment.fileName || 'file'" type="button" role="menuitem" :disabled="!attachment.id" @click="removeContent('attachment', attachment.id || undefined)">
            Delete attachment: {{ attachment.fileName || 'file' }}…
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
import { inlineThreadKey } from "./desktop-chat-message/inline-thread";
import RoomGif from "./room-chat/RoomGif.vue";
import RoomMessageReceiptMark from "./room-chat/RoomMessageReceiptMark.vue";
import { injectRoomMessageReceipts } from "../../../composables/useRoomMessageReceipts";
import { visibleReceipt } from "../../../domain/message-receipt-view";
import { unreadMenuKey } from "../../../../../../../shared/room-unread-client";
import MessageReminderMenu from "./MessageReminderMenu.vue";
import { reminderAccount } from "../../../composables/useMessageReminders";
import {
  discardRefusedDesktopGif,
  discardRefusedDesktopOutgoingMessage,
  sendDesktopOutgoingWithoutGif,
  retryDesktopOutgoingMessage,
} from "../../../domain/message-outbox";
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { attentionResponseAgentNamesKey, roomMessageVisibleText } from "../../../domain/attention-response";
import { Check, ChevronDown, ChevronRight, CircleAlert, Clock, Copy, CornerUpLeft, Ellipsis, MessageSquare, Paperclip, Pin, RotateCw, SmilePlus } from "@lucide/vue";
import { formatBytes } from "./attachments/formatting";
import type { DesktopRoomAgentDeliveryAttention, DesktopRoomMessage } from "../../../../../electron/ipc-types";
import { desktopIpc } from "../../../ipc/index.js";
import { useDesktopActionToasts } from "../../../composables/useDesktopActionToasts";
import { useCopyIndicator } from "../../../composables/useCopyIndicator";
import { useSecondClock } from "../../../composables/useSecondClock";
import { scheduledRetryClockLabel, scheduledRetryLabelParts, scheduledRetryOutcome, type AgentScheduledRetry } from "../../../domain/scheduled-retry";
import type { RoomMessageFollowUpNote } from "../../../domain/room-message-receipts";

/** What this message needs of an automatic attempt: its time, its attempt, what it follows, and the id its two controls name. */
type AgentScheduledRetryView = Pick<AgentScheduledRetry, "atMs" | "attempt" | "attempts" | "kind" | "sourceMessageId">;
import { safeUserVisibleErrorDetail } from "../../../domain/user-visible-error";
import { resolveExternalWebHref } from "./desktop-chat-message/message-links";
import {
  buildLetAgentsMessageUrl,
  isLocalRoomIdentifier,
  isValidMessageId,
} from "../../../domain/room-urls";
import DesktopGitHubEventCard from "./desktop-chat-message/DesktopGitHubEventCard.vue";
import DesktopMessageAttachments from "./desktop-chat-message/DesktopMessageAttachments.vue";
import ChatAvatar from "../../../../../../../shared/ui/ChatAvatar.vue";
import { chatSenderRole } from "../../../../../../../shared/chat-appearance";
import { isOwnedLocalRoomAgent, supervisorEntriesKey } from "./add-agent/supervisor-entries-context";
import { composerAgentLaunchKey } from "./room-chat/composer-agent-launch";
import ClaudeLimitNotice from "./agent-inspector/ClaudeLimitNotice.vue";
import { claudeLimitNotice, type ClaudeLimitNotice as ClaudeLimitDetails } from "../../../domain/claude-usage-limit";
import "../../../../../../../shared/ui/chat-palette.css";
import { useChatStyling } from "../../../../../../../shared/ui/chat-styling";
const chatStyling = useChatStyling();
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
  linkRenderedGitHubReferences,
  linkRenderedMessageReferences,
  mayContainMessageReference,
  renderMessageText,
  isAmbientSystemMessage,
  stripStatusPrefix,
  truncate,
} from "./desktop-chat-message/message-rendering";
import type { AgentModalTarget } from "./desktop-chat-message/types";
import type { PersonTarget } from "../../../domain/person-target";
import { personMenuPosition, type PersonMenuPosition } from "../../../domain/person-context-menu";
import type { ThreadIndicatorSummary } from "./room-chat/thread-utils";
import DesktopLongMessageContent from "./DesktopLongMessageContent.vue";
import MessageReactionBar from "../../../../../../../shared/ui/MessageReactionBar.vue";
import MessageReactionPicker, { type MessageReactionPickerAnchor } from "../../../../../../../shared/ui/MessageReactionPicker.vue";
import ThreadTransition from "../../../../../../../shared/ui/ThreadTransition.vue";
import WakeGlyph from "../../../../../../../shared/ui/WakeGlyph.vue";
import { isPinMessageId } from "../../../../../../../shared/message-pins.mjs";
import { linkRenderedMentions, mayContainMention, roomMentionDirectoryKey } from "../../../domain/room-mention-links";
import { injectRoomMessageLinkPreviews } from "../../../composables/useRoomMessageLinkPreviews";
import { excludeGitHubEventLink, linkPreviewPresentation } from "../../../../../../../shared/message-link-previews.mjs";
import { injectRoomMessagePins } from "../../../composables/useRoomMessagePins";
import { useMessageViewer, injectRoomMessageReactions } from "../../../composables/useRoomMessageReactions";
import { WAKE_NOTICE_SOURCE } from "../../../../../../../shared/wake-rules.mjs";

import { deleteRoomContentKey } from "./room-chat/content-deletion";
const deleteContent = inject(deleteRoomContentKey, null);
function removeContent(kind: "message" | "thread" | "attachment", attachmentId?: string): void {
  closeContextMenu("action");
  if (kind === "attachment") { if (attachmentId) void deleteContent?.({ kind, id: props.message.id, attachmentId }); }
  else void deleteContent?.({ kind, id: props.message.id });
}

const props = withDefaults(defineProps<{
  githubHistory?: boolean;
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
  deliveryReceipts?: Array<{ agentId: string; agentName: string; state: string; blockedByMessageId: string | null; error: string | null; failureCode: string | null; terminalReason: string | null; attemptCount: number; providerTurnId: string | null; retry?: DesktopRoomAgentDeliveryAttention["retry"] | null;
    /** The agent's automatic attempt for the work this message began, while it waits for its time. */
    scheduledRetry?: AgentScheduledRetryView | null;
    /** The follow-up of the work this message began, when it waits for its owner or ended with nothing started. */
    followUpNote?: RoomMessageFollowUpNote | null }>;
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

/** A request for this agent that is on its way. A follow-up has an id of its own, which is not this message's. */
function retryingReceipt(agentId: string, sourceMessageId = props.message.id): boolean {
  return props.deliveryRetryKeys?.has(`${agentId}:${sourceMessageId}`) === true;
}

function restoringReceipt(agentId: string): boolean {
  return props.continuationRepairKeys?.has(`${agentId}:${props.message.id}`) === true;
}

function skippingReceipt(agentId: string, sourceMessageId = props.message.id): boolean {
  return props.roomDeliverySkipKeys?.has(`${agentId}:${sourceMessageId}`) === true;
}

const emit = defineEmits<{
  "quote-reply": [messageId: string];
  "open-thread": [messageId: string];
  "scroll-to-message": [messageId: string | null];
  "open-image": [imageId: string];
  "open-agent": [target: AgentModalTarget];
  "open-person": [target: PersonTarget, position: PersonMenuPosition];
  "open-github-event": [url: string];
  "open-task": [taskId: string];
  "quote-selection": [messageId: string, text: string];
  "jump-to-thread-root": [messageId: string];
  "retry-delivery": [agentId: string, sourceMessageId: string];
  "restore-conversation": [agentId: string, sourceMessageId: string];
  "skip-delivery": [agentId: string, sourceMessageId: string];
}>();

/** Try now: ask the agent to start its automatic attempt at once. The request names the attempt, which is not this message. */
function tryRetryNow(receipt: { agentId: string; scheduledRetry?: AgentScheduledRetryView | null }): void {
  const retryId = receipt.scheduledRetry?.sourceMessageId;
  if (retryId && props.deliveryRecoveryAvailable && !retryingReceipt(receipt.agentId, retryId)) emit("retry-delivery", receipt.agentId, retryId);
}

/** Stop trying: end the agent's automatic attempt before it starts. */
function stopRetrying(receipt: { agentId: string; scheduledRetry?: AgentScheduledRetryView | null }): void {
  const retryId = receipt.scheduledRetry?.sourceMessageId;
  if (retryId && props.roomDeliverySkipAvailable && !skippingReceipt(receipt.agentId, retryId)) emit("skip-delivery", receipt.agentId, retryId);
}

/** Retry for a follow-up that waits for its owner: the request names the follow-up, which is not this message. */
function retryFollowUp(receipt: { agentId: string; followUpNote?: RoomMessageFollowUpNote | null }): void {
  const note = receipt.followUpNote;
  if (note?.canRetry && props.deliveryRecoveryAvailable && !retryingReceipt(receipt.agentId, note.sourceMessageId)) emit("retry-delivery", receipt.agentId, note.sourceMessageId);
}

/**
 * The countdown as this message shows it: the saved time minus the clock, so it is right however long the app slept.
 * It has two parts, which the receipt may wrap between: the wait, and the attempt.
 */
function scheduledRetryParts(receipt: { scheduledRetry?: AgentScheduledRetryView | null }): [string, string] {
  return receipt.scheduledRetry ? scheduledRetryLabelParts(receipt.scheduledRetry, retryClock.value) : ["", ""];
}

/** Why the follow-up of this message's work waits for its owner, or why it ended with nothing started. */
function followUpNoteLabel(note: Pick<RoomMessageFollowUpNote, "state" | "text">): string {
  return receiptErrorLabel(note.text) || (note.state === "ended" ? "The agent did not try again." : "The agent stopped and now waits for you.");
}

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
  "queued_behind_retry",
].includes(receipt.state)));
// Counts down to the saved time of an automatic attempt, once a second while one shows on this message.
const retryClock = useSecondClock(() => Boolean(props.deliveryReceipts?.some((receipt) => receipt.scheduledRetry)));

function receiptIsAnimated(state: string): boolean {
  return ["pending", "dispatching", "awaiting_result", "publishing", "retryable", "result_recovery", "restoring_conversation", "queued_behind_retry"].includes(state);
}

function receiptNeedsAttention(state: string): boolean {
  return state === "blocked" || state === "queued_behind_blocked";
}

function receiptErrorLabel(error: string | null): string | null {
  const normalized = safeUserVisibleErrorDetail(error, "");
  if (!normalized) return null;
  return normalized.length > 180 ? `${normalized.slice(0, 179)}…` : normalized;
}

function receiptStateLabel(receipt: { agentId: string; state: string; terminalReason: string | null; error: string | null }): string {
  if (receipt.terminalReason === "upgrade_authority_unavailable") return "Retired during safety upgrade";
  const state = receipt.state;
  if (state === "retryable") return "Retrying";
  if (state === "result_recovery") return "Recovering reply";
  if (state === "restoring_conversation") return "Restoring conversation";
  if (state === "blocked") return receiptErrorLabel(receipt.error) || "Needs attention";
  if (state === "queued_behind_blocked") return "Queued behind an issue";
  if (state === "queued_behind_retry") return "Queued until the agent has tried again";
  if (state === "acknowledged_no_reply") return "Read · no reply";
  if (state === "acknowledged_failed") return receiptFailureLabel(receipt);
  if (state === "cancelled_by_room_move") return "Moved rooms";
  if (state === "cancelled_by_user") return "Skipped";
  return "";
}

function receiptFailureLabel(receipt: { agentId?: string; error: string | null }): string {
  return (receipt.agentId ? deliveryLimitNotices.value.get(receipt.agentId)?.title : null)
    || receiptErrorLabel(receipt.error) || "Work did not finish";
}

function receiptLabel(receipt: { agentId?: string; agentName: string; state: string; blockedByMessageId: string | null; terminalReason: string | null; error: string | null;
  scheduledRetry?: AgentScheduledRetryView | null; followUpNote?: RoomMessageFollowUpNote | null }): string {
  if (receipt.terminalReason === "upgrade_authority_unavailable") return `A safety upgrade retired this legacy turn for ${receipt.agentName}; its exact authority could not be reconstructed`;
  if (receipt.scheduledRetry || receipt.followUpNote) {
    // Read aloud with a clock time: the list is a live region, and a count that changes each second would be read each second.
    const failed = (receiptErrorLabel(receipt.error) || "Work did not finish").replace(/[.\s]+$/, "");
    return `${receipt.agentName}: ${failed}. ${receipt.scheduledRetry
      ? `${scheduledRetryClockLabel(receipt.scheduledRetry, retryClock.value)}. ${scheduledRetryOutcome(receipt.scheduledRetry)}`
      : followUpNoteLabel(receipt.followUpNote!)}`;
  }
  if (receipt.state === "queued_behind_retry") return `Waiting — ${receipt.agentName} will try earlier work again first`;
  if (receipt.state === "dispatching" || receipt.state === "awaiting_result") return `${receipt.agentName} is responding`;
  if (receipt.state === "publishing") return `${receipt.agentName} is sending a reply`;
  if (receipt.state === "pending") return `${receipt.agentName} is queued to respond`;
  if (receipt.state === "acknowledged") return `${receipt.agentName} replied`;
  if (receipt.state === "acknowledged_no_reply") return `${receipt.agentName} saw this and chose not to reply`;
  if (receipt.state === "acknowledged_failed") return `${receipt.agentName}: ${receiptFailureLabel(receipt)}`;
  if (receipt.state === "retryable") return `${receipt.agentName} couldn’t finish; retrying`;
  if (receipt.state === "result_recovery") return `${receipt.agentName} answered, but LetAgents is re-reading the completed result`;
  if (receipt.state === "restoring_conversation") return `${receipt.agentName} is restoring its private conversation`;
  if (receipt.state === "blocked") return `${receipt.agentName}: ${receiptErrorLabel(receipt.error) || "Needs attention"}`;
  if (receipt.state === "cancelled_by_room_move") return `${receipt.agentName} moved to another room before handling this`;
  if (receipt.state === "cancelled_by_user") return `You skipped this message for ${receipt.agentName}`;
  if (receipt.state === "queued_behind_blocked") return `Waiting — ${receipt.agentName} needs attention on ${receipt.blockedByMessageId || "an earlier message"}`;
  return `Waiting for ${receipt.agentName}`;
}

const gifState = ref<'loading' | 'ready' | 'unavailable'>('loading');
const remindable = computed(() => Boolean(reminderAccount.value && props.roomIdentifier && !isLocalRoomIdentifier(props.roomIdentifier) && isValidMessageId(props.message.id) && !props.message.outgoing));
const { pushActionToast } = useDesktopActionToasts();
function reminderScheduled(dueAt: string) {
  pushActionToast(`Reminder set for ${new Date(dueAt).toLocaleString()}`, "success");
  closeContextMenu("complete");
}
const contextMenuOpen = ref(false);
const contextMenuPosition = ref({ x: 0, y: 0 });
const firstContextMenuButton = ref<HTMLButtonElement | null>(null);
const messageActionsTrigger = ref<HTMLButtonElement | null>(null);
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
const displayName = computed(() => props.message.source === "browser" ? props.message.sender : props.message.agentIdentity?.displayName || identity.value.displayName);
const ownerAttribution = computed(() => resolveOwnerAttribution({
  ownerAttribution: props.message.agentIdentity?.ownerAttribution,
  ownerLabel: props.message.agentIdentity?.ownerLabel,
  actorLabel: props.message.agentIdentity?.actorLabel || props.message.actorLabel,
  sender: props.message.sender,
}));
const ideLabel = computed(() => props.providerLabel || props.message.agentIdentity?.ideLabel || identity.value.ideLabel);
const isSystem = computed(() => props.message.source !== "browser" && ["system", "letagents"].includes(props.message.sender.toLowerCase()));
/** An agent's wake rule fired: a quiet line, not a conversation. */
const isWakeNotice = computed(() => props.message.source === WAKE_NOTICE_SOURCE);
const isAmbientSystem = computed(() =>
  props.message.source !== "browser" && isAmbientSystemMessage(props.message.sender, props.message.text || "")
);
const githubEvent = computed(() => props.message.source === "browser" ? null : parseGitHubEvent(props.message));
const viewer = useMessageViewer();
const supervisorEntries = inject(supervisorEntriesKey, null);
const agentLaunchHost = inject(composerAgentLaunchKey, null);
const deliveryLimitNotices = computed(() => {
  const notices = new Map<string, ClaudeLimitDetails>();
  for (const receipt of visibleDeliveryReceipts.value) {
    if (receipt.state !== "acknowledged_failed" && receipt.state !== "blocked") continue;
    const entry = supervisorEntries?.entries.value.find(agent => agent.id === receipt.agentId);
    const notice = claudeLimitNotice(receipt.error, entry?.provider);
    if (notice) notices.set(receipt.agentId, notice);
  }
  return notices;
});
const inlineDeliveryLimits = computed(() => new Set(visibleDeliveryReceipts.value.filter((receipt) => {
  const notice = deliveryLimitNotices.value.get(receipt.agentId);
  return notice && (receipt.state !== "acknowledged_failed" || !notice.modelFamily);
}).map((receipt) => receipt.agentId)));
const deliveryReceiptRows = computed(() => visibleDeliveryReceipts.value.map((receipt) => ({
  receipt,
  modelRecovery: receipt.state === "acknowledged_failed" && deliveryLimitNotices.value.get(receipt.agentId)?.modelFamily
    ? receiptContext?.modelRecoveryFor?.(props.message, receipt.agentId)
    : null,
})));
const ownedLocalAgent = computed(() => isOwnedLocalRoomAgent(
  props.roomIdentifier, props.message.agentIdentity?.agentKey, supervisorEntries?.entries.value,
));
const senderRole = computed(() => chatSenderRole({ human: ownerKind.value === 'human', agent: ownerKind.value === 'agent',
  viewerLogin: viewer.value?.login, login: props.message.senderProfile?.login, agentKey: props.message.agentIdentity?.agentKey,
  ownedLocalAgent: ownedLocalAgent.value, outgoing: Boolean(props.message.outgoing) }));
const showQuickActions = computed(() => Boolean(senderRole.value) && props.context === "timeline" && !props.message.outgoing);
const avatarUrl = computed(() => props.message.senderProfile?.avatarUrl || (props.message.outgoing ? viewer.value?.avatar_url : null));
const readerSender = computed(() => ({
  name: displayName.value,
  context: senderRole.value === 'own-agent' ? 'Your agent' : senderRole.value === 'self' ? 'You'
    : ownerKind.value === 'agent' ? ownerAttribution.value || 'Agent' : ownerKind.value === 'human' ? 'Human' : 'Room',
  timestamp: props.message.timestamp,
  avatarUrl: avatarUrl.value,
  agent: ownerKind.value === 'agent',
  provider: ideLabel.value,
  agentKey: props.message.agentIdentity?.agentKey,
}));
const senderColor = computed(() => getSenderColor(props.message.sender, props.message.source));
const ownerKind = computed(() => {
  if (isSystem.value) return "system";
  if (props.message.source === "github") return "github";
  if (props.message.source === "browser") return "human";
  if (props.message.source === "agent" || ownerAttribution.value || ideLabel.value) return "agent";
  return "room";
});
/** A human who sent this message, with a GitHub login, can be clicked. System and GitHub senders cannot. */
const personTarget = computed<PersonTarget | null>(() => {
  const login = props.message.senderProfile?.login?.trim();
  if (ownerKind.value !== "human" || !login) return null;
  return { login, displayName: displayName.value, avatarUrl: props.message.senderProfile?.avatarUrl ?? null };
});
function openPersonMenu(event: MouseEvent): void {
  const target = personTarget.value;
  if (target) emit("open-person", target, personMenuPosition(event));
}
const provenanceLabel = computed(() =>
  ownerKind.value === "agent" && ownerAttribution.value ? null : ownerKind.value
);
const replyDisplayName = computed(() =>
  props.message.replyTo ? parseSenderIdentity(props.message.replyTo).displayName : "unknown"
);
const attentionResponseAgentNames = inject(attentionResponseAgentNamesKey, null);
const inlineThread = inject(inlineThreadKey, null);
const replyPreviewText = computed(() => truncate((props.message.replyTo
  ? roomMessageVisibleText(props.message.replyTo, attentionResponseAgentNames?.value)
  : "").replace(/\s+/g, " ").trim(), 160));
const visibleText = computed(() => roomMessageVisibleText(props.message, attentionResponseAgentNames?.value));
const outgoingStatusText = computed(() => {
  const outgoing = props.message.outgoing;
  if (!outgoing) return "";
  if (outgoing.status === "pending") return "Sending…";
  if (outgoing.error?.includes("expressions_disabled:")) return "GIF sending is off in this room";
  if (outgoing.status === "refused") return "Not sent";
  return "Delivery not confirmed";
});
const outgoingTone = computed<"pending" | "warning" | "error">(() => {
  const outgoing = props.message.outgoing;
  if (!outgoing || outgoing.status === "pending") return "pending";
  return outgoing.status === "refused" || outgoing.error?.includes("expressions_disabled:")
    ? "error"
    : "warning";
});
const outgoingAttachmentItems = computed(() => {
  const attachments = props.message.outgoing?.attachments ?? [];
  return attachments
    .filter((item) => Boolean(item.fileName))
    .map((item) => ({
      upload_id: item.upload_id,
      fileName: item.fileName || "Attachment",
      sizeLabel: typeof item.sizeBytes === "number" && item.sizeBytes > 0 ? formatBytes(item.sizeBytes) : null,
    }));
});
const outgoingAttachmentSummary = computed(() => {
  const count = props.message.outgoing?.attachmentCount ?? 0;
  if (!count) return "";
  return `${count} attachment${count === 1 ? "" : "s"}`;
});
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
// A message with no msg_/task_ text must not read the reference sets, so a new
// message elsewhere in the room does not re-run this pass for it.
const linkedText = computed(() => {
  const html = renderedMessage.value.html;
  if (!mayContainMessageReference(html)) return html;
  return linkRenderedMessageReferences(html, props.messageReferenceIds, props.taskReferenceIds);
});
// Same rule for mentions: only a message with an @mention reads the room's participants.
const mentionDirectory = inject(roomMentionDirectoryKey, null);
const mentionLinkedText = computed(() => {
  const html = linkedText.value;
  if (!mentionDirectory || !mayContainMention(html)) return html;
  return linkRenderedMentions(html, mentionDirectory.value);
});
/** A clicked @mention opens that participant: an agent's inspector, or a person's menu. */
function openMention(mentionKey: string, position: PersonMenuPosition): void {
  const target = mentionDirectory?.value.byKey(mentionKey);
  if (!target) return;
  if (target.kind === "agent") emit("open-agent", target.agent);
  else emit("open-person", target.person, position);
}
const gitHubLinkedText = computed(() => linkRenderedGitHubReferences(mentionLinkedText.value, previewContext?.repository.value ?? null));
const renderedText = computed(() => highlightRenderedMessage(gitHubLinkedText.value, props.highlightQuery));
const copyButtonTitle = computed(() => copied.value ? "Copied" : "Copy message");
const tertiaryActionLabel = computed(() => props.context === "timeline" ? "Reply in thread" : "Jump to root");
const selectionActionLabel = computed(() => props.context === "timeline" ? "Add to chat" : "Add to thread");
const threadIndicatorVisible = computed(() =>
  props.threadSummary.count > 0 || props.threadSummary.hasPartialHistory || props.threadSummary.loadingEarlier
);
const threadMarkerCountLabel = computed(() => {
  if (props.threadSummary.loadingEarlier && props.threadSummary.count === 0) return "Loading replies";
  if (props.threadSummary.count === 0) return "Thread";
  if (props.threadSummary.count === 1) return "1 reply";
  return `${props.threadSummary.count} replies`;
});
const threadMarkerAriaLabel = computed(() => {
  const unread = props.threadSummary.unreadCount > 0 ? `, ${props.threadSummary.unreadCount} unread` : "";
  return `${threadMarkerCountLabel.value}${unread}. ${props.activeThreadRoot ? "Collapse replies" : "Open thread"}.`;
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

const receiptContext = injectRoomMessageReceipts();
const receiptMark = ref<InstanceType<typeof RoomMessageReceiptMark> | null>(null);
/** Receipts are for the sender only: your own sent messages in a room on the server. */
const showsReceipt = computed(() => senderRole.value === "self"
  && Boolean(receiptContext?.available.value)
  && !isLocalRoomIdentifier(props.roomIdentifier)
  && !props.message.outgoing
  && isValidMessageId(props.message.id));
/** Message info opens the receipt, so it is offered only once there is one to show. */
const hasReceipt = computed(() => showsReceipt.value && visibleReceipt(receiptContext?.receiptFor(props.message.id)) !== null);

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
  const invoker = target?.closest<HTMLElement>("button, a, [tabindex]") || article;
  showContextMenu(event.clientX, event.clientY, invoker, linkHref);
}

function openMessageActions(): void {
  const trigger = messageActionsTrigger.value;
  if (!trigger) return;
  if (contextMenuOpen.value && contextMenuInvoker.value === trigger) {
    closeContextMenu("complete");
    return;
  }
  const bounds = trigger.getBoundingClientRect();
  showContextMenu(bounds.right - messageMenuWidth, bounds.bottom + 4, trigger, null);
}

const messageMenuWidth = 180;

function showContextMenu(x: number, y: number, invoker: HTMLElement | null, linkHref: string | null): void {
  contextLinkHref.value = linkHref;
  contextMenuInvoker.value = invoker;
  closeSelectionPopover();
  // Link variant: 3 rows + separator; message variant: 4 rows + separator,
  // plus a row for each available pin/reaction action. The estimate must
  // cover the tallest variant or the last row ("Message info") clips below
  // the viewport near the bottom edge. Message info and its separator show
  // only on your own messages, which carry a receipt.
  const deletionMenuHeight = deleteContent ? 44 + props.message.attachments.length * 36 : 0;
  const menuHeight = deletionMenuHeight + (linkHref ? 140 : 176 + (reactable.value ? 32 : 0) + (pinnable.value ? 32 : 0)) - (hasReceipt.value ? 0 : 41);
  const clampedMenuHeight = menuHeight + (!linkHref && remindable.value ? 32 : 0) + (!linkHref && canCopyMessageLink.value ? 32 : 0)
    + (!linkHref && longMessageContent.value?.canOpenReader ? 32 : 0)
    + (!linkHref && canMarkUnread.value ? 32 : 0);
  contextMenuPosition.value = {
    x: Math.max(8, Math.min(x, window.innerWidth - messageMenuWidth - 8)),
    y: Math.max(8, Math.min(y, window.innerHeight - clampedMenuHeight - 8)),
  };
  contextMenuOpen.value = true;
  void nextTick(() => {
    const firstItem = firstContextMenuButton.value;
    if (!contextMenuOpen.value || !firstItem) return;
    const bounds = firstItem.parentElement?.getBoundingClientRect?.();
    if (bounds && invoker === messageActionsTrigger.value && invoker) {
      const anchor = invoker.getBoundingClientRect();
      const positionAbove = anchor.bottom + 4 + bounds.height > window.innerHeight - 8;
      contextMenuPosition.value = {
        x: Math.max(8, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 8)),
        y: Math.max(8, positionAbove ? anchor.top - bounds.height - 4 : anchor.bottom + 4),
      };
    }
    firstItem.focus({ preventScroll: true });
  });
  window.addEventListener("pointerdown", closeContextMenuFromOutside);
  window.addEventListener("keydown", handleContextMenuKeydown);
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

function closeContextMenuFromOutside(event?: PointerEvent): void {
  const trigger = messageActionsTrigger.value;
  if (trigger === contextMenuInvoker.value && trigger && event?.target instanceof Node && trigger.contains(event.target)) return;
  closeContextMenu("outside");
}

function tabFromContextMenu(): void {
  // Continue through the message list from the invoker, not the teleported menu.
  restoreContextMenuFocus(contextMenuInvoker.value);
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
watch([() => props.message.id, () => props.message.reactions !== undefined], () => {
  stopTrackingReactions?.();
  stopTrackingReactions = reactionContext?.track(props.message) ?? null;
}, { immediate: true });

const messageElement = ref<HTMLElement | null>(null);
const longMessageContent = ref<InstanceType<typeof DesktopLongMessageContent> | null>(null);
const threadClosing = ref(false);
const threadWide = computed(() => props.context === "timeline" && (threadIndicatorVisible.value || props.activeThreadRoot));
const showThreadMarker = computed(() => threadWide.value || threadClosing.value);

watch(() => props.activeThreadRoot, open => {
  threadClosing.value = !open && props.context === "timeline";
}, { flush: "sync" });

function finishThreadMotion(): void {
  threadClosing.value = false;
}

function openMessageReader(): void {
  closeContextMenu("complete");
  void nextTick(() => longMessageContent.value?.openReader());
}
const reactionPickerAnchor = ref<MessageReactionPickerAnchor | null>(null);
const reactionAction = ref<HTMLButtonElement | null>(null);
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
  if (props.context === "timeline") {
    emit("open-thread", props.message.id);
    return;
  }
  emit("jump-to-thread-root", props.message.id);
}

/** Message info is the receipt: it opens from the mark after the time. */
function messageInfoFromContext(): void {
  closeContextMenu("action");
  void nextTick(() => receiptMark.value?.open());
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
    return props.message.attachments[0]?.fileName || "1 attachment";
  }
  if (props.message.attachments.length > 1) {
    return props.message.attachments
      .map((attachment) => attachment.fileName)
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
    if (contextMenuOpen.value) closeContextMenu("outside");
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
