<template>
  <form class="composer" @submit.prevent="handleSend">
    <div class="composer-pills-row">
      <div class="composer-toolbar-pills">
        <!-- Prompt injection pill -->
        <div class="prompt-menu" ref="menuEl">
          <button
            class="prompt-trigger"
            type="button"
            :data-mode="promptMode"
            @click="menuOpen = !menuOpen"
          >
            <span>{{ promptLabel }}</span>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
          </button>
          <div v-if="menuOpen" class="prompt-panel">
            <div class="prompt-panel-header">
              <strong>Agent prompts</strong>
            </div>
            <button
              class="prompt-option"
              type="button"
              :data-active="autoKeepPolling"
              @click="toggleAutoKeepPolling"
            >
              <span class="prompt-option-copy">
                <span class="prompt-option-title">Auto read + poll</span>
                <span class="prompt-option-meta">Send quiet metadata-only reminders every 20s to keep agents polling this room.</span>
              </span>
              <span class="prompt-option-check">
                <template v-if="autoKeepPolling">✓</template>
              </span>
            </button>
            <button
              class="prompt-option"
              type="button"
              :data-active="injectPrompt"
              @click="toggleInjectPrompt"
            >
              <span class="prompt-option-copy">
                <span class="prompt-option-title">Attach room prompt</span>
                <span class="prompt-option-meta">Send the visible message normally and attach the stay-in-room agent prompt as hidden metadata.</span>
              </span>
              <span class="prompt-option-check">
                <template v-if="injectPrompt">✓</template>
              </span>
            </button>
            <p class="prompt-help">Prompts stay out of the transcript. Injected visible messages get a small badge; auto-poll reminders stay hidden.</p>
          </div>
        </div>
      </div>
      <div class="composer-identity">
        <span class="composer-sender-label">
          Sending as <strong>{{ senderName }}</strong>
        </span>
        <button
          v-if="!isSignedIn"
          class="composer-signin-btn"
          type="button"
          @click="emit('signIn')"
        >
          Sign in
        </button>
      </div>
      <span class="composer-shortcut-hint">⏎ to send · ⇧⏎ new line</span>
    </div>
    <div
      class="composer-card"
      :data-drag-active="isDragActive"
      @dragenter="handleDragEnter"
      @dragover="handleDragOver"
      @dragleave="handleDragLeave"
      @drop="handleDrop"
    >
      <div v-if="isDragActive && dropAttachmentsEnabled" class="composer-drop-hint">
        Drop files to attach
      </div>
      <div v-if="replyTo" class="reply-draft">
        <div class="reply-draft-copy">
          <strong>Replying to {{ replyDisplayName }}</strong>
          <span>{{ replyPreviewText }}</span>
        </div>
        <button class="reply-draft-clear" type="button" @click="emit('clearReply')">Cancel</button>
      </div>
      <textarea
        ref="textareaEl"
        class="message-textarea"
        placeholder="Write a message…"
        v-model="text"
        @input="syncMentionContext"
        @click="syncMentionContext"
        @select="syncMentionContext"
        @keydown="handleKeyDown"
        @keyup="handleKeyUp"
        rows="1"
      />
      <div v-if="attachmentDrafts.length || attachmentError || attachmentStatusSummary" class="attachment-tray">
        <div v-if="attachmentDrafts.length" class="attachment-list">
          <div
            v-for="attachment in attachmentDrafts"
            :key="attachment.id"
            class="attachment-chip"
            :data-upload-state="attachment.uploadState"
          >
            <div
              v-if="attachment.previewUrl"
              class="attachment-preview-shell"
              :data-preview-state="attachment.previewState"
            >
              <img
                class="attachment-preview"
                :src="attachment.previewUrl"
                alt=""
                @load="markAttachmentPreviewLoaded(attachment.id)"
                @error="markAttachmentPreviewError(attachment.id)"
              >
              <span v-if="attachment.previewState === 'loading'" class="attachment-preview-badge">
                Loading
              </span>
              <span v-else-if="attachment.previewState === 'error'" class="attachment-preview-badge error">
                Preview unavailable
              </span>
            </div>
            <span v-else class="attachment-file-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" fill="none">
                <path d="M4 2.5h5l3 3v8H4v-11Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
                <path d="M9 2.5v3h3" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
              </svg>
            </span>
            <span class="attachment-chip-copy">
              <strong>{{ attachment.name }}</strong>
              <span>{{ attachment.uploadMessage || attachmentSecondaryText(attachment) }}</span>
            </span>
            <button
              class="attachment-remove"
              type="button"
              :disabled="isSending"
              :aria-label="`Remove ${attachment.name}`"
              @click="removeAttachment(attachment.id)"
            >
              {{ attachment.uploadState === 'uploading' ? 'Cancel' : 'Remove' }}
            </button>
          </div>
        </div>
        <p v-if="attachmentStatusSummary" class="attachment-status">{{ attachmentStatusSummary }}</p>
        <p v-if="attachmentError" class="attachment-error">{{ attachmentError }}</p>
      </div>
      <div v-if="mentionMenuOpen" class="composer-mention-panel" role="listbox" aria-label="Mention suggestions">
        <button
          v-for="(candidate, index) in filteredMentionCandidates"
          :key="candidate.key"
          class="composer-mention-option"
          type="button"
          :data-active="index === mentionActiveIndex"
          :aria-selected="index === mentionActiveIndex"
          @mousedown.prevent="selectMention(candidate)"
        >
          <span class="composer-mention-copy">
            <strong>{{ candidate.label }}</strong>
            <span>{{ candidate.meta }}</span>
          </span>
        </button>
      </div>
      <div class="composer-toolbar">
        <div class="composer-toolbar-left">
          <input
            ref="fileInputEl"
            class="attachment-input"
            type="file"
            multiple
            @change="handleFileSelection"
          >
          <button
            class="attachment-btn"
            type="button"
            :disabled="disabled || isSending || !attachmentsAvailable || attachmentDrafts.length >= MAX_ATTACHMENTS"
            @click="openFilePicker"
          >
            Attach
          </button>
          <span v-if="!attachmentsAvailable" class="attachment-count">
            Unavailable
          </span>
          <span v-if="attachmentDrafts.length" class="attachment-count">
            {{ attachmentDrafts.length }} / {{ MAX_ATTACHMENTS }}
          </span>
        </div>
        <button class="send-btn" type="submit" :disabled="!canSend" aria-label="Send message">
          <svg viewBox="0 0 24 24"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg>
        </button>
      </div>
    </div>
  </form>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import {
  type OutgoingMessageAttachment,
  type RoomAgentPresence,
  type RoomMessage,
  type RoomParticipant,
  parseAgentIdentity,
  getReplyPreviewText,
} from '@/composables/useRoom'
import { buildMentionCandidates } from './reachability'
import { MAX_ATTACHMENTS } from './composer/types'
import { useComposerAttachments } from './composer/useComposerAttachments'
import { useComposerMentions } from './composer/useComposerMentions'
import { useComposerPrompts } from './composer/useComposerPrompts'

