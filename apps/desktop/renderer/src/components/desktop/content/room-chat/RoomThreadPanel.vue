<template>
  <aside
    ref="panelElement"
    class="room-thread-panel"
    data-testid="room-thread-panel"
    aria-label="Message thread"
    tabindex="-1"
    @dragenter.stop.prevent
    @dragover.stop.prevent
    @dragleave.stop.prevent
    @drop.stop.prevent="handleAttachmentDrop"
    @keydown.escape.stop.prevent="$emit('close')"
  >
    <header class="room-thread-header">
      <div>
        <p>Thread</p>
        <strong>{{ replyCountLabel }}</strong>
      </div>
      <div class="room-thread-header-actions">
        <span v-if="threadSummary.unreadCount > 0" class="room-thread-unread-pill">
          {{ threadSummary.unreadCount }} unread
        </span>
        <button type="button" aria-label="Close thread" data-testid="room-thread-close" @click="$emit('close')">
          <X :size="16" aria-hidden="true" />
        </button>
      </div>
    </header>

    <section ref="bodyElement" class="room-thread-body">
      <div v-if="loadingOlderReplies" class="room-thread-history-state" data-testid="room-thread-loading-earlier">
        <span class="room-thread-history-spinner" aria-hidden="true"></span>
        <span>Loading earlier replies...</span>
      </div>
      <div v-else-if="hasOlderReplies" class="room-thread-history-state" data-testid="room-thread-partial-history">
        <span>Earlier replies are available.</span>
        <button
          type="button"
          data-testid="room-thread-load-earlier"
          @click="$emit('load-older-replies')"
        >
          Load earlier
        </button>
      </div>

      <article
        class="room-thread-message is-root"
        :class="{ 'is-search-active': parent.id === activeSearchMessageId }"
        :data-thread-message-id="parent.id"
        :data-testid="`room-thread-message-${parent.id}`"
      >
        <div class="room-thread-avatar" :style="{ '--avatar-color': senderColor(parent) }" aria-hidden="true"></div>
        <div class="room-thread-message-content">
          <div class="room-thread-message-meta">
            <div class="room-thread-author-stack">
              <button
                v-if="isAgentMessage(parent)"
                class="room-thread-author-button"
                type="button"
                :title="`Show ${displayName(parent)} details`"
                @click="$emit('open-agent', agentTarget(parent))"
              >
                {{ displayName(parent) }}
              </button>
              <strong v-else>{{ displayName(parent) }}</strong>
              <span v-if="ownerAttribution(parent)" class="room-thread-owner">{{ ownerAttribution(parent) }}</span>
              <span v-if="ideLabel(parent)" class="room-thread-ide">{{ ideLabel(parent) }}</span>
            </div>
            <div class="room-thread-message-tail">
              <span class="room-thread-provenance" :data-kind="sourceKind(parent)">
                {{ sourceKind(parent) }}
              </span>
              <time :datetime="parent.timestamp">{{ formatTimestamp(parent.timestamp) }}</time>
            </div>
          </div>
          <div class="room-thread-message-actions" aria-label="Thread root actions">
            <button type="button" title="Quote root" aria-label="Quote root" @click="quoteInThread(parent)">
              <CornerUpLeft :size="14" aria-hidden="true" />
            </button>
            <button type="button" title="Jump to root" aria-label="Jump to root message" @click="$emit('jump-message', parent.id)">
              <LocateFixed :size="14" aria-hidden="true" />
            </button>
          </div>
          <DesktopGitHubEventCard
            v-if="githubEvent(parent)"
            :event="githubEvent(parent)!"
            @open-event="$emit('open-github-event', $event)"
          />
          <DesktopLongMessageContent
            v-else
            :text="parent.text || 'No message body.'"
            :html="renderMessageText(parent.text || 'No message body.', searchQuery)"
            :message-id="`${parent.id}-thread-parent`"
          />
          <DesktopMessageAttachments
            v-if="parent.attachments.length"
            :message-id="parent.id"
            :attachments="parent.attachments"
            @open-image="$emit('open-image', $event)"
          />
        </div>
      </article>

      <div class="room-thread-divider">
        <span>{{ replyCountLabel }}</span>
      </div>

      <template v-for="reply in replies" :key="reply.id">
        <div
          v-if="readState.firstUnreadReplyId === reply.id"
          class="room-thread-new-divider"
          data-testid="room-thread-new-replies-divider"
        >
          <span>New replies</span>
        </div>
        <article
          class="room-thread-message"
          :class="{ 'is-search-active': reply.id === activeSearchMessageId }"
          :data-thread-message-id="reply.id"
          :data-testid="`room-thread-reply-${reply.id}`"
        >
          <div class="room-thread-avatar" :style="{ '--avatar-color': senderColor(reply) }" aria-hidden="true"></div>
          <div class="room-thread-message-content">
            <div class="room-thread-message-meta">
              <div class="room-thread-author-stack">
                <button
                  v-if="isAgentMessage(reply)"
                  class="room-thread-author-button"
                  type="button"
                  :title="`Show ${displayName(reply)} details`"
                  @click="$emit('open-agent', agentTarget(reply))"
                >
                  {{ displayName(reply) }}
                </button>
                <strong v-else>{{ displayName(reply) }}</strong>
                <span v-if="ownerAttribution(reply)" class="room-thread-owner">{{ ownerAttribution(reply) }}</span>
                <span v-if="ideLabel(reply)" class="room-thread-ide">{{ ideLabel(reply) }}</span>
              </div>
              <div class="room-thread-message-tail">
                <span class="room-thread-provenance" :data-kind="sourceKind(reply)">
                  {{ sourceKind(reply) }}
                </span>
                <time :datetime="reply.timestamp">{{ formatTimestamp(reply.timestamp) }}</time>
              </div>
            </div>
            <div class="room-thread-message-actions" aria-label="Thread reply actions">
              <button type="button" title="Quote reply" aria-label="Quote reply" @click="quoteInThread(reply)">
                <CornerUpLeft :size="14" aria-hidden="true" />
              </button>
              <button type="button" title="Jump to root" aria-label="Jump to root message" @click="$emit('jump-message', parent.id)">
                <LocateFixed :size="14" aria-hidden="true" />
              </button>
            </div>
            <DesktopGitHubEventCard
              v-if="githubEvent(reply)"
              :event="githubEvent(reply)!"
              @open-event="$emit('open-github-event', $event)"
            />
            <DesktopLongMessageContent
              v-else
              :text="reply.text || 'No message body.'"
              :html="renderMessageText(reply.text || 'No message body.', searchQuery)"
              :message-id="`${reply.id}-thread-reply`"
            />
            <DesktopMessageAttachments
              v-if="reply.attachments.length"
              :message-id="reply.id"
              :attachments="reply.attachments"
              @open-image="$emit('open-image', $event)"
            />
          </div>
        </article>
      </template>

      <div v-if="!replies.length" class="room-thread-empty" data-testid="room-thread-empty">
        <MessageSquarePlus :size="18" aria-hidden="true" />
        <div>
          <strong>Start this thread</strong>
          <span>Reply here to keep follow-up out of the main timeline.</span>
        </div>
      </div>
    </section>

    <form class="room-thread-composer" data-testid="room-thread-composer" @submit.prevent="submitThreadReply">
      <div v-if="quoteTarget" class="room-thread-quote-preview" data-testid="room-thread-quote-preview">
        <div>
          <strong>Quoting {{ displayName(quoteTarget) }}</strong>
          <span>{{ threadQuotePreview(quoteTarget) }}</span>
        </div>
        <button type="button" aria-label="Cancel quote" @click="quoteTarget = null">
          <X :size="14" aria-hidden="true" />
        </button>
      </div>
      <textarea
        ref="textareaElement"
        v-model="draft"
        rows="3"
        :disabled="sending || !roomIdentifier"
        :placeholder="composerPlaceholder"
        data-testid="room-thread-composer-input"
        @input="handleDraftInput"
        @keydown.down="handleMentionArrow($event, 1)"
        @keydown.up="handleMentionArrow($event, -1)"
        @keydown.enter="handleEnterKey"
        @keydown.escape.stop="handleComposerEscape"
      />
      <DesktopAttachmentDrafts
        :attachments="attachmentDrafts"
        :pending-attachments="pendingAttachmentDrafts"
        @remove="$emit('remove-attachment', $event)"
      />
      <div v-if="mentionOpen" class="desktop-mention-panel room-thread-mention-panel" data-testid="room-thread-mention-panel">
        <button
          v-for="(candidate, index) in mentionCandidates"
          :key="candidate.participantKey"
          class="desktop-mention-option"
          :data-active="index === activeMentionIndex"
          :data-testid="`room-thread-mention-option-${candidate.participantKey}`"
          type="button"
          @click="insertMention(candidate.displayName)"
        >
          <span>{{ candidate.displayName }}</span>
          <small>{{ candidate.kind === 'agent' ? 'Agent' : 'Human' }}</small>
        </button>
      </div>
      <div class="room-thread-composer-footer">
        <p v-if="sendError || attachmentError" class="room-thread-composer-error" data-testid="room-thread-send-error">
          {{ sendError || attachmentError }}
        </p>
        <span v-else>{{ roomIdentifier ? "Reply in thread" : "Open a room to reply" }}</span>
        <div class="room-thread-composer-actions">
          <button
            type="button"
            :disabled="sending || !roomIdentifier || attaching"
            :title="attaching ? 'Attaching' : 'Attach files'"
            :aria-label="attaching ? 'Attaching files' : 'Attach files'"
            data-testid="room-thread-attach"
            @click="$emit('pick-attachments')"
          >
            <Paperclip :size="14" aria-hidden="true" />
          </button>
          <button type="submit" :disabled="!canSend" data-testid="room-thread-send">
            {{ sending ? "Sending..." : "Reply" }}
          </button>
        </div>
      </div>
    </form>
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { CornerUpLeft, LocateFixed, MessageSquarePlus, Paperclip, X } from "@lucide/vue";
import type {
  DesktopParticipantSummary,
  DesktopRoomMessage,
  DesktopRoomMessageThreadSummary,
  DesktopStagedAttachment,
} from "../../../../../../electron/ipc-types";
import { isMentionableRoomParticipant } from "../../../../domain/participants";
import DesktopAttachmentDrafts, { type PendingAttachmentDraft } from "../DesktopAttachmentDrafts.vue";
import DesktopGitHubEventCard from "../desktop-chat-message/DesktopGitHubEventCard.vue";
import DesktopMessageAttachments from "../desktop-chat-message/DesktopMessageAttachments.vue";
import { parseGitHubEvent } from "../desktop-chat-message/github-event";
import { getSenderColor, parseSenderIdentity } from "../desktop-chat-message/identity";
import { formatTimestamp, renderMessageText } from "../desktop-chat-message/message-rendering";
import type { AgentModalTarget } from "../desktop-chat-message/types";
import DesktopLongMessageContent from "../DesktopLongMessageContent.vue";
import {
  applyThreadQuoteToDraft,
  buildThreadIndicatorSummary,
  threadQuotePreview,
  threadReadState,
} from "./thread-utils";

