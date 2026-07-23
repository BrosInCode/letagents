<template>
  <form class="desktop-composer" data-testid="desktop-composer" @submit.prevent="submitMessage">
    <div
      v-if="primaryPermissionApproval"
      class="desktop-composer-permission-tray"
      data-testid="desktop-composer-permission-tray"
      aria-live="polite"
    >
      <div class="desktop-composer-permission-main">
        <span class="desktop-composer-permission-dot" aria-hidden="true"></span>
        <div class="desktop-composer-permission-copy">
          <strong>{{ primaryPermissionApproval.displayName }} needs approval</strong>
          <span>
            {{ primaryPermissionApproval.title }}
            <template v-if="permissionOverflowCount > 0">
              / {{ permissionOverflowCount }} more waiting
            </template>
          </span>
        </div>
      </div>
      <p>
        <span>{{ primaryPermissionApproval.providerLabel }}</span>
        <span>{{ primaryPermissionApproval.toolName }}</span>
        <span v-if="primaryPermissionApproval.targetLabel">{{ primaryPermissionApproval.targetLabel }}</span>
      </p>
      <div class="desktop-composer-permission-actions">
        <button
          type="button"
          class="desktop-composer-permission-detail"
          @click="$emit('open-permission-detail', primaryPermissionApproval)"
        >
          Details
        </button>
        <button
          type="button"
          class="desktop-composer-permission-deny"
          :disabled="Boolean(resolvingPermissionIds[primaryPermissionApproval.id])"
          @click="$emit('resolve-permission', primaryPermissionApproval, 'deny')"
        >
          {{ resolvingPermissionIds[primaryPermissionApproval.id] === 'deny' ? "Denying..." : "Deny" }}
        </button>
        <button
          type="button"
          class="desktop-composer-permission-allow"
          :disabled="Boolean(resolvingPermissionIds[primaryPermissionApproval.id])"
          @click="$emit('resolve-permission', primaryPermissionApproval, 'allow')"
        >
          {{ resolvingPermissionIds[primaryPermissionApproval.id] === 'allow' ? "Allowing..." : "Allow" }}
        </button>
      </div>
    </div>
    <div v-if="permissionError" class="desktop-composer-permission-error" role="alert">
      {{ permissionError }}
    </div>
    <div v-if="replyTo" class="desktop-composer-reply" data-testid="desktop-composer-reply">
      <div>
        <strong>{{ replyHeading }}</strong>
        <span>{{ replyPreview(replyTo.text) }}</span>
      </div>
      <button type="button" @click="$emit('clear-reply')">Cancel</button>
    </div>
    <RoomComposerEventChips
      :event-previews="eventPreviews"
      @open-event-preview="openEventPreview"
      @dismiss-event-preview="emit('dismiss-event-preview', $event)"
    />
    <div class="desktop-composer-input-row">
      <button
        class="desktop-composer-add-agent"
        type="button"
        :disabled="roomLoading || !roomIdentifier"
        :title="roomIdentifier ? 'Add agent to room' : 'Choose a room before adding an agent'"
        :aria-label="roomIdentifier ? 'Add agent to room' : 'Choose a room before adding an agent'"
        data-testid="desktop-composer-add-agent"
        @click="$emit('open-add-agent')"
      >
        <Plus :size="18" aria-hidden="true" />
      </button>
      <textarea
        ref="textareaElement"
        v-model="draft"
        class="desktop-composer-input"
        rows="1"
        :aria-label="composerInputLabel"
        role="combobox"
        aria-autocomplete="list"
        :aria-expanded="mentionOpen"
        aria-controls="desktop-mention-listbox"
        :aria-activedescendant="mentionOpen ? `desktop-mention-option-${mentionCandidates[activeMentionIndex]?.participantKey}` : undefined"
        :disabled="roomLoading || !roomIdentifier"
        data-testid="desktop-composer-input"
        @input="handleDraftInput"
        @keydown.down="moveMentionSelection($event, 1)"
        @keydown.up="moveMentionSelection($event, -1)"
        @keydown.tab="closeMentionForTab"
        @keydown.enter="handleEnterKey"
        @keydown.escape="mentionOpen = false"
      />
      <button
        class="desktop-composer-attach"
        type="button"
        :disabled="roomLoading || sending || !roomIdentifier || attaching"
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
        :aria-label="sending ? 'Sending message' : 'Send message'"
        :title="sending ? 'Sending message' : 'Send message'"
        :disabled="roomLoading || sending || !canSend"
        data-testid="desktop-composer-send"
      >
        <LoaderCircle v-if="sending" :size="16" aria-hidden="true" />
        <ArrowUp v-else :size="17" aria-hidden="true" />
      </button>
    </div>
    <DesktopAttachmentDrafts
      :attachments="attachmentDrafts"
      :pending-attachments="pendingAttachmentDrafts"
      @remove="$emit('remove-attachment', $event)"
    />
    <div
      v-if="mentionOpen"
      id="desktop-mention-listbox"
      class="desktop-mention-panel"
      role="listbox"
      data-testid="desktop-mention-panel"
    >
      <button
        v-for="(candidate, index) in mentionCandidates"
        :key="candidate.participantKey"
        class="desktop-mention-option"
        :id="`desktop-mention-option-${candidate.participantKey}`"
        role="option"
        tabindex="-1"
        :aria-selected="index === activeMentionIndex"
        :data-active="index === activeMentionIndex"
        :data-testid="`desktop-mention-option-${candidate.participantKey}`"
        type="button"
        @click="insertMention(candidate.insertText)"
      >
        <span>{{ candidate.displayName }}</span>
        <small>{{ candidate.label }}</small>
      </button>
    </div>
    <div v-if="sendError || attachmentError" class="desktop-composer-footer">
      <p class="desktop-composer-error" data-testid="desktop-composer-error">
        {{ sendError || attachmentError }}
      </p>
    </div>
  </form>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ArrowUp, LoaderCircle, Plus } from "@lucide/vue";
