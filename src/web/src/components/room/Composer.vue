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
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import {
  type OutgoingMessageAttachment,
  type RoomAgentPresence,
  type RoomMessage,
  type RoomParticipant,
  parseAgentIdentity,
  getReplyPreviewText,
} from '@/composables/useRoom'

const KEEP_POLLING_INTERVAL_MS = 20_000
const PREFS_KEY = 'lac-prompt-prefs'
const MAX_ATTACHMENTS = 4
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

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
const fileInputEl = ref<HTMLInputElement | null>(null)
const menuEl = ref<HTMLDivElement | null>(null)
const menuOpen = ref(false)
const autoKeepPolling = ref(false)
const injectPrompt = ref(false)
const attachmentDrafts = ref<AttachmentDraft[]>([])
const attachmentError = ref('')
const isDragActive = ref(false)
const mentionQuery = ref('')
const mentionStart = ref(-1)
const mentionEnd = ref(-1)
const mentionActiveIndex = ref(0)
const isSending = ref(false)

let keepPollingTimer: ReturnType<typeof setInterval> | null = null
let keepPollingInFlight = false
let dragDepth = 0

interface AttachmentDraft {
  id: string
  name: string
  type: string
  size: number
  file: File
  uploadId: string | null
  uploadState: 'idle' | 'uploading' | 'uploaded' | 'error'
  uploadMessage: string
  abortController: AbortController | null
  previewUrl: string | null
  previewState: 'idle' | 'loading' | 'loaded' | 'error'
}

const replyDisplayName = computed(() => {
  const reply = props.replyTo
  if (!reply?.sender) return 'unknown'
  return parseAgentIdentity(reply.sender).displayName || reply.sender
})

const replyPreviewText = computed(() => getReplyPreviewText(props.replyTo))
const attachmentsAvailable = computed(() => props.attachmentsEnabled !== false)
const dropAttachmentsEnabled = computed(() => attachmentsAvailable.value && !props.disabled && !isSending.value)
const eagerUploadsEnabled = computed(() =>
  Boolean(props.stageAttachmentDraft && props.roomIdentifier && attachmentsAvailable.value)
)

interface MentionCandidate {
  key: string
  label: string
  mention: string
  meta: string
  search: string
  priority: number
}

const mentionCandidates = computed<MentionCandidate[]>(() => {
  const seen = new Set<string>()
  const candidates: MentionCandidate[] = []
  const visibleAgentActors = new Set(
    props.participants
      .filter((participant) => participant.kind === 'agent' && !participant.hidden_at)
      .map((participant) => String(participant.actor_label || '').trim())
      .filter(Boolean)
  )

  const pushCandidate = (
    rawMention: string,
    label: string,
    meta: string,
    priority: number,
    searchParts: Array<string | null | undefined>
  ) => {
    const mention = normalizeMentionToken(rawMention)
    if (!mention) return
    const key = mention.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({
      key,
      label: `@${mention}`,
      mention,
      meta,
      priority,
      search: [mention, label, meta, ...searchParts]
        .filter(Boolean)
        .join(' ')
        .toLowerCase(),
    })
  }

  for (const agent of props.presence) {
    const actorLabel = String(agent.actor_label || '').trim()
    if (agent.freshness !== 'active' && actorLabel && !visibleAgentActors.has(actorLabel)) {
      continue
    }

    const parsed = parseAgentIdentity(agent.actor_label)
    const label = agent.display_name || parsed.displayName || agent.actor_label
    const meta = [agent.owner_label, agent.ide_label].filter(Boolean).join(' · ') || 'Agent'
    pushCandidate(label, label, meta, agent.freshness === 'active' ? 0 : 1, [
      actorLabel,
      agent.owner_label,
      agent.ide_label,
      agent.status,
    ])
  }

  for (const participant of props.participants) {
    if (participant.hidden_at) continue

    if (participant.kind === 'agent') {
      const label = participant.display_name || parseAgentIdentity(participant.actor_label || '').displayName
      const meta = [participant.owner_label, participant.ide_label].filter(Boolean).join(' · ') || 'Agent'
      const isActive = props.presence.some((entry) => entry.actor_label === participant.actor_label && entry.freshness === 'active')
      pushCandidate(label, label, meta, isActive ? 0 : 1, [
        participant.actor_label,
        participant.owner_label,
        participant.ide_label,
        participant.agent_key,
      ])
      continue
    }

    const label = participant.display_name || participant.github_login || ''
    if (!label || label === props.senderName) continue
    pushCandidate(label, label, 'User', 2, [participant.github_login])
  }

  return candidates.sort((left, right) =>
    left.priority - right.priority || left.label.localeCompare(right.label)
  )
})

