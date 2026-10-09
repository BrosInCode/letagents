<template>
  <section
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
    <section ref="bodyElement" @scroll="handleScroll" @scrollend="finishMessageReveal" class="room-thread-body" tabindex="0" aria-label="Thread replies">
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
      <template v-for="reply in replies" :key="reply.clientMessageId || reply.id">
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
          :room-identifier="roomIdentifier"
          :message-reference-ids="threadMessageReferenceIds"
          :task-reference-ids="taskReferenceIds"
          :search-active="reply.id === activeSearchMessageId"
          :thread-message-id="reply.id"
          :test-id="`room-thread-reply-${reply.id}`"
          :delivery-receipts="deliveryReceiptsByMessage[reply.id] || []"
          :delivery-recovery-available="deliveryRecoveryAvailable"
          :continuation-repair-available="continuationRepairAvailable"
          :room-delivery-skip-available="roomDeliverySkipAvailable"
          :delivery-retry-keys="deliveryRetryKeys"
          :continuation-repair-keys="continuationRepairKeys"
          :room-delivery-skip-keys="roomDeliverySkipKeys"
          :provider-label="resolveProviderLabel(reply)"
          @quote-reply="quoteInThread(reply)"
          @message-info="(messageId, context) => $emit('message-info', messageId, context)"
          @quote-selection="(_messageId, text) => quoteSelectionInThread(reply, text)"
          @jump-to-thread-root="$emit('jump-message', parent.id)"
          @scroll-to-message="navigateThreadMessageReference"
          @open-image="$emit('open-image', $event)"
          @open-agent="$emit('open-agent', $event)"
          @open-github-event="$emit('open-github-event', $event)"
          @open-task="$emit('open-task', $event)"
          @retry-delivery="(agentId, sourceMessageId) => $emit('retry-delivery', agentId, sourceMessageId)"
          @restore-conversation="(agentId, sourceMessageId) => $emit('restore-conversation', agentId, sourceMessageId)"
          @skip-delivery="(agentId, sourceMessageId) => $emit('skip-delivery', agentId, sourceMessageId)"
        />
        <RoomContribution v-for="work in contributionsFor(reply.id)" :key="work.attemptId" :work="work" :participants="participants" :status="roomAgentWorkStatus ?? 'idle'" @open-workspace="$emit('open-agent', workspaceAgentTarget($event, participants))" />
      </template>

      <div v-if="!replies.length" class="room-thread-empty" data-testid="room-thread-empty">
        <MessageSquarePlus :size="18" aria-hidden="true" />
        <div>
          <span>No replies yet.</span>
        </div>
      </div>
      </div>
    </section>

    <button v-if="isScrolledUp" type="button" class="room-thread-latest" @click="scrollToLatest">Latest replies ↓</button>

    <form class="room-thread-composer" data-testid="room-thread-composer" @submit.prevent="submitThreadReply">
      <div v-if="quoteTarget" class="room-thread-quote-preview" data-testid="room-thread-quote-preview">
        <div>
          <strong>{{ selectedQuoteText ? "Quoting selection from" : "Quoting" }} {{ displayName(quoteTarget) }}</strong>
          <span>{{ selectedQuoteText || threadQuotePreview(quoteTarget, attentionResponseAgentNames) }}</span>
        </div>
        <button type="button" aria-label="Cancel quote" @click="clearThreadQuote">
          <X :size="14" aria-hidden="true" />
        </button>
      </div>
      <textarea
        ref="textareaElement"
        v-model="draft"
        rows="1"
        :disabled="!roomIdentifier"
        :placeholder="composerPlaceholder"
        :aria-label="composerPlaceholder"
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
          <button type="submit" :disabled="!canSend" :aria-label="sending ? 'Sending reply' : 'Send reply'" data-testid="room-thread-send">
            <ArrowUp :size="16" aria-hidden="true" />
          </button>
        </div>
      </div>
    </form>
  </section>
</template>