const props = withDefaults(defineProps<{
  senderName?: string
  disabled?: boolean
  isSignedIn?: boolean
  attachmentsEnabled?: boolean
  roomIdentifier?: string
  submitMessage?: (text: string, agentPromptKind: string | null, replyTo: string | null, attachments?: OutgoingMessageAttachment[]) => Promise<boolean>
  stageAttachmentDraft?: (roomIdentifier: string, attachment: OutgoingMessageAttachment, signal?: AbortSignal) => Promise<{ upload_id: string }>
  discardAttachmentDraft?: (roomIdentifier: string, uploadId: string) => Promise<void>
  replyTo?: RoomMessage | null
  messages?: readonly RoomMessage[]
  presence?: readonly RoomAgentPresence[]
  participants?: readonly RoomParticipant[]
  refreshReachability?: () => Promise<unknown> | unknown
}>(), {
  senderName: 'anonymous',
  disabled: false,
  isSignedIn: false,
  attachmentsEnabled: true,
  roomIdentifier: '',
  replyTo: null,
  messages: () => [],
  presence: () => [],
  participants: () => [],
})

const emit = defineEmits<{
  send: [text: string, agentPromptKind: string | null, replyTo: string | null, attachments?: OutgoingMessageAttachment[]]
  clearReply: []
  signIn: []
}>()