const props = defineProps<{
  parent: DesktopRoomMessage;
  initialThreadSummary: DesktopRoomMessageThreadSummary | null;
  replies: DesktopRoomMessage[];
  participants: DesktopParticipantSummary[];
  roomIdentifier: string | null;
  sending: boolean;
  sendError: string | null;
  attaching: boolean;
  attachmentDrafts: DesktopStagedAttachment[];
  attachmentError: string | null;
  pendingAttachmentDrafts: PendingAttachmentDraft[];
  hasOlderReplies: boolean;
  loadingOlderReplies: boolean;
  searchQuery: string;
  activeSearchMessageId: string | null;
}>();

const emit = defineEmits<{
  close: [];
  "open-image": [imageId: string];
  "send-thread-message": [text: string, threadRootId: string, replyToId: string | null, attachments: Array<{ upload_id: string }>];
  "open-github-event": [url: string];
  "open-agent": [target: AgentModalTarget];
  "jump-message": [messageId: string];
  "load-older-replies": [];
  "pick-attachments": [];
  "remove-attachment": [uploadId: string];
  "stage-dropped-attachments": [files: File[]];
}>();

const draft = ref("");
const quoteTarget = ref<DesktopRoomMessage | null>(null);
const textareaElement = ref<HTMLTextAreaElement | null>(null);
const panelElement = ref<HTMLElement | null>(null);
const bodyElement = ref<HTMLElement | null>(null);
const mentionQuery = ref<string | null>(null);
const activeMentionIndex = ref(0);

