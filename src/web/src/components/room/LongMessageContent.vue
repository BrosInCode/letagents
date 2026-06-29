<template>
  <div
    class="long-message"
    @click="handleReferenceClick"
    @mouseover="handleReferenceMouseOver"
    @mouseout="handleReferenceMouseOut"
    @focusin="handleReferenceFocusIn"
    @focusout="handleReferenceFocusOut"
  >
    <div
      :id="contentId"
      class="long-message-content"
      :class="{ collapsed: isLong && !expanded }"
    >
      <div class="md-content" v-html="html" />
      <span v-if="isLong && !expanded" class="long-message-fade" aria-hidden="true" />
    </div>

    <div v-if="isLong" class="long-message-actions">
      <span class="long-message-stats">{{ statsLabel }}</span>
      <button
        class="long-message-button"
        type="button"
        :aria-expanded="expanded"
        :aria-controls="contentId"
        @click="expanded = !expanded"
      >
        {{ expanded ? 'Collapse' : 'Show full message' }}
      </button>
      <button class="long-message-button" type="button" @click="openReader">
        Open reader
      </button>
    </div>

    <Teleport to="body">
      <div
        v-if="readerOpen"
        class="reader-backdrop"
        @click.self="closeReader"
      >
        <section
          ref="readerDialog"
          class="reader-dialog"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="readerTitleId"
          tabindex="-1"
          @keydown.esc="closeReader"
        >
          <header class="reader-header">
            <div>
              <p class="reader-eyebrow">{{ statsLabel }}</p>
              <h2 :id="readerTitleId">Message reader</h2>
            </div>
            <button class="reader-close" type="button" @click="closeReader">
              Close
            </button>
          </header>

          <div
            class="reader-content md-content"
            v-html="html"
            @click="handleReferenceClick"
            @mouseover="handleReferenceMouseOver"
            @mouseout="handleReferenceMouseOut"
            @focusin="handleReferenceFocusIn"
            @focusout="handleReferenceFocusOut"
          />

          <footer class="reader-footer">
            <button class="reader-action" type="button" @click="copyText">
              {{ copyLabel }}
            </button>
            <button class="reader-action primary" type="button" @click="closeReader">
              Done
            </button>
          </footer>
        </section>
      </div>

      <Transition name="message-ref-popover">
        <div
          v-if="hoveredReference"
          class="message-ref-popover"
          :class="{ missing: !hoveredReference.loaded }"
          :style="hoverPopoverStyle"
          role="tooltip"
        >
          <strong>{{ hoveredReference.id }}</strong>
          <span>{{ hoveredReference.preview }}</span>
        </div>
      </Transition>

      <Transition name="message-ref-modal">
        <div
          v-if="referenceDialogOpen"
          class="message-ref-backdrop"
          @click.self="closeReferenceDialog"
        >
          <section
            ref="referenceDialog"
            class="message-ref-dialog"
            role="dialog"
            aria-modal="true"
            :aria-labelledby="referenceTitleId"
            tabindex="-1"
            @keydown.esc="closeReferenceDialog"
          >
            <header class="message-ref-header">
              <div>
                <p class="message-ref-eyebrow">{{ selectedReferenceId }}</p>
                <h2 :id="referenceTitleId">Message reference</h2>
              </div>
              <button class="reader-close" type="button" @click="closeReferenceDialog">
                Close
              </button>
            </header>

            <div class="message-ref-content">
              <template v-if="selectedReferenceMessage">
                <div class="message-ref-meta">
                  <strong>{{ selectedReferenceDisplayName }}</strong>
                  <time v-if="selectedReferenceTime">{{ selectedReferenceTime }}</time>
                </div>
                <p class="message-ref-full-text">{{ selectedReferenceMessage.text || 'Empty message' }}</p>
              </template>
              <p v-else class="message-ref-missing">
                This message is not loaded in the current transcript window.
              </p>
            </div>

            <footer class="message-ref-footer">
              <button
                v-if="selectedReferenceMessage"
                class="reader-action"
                type="button"
                @click="jumpToReference"
              >
                Jump to message
              </button>
              <button class="reader-action primary" type="button" @click="closeReferenceDialog">
                Done
              </button>
            </footer>
          </section>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import {
  type RoomMessage,
  parseAgentIdentity,
} from '@/composables/useRoom'
import { formatMessageTime } from './chat-message/formatting'

