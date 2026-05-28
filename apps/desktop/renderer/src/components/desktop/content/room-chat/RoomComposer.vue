<template>
  <form class="desktop-composer" data-testid="desktop-composer" @submit.prevent="submitMessage">
    <div class="desktop-composer-identity">
      <span>{{ composerTargetLabel }}</span>
      <span class="desktop-composer-shortcut">{{ composerPresenceLabel }}</span>
    </div>
    <div v-if="replyTo" class="desktop-composer-reply" data-testid="desktop-composer-reply">
      <div>
        <strong>Replying to {{ displaySender(replyTo.sender) }}</strong>
        <span>{{ replyPreview(replyTo.text) }}</span>
      </div>
      <button type="button" @click="$emit('clear-reply')">Cancel</button>
    </div>
    <textarea
      ref="textareaElement"
      v-model="draft"
      class="desktop-composer-input"
      rows="3"
      :placeholder="roomIdentifier ? 'Write a message...' : 'Choose a room to start writing'"
      :disabled="!roomIdentifier"
      data-testid="desktop-composer-input"
      @input="handleDraftInput"
      @keydown.down.prevent="moveMentionSelection(1)"
      @keydown.up.prevent="moveMentionSelection(-1)"
      @keydown.enter="handleEnterKey"
      @keydown.escape="mentionOpen = false"
    />
    <DesktopAttachmentDrafts
      :attachments="attachmentDrafts"
      :pending-attachments="pendingAttachmentDrafts"
      @remove="$emit('remove-attachment', $event)"
    />
    <div v-if="mentionOpen" class="desktop-mention-panel" data-testid="desktop-mention-panel">
      <button
        v-for="(candidate, index) in mentionCandidates"
        :key="candidate.participantKey"
        class="desktop-mention-option"
        :data-active="index === activeMentionIndex"
        :data-testid="`desktop-mention-option-${candidate.participantKey}`"
        type="button"
        @click="insertMention(candidate.displayName)"
      >
        <span>{{ candidate.displayName }}</span>
        <small>{{ candidate.kind === 'agent' ? 'Agent' : 'Human' }}</small>
      </button>
    </div>
    <div class="desktop-composer-footer">
      <p v-if="sendError || attachmentError" class="desktop-composer-error" data-testid="desktop-composer-error">
        {{ sendError || attachmentError }}
      </p>
      <p v-else class="desktop-composer-hint">{{ composerHint }}</p>
      <button
        class="desktop-composer-attach"
        type="button"
        :disabled="sending || !roomIdentifier || attaching"
        :title="attaching ? 'Attaching' : 'Attach files'"
        :aria-label="attaching ? 'Attaching files' : 'Attach files'"
        data-testid="desktop-composer-attach"
        @click="$emit('pick-attachments')"
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="m21.4 11.6-8.5 8.5a6 6 0 0 1-8.5-8.5l8.8-8.8a4 4 0 1 1 5.7 5.7l-8.9 8.9a2 2 0 0 1-2.8-2.8l8.1-8.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span class="sr-only">{{ attaching ? "Attaching files" : "Attach files" }}</span>
      </button>
      <button
        class="desktop-composer-send"
        type="submit"
        :disabled="sending || !canSend"
        data-testid="desktop-composer-send"
      >
        {{ sending ? "Sending..." : "Send" }}
      </button>
    </div>
  </form>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type {
  DesktopParticipantSummary,
  DesktopRoomMessage,
  DesktopStagedAttachment,
} from "../../../../../../electron/ipc-types";
import DesktopAttachmentDrafts, { type PendingAttachmentDraft } from "../DesktopAttachmentDrafts.vue";
import { displaySender, replyPreview } from "./message-format";

const props = defineProps<{
  attaching: boolean;
  attachmentDrafts: DesktopStagedAttachment[];
  attachmentError: string | null;
  initialDraft?: string;
  participants: DesktopParticipantSummary[];
  pendingAttachmentDrafts: PendingAttachmentDraft[];
  replyTo: DesktopRoomMessage | null;
  roomIdentifier: string | null;
  sendError: string | null;
  sending: boolean;
}>();

