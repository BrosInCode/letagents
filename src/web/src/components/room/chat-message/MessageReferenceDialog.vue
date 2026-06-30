<template>
  <Transition name="message-ref-modal">
    <div
      v-if="open"
      class="message-ref-backdrop"
      @click.self="emit('close')"
    >
      <section
        ref="dialog"
        class="message-ref-dialog"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
        @keydown="handleDialogKeydown"
      >
        <header class="message-ref-header">
          <div>
            <p class="message-ref-eyebrow">{{ messageId }}</p>
            <h2 :id="titleId">Message reference</h2>
          </div>
          <button class="message-ref-button" type="button" @click="emit('close')">
            Close
          </button>
        </header>

        <div class="message-ref-content">
          <template v-if="message">
            <div class="message-ref-meta">
              <strong>{{ displayName }}</strong>
              <time v-if="formattedTime">{{ formattedTime }}</time>
            </div>
            <p class="message-ref-full-text">{{ message.text || 'Empty message' }}</p>
          </template>
          <p v-else class="message-ref-missing">
            This message is not loaded in the current transcript window.
          </p>
        </div>

        <footer class="message-ref-footer">
          <button
            v-if="message"
            class="message-ref-button"
            type="button"
            @click="emit('jump')"
          >
            Jump to message
          </button>
          <button class="message-ref-button primary" type="button" @click="emit('close')">
            Done
          </button>
        </footer>
      </section>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import {
  type RoomMessage,
  parseAgentIdentity,
} from '@/composables/useRoom'
import { formatMessageTime } from './formatting'

const props = defineProps<{
  open: boolean
  messageId: string | null
  message: RoomMessage | null
  titleId: string
  returnFocusTo?: HTMLElement | null
}>()

const emit = defineEmits<{
  close: []
  jump: []
}>()

const dialog = ref<HTMLElement | null>(null)

const displayName = computed(() => {
  if (!props.message) return 'Unknown'
  return parseAgentIdentity(props.message.sender).displayName || props.message.sender || 'Unknown'
})

const formattedTime = computed(() =>
  props.message?.timestamp ? formatMessageTime(props.message.timestamp) : ''
)

function focusableElements(): HTMLElement[] {
  if (!dialog.value) return []
  return Array.from(dialog.value.querySelectorAll<HTMLElement>([
    'button:not([disabled])',
    '[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(','))).filter((element) => !element.hasAttribute('disabled') && element.offsetParent !== null)
}

function focusDialog() {
  const first = focusableElements()[0]
  if (first) {
    first.focus()
    return
  }
  dialog.value?.focus()
}

function restoreFocus() {
  const target = props.returnFocusTo
  if (target?.isConnected) {
    target.focus()
  }
}

function handleDialogKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    emit('close')
    return
  }

  if (event.key !== 'Tab') return

  const focusable = focusableElements()
  if (focusable.length === 0) {
    event.preventDefault()
    dialog.value?.focus()
    return
  }

  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const active = document.activeElement

  if (event.shiftKey && active === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
  }
}

function handleDocumentKeydown(event: KeyboardEvent) {
  if (!props.open || event.key !== 'Escape') return
  event.preventDefault()
  emit('close')
}

watch(() => props.open, (open) => {
  if (open) {
    document.addEventListener('keydown', handleDocumentKeydown)
    nextTick(focusDialog)
    return
  }

  document.removeEventListener('keydown', handleDocumentKeydown)
  nextTick(restoreFocus)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleDocumentKeydown)
})
</script>

<style scoped>
.message-ref-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(9, 9, 11, 0.72);
}

