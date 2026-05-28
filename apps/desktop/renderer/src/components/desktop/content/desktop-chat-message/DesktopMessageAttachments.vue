<template>
  <div class="room-message-attachments">
    <template v-for="attachment in attachments" :key="attachmentKey(attachment)">
      <button
        v-if="isImageAttachment(attachment)"
        class="room-message-attachment is-image"
        type="button"
        @click="$emit('open-image', imageAttachmentId(messageId, attachment))"
      >
        <img :src="attachmentHref(attachment)" :alt="attachmentName(attachment)">
        <span>
          <strong>{{ attachmentName(attachment) }}</strong>
          <small>{{ attachmentDisplayMeta(attachment) }}</small>
        </span>
      </button>
      <a
        v-else
        class="room-message-attachment"
        :href="attachmentHref(attachment)"
        target="_blank"
        rel="noopener noreferrer"
      >
        <span>
          <strong>{{ attachmentName(attachment) }}</strong>
          <small>{{ attachmentDisplayMeta(attachment) }}</small>
        </span>
      </a>
    </template>
  </div>
</template>

<script setup lang="ts">
import type { DesktopRoomMessageAttachment } from "../../../../../../electron/ipc-types";
import {
  attachmentHref,
  attachmentKey,
  attachmentMimeType,
  attachmentName,
  imageAttachmentId,
  isImageAttachment,
} from "../room-chat/attachment-utils";

defineProps<{
  messageId: string;
  attachments: DesktopRoomMessageAttachment[];
}>();

defineEmits<{
  "open-image": [imageId: string];
}>();

function attachmentDisplayMeta(attachment: DesktopRoomMessageAttachment): string {
  return [
    attachmentMimeType(attachment),
    formatDisplayBytes(attachment.sizeBytes || 0),
  ].filter(Boolean).join(" · ");
}

function formatDisplayBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}
</script>
