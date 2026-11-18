<template>
  <SharedLongMessageContent
    :text="text"
    :html="html"
    :message-id="messageId"
    :sender="sender"
    :room-identifier="roomIdentifier"
    content-class="md-content"
    @task-reference-click="emit('taskReferenceClick', $event)"
  />
</template>

<script setup lang="ts">
import SharedLongMessageContent from '../../../../../shared/ui/LongMessageContent.vue'
import type { MessageReaderSender } from '../../../../../shared/ui/message-reader'

defineProps<{
  text: string
  html: string
  messageId: string
  sender?: MessageReaderSender
  roomIdentifier?: string | null
}>()

const emit = defineEmits<{
  taskReferenceClick: [taskId: string]
}>()
</script>

<style scoped>
/* Web chat text styles. The shared component owns the collapse and action styles. */
.long-message :deep(.md-content) {
  line-height: 1.68;
  font-size: 0.94rem;
  overflow-wrap: anywhere;
  word-break: normal;
}

.long-message :deep(a) {
  color: #60a5fa;
  text-decoration: none;
  word-break: break-all;
}

.long-message :deep(a:hover) {
  text-decoration: underline;
}

.long-message :deep(.task-reference-link) {
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

.long-message :deep(.task-reference-link:hover),
.long-message :deep(.task-reference-link:focus-visible) {
  color: #93c5fd;
  text-decoration-color: currentColor;
}

.long-message :deep(code) {
  padding: 2px 5px;
  border-radius: 4px;
  background: var(--surface, #18181b);
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.84em;
}

.long-message :deep(.mention-token) {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 8px;
  background: rgba(125, 211, 252, 0.14);
  color: #7dd3fc;
  font-weight: 600;
}
</style>