.message-ref-dialog {
  display: flex;
  flex-direction: column;
  width: min(560px, 100%);
  max-height: min(78vh, 720px);
  overflow: hidden;
  border: 1px solid var(--line, #27272a);
  border-radius: 8px;
  background: var(--bg-0, #09090b);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.4);
  transform: translateY(0) scale(1);
}

.message-ref-dialog:focus {
  outline: none;
}

.message-ref-modal-enter-active,
.message-ref-modal-leave-active {
  transition: opacity 160ms ease;
}

.message-ref-modal-enter-active .message-ref-dialog,
.message-ref-modal-leave-active .message-ref-dialog {
  transition: opacity 160ms ease, transform 160ms ease;
}

.message-ref-modal-enter-from,
.message-ref-modal-leave-to {
  opacity: 0;
}

.message-ref-modal-enter-from .message-ref-dialog,
.message-ref-modal-leave-to .message-ref-dialog {
  opacity: 0;
  transform: translateY(8px) scale(0.98);
}

.message-ref-modal-enter-to,
.message-ref-modal-leave-from {
  opacity: 1;
}

.message-ref-modal-enter-to .message-ref-dialog,
.message-ref-modal-leave-from .message-ref-dialog {
  opacity: 1;
  transform: translateY(0) scale(1);
}

.message-ref-header,
.message-ref-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--line, #27272a);
}

.message-ref-footer {
  justify-content: flex-end;
  border-top: 1px solid var(--line, #27272a);
  border-bottom: none;
}

.message-ref-eyebrow {
  margin: 0 0 4px;
  color: var(--muted, #a1a1aa);
  font-size: 0.72rem;
  line-height: 1.2;
}

.message-ref-header h2 {
  margin: 0;
  color: var(--text, #fafafa);
  font-size: 1rem;
  line-height: 1.2;
}

.message-ref-content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 16px;
  color: var(--text, #fafafa);
}

.message-ref-meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.message-ref-meta strong {
  font-size: 0.82rem;
  line-height: 1.2;
}

.message-ref-meta time {
  color: var(--muted, #a1a1aa);
  font-size: 0.72rem;
  white-space: nowrap;
}

.message-ref-full-text,
.message-ref-missing {
  margin: 0;
  color: var(--text, #fafafa);
  font-size: 0.88rem;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.message-ref-missing {
  color: var(--muted, #a1a1aa);
}

.message-ref-button {
  border: 1px solid var(--line, #27272a);
  border-radius: 8px;
  background: var(--surface, #18181b);
  color: var(--text, #fafafa);
  cursor: pointer;
  font: inherit;
  font-size: 0.76rem;
  font-weight: 700;
  line-height: 1;
  padding: 8px 10px;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.message-ref-button:hover,
.message-ref-button:focus-visible {
  background: color-mix(in srgb, var(--surface, #18181b) 84%, var(--text, #fafafa) 8%);
  border-color: var(--muted, #71717a);
  outline: 2px solid #93c5fd;
  outline-offset: 2px;
  box-shadow: 0 0 0 4px rgba(96, 165, 250, 0.16);
}

.message-ref-button.primary {
  background: var(--text, #fafafa);
  color: var(--bg-0, #09090b);
  border-color: var(--text, #fafafa);
}

.message-ref-button.primary:focus-visible {
  outline-color: #93c5fd;
  box-shadow: 0 0 0 4px rgba(96, 165, 250, 0.24);
}

@media (max-width: 768px) {
  .message-ref-backdrop {
    align-items: stretch;
    padding: 10px;
  }

  .message-ref-dialog {
    max-height: calc(100vh - 20px);
  }

  .message-ref-header,
  .message-ref-footer {
    align-items: flex-start;
    flex-direction: column;
    padding: 12px;
  }

  .message-ref-button {
    width: 100%;
  }

  .message-ref-content {
    padding: 14px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .message-ref-modal-enter-active,
  .message-ref-modal-leave-active,
  .message-ref-modal-enter-active .message-ref-dialog,
  .message-ref-modal-leave-active .message-ref-dialog {
    transition-duration: 1ms;
  }

  .message-ref-modal-enter-from .message-ref-dialog,
  .message-ref-modal-leave-to .message-ref-dialog,
  .message-ref-modal-enter-to .message-ref-dialog,
  .message-ref-modal-leave-from .message-ref-dialog {
    transform: none;
  }
}
</style>