<script setup lang="ts">
import { useDesktopMessageDraft } from "../../../../domain/desktop-message-drafts";
import RoomContribution from "./RoomContribution.vue";
import { contributionChanges, workspaceAgentTarget } from "../../../../domain/room-contributions";
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { injectRoomMessageReactions } from "../../../../composables/useRoomMessageReactions";
import { injectRoomMessageLinkPreviews } from "../../../../composables/useRoomMessageLinkPreviews";
import { attentionResponseAgentNamesKey } from "../../../../domain/attention-response";
import { ArrowUp, MessageSquarePlus, Paperclip, X } from "@lucide/vue";
import type {
  DesktopAgentPresence,
  DesktopParticipantSummary,
  DesktopRoomMessage,
  DesktopRoomAgentDeliveryAttention,
  DesktopRoomAgentWork,
  DesktopRoomMessageThreadSummary,
  DesktopStagedAttachment,
  DesktopSupervisorManifestEntry,
} from "../../../../../../electron/ipc-types";
import { roomMentionCandidates } from "../../../../domain/participants";
import { createMessageProviderLabelResolver } from "../../../../domain/agent-provider";
import DesktopAttachmentDrafts, { type PendingAttachmentDraft } from "../DesktopAttachmentDrafts.vue";
import DesktopChatMessage from "../DesktopChatMessage.vue";
import { parseSenderIdentity } from "../desktop-chat-message/identity";
import type { AgentModalTarget } from "../desktop-chat-message/types";
import { applySelectedTextQuoteToDraft } from "./message-format";
import {
  applyThreadQuoteToDraft,
  scrollThreadMessageIntoView,
  threadQuotePreview,
  threadReadState,
} from "./thread-utils";
import type { ThreadIndicatorSummary } from "./thread-utils";

function contributionsFor(source: string) {
  return (props.roomAgentWork ?? []).filter(work => {
    const changes = contributionChanges(work);
    return work.sourceMessageId === source && changes;
  });
}
const props = defineProps<{
  roomAgentWork?: DesktopRoomAgentWork[];
  roomAgentWorkStatus?: string;
  parent: DesktopRoomMessage;
  active?: boolean;
  initialThreadSummary: DesktopRoomMessageThreadSummary | null;
  replies: DesktopRoomMessage[];
  participants: DesktopParticipantSummary[];
  presence?: DesktopAgentPresence[];
  supervisorEntries?: DesktopSupervisorManifestEntry[];
  roomIdentifier: string | null;
  messageNamespace?: string;
  sending: boolean;
  sendError: string | null;
  attaching: boolean;
  attachmentDrafts: DesktopStagedAttachment[];
  attachmentError: string | null;
  pendingAttachmentDrafts: PendingAttachmentDraft[];
  hasOlderReplies: boolean;
  loadingOlderReplies: boolean;
  revealMessageId?: string | null;
  initialScrollTop?: number | null;
  searchQuery: string;
  activeSearchMessageId: string | null;
  taskReferenceIds: ReadonlySet<string>;
  deliveryReceiptsByMessage: Record<string, Array<{ agentId: string; agentName: string; state: string; blockedByMessageId: string | null; error: string | null; failureCode: string | null; terminalReason: string | null; attemptCount: number; providerTurnId: string | null; retry?: DesktopRoomAgentDeliveryAttention["retry"] | null }> >;
  deliveryRecoveryAvailable?: boolean;
  continuationRepairAvailable?: boolean;
  roomDeliverySkipAvailable?: boolean;
  deliveryRetryKeys?: ReadonlySet<string>;
  continuationRepairKeys?: ReadonlySet<string>;
  roomDeliverySkipKeys?: ReadonlySet<string>;
}>();

const attentionResponseAgentNames = inject(attentionResponseAgentNamesKey, null);
const emit = defineEmits<{
  "message-info": [messageId: string, context: "timeline" | "thread-root" | "thread-reply"];
  close: [];
  "read-message": [messageId: string];
  "reading-latest": [reading: boolean];
  "scroll-position": [parentId: string, top: number, namespace: string];
  "open-image": [imageId: string];
  "send-thread-message": [text: string, threadRootId: string, replyToId: string | null, attachments: Array<{ upload_id: string }>, complete: (sent: boolean) => void];
  "open-github-event": [url: string];
  "open-agent": [target: AgentModalTarget];
  "open-task": [taskId: string];
  "jump-message": [messageId: string];
  "load-older-replies": [];
  "pick-attachments": [];
  "remove-attachment": [uploadId: string];
  "stage-dropped-attachments": [files: File[]];
  "retry-delivery": [agentId: string, sourceMessageId: string];
  "restore-conversation": [agentId: string, sourceMessageId: string];
  "skip-delivery": [agentId: string, sourceMessageId: string];
}>();

const resolveProviderLabel = computed(() => createMessageProviderLabelResolver(
  props.participants, props.presence, props.supervisorEntries,
));
const { text: draft, quote: quoteTarget, selectedQuoteText, captureSubmittedDraft } = useDesktopMessageDraft(
  () => props.messageNamespace || props.roomIdentifier, () => props.parent.id,
);
const textareaElement = ref<HTMLTextAreaElement | null>(null);
const panelElement = ref<HTMLElement | null>(null);
const bodyElement = ref<HTMLElement | null>(null);
const isScrolledUp = ref(false);
const mentionQuery = ref<string | null>(null);
let scrollRevision = 0;
let revealingMessage = false;
let revealFrame: number | null = null;
let revealTimer: number | null = null;