const filteredMentionCandidates = computed(() => {
  const query = mentionQuery.value.trim().toLowerCase()
  const filtered = mentionCandidates.value
    .filter((candidate) => !query || candidate.search.includes(query))

  // Guarantee humans (priority >= 2) are never pushed off by a flood of agents
  const agents = filtered.filter((c) => c.priority < 2)
  const humans = filtered.filter((c) => c.priority >= 2)
  const maxAgents = Math.max(0, 8 - humans.length)
  return [...agents.slice(0, maxAgents), ...humans].slice(0, 8)
})

const mentionMenuOpen = computed(() =>
  mentionStart.value >= 0 && filteredMentionCandidates.value.length > 0
)

// ── Prompt mode label ──
const promptMode = computed(() => {
  if (autoKeepPolling.value && injectPrompt.value) return 'auto+inject'
  if (autoKeepPolling.value) return 'auto'
  if (injectPrompt.value) return 'inject'
  return 'off'
})

const promptLabel = computed(() => {
  const labels: Record<string, string> = {
    off: 'Inject',
    auto: 'Auto poll',
    inject: 'Inject on',
    'auto+inject': 'Auto + inject',
  }
  return labels[promptMode.value] || 'Inject'
})

// ── Persistence ──
function prefsKey(): string {
  const room = props.roomIdentifier
  return room ? `lac-prompt-prefs:${room}` : PREFS_KEY
}

function persistPrefs() {
  try {
    localStorage.setItem(prefsKey(), JSON.stringify({
      autoKeepPolling: autoKeepPolling.value,
      injectPrompt: injectPrompt.value,
    }))
  } catch { /* silent */ }
}

function loadPrefs() {
  try {
    const raw = localStorage.getItem(prefsKey())
    if (!raw) return
    const saved = JSON.parse(raw)
    autoKeepPolling.value = Boolean(saved.autoKeepPolling)
    injectPrompt.value = Boolean(saved.injectPrompt)
  } catch {
    autoKeepPolling.value = false
    injectPrompt.value = false
  }
}

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

// ── Auto-poll loop ──
async function sendAutoPollingPrompt() {
  if (!props.roomIdentifier || keepPollingInFlight) return
  keepPollingInFlight = true
  try {
    await submitComposerMessage('', 'auto', null, [])
  } finally {
    keepPollingInFlight = false
  }
}

function startKeepPollingLoop(sendImmediately = true) {
  stopKeepPollingLoop()
  if (!autoKeepPolling.value || !props.roomIdentifier) return

  if (sendImmediately) {
    sendAutoPollingPrompt()
  }

  keepPollingTimer = setInterval(() => {
    sendAutoPollingPrompt()
  }, KEEP_POLLING_INTERVAL_MS)
}

function stopKeepPollingLoop() {
  if (keepPollingTimer) {
    clearInterval(keepPollingTimer)
    keepPollingTimer = null
  }
}

// ── Toggle handlers ──
function toggleAutoKeepPolling() {
  autoKeepPolling.value = !autoKeepPolling.value
  persistPrefs()

  if (autoKeepPolling.value) {
    startKeepPollingLoop()
  } else {
    stopKeepPollingLoop()
  }
}

function toggleInjectPrompt() {
  injectPrompt.value = !injectPrompt.value
  persistPrefs()
}

// ── Close menu on outside click ──
function handleDocClick(e: MouseEvent) {
  if (menuOpen.value && menuEl.value && !menuEl.value.contains(e.target as Node)) {
    menuOpen.value = false
  }
}

function normalizeMentionToken(value: string): string {
  return (value || '')
    .trim()
    .replace(/^@+/, '')
    .replace(/\s+/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '')
}

function resetMentionContext() {
  mentionQuery.value = ''
  mentionStart.value = -1
  mentionEnd.value = -1
  mentionActiveIndex.value = 0
}

