<template>
  <div class="long-message">
    <div
      :id="contentId"
      class="long-message-content"
      :class="{ collapsed: isLong && !expanded }"
    >
      <div class="md-content" v-html="html" @click="handleInlineReferenceClick" />
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

    <MessageReader
      v-if="readerOpen"
      :text="text"
      :html="html"
      :sender="sender"
      :room-identifier="roomIdentifier"
      @close="readerOpen = false"
      @content-click="handleInlineReferenceClick"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import MessageReader from '../../../../../shared/ui/MessageReader.vue'
import type { MessageReaderSender } from '../../../../../shared/ui/message-reader'

const props = withDefaults(defineProps<{
  text: string
  html: string
  messageId: string
  sender?: MessageReaderSender
  roomIdentifier?: string | null
  collapseAfterChars?: number
  collapseAfterLines?: number
}>(), {
  collapseAfterChars: 1400,
  collapseAfterLines: 18,
})

const emit = defineEmits<{
  taskReferenceClick: [taskId: string]
}>()

const expanded = ref(false)
const readerOpen = ref(false)

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

const statsLabel = computed(() => {
  const lines = lineCount.value
  const chars = new Intl.NumberFormat().format(characterCount.value)
  return `${lines} ${lines === 1 ? 'line' : 'lines'} / ${chars} chars`
})

function openReader() {
  readerOpen.value = true
}

function handleInlineReferenceClick(event: MouseEvent) {
  const target = event.target instanceof Element
    ? event.target.closest<HTMLElement>('[data-task-reference-id]')
    : null
  const taskId = target?.dataset.taskReferenceId || ''
  if (!taskId) return
  event.preventDefault()
  event.stopPropagation()
  readerOpen.value = false
  emit('taskReferenceClick', taskId)
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
  background: linear-gradient(to bottom, transparent, var(--message-surface, var(--chat-bubble, var(--bg-1, #111113))) 85%);
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

.long-message-button {
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
.long-message-button:focus-visible {
  background: color-mix(in srgb, var(--surface, #18181b) 84%, var(--text, #fafafa) 8%);
  border-color: var(--muted, #71717a);
  outline: none;
}

.long-message-content :deep(.md-content) {
  line-height: 1.68;
  font-size: 0.94rem;
  overflow-wrap: anywhere;
  word-break: normal;
}

.long-message-content :deep(a) {
  color: #60a5fa;
  text-decoration: none;
  word-break: break-all;
}

.long-message-content :deep(a:hover) {
  text-decoration: underline;
}

.long-message-content :deep(.task-reference-link) {
  display: inline;
  padding: 0;
  border: 0;
  background: transparent;
  color: #60a5fa;
  cursor: pointer;
  font: inherit;
  font-weight: 700;
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, currentColor 38%, transparent);
  text-underline-offset: 0.14em;
}

.long-message-content :deep(.task-reference-link:hover),
.long-message-content :deep(.task-reference-link:focus-visible) {
  color: #93c5fd;
  text-decoration-color: currentColor;
}

.long-message-content :deep(code) {
  padding: 2px 5px;
  border-radius: 4px;
  background: var(--surface, #18181b);
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.84em;
}

.long-message-content :deep(.mention-token) {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 8px;
  background: rgba(125, 211, 252, 0.14);
  color: #7dd3fc;
  font-weight: 600;
}

@media (max-width: 768px) {
  .long-message-content.collapsed {
    max-height: 220px;
  }

  .long-message-button {
    min-height: 44px;
  }
}
</style>
