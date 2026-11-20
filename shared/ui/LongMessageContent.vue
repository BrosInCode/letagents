<template>
  <div class="long-message" data-testid="long-message">
    <div
      :id="contentId"
      class="long-message-content"
      :class="{ collapsed: isLong && !expanded }"
    >
      <div :class="contentClass" v-html="html" @click="handleInlineReferenceClick" />
    </div>

    <div v-if="isLong" class="long-message-actions">
      <button
        class="long-message-button"
        type="button"
        :aria-expanded="expanded"
        :aria-controls="contentId"
        data-testid="long-message-toggle"
        @click="expanded = !expanded"
      >
        {{ expanded ? 'Show less' : 'Read more' }}
      </button>
      <button class="long-message-button" type="button" data-testid="open-reader" @click="openReader">
        Open reader
      </button>
    </div>

    <MessageReader
      v-if="readerOpen"
      :text="text"
      :html="html"
      :sender="sender"
      :room-identifier="roomIdentifier"
      @close="closeReader"
      @content-click="handleInlineReferenceClick"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTaskLinkPreview } from './board/task-link-preview'
import MessageReader from './MessageReader.vue'
import type { MessageReaderSender } from './message-reader'

const props = withDefaults(defineProps<{
  text: string
  html: string
  messageId: string
  sender?: MessageReaderSender
  roomIdentifier?: string | null
  /** Class on the element that holds the rendered HTML; each app styles its own. */
  contentClass?: string
  /**
   * App-specific click handling, run first. Return an action to claim the click:
   * the component then closes the reader and runs the action.
   */
  interceptClick?: (event: MouseEvent) => (() => void) | null
  collapseAfterChars?: number
  collapseAfterLines?: number
}>(), {
  roomIdentifier: null,
  contentClass: 'long-message-html',
  collapseAfterChars: 1400,
  collapseAfterLines: 18,
})

const emit = defineEmits<{
  messageReferenceClick: [messageId: string]
  taskReferenceClick: [taskId: string]
}>()

const previewTask = useTaskLinkPreview()
const expanded = ref(false)
const readerOpen = ref(false)

const lineCount = computed(() => props.text ? props.text.split(/\r\n|\r|\n/).length : 0)
const isLong = computed(() =>
  props.text.length > props.collapseAfterChars || lineCount.value > props.collapseAfterLines,
)
const safeMessageId = computed(() => props.messageId.replace(/[^A-Za-z0-9_-]/g, '-') || 'message')
const contentId = computed(() => `message-content-${safeMessageId.value}`)

function openReader(): void {
  readerOpen.value = true
}

function closeReader(): void {
  readerOpen.value = false
}

function handleInlineReferenceClick(event: MouseEvent): void {
  const action = props.interceptClick?.(event)
  if (action) {
    event.preventDefault()
    event.stopPropagation()
    closeReader()
    action()
    return
  }

  const target = event.target instanceof Element ? event.target : null
  const messageTarget = target?.closest<HTMLElement>('[data-message-reference-id]')
  const taskTarget = target?.closest<HTMLElement>('[data-task-reference-id]')
  const messageId = messageTarget?.dataset.messageReferenceId || ''
  const taskId = taskTarget?.dataset.taskReferenceId || ''
  if (!messageId && !taskId) return
  event.preventDefault()
  event.stopPropagation()
  if (!messageId && taskId && taskTarget && previewTask) {
    void previewTask(taskId, taskTarget, event.detail === 0, closeReader)
    return
  }
  closeReader()
  if (messageId) {
    emit('messageReferenceClick', messageId)
    return
  }
  emit('taskReferenceClick', taskId)
}
</script>

<style scoped>
.long-message,
.long-message-content {
  min-width: 0;
}

.long-message-content {
  position: relative;
}

.long-message-content.collapsed {
  max-height: 260px;
  overflow: hidden;
  mask-image: linear-gradient(#000 calc(100% - 28px), transparent);
}

.long-message-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 18px;
  margin-top: 12px;
}

.long-message-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--chat-foreground, var(--text));
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 500;
}

.long-message-button:first-child::after { content: '⌄'; font-size: 15px; }
.long-message-button[aria-expanded="true"]::after { transform: rotate(180deg); }
.long-message-button:hover { text-decoration: underline; text-underline-offset: 3px; }
.long-message-button:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; border-radius: 3px; }

@media (max-width: 768px) {
  .long-message-content.collapsed { max-height: 220px; }
  .long-message-button { min-height: 44px; }
}
</style>
