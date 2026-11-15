<template>
  <div class="long-message">
    <div
      :id="contentId"
      class="long-message-content"
      :class="{ collapsed: isLong && !expanded }"
    >
      <div class="md-content" v-html="html" @click="handleInlineReferenceClick" />
    </div>

    <div v-if="isLong" class="long-message-actions">
      <button
        class="long-message-button"
        type="button"
        :aria-expanded="expanded"
        :aria-controls="contentId"
        @click="expanded = !expanded"
      >
        {{ expanded ? 'Show less' : 'Read more' }}
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
import { useTaskLinkPreview } from "../../../../../shared/ui/board/task-link-preview"
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

const previewTask = useTaskLinkPreview()
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
  if (target && previewTask) {
    void previewTask(taskId, target, event.detail === 0, () => { readerOpen.value = false })
    return
  }
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

.long-message-content.collapsed { mask-image: linear-gradient(#000 calc(100% - 28px), transparent); }
.long-message-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 18px; margin-top: 12px; }
.long-message-button { display: inline-flex; align-items: center; gap: 6px; min-height: 30px; padding: 0; border: 0; background: transparent; color: var(--chat-foreground, var(--text)); cursor: pointer; font: inherit; font-size: 12px; font-weight: 500; }
.long-message-button:first-child::after { content: '⌄'; font-size: 15px; }
.long-message-button[aria-expanded="true"]::after { transform: rotate(180deg); }
.long-message-button:hover { text-decoration: underline; text-underline-offset: 3px; }
.long-message-button:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; border-radius: 3px; }

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