function syncMentionContext() {
  const textarea = textareaEl.value
  if (!textarea) {
    resetMentionContext()
    return
  }

  const cursor = textarea.selectionStart ?? text.value.length
  const beforeCursor = text.value.slice(0, cursor)
  const match = beforeCursor.match(/(^|[\s(])@([A-Za-z0-9._-]*)$/)
  if (!match) {
    resetMentionContext()
    return
  }

  mentionQuery.value = (match[2] || '').toLowerCase()
  mentionStart.value = cursor - mentionQuery.value.length - 1
  mentionEnd.value = cursor
  mentionActiveIndex.value = 0
}

function moveMentionSelection(direction: number) {
  if (!filteredMentionCandidates.value.length) return
  const size = filteredMentionCandidates.value.length
  mentionActiveIndex.value = (mentionActiveIndex.value + direction + size) % size
}

function selectMention(candidate: MentionCandidate) {
  if (mentionStart.value < 0 || mentionEnd.value < 0) return

  const nextChar = text.value.slice(mentionEnd.value, mentionEnd.value + 1)
  const suffix = nextChar && /\s/.test(nextChar) ? '' : ' '
  const insertion = `@${candidate.mention}${suffix}`
  const newCursor = mentionStart.value + insertion.length

  text.value = `${text.value.slice(0, mentionStart.value)}${insertion}${text.value.slice(mentionEnd.value)}`
  resetMentionContext()

  nextTick(() => {
    textareaEl.value?.focus()
    textareaEl.value?.setSelectionRange(newCursor, newCursor)
  })
}

const hasUploadingAttachments = computed(() =>
  attachmentDrafts.value.some((attachment) => attachment.uploadState === 'uploading')
)

const hasFailedAttachments = computed(() =>
  eagerUploadsEnabled.value
    && attachmentDrafts.value.some((attachment) => attachment.uploadState === 'error')
)

const attachmentStatusSummary = computed(() => {
  if (hasUploadingAttachments.value) {
    const count = attachmentDrafts.value.filter((attachment) => attachment.uploadState === 'uploading').length
    return count === 1 ? 'Uploading 1 attachment...' : `Uploading ${count} attachments...`
  }
  if (hasFailedAttachments.value) {
    const count = attachmentDrafts.value.filter((attachment) => attachment.uploadState === 'error').length
    return count === 1
      ? 'Remove the failed attachment before sending.'
      : 'Remove the failed attachments before sending.'
  }
  return ''
})

const canSend = computed(() =>
  !props.disabled
  && !isSending.value
  && !hasUploadingAttachments.value
  && !hasFailedAttachments.value
  && (text.value.trim().length > 0 || attachmentDrafts.value.length > 0)
)

function updateAttachmentDraft(id: string, update: (draft: AttachmentDraft) => AttachmentDraft) {
  attachmentDrafts.value = attachmentDrafts.value.map((attachment) =>
    attachment.id === id ? update(attachment) : attachment
  )
}

function findAttachmentDraft(id: string): AttachmentDraft | undefined {
  return attachmentDrafts.value.find((attachment) => attachment.id === id)
}

function releaseAttachmentPreview(attachment: AttachmentDraft) {
  if (attachment.previewUrl) {
    URL.revokeObjectURL(attachment.previewUrl)
  }
}

function describeAttachmentUploadError(error: unknown, fileName: string): string {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return `${fileName} upload was cancelled.`
  }
  const message = error instanceof Error ? error.message.trim() : ''
  if (/attachment object storage is not configured/i.test(message)) {
    return 'Attachments are unavailable right now.'
  }
  return message || `${fileName} could not be uploaded.`
}

function attachmentSecondaryText(attachment: AttachmentDraft): string {
  const size = formatFileSize(attachment.size)
  if (attachment.uploadState === 'uploading') {
    return size ? `Uploading... · ${size}` : 'Uploading...'
  }
  if (attachment.uploadState === 'uploaded') {
    return size ? `Ready · ${size}` : 'Ready'
  }
  if (attachment.uploadState === 'error') {
    return size ? `Upload failed · ${size}` : 'Upload failed'
  }
  return size
}

function markAttachmentPreviewLoaded(id: string) {
  updateAttachmentDraft(id, (attachment) => ({
    ...attachment,
    previewState: 'loaded',
  }))
}

