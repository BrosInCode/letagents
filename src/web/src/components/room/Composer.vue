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
      <ReplyDraft
        v-if="replyTo"
        :display-name="replyDisplayName"
        :preview-text="replyPreviewText"
        @clear="emit('clearReply')"
      />
      <textarea
        ref="textareaEl"
        class="message-textarea"
        placeholder="Write a message…"
        v-model="text"
        role="combobox"
        aria-autocomplete="list"
        :aria-expanded="mentionMenuOpen"
        aria-controls="composer-mention-listbox"
        :aria-activedescendant="mentionMenuOpen ? `composer-mention-option-${filteredMentionCandidates[mentionActiveIndex]?.key}` : undefined"
        @input="syncMentionContext"
        @click="syncMentionContext"
        @select="syncMentionContext"
        @keydown="handleKeyDown"
        @keyup="handleKeyUp"
        rows="1"
      />
      <AttachmentTray
        v-if="attachmentDrafts.length || attachmentError || attachmentStatusSummary"
        :attachments="attachmentDrafts"
        :attachment-error="attachmentError"
        :attachment-status-summary="attachmentStatusSummary"
        :is-sending="isSending"
        :attachment-secondary-text="attachmentSecondaryText"
        @preview-loaded="markAttachmentPreviewLoaded"
        @preview-error="markAttachmentPreviewError"
        @remove="removeAttachment"
      />
      <MentionPanel
        v-if="mentionMenuOpen"
        :candidates="filteredMentionCandidates"
        :active-index="mentionActiveIndex"
        @select="selectMention"
      />
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
import AttachmentTray from './composer/AttachmentTray.vue'
import MentionPanel from './composer/MentionPanel.vue'
import ReplyDraft from './composer/ReplyDraft.vue'
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
    if (e.key === 'Enter' && filteredMentionCandidates.value.length > 0) {
      e.preventDefault()
      selectMention(filteredMentionCandidates.value[mentionActiveIndex.value])
      return
    }
    if (e.key === 'Tab') {
      resetMentionContext()
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

<style scoped src="./composer/Composer.css"></style>