function cancelMessageRevealFrame(): void {
  if (revealFrame !== null) window.cancelAnimationFrame(revealFrame);
  revealFrame = null;
}

function handleScroll(): void {
  const body = bodyElement.value;
  isScrolledUp.value = Boolean(body && body.scrollHeight - body.scrollTop - body.clientHeight > 96);
  scrollRevision++;
  cancelMessageRevealFrame();
}

function scrollToLatest(): void {
  finishMessageReveal();
  const body = bodyElement.value;
  body?.scrollTo({ top: body.scrollHeight, behavior: "instant" });
  isScrolledUp.value = false;
}

function finishMessageReveal(): void {
  cancelMessageRevealFrame();
  if (revealTimer !== null) window.clearTimeout(revealTimer);
  revealFrame = revealTimer = null;
  revealingMessage = false;
}

function beginMessageReveal(): void {
  finishMessageReveal();
  const body = bodyElement.value;
  if (!body) return;
  const top = body.scrollTop;
  revealingMessage = true;
  // Smooth scrolling may start after the first frame. Any scroll event cancels this probe.
  revealFrame = window.requestAnimationFrame(() => {
    revealFrame = window.requestAnimationFrame(() => {
      revealFrame = null;
      if (bodyElement.value === body && body.scrollTop === top) finishMessageReveal();
    });
  });
  revealTimer = window.setTimeout(finishMessageReveal, 800);
}
onBeforeUnmount(() => {
  if (bodyElement.value) emit("scroll-position", props.parent.id, bodyElement.value.scrollTop, props.messageNamespace || props.roomIdentifier || "");
  finishMessageReveal();
});

// IntersectionObserver clips against both the reply scroller and the room viewport.
// Merely keeping a thread expanded is not evidence that its replies were read.
let readObserver: IntersectionObserver | null = null;
const visibleReplies = new Set<string>();
function reportVisibleReplies(): void {
  const visible = props.active !== false && document.visibilityState === "visible" && document.hasFocus();
  const readable = props.replies.filter(reply => !reply.outgoing && visibleReplies.has(reply.id));
  const latest = props.replies.filter(reply => !reply.outgoing).at(-1);
  emit("reading-latest", Boolean(visible && latest && visibleReplies.has(latest.id)));
  if (visible && readable.length) emit("read-message", readable.at(-1)!.id);
}
function observeReplies(): void {
  readObserver?.disconnect();
  visibleReplies.clear();
  emit("reading-latest", false);
  if (typeof IntersectionObserver === "undefined") return;
  readObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const id = (entry.target as HTMLElement).dataset.threadMessageId;
      if (!id) continue;
      if (entry.isIntersecting && entry.intersectionRect.height >= Math.min(80, entry.boundingClientRect.height)) visibleReplies.add(id);
      else visibleReplies.delete(id);
    }
    reportVisibleReplies();
  }, { threshold: Array.from({ length: 21 }, (_, index) => index / 20) });
  bodyElement.value?.querySelectorAll("[data-thread-message-id]").forEach(row => readObserver?.observe(row));
}
onMounted(() => {
  observeReplies();
  document.addEventListener("visibilitychange", reportVisibleReplies);
  window.addEventListener("focus", reportVisibleReplies);
  window.addEventListener("blur", reportVisibleReplies);
});
watch(() => [props.replies, props.active], () => void nextTick(observeReplies));
onBeforeUnmount(() => {
  readObserver?.disconnect();
  document.removeEventListener("visibilitychange", reportVisibleReplies);
  window.removeEventListener("focus", reportVisibleReplies);
  window.removeEventListener("blur", reportVisibleReplies);
  emit("reading-latest", false);
});

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

const readStateParent = computed(() =>
  props.initialThreadSummary ? { ...props.parent, thread: props.initialThreadSummary } : props.parent
);
const readState = computed(() => threadReadState(readStateParent.value, props.replies));
const threadMessageReferenceIds = computed(() =>
  new Set([props.parent.id, ...props.replies.map((reply) => reply.id)])
);
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
  [() => props.revealMessageId, () => props.parent.id, () => Boolean(props.revealMessageId && threadMessageReferenceIds.value.has(props.revealMessageId))],
  ([messageId]) => {
    if (!messageId) return;
    if (messageId !== props.parent.id && !props.replies.some((reply) => reply.id === messageId)) return;
    void nextTick(() => jumpToThreadMessageReference(messageId));
  },
  { flush: "post", immediate: true },
);