function markAttachmentPreviewError(id: string) {
  updateAttachmentDraft(id, (attachment) => ({
    ...attachment,
    previewState: 'error',
  }))
}

async function startAttachmentDraftUpload(id: string) {
  const attachment = findAttachmentDraft(id)
  if (!attachment || !props.stageAttachmentDraft || !props.roomIdentifier) return

  const abortController = new AbortController()
  updateAttachmentDraft(id, (draft) => ({
    ...draft,
    abortController,
    uploadState: 'uploading',
    uploadMessage: '',
  }))

  try {
    const staged = await props.stageAttachmentDraft(props.roomIdentifier, {
      file_name: attachment.name,
      mime_type: attachment.type,
      size_bytes: attachment.size,
      file: attachment.file,
    }, abortController.signal)

    if (!findAttachmentDraft(id)) return

    updateAttachmentDraft(id, (draft) => ({
      ...draft,
      uploadId: staged.upload_id,
      uploadState: 'uploaded',
      uploadMessage: '',
      abortController: null,
    }))
  } catch (error) {
    if (!findAttachmentDraft(id)) return
    if (abortController.signal.aborted) return

    const uploadMessage = describeAttachmentUploadError(error, attachment.name)
    updateAttachmentDraft(id, (draft) => ({
      ...draft,
      uploadState: 'error',
      uploadMessage,
      uploadId: null,
      abortController: null,
    }))
    attachmentError.value = uploadMessage
  }
}

async function discardUploadedAttachment(attachment: AttachmentDraft) {
  if (!props.discardAttachmentDraft || !props.roomIdentifier || !attachment.uploadId) return
  try {
    await props.discardAttachmentDraft(props.roomIdentifier, attachment.uploadId)
  } catch {
    attachmentError.value = `${attachment.name} could not be removed from draft storage.`
  }
}

function openFilePicker() {
  attachmentError.value = ''
  if (isSending.value) {
    attachmentError.value = 'Wait for the current send to finish.'
    return
  }
  if (!attachmentsAvailable.value) {
    attachmentError.value = 'Attachments are unavailable right now.'
    return
  }
  fileInputEl.value?.click()
}

async function handleFileSelection(event: Event) {
  const input = event.target as HTMLInputElement
  const selected = Array.from(input.files || [])
  input.value = ''
  if (!selected.length) return

  await addAttachmentFiles(selected)
}

async function addAttachmentFiles(selected: readonly File[]) {
  if (!selected.length) return

  attachmentError.value = ''
  if (props.disabled) {
    attachmentError.value = 'Attachments cannot be added right now.'
    return
  }
  if (isSending.value) {
    attachmentError.value = 'Wait for the current send to finish.'
    return
  }
  if (!attachmentsAvailable.value) {
    attachmentError.value = 'Attachments are unavailable right now.'
    return
  }
  const availableSlots = Math.max(0, MAX_ATTACHMENTS - attachmentDrafts.value.length)
  const acceptedFiles = selected.slice(0, availableSlots)
  if (selected.length > availableSlots) {
    attachmentError.value = `Attach up to ${MAX_ATTACHMENTS} files per message.`
  }

  for (const file of acceptedFiles) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      attachmentError.value = `${file.name} is larger than ${formatFileSize(MAX_ATTACHMENT_BYTES)}.`
      continue
    }
    try {
      const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null
      const id = `${file.name}-${file.size}-${file.lastModified}-${globalThis.crypto?.randomUUID?.() || Date.now()}`
      const draft: AttachmentDraft = {
        id,
        name: file.name,
        type: file.type || 'application/octet-stream',
        size: file.size,
        file,
        uploadId: null,
        uploadState: eagerUploadsEnabled.value ? 'uploading' : 'idle',
        uploadMessage: '',
        abortController: null,
        previewUrl,
        previewState: previewUrl ? 'loading' : 'idle',
      }
      attachmentDrafts.value = [
        ...attachmentDrafts.value,
        draft,
      ]
      if (eagerUploadsEnabled.value) {
        void startAttachmentDraftUpload(id)
      }
    } catch {
      attachmentError.value = `${file.name} could not be attached.`
    }
  }
}