import type {
  DesktopManagedAgentPermissionDecisionBehavior,
  DesktopParticipantSummary,
  DesktopStagedAttachment,
} from "../../../../../../electron/ipc-types";
import type { ManagedAgentPermissionApproval } from "../../../../domain/managed-agents";
import { roomMentionCandidates } from "../../../../domain/participants";
import DesktopAttachmentDrafts, { type PendingAttachmentDraft } from "../DesktopAttachmentDrafts.vue";
import RoomComposerEventChips, { type ComposerEventPreview } from "./RoomComposerEventChips.vue";
import { applySelectedTextQuoteToDraft, displaySender, replyPreview } from "./message-format";

export interface RoomComposerReplyTarget {
  id: string;
  sender: string;
  text: string;
  isSelection?: boolean;
  sourceMessageId?: string | null;
}

const props = defineProps<{
  attaching: boolean;
  attachmentDrafts: DesktopStagedAttachment[];
  attachmentError: string | null;
  eventPreviews: ComposerEventPreview[];
  initialDraft?: string;
  participants: DesktopParticipantSummary[];
  pendingAttachmentDrafts: PendingAttachmentDraft[];
  permissionApprovals: ManagedAgentPermissionApproval[];
  permissionError: string | null;
  replyTo: RoomComposerReplyTarget | null;
  resolvingPermissionIds: Record<string, DesktopManagedAgentPermissionDecisionBehavior>;
  roomIdentifier: string | null;
  roomLoading: boolean;
  sendError: string | null;
  sending: boolean;
}>();

const emit = defineEmits<{
  "clear-reply": [];
  "draft-change": [text: string];
  "pick-attachments": [];
  "open-add-agent": [];
  "open-permission-detail": [approval: ManagedAgentPermissionApproval];
  "remove-attachment": [uploadId: string];
  "resolve-permission": [
    approval: ManagedAgentPermissionApproval,
    behavior: DesktopManagedAgentPermissionDecisionBehavior,
  ];
  "send-message": [text: string, replyTo: string | null, attachments: Array<{ upload_id: string }>];
  "open-event-preview": [event: ComposerEventPreview];
  "dismiss-event-preview": [messageId: string];
}>();

const maxComposerInputHeight = 156;
const draft = ref(props.initialDraft || "");
const textareaElement = ref<HTMLTextAreaElement | null>(null);
const mentionQuery = ref<string | null>(null);
const activeMentionIndex = ref(0);