watch(
  () => props.parent.id,
  async () => {
    scrollRevision++;
    finishMessageReveal();
    mentionQuery.value = null;
    await nextTick();
    if (!props.activeSearchMessageId && !props.revealMessageId) {
      if (bodyElement.value) bodyElement.value.scrollTop = props.initialScrollTop ?? bodyElement.value.scrollHeight;
      handleScroll();
    }
  },
  { immediate: true },
);

watch(
  [() => props.activeSearchMessageId, () => props.parent.id, () => Boolean(props.activeSearchMessageId && threadMessageReferenceIds.value.has(props.activeSearchMessageId))],
  async () => {
    await nextTick();
    scrollActiveSearchMessage();
  },
  { immediate: true },
);

// One pre-layout snapshot covers replies, contributions, reactions and previews.
const messageReactions = injectRoomMessageReactions();
const messageLinkPreviews = injectRoomMessageLinkPreviews();
watch(
  [
    () => props.replies,
    () => [props.parent.id, ...props.replies.map(reply => reply.id)]
      .flatMap(source => contributionsFor(source).map(work => work.attemptId)).join('|'),
    () => messageReactions?.revision.value,
    () => messageLinkPreviews?.revision.value,
  ],
  async ([newReplies], [oldReplies]) => {
    const body = bodyElement.value;
    if (!body) return;
    const revision = scrollRevision;
    const previousScrollHeight = body.scrollHeight;
    const previousScrollTop = body.scrollTop;
    const wasNearBottom = !revealingMessage && body.scrollHeight - body.scrollTop - body.clientHeight < 96;
    const oldFirstId = oldReplies[0]?.id;
    const isPrepend = oldFirstId && newReplies.findIndex(reply => reply.id === oldFirstId) > 0;
    await nextTick();
    if (revision !== scrollRevision || body !== bodyElement.value || body.scrollTop !== previousScrollTop) return;
    if (isPrepend) {
      body.scrollTop = previousScrollTop + body.scrollHeight - previousScrollHeight;
    } else if (wasNearBottom) {
      body.scrollTop = body.scrollHeight;
    }
  },
);

function displayName(message: DesktopRoomMessage): string {
  return message.agentIdentity?.displayName || parseSenderIdentity(message).displayName;
}

function quoteInThread(message: DesktopRoomMessage): void {
  quoteTarget.value = message;
  selectedQuoteText.value = null;
  void nextTick(() => textareaElement.value?.focus({ preventScroll: true }));
}

function quoteSelectionInThread(message: DesktopRoomMessage, text: string): void {
  quoteTarget.value = message;
  selectedQuoteText.value = text;
  void nextTick(() => textareaElement.value?.focus({ preventScroll: true }));
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
  scrollRevision++;
  beginMessageReveal();
  const target = scrollThreadMessageIntoView(bodyElement.value, messageId);
  if (!target) finishMessageReveal();
  return Boolean(target);
}

function jumpToThreadMessageReference(messageId: string): void {
  scrollRevision++;
  beginMessageReveal();
  const target = scrollThreadMessageIntoView(bodyElement.value, messageId, "smooth");
  if (!target) { finishMessageReveal(); return; }
  target.classList.add("jump-target");
  window.setTimeout(() => target.classList.remove("jump-target"), 1500);
}

function navigateThreadMessageReference(messageId: string | null): void {
  if (!messageId) return;
  const isInThread = props.replies.some((reply) => reply.id === messageId);
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
  const clearSubmittedText = captureSubmittedDraft();
  const roomIdentifier = props.roomIdentifier;
  const parentId = props.parent.id;
  emit(
    "send-thread-message",
    selectedQuoteText.value
      ? applySelectedTextQuoteToDraft(text, selectedQuoteText.value, quoteTarget.value?.id)
      : applyThreadQuoteToDraft(text, quoteTarget.value),
    props.parent.id,
    quoteTarget.value?.id || props.parent.id,
    props.attachmentDrafts.map((attachment) => ({ upload_id: attachment.uploadId })),
    (sent) => {
      if (!sent) return;
      const cleared = clearSubmittedText();
      if (props.roomIdentifier !== roomIdentifier || props.parent.id !== parentId) return;
      if (cleared) mentionQuery.value = null;
      void nextTick(scrollToLatest);
      void nextTick(() => textareaElement.value?.focus({ preventScroll: true }));
    },
  );
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
  if (event.isComposing) return;
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
  void nextTick(() => textareaElement.value?.focus({ preventScroll: true }));
}

function handleComposerEscape(): void {
  if (mentionOpen.value) {
    mentionQuery.value = null;
    return;
  }
  emit("close");
}
</script>