function dragContainsFiles(event: DragEvent): boolean {
  const types = Array.from(event.dataTransfer?.types || [])
  return types.includes('Files')
}

function resetDragState() {
  dragDepth = 0
  isDragActive.value = false
}

function handleDragEnter(event: DragEvent) {
  if (!dragContainsFiles(event)) return
  event.preventDefault()
  if (!dropAttachmentsEnabled.value) return
  dragDepth += 1
  isDragActive.value = true
}

function handleDragOver(event: DragEvent) {
  if (!dragContainsFiles(event)) return
  event.preventDefault()
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = dropAttachmentsEnabled.value ? 'copy' : 'none'
  }
  if (!dropAttachmentsEnabled.value) {
    isDragActive.value = false
    return
  }
  isDragActive.value = true
}

function handleDragLeave(event: DragEvent) {
  if (!dragContainsFiles(event)) return
  if (!dropAttachmentsEnabled.value) return
  if (dragDepth > 0) {
    dragDepth -= 1
  }
  if (dragDepth === 0) {
    isDragActive.value = false
  }
}

async function handleDrop(event: DragEvent) {
  const dropped = Array.from(event.dataTransfer?.files || [])
  if (dropped.length) {
    event.preventDefault()
  }
  resetDragState()
  if (!dropped.length) return
  await addAttachmentFiles(dropped)
}

function removeAttachment(id: string) {
  if (isSending.value) return
  const attachment = findAttachmentDraft(id)
  if (!attachment) return

  attachment.abortController?.abort()
  releaseAttachmentPreview(attachment)
  attachmentDrafts.value = attachmentDrafts.value.filter((draft) => draft.id !== id)

  if (attachment.uploadId) {
    void discardUploadedAttachment(attachment)
  }
}

function clearAttachments(options: { discardUploads?: boolean } = {}) {
  const drafts = attachmentDrafts.value
  attachmentDrafts.value = []
  const shouldDiscardUploads = Boolean(options.discardUploads && !isSending.value)

  for (const attachment of drafts) {
    attachment.abortController?.abort()
    releaseAttachmentPreview(attachment)
    if (shouldDiscardUploads && attachment.uploadId) {
      void discardUploadedAttachment(attachment)
    }
  }
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = bytes
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  const precision = size >= 10 || unitIndex === 0 ? 0 : 1
  return `${size.toFixed(precision)} ${units[unitIndex]}`
}

function buildOutgoingAttachments(): OutgoingMessageAttachment[] {
  return attachmentDrafts.value.map((attachment) => ({
    file_name: attachment.name,
    mime_type: attachment.type,
    size_bytes: attachment.size,
    file: attachment.file,
    upload_id: attachment.uploadId,
  }))
}

// ── Send ──
async function handleSend() {
  const trimmed = text.value.trim()
  if (!canSend.value) return
  if (!attachmentsAvailable.value && attachmentDrafts.value.length > 0) {
    attachmentError.value = 'Attachments are unavailable right now.'
    clearAttachments({ discardUploads: true })
    return
  }

  // Determine agent_prompt_kind for this message
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

// ── Lifecycle ──
onMounted(() => {
  textareaEl.value?.focus()
  loadPrefs()
  document.addEventListener('click', handleDocClick)
  // Start auto-poll if it was persisted on
  if (autoKeepPolling.value && props.roomIdentifier) {
    startKeepPollingLoop(false)
  }
})

onUnmounted(() => {
  stopKeepPollingLoop()
  clearAttachments({ discardUploads: true })
  document.removeEventListener('click', handleDocClick)
})

// Reload prefs + restart loop when room changes
watch(() => props.roomIdentifier, (newId, oldId) => {
  if (oldId && newId !== oldId && attachmentDrafts.value.length > 0) {
    clearAttachments({ discardUploads: true })
    attachmentError.value = ''
  }
  stopKeepPollingLoop()
  loadPrefs()
  if (newId && autoKeepPolling.value) {
    startKeepPollingLoop(false)
  }
})

watch(() => props.replyTo, (newVal) => {
  if (newVal) {
    textareaEl.value?.focus()
  }
})

watch(filteredMentionCandidates, (candidates) => {
  if (mentionActiveIndex.value >= candidates.length) {
    mentionActiveIndex.value = 0
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
