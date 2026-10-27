<template>
  <form class="composer" :class="{ 'inline-thread-composer': inlineThread }" @submit.prevent="handleSend">
    <PresenceChips v-if="!inlineThread" :chips="presenceChips" />
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
      <div class="composer-scroll-content">
        <ReplyDraft
          v-if="replyTo"
          :display-name="replyDisplayName"
          :preview-text="replyPreviewText"
          @clear="emit('clearReply')"
        />
        <div class="composer-typing-input">
          <textarea
            ref="textareaEl"
            class="message-textarea"
            :placeholder="inlineThread ? 'Reply in thread…' : 'Write a message…'"
            :aria-label="inlineThread ? 'Reply in thread' : 'Write a message'"
            v-model="text"
            role="combobox"
            aria-autocomplete="list"
            :aria-expanded="suggestionsOpen"
            :aria-controls="`${composerId}-mention-listbox`"
            :aria-activedescendant="suggestionsOpen ? `${composerId}-mention-option-${suggestions[suggestionIndex]?.key}` : undefined"
            @input="handleTypingInput"
            @click="syncMentionContext"
            @select="syncMentionContext"
            @keydown="handleKeyDown"
            @keyup="handleKeyUp"
            rows="1"
          />
        </div>
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
      </div>
      <div class="composer-toolbar">
        <div ref="menuEl" class="composer-add-wrap">
          <input
            ref="fileInputEl"
            class="attachment-input"
            type="file"
            multiple
            @change="handleFileSelection"
          >
          <button
            ref="addTriggerEl"
            class="composer-add-btn"
            type="button"
            :disabled="addMenuDisabled"
            :aria-label="autoKeepPolling ? 'Add to message, auto read and poll enabled' : 'Add to message'"
            :title="autoKeepPolling ? 'Add to message · auto read and poll enabled' : 'Add to message'"
            aria-haspopup="menu"
            :aria-expanded="menuOpen"
            :aria-controls="menuOpen ? `${composerId}-add-menu` : undefined"
            :data-prompts-active="autoKeepPolling"
            @click="toggleAddMenu"
            @keydown="handleAddTriggerKey"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
          </button>
          <div
            v-if="menuOpen"
            :id="`${composerId}-add-menu`"
            ref="addMenuEl"
            class="composer-add-menu"
            :data-animate="animateAddMenu || undefined"
            role="menu"
            aria-label="Add to message"
            @keydown="handleAddMenuKey"
          >
            <button
              class="composer-menu-item"
              type="button"
              role="menuitem"
              tabindex="-1"
              :disabled="!canAttach"
              @click="chooseAttachment"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21.4 11.6-9.2 9.2a6 6 0 0 1-8.5-8.5L13.6 2.4a4 4 0 0 1 5.7 5.7l-9.9 9.9a2 2 0 0 1-2.8-2.8l9.2-9.2"/></svg>
              <span class="composer-menu-copy">
                <span>Attach files…</span>
                <span v-if="!attachmentsAvailable" class="composer-menu-meta">Attachments are unavailable</span>
                <span v-else-if="attachmentDrafts.length >= MAX_ATTACHMENTS" class="composer-menu-meta">Up to {{ MAX_ATTACHMENTS }} attachments per message</span>
              </span>
            </button>
            <template v-if="!inlineThread">
              <div class="composer-menu-separator" role="separator"></div>
              <div class="composer-menu-heading">Agent prompts</div>
              <button
                class="composer-menu-item"
                type="button"
                role="menuitemcheckbox"
                tabindex="-1"
                :aria-checked="autoKeepPolling"
                @click="toggleAutoKeepPolling"
              >
                <span class="composer-menu-copy">
                  <span>Auto read + poll</span>
                  <span class="composer-menu-meta">Keep agents polling this room with quiet reminders every 20 seconds.</span>
                </span>
                <span class="composer-menu-check" aria-hidden="true">{{ autoKeepPolling ? '✓' : '' }}</span>
              </button>
            </template>
          </div>
        </div>
        <div class="composer-toolbar-context">
          <div v-if="!inlineThread" class="composer-identity">
            <span class="composer-sender-label" :title="`Sending as ${senderName}`" :aria-label="`Sending as ${senderName}`">{{ senderName }}</span>
            <button v-if="!isSignedIn" class="composer-signin-btn" type="button" @click="emit('signIn')">Sign in</button>
          </div>
          <span v-if="attachmentDrafts.length" class="attachment-count" :aria-label="`${attachmentDrafts.length} of ${MAX_ATTACHMENTS} attachments`">{{ attachmentDrafts.length }} / {{ MAX_ATTACHMENTS }}</span>
        </div>
        <button
          class="send-btn"
          type="submit"
          :disabled="!canSend"
          :aria-busy="isSending || slash.busy.value"
          :aria-label="isSending || slash.busy.value ? 'Sending…' : inlineThread ? 'Send reply' : 'Send message'"
          title="Send · Enter (Shift+Enter for a new line)"
        >
          <svg v-if="isSending || slash.busy.value" class="composer-send-spinner" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 1-9 9"/></svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 7-7 7 7M12 5v14"/></svg>
        </button>
      </div>
    </div>
    <MentionPanel
      v-if="suggestionsOpen"
      :id-prefix="composerId"
      :candidates="suggestions"
      :active-index="suggestionIndex"
      :aria-label="slash.open.value ? 'Command suggestions' : 'Mention suggestions'"
      :hint="slash.hint.value"
      @select="selectSuggestion"
    />
  </form>
