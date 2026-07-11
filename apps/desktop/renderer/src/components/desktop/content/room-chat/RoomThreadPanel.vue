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
      <div class="room-thread-heading">
        <strong>Thread</strong>
        <span>{{ replyCountLabel }}</span>
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

      <div class="room-thread-conversation">
      <DesktopChatMessage
        context="thread-root"
        :message="parent"
        :thread-summary="threadSummary"
        :active-thread-root="false"
        :highlight-query="searchQuery"
        :message-reference-ids="threadMessageReferenceIds"
        :search-active="parent.id === activeSearchMessageId"
        :thread-message-id="parent.id"
        :test-id="`room-thread-message-${parent.id}`"
        @quote-reply="quoteInThread(parent)"
        @quote-selection="(_messageId, text) => quoteSelectionInThread(parent, text)"
        @jump-to-thread-root="$emit('jump-message', parent.id)"
        @scroll-to-message="navigateThreadMessageReference"
        @open-image="$emit('open-image', $event)"
        @open-agent="$emit('open-agent', $event)"
        @open-github-event="$emit('open-github-event', $event)"
      />

      <div class="room-thread-divider">
        <span>Replies</span>
      </div>

      <template v-for="reply in replies" :key="reply.id">
        <div
          v-if="readState.firstUnreadReplyId === reply.id"
          class="room-thread-new-divider"
          data-testid="room-thread-new-replies-divider"
        >
          <span>New replies</span>
        </div>
        <DesktopChatMessage
          context="thread-reply"
          :message="reply"
          :thread-summary="emptyThreadSummary"
          :active-thread-root="false"
          :highlight-query="searchQuery"
          :message-reference-ids="threadMessageReferenceIds"
          :search-active="reply.id === activeSearchMessageId"
          :thread-message-id="reply.id"
          :test-id="`room-thread-reply-${reply.id}`"
          @quote-reply="quoteInThread(reply)"
          @quote-selection="(_messageId, text) => quoteSelectionInThread(reply, text)"
          @jump-to-thread-root="$emit('jump-message', parent.id)"
          @scroll-to-message="navigateThreadMessageReference"
          @open-image="$emit('open-image', $event)"
          @open-agent="$emit('open-agent', $event)"
          @open-github-event="$emit('open-github-event', $event)"
        />
      </template>

      <div v-if="!replies.length" class="room-thread-empty" data-testid="room-thread-empty">
        <MessageSquarePlus :size="18" aria-hidden="true" />
        <div>
          <strong>Start this thread</strong>
          <span>Reply here to keep follow-up out of the main timeline.</span>
        </div>
      </div>
      </div>
    </section>

    <form class="room-thread-composer" data-testid="room-thread-composer" @submit.prevent="submitThreadReply">
      <div v-if="quoteTarget" class="room-thread-quote-preview" data-testid="room-thread-quote-preview">
        <div>
          <strong>{{ selectedQuoteText ? "Quoting selection from" : "Quoting" }} {{ displayName(quoteTarget) }}</strong>
          <span>{{ selectedQuoteText || threadQuotePreview(quoteTarget) }}</span>
        </div>
        <button type="button" aria-label="Cancel quote" @click="clearThreadQuote">
          <X :size="14" aria-hidden="true" />
        </button>
      </div>
      <textarea
        ref="textareaElement"
        v-model="draft"
        rows="2"
        :disabled="sending || !roomIdentifier"
        :placeholder="composerPlaceholder"
        role="combobox"
        aria-autocomplete="list"
        :aria-expanded="mentionOpen"
        aria-controls="room-thread-mention-listbox"
        :aria-activedescendant="mentionOpen ? `room-thread-mention-option-${mentionCandidates[activeMentionIndex]?.participantKey}` : undefined"
        data-testid="room-thread-composer-input"
        @input="handleDraftInput"
        @keydown.down="handleMentionArrow($event, 1)"
        @keydown.up="handleMentionArrow($event, -1)"
        @keydown.tab="closeMentionForTab"
        @keydown.enter="handleEnterKey"
        @keydown.escape.stop="handleComposerEscape"
      />
      <DesktopAttachmentDrafts
        :attachments="attachmentDrafts"
        :pending-attachments="pendingAttachmentDrafts"
        @remove="$emit('remove-attachment', $event)"
      />
      <div
        v-if="mentionOpen"
        id="room-thread-mention-listbox"
        class="desktop-mention-panel room-thread-mention-panel"
        role="listbox"
        data-testid="room-thread-mention-panel"
      >
        <button
          v-for="(candidate, index) in mentionCandidates"
          :key="candidate.participantKey"
          class="desktop-mention-option"
          :id="`room-thread-mention-option-${candidate.participantKey}`"
          role="option"
          tabindex="-1"
          :aria-selected="index === activeMentionIndex"
          :data-active="index === activeMentionIndex"
          :data-testid="`room-thread-mention-option-${candidate.participantKey}`"
          type="button"
          @click="insertMention(candidate.insertText)"
        >
          <span>{{ candidate.displayName }}</span>
          <small>{{ candidate.label }}</small>
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
import { MessageSquarePlus, Paperclip, X } from "@lucide/vue";
import type {
  DesktopParticipantSummary,
  DesktopRoomMessage,
  DesktopRoomMessageThreadSummary,
  DesktopStagedAttachment,
} from "../../../../../../electron/ipc-types";
import { roomMentionCandidates } from "../../../../domain/participants";
import DesktopAttachmentDrafts, { type PendingAttachmentDraft } from "../DesktopAttachmentDrafts.vue";
import DesktopChatMessage from "../DesktopChatMessage.vue";
import { parseSenderIdentity } from "../desktop-chat-message/identity";
import type { AgentModalTarget } from "../desktop-chat-message/types";
import { applySelectedTextQuoteToDraft } from "./message-format";
import {
  applyThreadQuoteToDraft,
  buildThreadIndicatorSummary,
  scrollThreadMessageIntoView,
  threadQuotePreview,
  threadReadState,
} from "./thread-utils";
import type { ThreadIndicatorSummary } from "./thread-utils";

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
const selectedQuoteText = ref<string | null>(null);
const textareaElement = ref<HTMLTextAreaElement | null>(null);
const panelElement = ref<HTMLElement | null>(null);
const bodyElement = ref<HTMLElement | null>(null);
const mentionQuery = ref<string | null>(null);
const activeMentionIndex = ref(0);
const emptyThreadSummary: ThreadIndicatorSummary = {
  count: 0,
  unreadCount: 0,
  latest: null,
  latestPreview: null,
  latestTimestamp: null,
  participants: [],
  hasPartialHistory: false,
  loadingEarlier: false,
};

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
const threadMessageReferenceIds = computed(() =>
  new Set([props.parent.id, ...props.replies.map((reply) => reply.id)])
);
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
  return roomMentionCandidates(props.participants, mentionQuery.value);
});