const props = withDefaults(defineProps<{
  text: string
  html: string
  messageId: string
  messageReferences?: ReadonlyMap<string, RoomMessage>
  collapseAfterChars?: number
  collapseAfterLines?: number
}>(), {
  collapseAfterChars: 1400,
  collapseAfterLines: 18,
})
const emit = defineEmits<{
  scrollToMessageReference: [messageId: string]
}>()

const expanded = ref(false)
const readerOpen = ref(false)
const copied = ref(false)
const readerDialog = ref<HTMLElement | null>(null)
const referenceDialog = ref<HTMLElement | null>(null)
const selectedReferenceId = ref<string | null>(null)
const referenceDialogOpen = ref(false)
const hoveredReference = ref<{
  id: string
  preview: string
  loaded: boolean
} | null>(null)
const hoverPopoverStyle = ref<Record<string, string>>({})

const lineCount = computed(() => {
  if (!props.text) return 0
  return props.text.split(/\r\n|\r|\n/).length
})

const characterCount = computed(() => props.text.length)

const isLong = computed(() =>
  characterCount.value > props.collapseAfterChars || lineCount.value > props.collapseAfterLines
)

const safeMessageId = computed(() => {
  const safe = props.messageId.replace(/[^A-Za-z0-9_-]/g, '-')
  return safe || 'message'
})

const contentId = computed(() => `message-content-${safeMessageId.value}`)
const readerTitleId = computed(() => `message-reader-title-${safeMessageId.value}`)
const referenceTitleId = computed(() => `message-ref-title-${safeMessageId.value}`)
const selectedReferenceMessage = computed(() =>
  selectedReferenceId.value
    ? props.messageReferences?.get(selectedReferenceId.value) || null
    : null
)
const selectedReferenceDisplayName = computed(() => {
  const message = selectedReferenceMessage.value
  if (!message) return 'Unknown'
  return parseAgentIdentity(message.sender).displayName || message.sender || 'Unknown'
})
const selectedReferenceTime = computed(() =>
  selectedReferenceMessage.value?.timestamp
    ? formatMessageTime(selectedReferenceMessage.value.timestamp)
    : ''
)

const statsLabel = computed(() => {
  const lines = lineCount.value
  const chars = new Intl.NumberFormat().format(characterCount.value)
  return `${lines} ${lines === 1 ? 'line' : 'lines'} / ${chars} chars`
})

const copyLabel = computed(() => copied.value ? 'Copied' : 'Copy text')

function openReader() {
  readerOpen.value = true
  copied.value = false
  nextTick(() => readerDialog.value?.focus())
}

function closeReader() {
  readerOpen.value = false
}

function findReferenceToken(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  const token = target.closest('.message-ref-token')
  return token instanceof HTMLElement ? token : null
}

function getReferencePreview(messageId: string): { id: string; preview: string; loaded: boolean } {
  const message = props.messageReferences?.get(messageId) || null
  if (!message) {
    return {
      id: messageId,
      preview: 'Message is not loaded in this transcript window.',
      loaded: false,
    }
  }

  const sender = parseAgentIdentity(message.sender).displayName || message.sender || 'Unknown'
  const text = (message.text || '').replace(/\s+/g, ' ').trim()
  const preview = text.length > 180 ? `${text.slice(0, 177)}...` : text
  return {
    id: messageId,
    preview: preview ? `${sender}: ${preview}` : `${sender}: empty message`,
    loaded: true,
  }
}

function showReferencePopover(token: HTMLElement) {
  const messageId = token.dataset.messageRefId || ''
  if (!messageId) return
  const rect = token.getBoundingClientRect()
  const left = Math.min(Math.max(rect.left + rect.width / 2, 20), window.innerWidth - 20)
  const showBelow = rect.top < 150
  hoveredReference.value = getReferencePreview(messageId)
  hoverPopoverStyle.value = {
    left: `${left}px`,
    top: `${showBelow ? rect.bottom + 10 : rect.top - 10}px`,
    '--message-ref-popover-transform': showBelow ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
  }
}

function hideReferencePopover() {
  hoveredReference.value = null
}

