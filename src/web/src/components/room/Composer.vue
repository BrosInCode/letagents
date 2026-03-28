<template>
  <form class="composer" @submit.prevent="handleSend">
    <div class="composer-card">
      <div class="composer-glow" />
      <textarea
        ref="textareaEl"
        class="message-textarea"
        placeholder="Write a message…"
        v-model="text"
        :disabled="disabled"
        @keydown="handleKeyDown"
        rows="1"
      />
      <div class="composer-toolbar">
        <div class="composer-toolbar-left">
          <span class="composer-sender-label">
            Sending as <strong>{{ senderName }}</strong>
          </span>
          <span class="composer-shortcut-hint">⏎ to send · ⇧⏎ new line</span>
        </div>
        <div class="keep-polling-controls">
          <label class="keep-polling-pill" :class="{ active: autoKeepPolling, disabled }">
            <input
              class="keep-polling-input"
              type="checkbox"
              :checked="autoKeepPolling"
              :disabled="disabled"
              @change="handleAutoKeepPollingToggle"
            />
            <span class="keep-polling-copy">
              <strong>Auto nudge</strong>
              <small>send `keep polling` every {{ keepPollingIntervalSeconds }}s</small>
            </span>
            <span class="keep-polling-state">{{ autoKeepPolling ? 'On' : 'Off' }}</span>
          </label>
          <label class="keep-polling-pill" :class="{ active: injectKeepPolling, disabled }">
            <input
              class="keep-polling-input"
              type="checkbox"
              :checked="injectKeepPolling"
              :disabled="disabled"
              @change="handleInjectKeepPollingToggle"
            />
            <span class="keep-polling-copy">
              <strong>Inject on send</strong>
              <small>append `keep polling` to each message</small>
            </span>
            <span class="keep-polling-state">{{ injectKeepPolling ? 'On' : 'Off' }}</span>
          </label>
        </div>
        <button class="send-btn" type="submit" :disabled="!text.trim() || disabled" aria-label="Send message">
          <svg viewBox="0 0 24 24"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg>
        </button>
      </div>
    </div>
  </form>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'

const props = withDefaults(defineProps<{
  senderName?: string
  disabled?: boolean
  autoKeepPolling?: boolean
  keepPollingIntervalSeconds?: number
  injectKeepPolling?: boolean
}>(), {
  senderName: 'anonymous',
  disabled: false,
  autoKeepPolling: false,
  keepPollingIntervalSeconds: 20,
  injectKeepPolling: false,
})

const emit = defineEmits<{
  send: [text: string]
  'update:autoKeepPolling': [enabled: boolean]
  'update:injectKeepPolling': [enabled: boolean]
}>()

const text = ref('')
const textareaEl = ref<HTMLTextAreaElement | null>(null)

function handleSend() {
  const trimmed = text.value.trim()
  if (!trimmed || props.disabled) return
  emit('send', trimmed)
  text.value = ''
  if (textareaEl.value) {
    textareaEl.value.style.height = 'auto'
  }
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSend()
  }
}

function handleAutoKeepPollingToggle(e: Event) {
  const target = e.target as HTMLInputElement | null
  emit('update:autoKeepPolling', !!target?.checked)
}

function handleInjectKeepPollingToggle(e: Event) {
  const target = e.target as HTMLInputElement | null
  emit('update:injectKeepPolling', !!target?.checked)
}

onMounted(() => {
  textareaEl.value?.focus()
})
</script>