const threadSummary = computed(() =>
  buildThreadIndicatorSummary(props.parent, {
    count: props.replies.length,
    latest: props.replies[props.replies.length - 1] || null,
    replies: props.replies,
  })
);
const readStateParent = computed(() =>
  props.initialThreadSummary ? { ...props.parent, thread: props.initialThreadSummary } : props.parent
);
const readState = computed(() => threadReadState(readStateParent.value, props.replies));
const replyCountLabel = computed(() => {
  if (props.loadingOlderReplies && props.replies.length === 0) return "Loading replies";
  if (threadSummary.value.count === 1) return "1 reply";
  return `${threadSummary.value.count} replies`;
});
const composerPlaceholder = computed(() =>
  props.roomIdentifier ? `Reply to ${displayName(props.parent)}...` : "Open a room to reply"
);
const canSend = computed(() =>
  Boolean(props.roomIdentifier && !props.sending && (draft.value.trim() || props.attachmentDrafts.length > 0))
);
const mentionOpen = computed(() => mentionQuery.value !== null && mentionCandidates.value.length > 0);
const mentionCandidates = computed(() => {
  const query = (mentionQuery.value || "").toLowerCase();
  return props.participants
    .filter(isMentionableRoomParticipant)
    .filter((participant) => participant.displayName.toLowerCase().includes(query))
    .slice(0, 6);
});

