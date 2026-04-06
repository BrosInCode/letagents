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
      <span class="composer-sender-label">
        Sending as <strong>{{ senderName }}</strong>
      </span>
      <span class="composer-shortcut-hint">⏎ to send · ⇧⏎ new line</span>
    </div>
    <div class="composer-card">
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
        @keydown="handleKeyDown"
        rows="1"
      />
      <div class="composer-toolbar">
        <button class="send-btn" type="submit" :disabled="!text.trim()" aria-label="Send message">
          <svg viewBox="0 0 24 24"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg>
        </button>
      </div>
    </div>
  </form>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { type RoomMessage, parseAgentIdentity, getReplyPreviewText } from '@/composables/useRoom'

const KEEP_POLLING_INTERVAL_MS = 20_000
const PREFS_KEY = 'lac-prompt-prefs'

const props = withDefaults(defineProps<{
  senderName?: string
  disabled?: boolean
  roomIdentifier?: string
  replyTo?: RoomMessage | null
}>(), {
  senderName: 'anonymous',
  disabled: false,
  roomIdentifier: '',
  replyTo: null,
})

const emit = defineEmits<{
  send: [text: string, agentPromptKind: string | null, replyTo: string | null]
  clearReply: []
}>()

const text = ref('')
const textareaEl = ref<HTMLTextAreaElement | null>(null)
const menuEl = ref<HTMLDivElement | null>(null)
const menuOpen = ref(false)
const autoKeepPolling = ref(false)
const injectPrompt = ref(false)

let keepPollingTimer: ReturnType<typeof setInterval> | null = null
let keepPollingInFlight = false

const replyDisplayName = computed(() => {
  const reply = props.replyTo
  if (!reply?.sender) return 'unknown'
  return parseAgentIdentity(reply.sender).displayName || reply.sender
})

const replyPreviewText = computed(() => getReplyPreviewText(props.replyTo))

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

// ── Auto-poll loop ──
async function sendAutoPollingPrompt() {
  if (!props.roomIdentifier || keepPollingInFlight) return
  keepPollingInFlight = true
  try {
    emit('send', '', 'auto', null)
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

// ── Send ──
function handleSend() {
  const trimmed = text.value.trim()
  if (!trimmed || props.disabled) return

  // Determine agent_prompt_kind for this message
  const kind = injectPrompt.value ? 'inline' : null
  emit('send', trimmed, kind, props.replyTo?.id || null)
  text.value = ''
  if (textareaEl.value) {
    textareaEl.value.style.height = 'auto'
  }
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    handleSend()
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
  document.removeEventListener('click', handleDocClick)
})

// Reload prefs + restart loop when room changes
watch(() => props.roomIdentifier, (newId) => {
  stopKeepPollingLoop()
  loadPrefs()
  if (newId && autoKeepPolling.value) {
    startKeepPollingLoop(false)
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
.composer-pills-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 4px 6px;
}
.composer-toolbar-pills {
  display: flex;
  align-items: center;
  gap: 6px;
}
.composer-toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 0 6px 6px;
}
.composer-toolbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.composer-sender-label {
  font-size: 0.72rem;
  color: var(--muted, #71717a);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.composer-sender-label strong {
  color: var(--text, #fafafa);
  font-weight: 600;
}
.composer-shortcut-hint {
  display: none;
  font-size: 0.66rem;
  color: var(--muted, #71717a);
  opacity: 0.5;
  white-space: nowrap;
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
</style>