</template>

<script setup lang="ts">
import { injectRoomMessageMotion } from "../../../../../shared/ui/useRoomMessageMotion";
import { useComposerSlashCommands } from '../../../../../shared/ui/useComposerSlashCommands'
import { useToast } from '@/composables/useToast'
import { useRoomTyping } from '@/composables/roomTyping'
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import {
  type OutgoingMessageAttachment,
  type RoomAgentPresence,
  type RoomMessage,
  type RoomParticipant,
  parseAgentIdentity,
  getReplyPreviewText,
} from '@/composables/useRoom'
import { buildMentionCandidates } from './reachability'
import { attentionResponseAgentNames, messageDisplayText } from './chat-message/formatting'
import AttachmentTray from './composer/AttachmentTray.vue'
import MentionPanel from './composer/MentionPanel.vue'
import ReplyDraft from './composer/ReplyDraft.vue'
import { MAX_ATTACHMENTS } from './composer/types'
import { useComposerAttachments } from './composer/useComposerAttachments'
import { useComposerMentions } from './composer/useComposerMentions'
import { useComposerPrompts } from './composer/useComposerPrompts'
import PresenceChips from './composer/PresenceChips.vue'
import { usePresenceChips } from './composer/usePresenceChips'

const props = withDefaults(defineProps<{
  inlineThread?: boolean
  threadRootId?: string
  senderName?: string
  disabled?: boolean
  isSignedIn?: boolean
  attachmentsEnabled?: boolean
  roomIdentifier?: string
  createTask?: (title: string) => Promise<boolean>
  openSearch?: (query: string) => boolean
  submitMessage?: (text: string, agentPromptKind: string | null, replyTo: string | null, attachments?: OutgoingMessageAttachment[]) => Promise<boolean>
  stageAttachmentDraft?: (roomIdentifier: string, attachment: OutgoingMessageAttachment, signal?: AbortSignal) => Promise<{ upload_id: string }>
  discardAttachmentDraft?: (roomIdentifier: string, uploadId: string) => Promise<void>
  replyTo?: RoomMessage | null
  messages?: readonly RoomMessage[]
  presence?: readonly RoomAgentPresence[]
  presenceReady?: boolean
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
  presenceReady: false,
  participants: () => [],
})

const emit = defineEmits<{
  send: [text: string, agentPromptKind: string | null, replyTo: string | null, attachments?: OutgoingMessageAttachment[]]
  clearReply: []
  signIn: []
}>()

const composerId = computed(() => props.inlineThread ? `thread-${props.threadRootId}` : 'composer')
const text = ref('')
const textareaEl = ref<HTMLTextAreaElement | null>(null)
const isSending = ref(false)