watch(
  () => props.parent.id,
  async () => {
    draft.value = "";
    quoteTarget.value = null;
    mentionQuery.value = null;
    await nextTick();
    panelElement.value?.focus({ preventScroll: true });
    if (!scrollActiveSearchMessage()) textareaElement.value?.focus();
  },
  { immediate: true },
);

watch(
  () => [props.activeSearchMessageId, props.parent.id, props.replies.length] as const,
  async () => {
    await nextTick();
    scrollActiveSearchMessage();
  },
);

watch(
  () => props.replies,
  async (newReplies, oldReplies = []) => {
    const body = bodyElement.value;
    const previousScrollHeight = body?.scrollHeight || 0;
    const previousScrollTop = body?.scrollTop || 0;
    const wasNearBottom = body
      ? body.scrollHeight - body.scrollTop - body.clientHeight < 96
      : true;
    const oldLastId = oldReplies[oldReplies.length - 1]?.id || null;
    const newLastId = newReplies[newReplies.length - 1]?.id || null;
    await nextTick();
    if (!bodyElement.value) return;
    if (scrollActiveSearchMessage()) return;
    if (oldLastId && oldLastId === newLastId && newReplies.length > oldReplies.length) {
      bodyElement.value.scrollTop = previousScrollTop + bodyElement.value.scrollHeight - previousScrollHeight;
      return;
    }
    if (oldLastId && !wasNearBottom) return;
    bodyElement.value.scrollTop = bodyElement.value.scrollHeight;
  },
);

function displayName(message: DesktopRoomMessage): string {
  return message.agentIdentity?.displayName || parseSenderIdentity(message).displayName;
}

function ownerAttribution(message: DesktopRoomMessage): string | null {
  return message.agentIdentity?.ownerAttribution || parseSenderIdentity(message).ownerAttribution;
}

function ideLabel(message: DesktopRoomMessage): string | null {
  return message.agentIdentity?.ideLabel || parseSenderIdentity(message).ideLabel;
}

