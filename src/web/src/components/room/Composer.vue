<template>
  <form class="composer" @submit.prevent="handleSend">
    <div class="composer-card">
      <textarea
        ref="textareaEl"
        class="message-textarea"
        placeholder="Write a message…"
        v-model="text"
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
        <button class="send-btn" type="submit" :disabled="!text.trim()" aria-label="Send message">
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
}>(), {
  senderName: 'anonymous',
  disabled: false,
})

const emit = defineEmits<{
  send: [text: string]
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

onMounted(() => {
  textareaEl.value?.focus()
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
.composer-card:focus-within {
  border-color: var(--line-strong, #3f3f46);
  box-shadow: 0 0 0 3px rgba(250,250,250,0.04), 0 8px 32px rgba(0,0,0,0.24);
}
.message-textarea {
  width: 100%;
  min-height: 48px;
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
}
.message-textarea::placeholder {
  color: var(--muted, #71717a);
  opacity: 0.6;
}
.composer-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px 8px 16px;
  gap: 8px;
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
</style>