function handleReferenceClick(event: MouseEvent) {
  const token = findReferenceToken(event.target)
  if (!token) return
  const messageId = token.dataset.messageRefId || ''
  if (!messageId) return
  event.preventDefault()
  event.stopPropagation()
  selectedReferenceId.value = messageId
  referenceDialogOpen.value = true
  hideReferencePopover()
  nextTick(() => referenceDialog.value?.focus())
}

function handleReferenceMouseOver(event: MouseEvent) {
  const token = findReferenceToken(event.target)
  if (token) showReferencePopover(token)
}

function handleReferenceMouseOut(event: MouseEvent) {
  const token = findReferenceToken(event.target)
  if (!token) return
  if (event.relatedTarget instanceof Node && token.contains(event.relatedTarget)) return
  hideReferencePopover()
}

function handleReferenceFocusIn(event: FocusEvent) {
  const token = findReferenceToken(event.target)
  if (token) showReferencePopover(token)
}

function handleReferenceFocusOut(event: FocusEvent) {
  const token = findReferenceToken(event.target)
  if (token) hideReferencePopover()
}

function closeReferenceDialog() {
  referenceDialogOpen.value = false
}

function jumpToReference() {
  if (!selectedReferenceId.value) return
  emit('scrollToMessageReference', selectedReferenceId.value)
  closeReferenceDialog()
  readerOpen.value = false
}

async function copyText() {
  try {
    await navigator.clipboard.writeText(props.text)
    copied.value = true
    window.setTimeout(() => {
      copied.value = false
    }, 1600)
  } catch {
    copied.value = false
  }
}
</script>

<style scoped>
.long-message {
  min-width: 0;
}

.long-message-content {
  position: relative;
  min-width: 0;
}

.long-message-content.collapsed {
  max-height: 260px;
  overflow: hidden;
}

