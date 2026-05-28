<template>
  <div
    v-if="attachments.length || pendingAttachments.length"
    class="desktop-attachment-drafts"
    data-testid="desktop-attachment-drafts"
  >
    <div
      v-for="attachment in pendingAttachments"
      :key="attachment.localId"
      class="desktop-attachment-draft is-pending"
      data-testid="desktop-attachment-draft-pending"
    >
      <span>
        <img
          v-if="attachment.previewDataUrl"
          class="desktop-attachment-preview"
          :src="attachment.previewDataUrl"
          alt=""
        >
        <span v-else class="desktop-attachment-pending-icon" aria-hidden="true"></span>
        <strong>{{ attachment.fileName }}</strong>
        <small>{{ attachment.mimeType }} · {{ formatBytes(attachment.sizeBytes) }} · Uploading...</small>
      </span>
    </div>
    <div
      v-for="attachment in attachments"
      :key="attachment.uploadId"
      class="desktop-attachment-draft"
      data-testid="desktop-attachment-draft"
    >
      <span>
        <img v-if="attachment.previewDataUrl" class="desktop-attachment-preview" :src="attachment.previewDataUrl" alt="">
        <strong>{{ attachment.fileName }}</strong>
        <small>{{ attachment.mimeType }} · {{ formatBytes(attachment.sizeBytes) }}</small>
      </span>
      <button type="button" @click="$emit('remove', attachment.uploadId)">Remove</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { DesktopStagedAttachment } from "../../../../../electron/ipc-types";
import { formatBytes } from "./room-chat/attachment-utils";

export interface PendingAttachmentDraft {
  localId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  previewDataUrl: string | null;
}

defineProps<{
  attachments: DesktopStagedAttachment[];
  pendingAttachments: PendingAttachmentDraft[];
}>();

defineEmits<{
  remove: [uploadId: string];
}>();
</script>