const canSend = computed(() =>
  Boolean(!props.roomLoading && props.roomIdentifier && (draft.value.trim() || props.attachmentDrafts.length > 0))
);
const primaryPermissionApproval = computed(() => props.permissionApprovals[0] ?? null);
const permissionOverflowCount = computed(() => Math.max(0, props.permissionApprovals.length - 1));
const composerInputLabel = computed(() => {
  if (props.roomLoading) return "Room messages are loading";
  return props.roomIdentifier ? "Message room" : "Choose a room before writing";
});
const replyHeading = computed(() => {
  const target = props.replyTo;
  if (!target) return "";
  const sender = displaySender(target.sender);
  return target.isSelection ? `Quoting selection from ${sender}` : `Replying to ${sender}`;
});
const mentionOpen = computed({
  get: () => mentionQuery.value !== null && mentionCandidates.value.length > 0,
  set: (value: boolean) => {
    if (!value) mentionQuery.value = null;
  },
});
const mentionCandidates = computed(() => {
  return roomMentionCandidates(props.participants, mentionQuery.value);
});

watch(
  () => props.roomIdentifier,
  () => {
    draft.value = props.initialDraft || "";
    emit("draft-change", draft.value);
    mentionQuery.value = null;
    void nextTick(syncTextareaHeight);
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

watch(
  draft,
  () => {
    void nextTick(syncTextareaHeight);
  },
  { flush: "post" },
);

onMounted(() => {
  void nextTick(syncTextareaHeight);
});

onBeforeUnmount(() => {
  emit("draft-change", draft.value);
});

function submitMessage(): void {
  const text = draft.value.trim();
  if (!text && props.attachmentDrafts.length === 0) return;
  const replyTarget = props.replyTo;
  const messageText = replyTarget?.isSelection
    ? applySelectedTextQuoteToDraft(text, replyTarget.text, replyTarget.sourceMessageId)
    : text;
  emit(
    "send-message",
    messageText,
    replyTarget?.isSelection ? null : replyTarget?.id || null,
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
    if (candidate) insertMention(candidate.insertText);
    return;
  }
  if (event.metaKey || event.ctrlKey || event.shiftKey) {
    insertNewlineAtCursor();
    return;
  }
  submitMessage();
}

function syncMentionQuery(): void {
  const match = /(^|\s)@([A-Za-z0-9._:-]*(?:\/[A-Za-z0-9._-]*)*)$/.exec(draft.value);
  mentionQuery.value = match ? match[2] : null;
  activeMentionIndex.value = 0;
}

function handleDraftInput(): void {
  syncDraftToShell();
  syncMentionQuery();
}

function moveMentionSelection(event: KeyboardEvent, delta: number): void {
  if (!mentionOpen.value) return;
  event.preventDefault();
  const count = mentionCandidates.value.length;
  if (!count) return;
  activeMentionIndex.value = (activeMentionIndex.value + delta + count) % count;
}

function closeMentionForTab(): void {
  if (mentionOpen.value) mentionQuery.value = null;
}

function insertMention(mentionText: string): void {
  draft.value = draft.value.replace(/(^|\s)@([A-Za-z0-9._:-]*(?:\/[A-Za-z0-9._-]*)*)$/, `$1@${mentionText} `);
  mentionQuery.value = null;
  syncDraftToShell();
  void nextTick(() => textareaElement.value?.focus());
}

/** Canonical entry point for non-composer surfaces such as the Agent Inspector. */
function focusWithMention(mentionText: string): void {
  const separator = draft.value && !/\s$/.test(draft.value) ? " " : "";
  draft.value = `${draft.value}${separator}@${mentionText} `;
  mentionQuery.value = null;
  syncDraftToShell();
  void nextTick(() => {
    syncTextareaHeight();
    const input = textareaElement.value;
    input?.focus();
    input?.setSelectionRange(draft.value.length, draft.value.length);
  });
}

function syncDraftToShell(): void {
  emit("draft-change", draft.value);
}

function syncTextareaHeight(): void {
  const input = textareaElement.value;
  if (!input) return;
  input.style.height = "auto";
  const nextHeight = Math.min(input.scrollHeight, maxComposerInputHeight);
  input.style.height = `${Math.max(nextHeight, 34)}px`;
  input.style.overflowY = input.scrollHeight > maxComposerInputHeight ? "auto" : "hidden";
}

function openEventPreview(event: ComposerEventPreview): void {
  emit("open-event-preview", event);
}

defineExpose({ focusWithMention });
</script>
