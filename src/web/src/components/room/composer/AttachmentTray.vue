<template>
  <div class="attachment-tray">
    <div v-if="attachments.length" class="attachment-list">
      <div
        v-for="attachment in attachments"
        :key="attachment.id"
        class="attachment-chip"
        :data-upload-state="attachment.uploadState"
      >
        <div
          v-if="attachment.previewUrl"
          class="attachment-preview-shell"
          :data-preview-state="attachment.previewState"
        >
          <img
            class="attachment-preview"
            :src="attachment.previewUrl"
            alt=""
            @load="emit('previewLoaded', attachment.id)"
            @error="emit('previewError', attachment.id)"
          >
          <span v-if="attachment.previewState === 'loading'" class="attachment-preview-badge">
            Loading
          </span>
          <span v-else-if="attachment.previewState === 'error'" class="attachment-preview-badge error">
            Preview unavailable
          </span>
        </div>
        <span v-else class="attachment-file-icon" aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="none">
            <path d="M4 2.5h5l3 3v8H4v-11Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
            <path d="M9 2.5v3h3" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
          </svg>
        </span>
        <span class="attachment-chip-copy">
          <strong>{{ attachment.name }}</strong>
          <span>{{ attachment.uploadMessage || attachmentSecondaryText(attachment) }}</span>
        </span>
        <button
          class="attachment-remove"
          type="button"
          :disabled="isSending"
          :aria-label="`Remove ${attachment.name}`"
          @click="emit('remove', attachment.id)"
        >
          {{ attachment.uploadState === 'uploading' ? 'Cancel' : 'Remove' }}
        </button>
      </div>
    </div>
    <p v-if="attachmentStatusSummary" class="attachment-status">{{ attachmentStatusSummary }}</p>
    <p v-if="attachmentError" class="attachment-error">{{ attachmentError }}</p>
  </div>
</template>

<script setup lang="ts">
import type { AttachmentDraft } from './types'

defineProps<{
  attachments: readonly AttachmentDraft[]
  attachmentError: string
  attachmentStatusSummary: string
  isSending: boolean
  attachmentSecondaryText: (attachment: AttachmentDraft) => string
}>()

const emit = defineEmits<{
  previewLoaded: [id: string]
  previewError: [id: string]
  remove: [id: string]
}>()
</script>

<style scoped>
.attachment-tray {
  display: grid;
  gap: 6px;
  padding: 0 8px 8px;
}
.attachment-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.attachment-chip {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  max-width: min(100%, 360px);
  padding: 6px;
  border: 1px solid var(--line, #27272a);
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface, #18181b) 88%, var(--text, #fafafa) 5%);
}
.attachment-chip[data-upload-state="uploading"] {
  border-color: color-mix(in srgb, #7dd3fc 30%, var(--line, #27272a));
}
.attachment-chip[data-upload-state="error"] {
  border-color: color-mix(in srgb, #fca5a5 55%, var(--line, #27272a));
}
.attachment-chip[data-upload-state="uploaded"] {
  border-color: color-mix(in srgb, #34d399 38%, var(--line, #27272a));
}
.attachment-preview-shell,
.attachment-file-icon {
  width: 36px;
  height: 36px;
  border-radius: 6px;
  border: 1px solid var(--line, #27272a);
  background: var(--bg-0, #09090b);
  flex-shrink: 0;
}
.attachment-preview-shell {
  position: relative;
  overflow: hidden;
}
.attachment-preview-shell[data-preview-state="loading"]::after,
.attachment-preview-shell[data-preview-state="error"]::after {
  content: '';
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--bg-0, #09090b) 74%, transparent);
}
.attachment-preview {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.attachment-preview-badge {
  position: absolute;
  inset-inline: 3px;
  bottom: 3px;
  z-index: 1;
  display: inline-flex;
  justify-content: center;
  padding: 1px 4px;
  border-radius: 4px;
  background: rgba(15, 23, 42, 0.88);
  color: var(--text, #fafafa);
  font-size: 0.58rem;
  font-weight: 650;
  white-space: nowrap;
}
.attachment-preview-badge.error {
  background: rgba(127, 29, 29, 0.9);
}
.attachment-file-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--muted, #a1a1aa);
}
.attachment-file-icon svg {
  width: 18px;
  height: 18px;
}
.attachment-chip-copy {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.attachment-chip-copy strong,
.attachment-chip-copy span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.attachment-chip-copy strong {
  font-size: 0.76rem;
  color: var(--text, #fafafa);
}
.attachment-chip-copy span,
.attachment-status,
.attachment-error {
  font-size: 0.68rem;
  color: var(--muted, #71717a);
}
.attachment-status,
.attachment-error {
  margin: 0;
}
.attachment-status {
  color: var(--muted, #a1a1aa);
}
.attachment-error {
  color: #fca5a5;
}
.attachment-remove {
  border: 1px solid var(--line, #27272a);
  border-radius: 8px;
  background: transparent;
  color: var(--text, #fafafa);
  font: inherit;
  font-size: 0.7rem;
  font-weight: 650;
  cursor: pointer;
  padding: 5px 8px;
  transition: background 150ms ease, border-color 150ms ease, opacity 150ms ease;
}
.attachment-remove:hover:not(:disabled) {
  border-color: var(--line-strong, #3f3f46);
  background: rgba(255, 255, 255, 0.08);
}
.attachment-remove:disabled {
  cursor: default;
  opacity: 0.45;
}

@media (max-width: 768px) {
  .attachment-tray { padding: 0 6px 6px; }
  .attachment-chip { max-width: 100%; }
}
</style>
