<template>
  <div class="message-attachments">
    <template v-for="attachment in attachments" :key="attachmentKey(attachment)">
      <button
        v-if="isImageAttachment(attachment)"
        class="message-attachment message-attachment-button"
        type="button"
        :aria-label="`Open ${attachmentName(attachment)} in image viewer`"
        @click="emit('openImageViewer', imageAttachmentId(messageId, attachment))"
      >
        <div
          class="message-attachment-image-shell"
          :data-image-state="attachmentImageState(attachment)"
        >
          <img
            v-if="attachmentImageState(attachment) !== 'error'"
            class="message-attachment-image"
            :src="attachmentHref(attachment)"
            :alt="attachmentName(attachment)"
            @load="markAttachmentImageLoaded(attachment)"
            @error="markAttachmentImageError(attachment)"
          >
          <span v-if="attachmentImageState(attachment) === 'loading'" class="message-attachment-image-status">
            Loading image...
          </span>
          <span v-else-if="attachmentImageState(attachment) === 'error'" class="message-attachment-image-status error">
            Image unavailable
          </span>
        </div>
        <span class="message-attachment-copy">
          <strong>{{ attachmentName(attachment) }}</strong>
          <span>{{ attachmentMeta(attachment) }}</span>
        </span>
      </button>
      <a
        v-else
        class="message-attachment"
        :href="attachmentHref(attachment)"
        :download="attachmentName(attachment)"
        target="_blank"
        rel="noopener noreferrer"
      >
        <span class="message-attachment-icon" aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="none">
            <path d="M4 2.5h5l3 3v8H4v-11Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
            <path d="M9 2.5v3h3" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
          </svg>
        </span>
        <span class="message-attachment-copy">
          <strong>{{ attachmentName(attachment) }}</strong>
          <span>{{ attachmentMeta(attachment) }}</span>
        </span>
      </a>
    </template>
  </div>
</template>

<script setup lang="ts">
import { reactive } from 'vue'
import type { RoomMessageAttachment } from '@/composables/useRoom'
import {
  attachmentHref,
  attachmentKey,
  attachmentMeta,
  attachmentName,
  imageAttachmentId,
  isImageAttachment,
} from '../messageAttachments'

defineProps<{
  messageId: string
  attachments: readonly RoomMessageAttachment[]
}>()

const emit = defineEmits<{
  openImageViewer: [imageId: string]
}>()

const attachmentImageStates = reactive<Record<string, 'loading' | 'loaded' | 'error'>>({})

function attachmentImageState(attachment: RoomMessageAttachment): 'loading' | 'loaded' | 'error' {
  return attachmentImageStates[attachmentKey(attachment)] || 'loading'
}

function markAttachmentImageLoaded(attachment: RoomMessageAttachment) {
  attachmentImageStates[attachmentKey(attachment)] = 'loaded'
}

function markAttachmentImageError(attachment: RoomMessageAttachment) {
  attachmentImageStates[attachmentKey(attachment)] = 'error'
}
</script>

<style scoped>
.message-attachments {
  display: grid;
  gap: 8px;
  margin-top: 8px;
}
.message-attachment {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  max-width: min(100%, 420px);
  padding: 8px;
  border: 1px solid var(--line, #27272a);
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface, #18181b) 82%, transparent);
  color: inherit;
  text-decoration: none;
  transition: border-color 150ms ease, background 150ms ease;
}
.message-attachment:hover,
.message-attachment:focus-visible {
  border-color: color-mix(in srgb, var(--sender-color, #71717a) 45%, var(--line-strong, #3f3f46));
  background: color-mix(in srgb, var(--surface, #18181b) 92%, var(--sender-color, #71717a) 8%);
  outline: none;
}

.message-attachment-button {
  width: 100%;
  font: inherit;
  cursor: zoom-in;
  text-align: left;
}
.message-attachment-image,
.message-attachment-icon {
  width: 54px;
  height: 54px;
  border-radius: 6px;
  border: 1px solid var(--line, #27272a);
  background: var(--bg-0, #09090b);
}
.message-attachment-image-shell {
  position: relative;
  overflow: hidden;
}
.message-attachment-image-shell[data-image-state="loading"]::after,
.message-attachment-image-shell[data-image-state="error"]::after {
  content: '';
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--bg-0, #09090b) 74%, transparent);
}
.message-attachment-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.message-attachment-image-status {
  position: absolute;
  inset-inline: 4px;
  bottom: 4px;
  z-index: 1;
  display: inline-flex;
  justify-content: center;
  padding: 2px 5px;
  border-radius: 4px;
  background: rgba(15, 23, 42, 0.88);
  color: var(--text, #fafafa);
  font-size: 0.58rem;
  font-weight: 650;
  white-space: nowrap;
}
.message-attachment-image-status.error {
  background: rgba(127, 29, 29, 0.9);
}
.message-attachment-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--muted, #a1a1aa);
}
.message-attachment-icon svg {
  width: 22px;
  height: 22px;
}
.message-attachment-copy {
  display: grid;
  gap: 3px;
  min-width: 0;
}
.message-attachment-copy strong,
.message-attachment-copy span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.message-attachment-copy strong {
  color: var(--text, #fafafa);
  font-size: 0.8rem;
}
.message-attachment-copy span {
  color: var(--muted, #a1a1aa);
  font-size: 0.72rem;
}
</style>