.long-message-fade {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 56px;
  pointer-events: none;
  background: linear-gradient(to bottom, transparent, var(--bg-1, #111113) 85%);
}

.long-message-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.long-message-stats {
  color: var(--muted, #a1a1aa);
  font-size: 0.72rem;
  line-height: 1.3;
}

.long-message-button,
.reader-close,
.reader-action {
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

.long-message-button:hover,
.long-message-button:focus-visible,
.reader-close:hover,
.reader-close:focus-visible,
.reader-action:hover,
.reader-action:focus-visible {
  background: color-mix(in srgb, var(--surface, #18181b) 84%, var(--text, #fafafa) 8%);
  border-color: var(--muted, #71717a);
  outline: none;
}

.reader-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(9, 9, 11, 0.78);
}

.message-ref-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(9, 9, 11, 0.72);
}

.message-ref-popover {
  position: fixed;
  z-index: 1100;
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: min(320px, calc(100vw - 24px));
  padding: 10px 12px;
  border: 1px solid var(--line, #27272a);
  border-radius: 8px;
  background: var(--bg-0, #09090b);
  color: var(--text, #fafafa);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.36);
  pointer-events: none;
  transform: var(--message-ref-popover-transform, translate(-50%, -100%)) scale(1);
  transform-origin: center center;
}

.message-ref-popover-enter-active,
.message-ref-popover-leave-active {
  transition: opacity 140ms ease, transform 140ms ease;
}

.message-ref-popover-enter-from,
.message-ref-popover-leave-to {
  opacity: 0;
  transform: var(--message-ref-popover-transform, translate(-50%, -100%)) translateY(3px) scale(0.98);
}

.message-ref-popover-enter-to,
.message-ref-popover-leave-from {
  opacity: 1;
  transform: var(--message-ref-popover-transform, translate(-50%, -100%)) scale(1);
}

.message-ref-popover strong {
  font-size: 0.72rem;
  line-height: 1.2;
  color: #93c5fd;
}

.message-ref-popover span {
  color: var(--muted, #d4d4d8);
  font-size: 0.78rem;
  line-height: 1.45;
}

.message-ref-popover.missing span {
  color: var(--muted, #a1a1aa);
}

.reader-dialog {
  display: flex;
  flex-direction: column;
  width: min(960px, 100%);
  max-height: min(86vh, 900px);
  overflow: hidden;
  border: 1px solid var(--line, #27272a);
  border-radius: 8px;
  background: var(--bg-0, #09090b);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.4);
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

.message-ref-dialog:focus {
  outline: none;
}

.reader-dialog:focus {
  outline: none;
}

.reader-header,
.reader-footer,
.message-ref-header,
.message-ref-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--line, #27272a);
}

.reader-footer,
.message-ref-footer {
  justify-content: flex-end;
  border-top: 1px solid var(--line, #27272a);
  border-bottom: none;
}

.reader-eyebrow,
.message-ref-eyebrow {
  margin: 0 0 4px;
  color: var(--muted, #a1a1aa);
  font-size: 0.72rem;
  line-height: 1.2;
}

.reader-header h2,
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

.reader-content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 18px 20px;
  color: var(--text, #fafafa);
}

.reader-action.primary {
  background: var(--text, #fafafa);
  color: var(--bg-0, #09090b);
  border-color: var(--text, #fafafa);
}

.reader-content,
.long-message-content :deep(.md-content) {
  line-height: 1.6;
  font-size: 0.88rem;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.reader-content :deep(a),
.long-message-content :deep(a) {
  color: #60a5fa;
  text-decoration: none;
  word-break: break-all;
}

.reader-content :deep(a:hover),
.long-message-content :deep(a:hover) {
  text-decoration: underline;
}

.reader-content :deep(code),
.long-message-content :deep(code) {
  padding: 2px 5px;
  border-radius: 4px;
  background: var(--surface, #18181b);
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.84em;
}

.reader-content :deep(.mention-token),
.long-message-content :deep(.mention-token) {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 8px;
  background: rgba(125, 211, 252, 0.14);
  color: #7dd3fc;
  font-weight: 600;
}

.reader-content :deep(.message-ref-token),
.long-message-content :deep(.message-ref-token) {
  display: inline-flex;
  align-items: center;
  min-height: 1.45em;
  margin: 0 1px;
  padding: 1px 6px;
  border: 1px solid rgba(96, 165, 250, 0.24);
  border-radius: 6px;
  background: rgba(96, 165, 250, 0.12);
  color: #93c5fd;
  cursor: pointer;
  font: inherit;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.9em;
  line-height: 1.35;
  vertical-align: baseline;
  white-space: nowrap;
}

.reader-content :deep(.message-ref-token:hover),
.reader-content :deep(.message-ref-token:focus-visible),
.long-message-content :deep(.message-ref-token:hover),
.long-message-content :deep(.message-ref-token:focus-visible) {
  border-color: rgba(147, 197, 253, 0.62);
  background: rgba(96, 165, 250, 0.2);
  outline: none;
}

.reader-content :deep(.message-ref-token.unresolved),
.long-message-content :deep(.message-ref-token.unresolved) {
  border-style: dashed;
  color: var(--muted, #a1a1aa);
}

@media (max-width: 768px) {
  .long-message-content.collapsed {
    max-height: 220px;
  }

  .reader-backdrop,
  .message-ref-backdrop {
    align-items: stretch;
    padding: 10px;
  }

  .reader-dialog,
  .message-ref-dialog {
    max-height: calc(100vh - 20px);
  }

  .reader-header,
  .reader-footer,
  .message-ref-header,
  .message-ref-footer {
    align-items: flex-start;
    flex-direction: column;
    padding: 12px;
  }

  .reader-close,
  .reader-action {
    width: 100%;
  }

  .reader-content,
  .message-ref-content {
    padding: 14px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .message-ref-popover-enter-active,
  .message-ref-popover-leave-active,
  .message-ref-modal-enter-active,
  .message-ref-modal-leave-active,
  .message-ref-modal-enter-active .message-ref-dialog,
  .message-ref-modal-leave-active .message-ref-dialog {
    transition-duration: 1ms;
  }

  .message-ref-popover-enter-from,
  .message-ref-popover-leave-to,
  .message-ref-popover-enter-to,
  .message-ref-popover-leave-from {
    transform: var(--message-ref-popover-transform, translate(-50%, -100%)) scale(1);
  }

  .message-ref-modal-enter-from .message-ref-dialog,
  .message-ref-modal-leave-to .message-ref-dialog,
  .message-ref-modal-enter-to .message-ref-dialog,
  .message-ref-modal-leave-from .message-ref-dialog {
    transform: none;
  }
}
</style>