const emit = defineEmits<{
  "clear-reply": [];
  "draft-change": [text: string];
  "pick-attachments": [];
  "remove-attachment": [uploadId: string];
  "send-message": [text: string, replyTo: string | null, attachments: Array<{ upload_id: string }>];
}>();

const draft = ref(props.initialDraft || "");
const textareaElement = ref<HTMLTextAreaElement | null>(null);
const mentionQuery = ref<string | null>(null);
const activeMentionIndex = ref(0);

const canSend = computed(() => Boolean(props.roomIdentifier && (draft.value.trim() || props.attachmentDrafts.length > 0)));
const reachableParticipantCount = computed(() =>
  props.participants.filter((participant) => participant.activityState !== "offline").length
);
const composerTargetLabel = computed(() => props.roomIdentifier ? "Message the room" : "No room selected");
const composerPresenceLabel = computed(() => {
  if (!props.roomIdentifier) return "Open a room before sending";
  if (reachableParticipantCount.value === 0) return "No reachable participants";
  if (reachableParticipantCount.value === 1) return "1 reachable participant";
  return `${reachableParticipantCount.value} reachable participants`;
});
const composerHint = computed(() =>
  props.roomIdentifier
    ? "Use @ to bring a person or agent into the thread."
    : "Select a room from the sidebar to enable chat."
);
const mentionOpen = computed({
  get: () => mentionQuery.value !== null && mentionCandidates.value.length > 0,
  set: (value: boolean) => {
    if (!value) mentionQuery.value = null;
  },
});
const mentionCandidates = computed(() => {
  const query = (mentionQuery.value || "").toLowerCase();
  return props.participants
    .filter((participant) => participant.activityState !== "offline")
    .filter((participant) => participant.displayName.toLowerCase().includes(query))
    .slice(0, 6);
});

watch(
  () => props.roomIdentifier,
  () => {
    draft.value = props.initialDraft || "";
    emit("draft-change", draft.value);
    mentionQuery.value = null;
  },
);

watch(
  () => props.replyTo,
  (message) => {
    if (message) {
      void nextTick(() => textareaElement.value?.focus());
    }
  },
);

onBeforeUnmount(() => {
  emit("draft-change", draft.value);
});

function submitMessage(): void {
  const text = draft.value.trim();
  if (!text && props.attachmentDrafts.length === 0) return;
  emit(
    "send-message",
    text,
    props.replyTo?.id || null,
    props.attachmentDrafts.map((attachment) => ({ upload_id: attachment.uploadId })),
  );
  draft.value = "";
  syncDraftToShell();
}

function insertNewlineAtCursor(): void {
  const input = textareaElement.value;
  if (!input) {
    draft.value = `${draft.value}\n`;
    syncDraftToShell();
    return;
  }
  const start = input.selectionStart ?? draft.value.length;
  const end = input.selectionEnd ?? draft.value.length;
  draft.value = `${draft.value.slice(0, start)}\n${draft.value.slice(end)}`;
  syncDraftToShell();
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
  submitMessage();
}

function syncMentionQuery(): void {
  const match = /(^|\s)@([A-Za-z0-9._-]*)$/.exec(draft.value);
  mentionQuery.value = match ? match[2] : null;
  activeMentionIndex.value = 0;
}

function handleDraftInput(): void {
  syncDraftToShell();
  syncMentionQuery();
}

function moveMentionSelection(delta: number): void {
  if (!mentionOpen.value) return;
  const count = mentionCandidates.value.length;
  if (!count) return;
  activeMentionIndex.value = (activeMentionIndex.value + delta + count) % count;
}

function insertMention(displayName: string): void {
  draft.value = draft.value.replace(/(^|\s)@([A-Za-z0-9._-]*)$/, `$1@${displayName} `);
  mentionQuery.value = null;
  syncDraftToShell();
  void nextTick(() => textareaElement.value?.focus());
}

function syncDraftToShell(): void {
  emit("draft-change", draft.value);
}
</script>