const text = ref('')
const textareaEl = ref<HTMLTextAreaElement | null>(null)
const isSending = ref(false)

const roomIdentifierRef = computed(() => props.roomIdentifier)
const disabledRef = computed(() => props.disabled)
const attachmentsAvailable = computed(() => props.attachmentsEnabled !== false)

async function submitComposerMessage(
  bodyText: string,
  agentPromptKind: string | null,
  replyTo: string | null,
  attachments: OutgoingMessageAttachment[]
): Promise<boolean> {
  if (props.submitMessage) {
    return props.submitMessage(bodyText, agentPromptKind, replyTo, attachments)
  }
  emit('send', bodyText, agentPromptKind, replyTo, attachments)
  return true
}

const {
  menuEl,
  menuOpen,
  autoKeepPolling,
  injectPrompt,
  promptMode,
  promptLabel,
  toggleAutoKeepPolling,
  toggleInjectPrompt,
} = useComposerPrompts({
  roomIdentifier: roomIdentifierRef,
  submitComposerMessage,
})

const {
  fileInputEl,
  attachmentDrafts,
  attachmentError,
  isDragActive,
  dropAttachmentsEnabled,
  hasUploadingAttachments,
  hasFailedAttachments,
  attachmentStatusSummary,
  attachmentSecondaryText,
  markAttachmentPreviewLoaded,
  markAttachmentPreviewError,
  openFilePicker,
  handleFileSelection,
  handleDragEnter,
  handleDragOver,
  handleDragLeave,
  handleDrop,
  removeAttachment,
  clearAttachments,
  buildOutgoingAttachments,
} = useComposerAttachments({
  disabled: disabledRef,
  isSending,
  attachmentsAvailable,
  roomIdentifier: roomIdentifierRef,
  stageAttachmentDraft: computed(() => props.stageAttachmentDraft),
  discardAttachmentDraft: computed(() => props.discardAttachmentDraft),
})

const replyDisplayName = computed(() => {
  const reply = props.replyTo
  if (!reply?.sender) return 'unknown'
  return parseAgentIdentity(reply.sender).displayName || reply.sender
})

const replyPreviewText = computed(() => getReplyPreviewText(props.replyTo))

const mentionCandidates = computed(() => {
  return buildMentionCandidates({
    participants: props.participants,
    presence: props.presence,
    senderName: props.senderName,
  })
})

const {
  filteredMentionCandidates,
  mentionMenuOpen,
  mentionActiveIndex,
  resetMentionContext,
  syncMentionContext,
  moveMentionSelection,
  selectMention,
} = useComposerMentions({
  text,
  textareaEl,
  mentionCandidates,
  refreshReachability: computed(() => props.refreshReachability),
})

const canSend = computed(() =>
  !props.disabled
  && !isSending.value
  && !hasUploadingAttachments.value
  && !hasFailedAttachments.value
  && (text.value.trim().length > 0 || attachmentDrafts.value.length > 0)
)

async function handleSend() {
  const trimmed = text.value.trim()
  if (!canSend.value) return
  if (!attachmentsAvailable.value && attachmentDrafts.value.length > 0) {
    attachmentError.value = 'Attachments are unavailable right now.'
    clearAttachments({ discardUploads: true })
    return
  }

  const kind = injectPrompt.value ? 'inline' : null
  isSending.value = true
  try {
    const sent = await submitComposerMessage(trimmed, kind, props.replyTo?.id || null, buildOutgoingAttachments())
    if (!sent) return

    text.value = ''
    clearAttachments()
    attachmentError.value = ''
    resetMentionContext()
    if (textareaEl.value) {
      textareaEl.value.style.height = 'auto'
    }
  } finally {
    isSending.value = false
  }
}

function handleKeyDown(e: KeyboardEvent) {
  if (mentionMenuOpen.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveMentionSelection(1)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveMentionSelection(-1)
      return
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && filteredMentionCandidates.value.length > 0) {
      e.preventDefault()
      selectMention(filteredMentionCandidates.value[mentionActiveIndex.value])
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      resetMentionContext()
      return
    }
  }

  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    void handleSend()
  }
}