const roomIdentifierRef = computed(() => props.roomIdentifier)
const typing = useRoomTyping(roomIdentifierRef)
watch(text, value => {
  if (!value) {
    typing.stop()
    resetMentionContext()
  }
})
function handleTypingInput() {
  typing.input(Boolean(text.value.trim()) && !slash.open.value)
  syncMentionContext()
}
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
  toggleAutoKeepPolling,
} = useComposerPrompts({
  enabled: computed(() => !props.inlineThread),
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

const addTriggerEl = ref<HTMLButtonElement | null>(null)
const addMenuEl = ref<HTMLDivElement | null>(null)
const animateAddMenu = ref(false)
const canAttach = computed(() => !props.disabled && !isSending.value && attachmentsAvailable.value && attachmentDrafts.value.length < MAX_ATTACHMENTS)
const addMenuDisabled = computed(() => props.disabled || isSending.value || (props.inlineThread && !canAttach.value))

function enabledAddItems() {
  return Array.from(addMenuEl.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
}

function focusAddItem(item: HTMLButtonElement | undefined) {
  if (!item) return
  item.focus({ preventScroll: true })
  const menu = addMenuEl.value
  if (!menu) return
  // Items are direct children of the positioned menu. Reveal the focused row
  // inside its own scroll area without moving the transcript or page.
  const top = item.offsetTop
  const bottom = top + item.offsetHeight
  if (top < menu.scrollTop || item.offsetHeight > menu.clientHeight) menu.scrollTop = top
  else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight
}

function openAddMenu(byPointer = false, focusLast = false) {
  if (addMenuDisabled.value) return
  animateAddMenu.value = byPointer && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  menuOpen.value = true
  void nextTick(() => {
    const items = enabledAddItems()
    focusAddItem(items[focusLast ? items.length - 1 : 0])
  })
}

function closeAddMenu(restoreFocus = false) {
  menuOpen.value = false
  if (restoreFocus) addTriggerEl.value?.focus({ preventScroll: true })
}

function toggleAddMenu(event: MouseEvent) {
  if (menuOpen.value) closeAddMenu()
  else openAddMenu(event.detail !== 0)
}

function handleAddTriggerKey(event: KeyboardEvent) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  event.preventDefault()
  openAddMenu(false, event.key === 'ArrowUp')
}

function handleAddMenuKey(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeAddMenu(true)
    return
  }
  if (event.key === 'Tab') {
    // Resume the composer's natural tab order from the trigger after removal.
    closeAddMenu(true)
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const items = enabledAddItems()
  const current = items.indexOf(document.activeElement as HTMLButtonElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
    : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
  focusAddItem(items[next])
}

function chooseAttachment() {
  if (!canAttach.value) return
  closeAddMenu(true)
  openFilePicker()
}

watch(() => props.roomIdentifier, () => closeAddMenu())
watch(addMenuDisabled, disabled => { if (disabled) closeAddMenu() })

const replyDisplayName = computed(() => {
  const reply = props.replyTo
  if (!reply?.sender) return 'unknown'
  return parseAgentIdentity(reply.sender).displayName || reply.sender
})

const replyPreviewText = computed(() => getReplyPreviewText(props.replyTo && {
  ...props.replyTo,
  display_text: messageDisplayText(props.replyTo, attentionResponseAgentNames([...props.participants, ...props.presence])),
}))

const { chips: presenceChips } = usePresenceChips({
  presence: () => props.presence,
  scope: () => props.roomIdentifier,
  ready: () => props.presenceReady,
})

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

const toast = useToast()
const slash = useComposerSlashCommands({
  text,
  platform: 'web',
  scope: () => props.roomIdentifier,
  hasAttachments: () => attachmentDrafts.value.length > 0,
  isReply: () => Boolean(props.replyTo || props.inlineThread),
  focus: () => { void nextTick(() => textareaEl.value?.focus({ preventScroll: props.inlineThread })) },
  onError: () => toast.error('Command could not be completed. Your draft is still here.'),
  run: async (command, argument) => {
    if (command.name === 'task') {
      if (!props.createTask || !await props.createTask(argument)) throw new Error('Task creation failed')
      toast.success('Task created')
    } else if (command.name === 'search') {
      if (!props.openSearch?.(argument)) throw new Error('Search is unavailable')
    }
    return true
  },
})
const suggestionsOpen = computed(() => !menuOpen.value && (slash.open.value || mentionMenuOpen.value))
const suggestions = computed(() => slash.open.value ? slash.candidates.value : filteredMentionCandidates.value)
const suggestionIndex = computed(() => slash.open.value ? slash.activeIndex.value : mentionActiveIndex.value)
function selectSuggestion(candidate: { key: string }) {
  if (slash.open.value) slash.complete(slash.candidates.value.findIndex(item => item.key === candidate.key))
  else {
    const mention = filteredMentionCandidates.value.find(item => item.key === candidate.key)
    if (mention) selectMention(mention)
  }
}

const canSend = computed(() =>
  !props.disabled
  && !isSending.value
  && !slash.busy.value
  && !hasUploadingAttachments.value
  && !hasFailedAttachments.value
  && (text.value.trim().length > 0 || attachmentDrafts.value.length > 0)
)

async function handleSend() {
  if (!canSend.value) return
  await slash.submit(sendRoomMessage)
}

const messageMotion = injectRoomMessageMotion()

async function sendRoomMessage() {
  const submittedText = text.value
  const submittedRoom = props.roomIdentifier
  const trimmed = submittedText.trim()
  if (!canSend.value) return
  if (!attachmentsAvailable.value && attachmentDrafts.value.length > 0) {
    attachmentError.value = 'Attachments are unavailable right now.'
    clearAttachments({ discardUploads: true })
    return
  }

  const finishMotion = props.inlineThread ? undefined : messageMotion?.capture(trimmed, textareaEl.value)
  isSending.value = true
  try {
    const sent = await submitComposerMessage(trimmed, null, props.replyTo?.id || null, buildOutgoingAttachments())
    if (!sent || props.roomIdentifier !== submittedRoom) return

    typing.stop()
    if (text.value === submittedText) text.value = ''
    clearAttachments()
    attachmentError.value = ''
    resetMentionContext()
    if (textareaEl.value) {
      textareaEl.value.style.height = 'auto'
    }
  } finally {
    await nextTick()
    finishMotion?.()
    isSending.value = false
  }
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.isComposing) return
  if (slash.handleKey(e)) {
    resetMentionContext()
    return
  }
  if (!slash.open.value && mentionMenuOpen.value) {
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
  // Opening a room on a phone should leave the transcript visible until the
  // user chooses to write. Explicit reply actions still focus the composer.
  if (!props.inlineThread && window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) {
    textareaEl.value?.focus({ preventScroll: true })
  }
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
    textareaEl.value?.focus({ preventScroll: props.inlineThread })
  }
})
</script>

<style scoped src="./composer/Composer.css"></style>