function sourceKind(message: DesktopRoomMessage): string {
  if (message.source === "github") return "github";
  if (message.source === "agent" || ownerAttribution(message) || ideLabel(message)) return "agent";
  if (message.source === "browser" || message.source === "user") return "human";
  if (["system", "letagents"].includes(message.sender.toLowerCase())) return "system";
  return message.source || "room";
}

function isAgentMessage(message: DesktopRoomMessage): boolean {
  return sourceKind(message) === "agent";
}

function senderColor(message: DesktopRoomMessage): string {
  return getSenderColor(message.sender, message.source);
}

function agentTarget(message: DesktopRoomMessage): AgentModalTarget {
  return {
    actorLabel: message.actorLabel || message.agentIdentity?.actorLabel || message.sender,
    displayName: displayName(message),
    ownerAttribution: ownerAttribution(message),
    ideLabel: ideLabel(message),
    sender: message.sender,
    agentKey: message.agentIdentity?.agentKey || null,
    agentSessionId: message.agentIdentity?.agentSessionId || null,
  };
}

function githubEvent(message: DesktopRoomMessage) {
  return parseGitHubEvent(message);
}

function quoteInThread(message: DesktopRoomMessage): void {
  quoteTarget.value = message;
  void nextTick(() => textareaElement.value?.focus());
}

function scrollActiveSearchMessage(): boolean {
  const messageId = props.activeSearchMessageId;
  if (!messageId || (messageId !== props.parent.id && !props.replies.some((reply) => reply.id === messageId))) {
    return false;
  }
  const target = [...(panelElement.value?.querySelectorAll<HTMLElement>("[data-thread-message-id]") ?? [])]
    .find((element) => element.dataset.threadMessageId === messageId);
  target?.scrollIntoView({ block: "center" });
  return Boolean(target);
}

function handleAttachmentDrop(event: DragEvent): void {
  const files = Array.from(event.dataTransfer?.files || []);
  if (files.length) emit("stage-dropped-attachments", files);
}

function submitThreadReply(): void {
  const text = draft.value.trim();
  if ((!text && props.attachmentDrafts.length === 0) || !props.roomIdentifier || props.sending) return;
  emit(
    "send-thread-message",
    applyThreadQuoteToDraft(text, quoteTarget.value),
    props.parent.id,
    quoteTarget.value?.id || props.parent.id,
    props.attachmentDrafts.map((attachment) => ({ upload_id: attachment.uploadId })),
  );
  draft.value = "";
  quoteTarget.value = null;
  mentionQuery.value = null;
}

function insertNewlineAtCursor(): void {
  const input = textareaElement.value;
  if (!input) return;
  const start = input.selectionStart;
  const end = input.selectionEnd;
  draft.value = `${draft.value.slice(0, start)}\n${draft.value.slice(end)}`;
  void nextTick(() => {
    input.selectionStart = start + 1;
    input.selectionEnd = start + 1;
  });
}

function handleEnterKey(event: KeyboardEvent): void {
  event.preventDefault();
  if (mentionOpen.value) {
    const candidate = mentionCandidates.value[activeMentionIndex.value];
    if (candidate) insertMention(candidate.displayName);
    return;
  }
  if (event.metaKey || event.ctrlKey || event.shiftKey) {
    insertNewlineAtCursor();
    return;
  }
  submitThreadReply();
}

function handleDraftInput(): void {
  const match = /(^|\s)@([A-Za-z0-9._-]*)$/.exec(draft.value);
  mentionQuery.value = match ? match[2] : null;
  activeMentionIndex.value = 0;
}

function handleMentionArrow(event: KeyboardEvent, delta: number): void {
  if (!mentionOpen.value) return;
  event.preventDefault();
  activeMentionIndex.value = (activeMentionIndex.value + delta + mentionCandidates.value.length) % mentionCandidates.value.length;
}

function insertMention(displayName: string): void {
  draft.value = draft.value.replace(/(^|\s)@([A-Za-z0-9._-]*)$/, `$1@${displayName} `);
  mentionQuery.value = null;
  void nextTick(() => textareaElement.value?.focus());
}

function handleComposerEscape(): void {
  if (mentionOpen.value) {
    mentionQuery.value = null;
    return;
  }
  emit("close");
}
</script>