watch(
  () => props.parent.id,
  async () => {
    draft.value = "";
    quoteTarget.value = null;
    selectedQuoteText.value = null;
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

function quoteInThread(message: DesktopRoomMessage): void {
  quoteTarget.value = message;
  selectedQuoteText.value = null;
  void nextTick(() => textareaElement.value?.focus());
}

function quoteSelectionInThread(message: DesktopRoomMessage, text: string): void {
  quoteTarget.value = message;
  selectedQuoteText.value = text;
  void nextTick(() => textareaElement.value?.focus());
}

function clearThreadQuote(): void {
  quoteTarget.value = null;
  selectedQuoteText.value = null;
}

function scrollActiveSearchMessage(): boolean {
  const messageId = props.activeSearchMessageId;
  if (!messageId || (messageId !== props.parent.id && !props.replies.some((reply) => reply.id === messageId))) {
    return false;
  }
  const target = scrollThreadMessageIntoView(panelElement.value, messageId);
  return Boolean(target);
}

function jumpToThreadMessageReference(messageId: string): void {
  const target = scrollThreadMessageIntoView(panelElement.value, messageId, "smooth");
  if (!target) return;
  target.classList.add("jump-target");
  window.setTimeout(() => target.classList.remove("jump-target"), 1500);
}

function navigateThreadMessageReference(messageId: string | null): void {
  if (!messageId) return;
  const isInThread = messageId === props.parent.id || props.replies.some((reply) => reply.id === messageId);
  if (isInThread) {
    jumpToThreadMessageReference(messageId);
    return;
  }
  emit("jump-message", messageId);
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
    selectedQuoteText.value
      ? applySelectedTextQuoteToDraft(text, selectedQuoteText.value, quoteTarget.value?.id)
      : applyThreadQuoteToDraft(text, quoteTarget.value),
    props.parent.id,
    quoteTarget.value?.id || props.parent.id,
    props.attachmentDrafts.map((attachment) => ({ upload_id: attachment.uploadId })),
  );
  draft.value = "";
  quoteTarget.value = null;
  selectedQuoteText.value = null;
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
    if (candidate) insertMention(candidate.insertText);
    return;
  }
  if (event.metaKey || event.ctrlKey || event.shiftKey) {
    insertNewlineAtCursor();
    return;
  }
  submitThreadReply();
}

function handleDraftInput(): void {
  const match = /(^|\s)@([A-Za-z0-9._:-]*(?:\/[A-Za-z0-9._-]*)*)$/.exec(draft.value);
  mentionQuery.value = match ? match[2] : null;
  activeMentionIndex.value = 0;
}

function handleMentionArrow(event: KeyboardEvent, delta: number): void {
  if (!mentionOpen.value) return;
  event.preventDefault();
  activeMentionIndex.value = (activeMentionIndex.value + delta + mentionCandidates.value.length) % mentionCandidates.value.length;
}

function closeMentionForTab(): void {
  if (mentionOpen.value) mentionQuery.value = null;
}

function insertMention(mentionText: string): void {
  draft.value = draft.value.replace(/(^|\s)@([A-Za-z0-9._:-]*(?:\/[A-Za-z0-9._-]*)*)$/, `$1@${mentionText} `);
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