function handleKeyUp(e: KeyboardEvent) {
  if (mentionMenuOpen.value && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    return
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
    syncMentionContext()
  }
}

onMounted(() => {
  textareaEl.value?.focus()
})

onUnmounted(() => {
  clearAttachments({ discardUploads: true })
})

watch(() => props.roomIdentifier, (newId, oldId) => {
  if (oldId && newId !== oldId && attachmentDrafts.value.length > 0) {
    clearAttachments({ discardUploads: true })
    attachmentError.value = ''
  }
})

watch(() => props.replyTo, (newVal) => {
  if (newVal) {
    textareaEl.value?.focus()
  }
})
</script>

<style scoped>
.composer {
  display: flex;
  flex-direction: column;
  padding: 16px 24px 20px;
}
.composer-card {
  position: relative;
  display: flex;
  flex-direction: column;
  background: var(--bg-1, #0f0f11);
  border: 1px solid var(--line, #27272a);
  border-radius: 16px;
  transition: border-color 200ms ease, box-shadow 200ms ease;
  overflow: hidden;
}
.composer-card[data-drag-active="true"] {
  border-color: color-mix(in srgb, var(--line-strong, #3f3f46) 45%, #7dd3fc 55%);
  box-shadow: 0 0 0 1px color-mix(in srgb, #7dd3fc 65%, transparent),
    0 14px 32px rgba(0, 0, 0, 0.28);
}
.composer-drop-hint {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: color-mix(in srgb, var(--bg-1, #0f0f11) 82%, #7dd3fc 18%);
  color: var(--text, #fafafa);
  font-size: 0.8rem;
  font-weight: 650;
  letter-spacing: 0;
  pointer-events: none;
}
.reply-draft {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px 8px;
  border-bottom: 1px solid var(--border, #27272a);
  background: color-mix(in srgb, var(--surface, #18181b) 72%, transparent);
}
.reply-draft-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.reply-draft-copy strong {
  font-size: 0.74rem;
  color: var(--text, #fafafa);
}
.reply-draft-copy span {
  font-size: 0.78rem;
  color: var(--muted, #a1a1aa);
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
}
.reply-draft-clear {
  border: none;
  background: transparent;
  color: var(--muted, #71717a);
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
  padding: 0;
}
.reply-draft-clear:hover {
  color: var(--text, #fafafa);
}
.composer-card:focus-within {
  border-color: var(--line-strong, #3f3f46);
  box-shadow: 0 0 0 3px rgba(250,250,250,0.04), 0 8px 32px rgba(0,0,0,0.24);
}
.message-textarea {
  width: 100%;
  min-height: 56px;
  max-height: 180px;
  resize: none;
  overflow-y: auto;
  padding: 16px 18px 8px;
  background: none;
  border: none;
  outline: none;
  font-size: 0.92rem;
  line-height: 1.55;
  color: var(--text, #fafafa);
  font-family: inherit;
}
.message-textarea::placeholder {
  color: var(--muted, #71717a);
  opacity: 0.6;
}
.composer-mention-panel {
  display: grid;
  gap: 4px;
  padding: 0 8px 8px;
}
.composer-mention-option {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding: 10px 12px;
  border: 1px solid transparent;
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface, #18181b) 82%, transparent);
  color: inherit;
  cursor: pointer;
  text-align: left;
  transition: border-color 150ms ease, background 150ms ease;
  font-family: inherit;
}
.composer-mention-option[data-active="true"],
.composer-mention-option:hover {
  border-color: color-mix(in srgb, var(--line-strong, #3f3f46) 75%, #7dd3fc 25%);
  background: color-mix(in srgb, var(--surface, #18181b) 92%, #7dd3fc 8%);
}
.composer-mention-copy {
  display: grid;
  gap: 3px;
}
.composer-mention-copy strong {
  font-size: 0.8rem;
  color: var(--text, #fafafa);
}
.composer-mention-copy span {
  font-size: 0.72rem;
  color: var(--muted, #71717a);
}
.attachment-tray {
  display: grid;
  gap: 6px;
  padding: 0 8px 8px;
}
.attachment-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.attachment-chip {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  max-width: min(100%, 360px);
  padding: 6px;
  border: 1px solid var(--line, #27272a);
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface, #18181b) 88%, var(--text, #fafafa) 5%);
}
.attachment-chip[data-upload-state="uploading"] {
  border-color: color-mix(in srgb, #7dd3fc 30%, var(--line, #27272a));
}
.attachment-chip[data-upload-state="error"] {
  border-color: color-mix(in srgb, #fca5a5 55%, var(--line, #27272a));
}
.attachment-chip[data-upload-state="uploaded"] {
  border-color: color-mix(in srgb, #34d399 38%, var(--line, #27272a));
}
.attachment-preview-shell,
.attachment-file-icon {
  width: 36px;
  height: 36px;
  border-radius: 6px;
  border: 1px solid var(--line, #27272a);
  background: var(--bg-0, #09090b);
  flex-shrink: 0;
}
.attachment-preview-shell {
  position: relative;
  overflow: hidden;
}
.attachment-preview-shell[data-preview-state="loading"]::after,
.attachment-preview-shell[data-preview-state="error"]::after {
  content: '';
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--bg-0, #09090b) 74%, transparent);
}
.attachment-preview {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.attachment-preview-badge {
  position: absolute;
  inset-inline: 3px;
  bottom: 3px;
  z-index: 1;
  display: inline-flex;
  justify-content: center;
  padding: 1px 4px;
  border-radius: 4px;
  background: rgba(15, 23, 42, 0.88);
  color: var(--text, #fafafa);
  font-size: 0.58rem;
  font-weight: 650;
  white-space: nowrap;
}
.attachment-preview-badge.error {
  background: rgba(127, 29, 29, 0.9);
}
.attachment-file-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--muted, #a1a1aa);
}
.attachment-file-icon svg {
  width: 18px;
  height: 18px;
}
.attachment-chip-copy {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.attachment-chip-copy strong,
.attachment-chip-copy span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.attachment-chip-copy strong {
  font-size: 0.76rem;
  color: var(--text, #fafafa);
}
.attachment-chip-copy span,
.attachment-count,
.attachment-status,
.attachment-error {
  font-size: 0.68rem;
  color: var(--muted, #71717a);
}
.attachment-status,
.attachment-error {
  margin: 0;
}
.attachment-status {
  color: var(--muted, #a1a1aa);
}
.attachment-error {
  color: #fca5a5;
}
.attachment-remove,
.attachment-btn {
  border: 1px solid var(--line, #27272a);
  border-radius: 8px;
  background: transparent;
  color: var(--text, #fafafa);
  font: inherit;
  font-size: 0.7rem;
  font-weight: 650;
  cursor: pointer;
  transition: background 150ms ease, border-color 150ms ease, opacity 150ms ease;
}
.attachment-remove {
  padding: 5px 8px;
}
.attachment-btn {
  height: 30px;
  padding: 0 10px;
}
.attachment-remove:hover:not(:disabled),
.attachment-btn:hover:not(:disabled) {
  border-color: var(--line-strong, #3f3f46);
  background: rgba(255, 255, 255, 0.08);
}
.attachment-remove:disabled,
.attachment-btn:disabled {
  cursor: default;
  opacity: 0.45;
}
.attachment-input {
  display: none;
}
.composer-pills-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 4px 6px;
}
.composer-toolbar-pills {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.composer-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 6px 6px;
}
.composer-toolbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.composer-identity {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.composer-sender-label {
  font-size: 0.72rem;
  color: var(--muted, #71717a);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.composer-sender-label strong {
  color: var(--text, #fafafa);
  font-weight: 600;
}
.composer-signin-btn {
  flex-shrink: 0;
  height: 24px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid var(--line, #27272a);
  background: color-mix(in srgb, var(--surface, #18181b) 88%, var(--text, #fafafa) 12%);
  color: var(--text, #fafafa);
  font: inherit;
  font-size: 0.72rem;
  font-weight: 650;
  cursor: pointer;
  transition: background 150ms ease, border-color 150ms ease;
}
.composer-signin-btn:hover {
  border-color: var(--line-strong, #3f3f46);
  background: color-mix(in srgb, var(--surface, #18181b) 76%, var(--text, #fafafa) 24%);
}
.composer-shortcut-hint {
  display: none;
  font-size: 0.66rem;
  color: var(--muted, #71717a);
  opacity: 0.5;
  white-space: nowrap;
  flex-shrink: 0;
}
@media (min-width: 641px) {
  .composer-shortcut-hint { display: inline; }
}
.send-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: var(--text, #fafafa);
  color: var(--bg-0, #09090b);
  border: none;
  cursor: pointer;
  transition: opacity 180ms ease, transform 180ms ease;
}
.send-btn:hover:not(:disabled) { transform: scale(1.06); }
.send-btn:active:not(:disabled) { transform: scale(0.96); }
.send-btn:disabled { opacity: 0.2; cursor: default; }
.send-btn svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* ── Prompt menu ── */
.prompt-menu {
  position: relative;
  display: inline-flex;
}
.prompt-trigger {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  border: none;
  background: rgba(255, 255, 255, 0.08);
  color: var(--text, #fafafa);
  font-size: 0.68rem;
  font-weight: 500;
  cursor: pointer;
  transition: background 150ms ease;
  white-space: nowrap;
}
.prompt-trigger:hover { background: rgba(255, 255, 255, 0.14); }
.prompt-trigger svg {
  width: 10px; height: 10px;
  fill: none; stroke: currentColor;
  stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round;
  flex-shrink: 0; opacity: 0.6;
}
.prompt-trigger[data-mode="auto"] { background: rgba(245, 158, 11, 0.18); color: #fbbf24; }
.prompt-trigger[data-mode="inject"] { background: rgba(56, 189, 248, 0.18); color: #7dd3fc; }
.prompt-trigger[data-mode="auto+inject"] { background: rgba(52, 211, 153, 0.18); color: #6ee7b7; }

/* Panel */
.prompt-panel {
  position: absolute;
  left: 0;
  bottom: calc(100% + 6px);
  width: 260px;
  padding: 6px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: var(--bg-card, #161616);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.44);
  z-index: 20;
  animation: panel-in 120ms ease forwards;
}
@keyframes panel-in {
  from { opacity: 0; transform: translateY(4px) scale(0.97); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.prompt-panel-header {
  padding: 6px 10px 4px;
}
.prompt-panel-header strong {
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--muted, #71717a);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.prompt-option {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  border: none;
  background: transparent;
  cursor: pointer;
  transition: background 120ms ease;
  text-align: left;
  color: inherit;
  font-family: inherit;
}
.prompt-option + .prompt-option { margin-top: 2px; }
.prompt-option:hover { background: rgba(255, 255, 255, 0.08); }
.prompt-option[data-active="true"] { background: rgba(255, 255, 255, 0.06); }
.prompt-option-copy {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  min-width: 0;
}
.prompt-option-title {
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--text, #fafafa);
}
.prompt-option-meta {
  font-size: 0.66rem;
  color: var(--muted, #71717a);
  line-height: 1.3;
}
.prompt-option-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px; height: 18px;
  border-radius: 4px;
  flex-shrink: 0;
  font-size: 0.82rem;
  font-weight: 700;
  color: #34d399;
}
.prompt-help {
  padding: 4px 10px 2px;
  font-size: 0.62rem;
  line-height: 1.35;
  color: var(--muted, #71717a);
  opacity: 0.7;
}

@media (max-width: 768px) {
  .composer { padding: 8px 12px 12px; }
  .composer-card { border-radius: 12px; }
  .message-textarea { padding: 12px 14px 6px; font-size: 0.88rem; min-height: 44px; max-height: 120px; }
  .composer-pills-row { padding: 0 2px 4px; }
  .composer-toolbar { padding: 0 4px 4px; }
  .attachment-tray { padding: 0 6px 6px; }
  .attachment-chip { max-width: 100%; }
  .composer-mention-panel { padding: 0 6px 6px; }
  .composer-mention-option { padding: 8px 10px; }
  .prompt-panel { width: 220px; }
  .send-btn { width: 34px; height: 34px; }
  .reply-draft { padding: 8px 10px 6px; }
}
</style>