<style scoped>
.composer {
  display: flex;
  flex-direction: column;
  padding: 18px 20px 20px;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.02), rgba(255, 255, 255, 0.01)),
    rgba(12, 12, 14, 0.78);
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}
.composer-card {
  position: relative;
  display: flex;
  flex-direction: column;
  background:
    linear-gradient(180deg, rgba(36, 36, 38, 0.92), rgba(24, 24, 26, 0.96));
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 30px;
  transition: border-color 200ms ease, box-shadow 200ms ease, transform 200ms ease;
  overflow: hidden;
  box-shadow:
    0 24px 56px rgba(0, 0, 0, 0.34),
    inset 0 1px 0 rgba(255, 255, 255, 0.05);
}
.composer-card:focus-within {
  border-color: rgba(255, 255, 255, 0.14);
  box-shadow:
    0 0 0 3px rgba(250,250,250,0.04),
    0 24px 64px rgba(0,0,0,0.42),
    inset 0 1px 0 rgba(255,255,255,0.08);
  transform: translateY(-1px);
}
.composer-glow {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(circle at top left, rgba(255, 255, 255, 0.1), transparent 34%),
    linear-gradient(180deg, rgba(255,255,255,0.04), transparent 28%);
  pointer-events: none;
}
.message-textarea {
  width: 100%;
  min-height: 88px;
  max-height: 220px;
  resize: none;
  overflow-y: auto;
  padding: 22px 24px 12px;
  background: none;
  border: none;
  outline: none;
  font-size: 1rem;
  line-height: 1.65;
  color: var(--text, #fafafa);
  letter-spacing: -0.01em;
}
.message-textarea::placeholder {
  color: rgba(255, 255, 255, 0.34);
  opacity: 1;
}
.message-textarea:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.composer-toolbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  flex-wrap: wrap;
  padding: 0 14px 14px 18px;
  gap: 12px;
}
.composer-toolbar-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.keep-polling-controls {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 10px;
  margin-left: auto;
}
.composer-sender-label {
  font-size: 0.72rem;
  color: rgba(255, 255, 255, 0.42);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.composer-sender-label strong {
  color: var(--text, #fafafa);
  font-weight: 640;
}
.composer-shortcut-hint {
  display: none;
  font-size: 0.66rem;
  color: rgba(255, 255, 255, 0.26);
  white-space: nowrap;
}
.keep-polling-pill {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  min-height: 56px;
  padding: 10px 12px 10px 14px;
  border-radius: 20px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(255, 255, 255, 0.035);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
  color: rgba(255, 255, 255, 0.76);
  user-select: none;
  transition: background 180ms ease, border-color 180ms ease, transform 180ms ease, box-shadow 180ms ease;
}
.keep-polling-pill:hover {
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(255, 255, 255, 0.1);
  transform: translateY(-1px);
}
.keep-polling-pill.active {
  background: rgba(255, 255, 255, 0.09);
  border-color: rgba(255, 255, 255, 0.16);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.06),
    0 14px 28px rgba(0, 0, 0, 0.18);
}
.keep-polling-pill.disabled {
  opacity: 0.45;
  cursor: not-allowed;
  transform: none;
}
.keep-polling-input {
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.06);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.05);
  flex-shrink: 0;
}
.keep-polling-pill.active .keep-polling-input {
  background: rgba(255, 255, 255, 0.95);
  border-color: rgba(255, 255, 255, 0.95);
  box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.12);
}
.keep-polling-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.keep-polling-copy strong {
  font-size: 0.76rem;
  font-weight: 650;
  letter-spacing: -0.01em;
  color: rgba(255, 255, 255, 0.94);
}
.keep-polling-copy small {
  font-size: 0.66rem;
  line-height: 1.35;
  color: rgba(255, 255, 255, 0.46);
}
.keep-polling-state {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 40px;
  padding: 6px 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  font-size: 0.68rem;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.76);
}
.keep-polling-pill.active .keep-polling-state {
  background: rgba(255, 255, 255, 0.14);
  color: rgba(255, 255, 255, 0.98);
}
@media (min-width: 641px) {
  .composer-shortcut-hint { display: inline; }
}
.send-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  border-radius: 999px;
  background: var(--text, #fafafa);
  color: var(--bg-0, #09090b);
  border: none;
  cursor: pointer;
  transition: opacity 180ms ease, transform 180ms ease, box-shadow 180ms ease;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.48),
    0 16px 28px rgba(0, 0, 0, 0.24);
}
.send-btn:hover:not(:disabled) {
  transform: scale(1.03) translateY(-1px);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.48),
    0 20px 34px rgba(0, 0, 0, 0.28);
}
.send-btn:active:not(:disabled) { transform: scale(0.96); }
.send-btn:disabled { opacity: 0.2; cursor: default; }
.send-btn svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

@media (max-width: 900px) {
  .composer {
    padding: 14px;
  }

  .composer-card {
    border-radius: 24px;
  }

  .message-textarea {
    min-height: 76px;
    padding: 18px 18px 10px;
  }

  .composer-toolbar {
    align-items: stretch;
    padding: 0 12px 12px;
  }

  .composer-toolbar-left,
  .keep-polling-controls {
    width: 100%;
    margin-left: 0;
  }

  .keep-polling-pill {
    width: 100%;
  }

  .send-btn {
    margin-left: auto;
  }
}
</style>
